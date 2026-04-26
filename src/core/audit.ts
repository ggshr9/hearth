// Audit log — append-only event journal at <vault>/.hearth/audit.jsonl.
//
// "No audit, no governance." Every state-changing event in hearth's reach
// lands here, in JSONL so it stays human-readable and grep-friendly. Writes
// are file-locked (proper-lockfile) so concurrent writers (CLI + MCP server +
// channel adapter) can't tear lines.
//
// Rotation, retention, and querying-beyond-grep all land in v0.5+. This is
// intentionally the simplest thing that makes "hearth log" possible.

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';

export type AuditEvent =
  | 'adopt.proposed'
  | 'adopt.applied'
  | 'channel.ingested'
  | 'changeplan.created'
  | 'changeplan.applied'
  | 'changeplan.rejected'
  | 'lint.run'
  | 'doctor.run'
  | 'mcp.tool_called'
  | 'approval_token.issued'
  | 'approval_token.consumed'
  | 'approval_token.rejected';

export interface AuditEntry {
  ts: string;                      // ISO 8601
  event: AuditEvent;
  initiated_by?: string;           // e.g. "cli", "mcp:claude-code", "channel:wechat"
  agent?: string;                  // e.g. "mock", "claude", null
  vault: string;                   // absolute vault path
  /** Free-form structured payload. Keep small — not for blob storage. */
  data?: Record<string, unknown>;
}

/** Path to the audit log for a given vault. */
export function auditLogPath(vaultRoot: string): string {
  return join(vaultRoot, '.hearth', 'audit.jsonl');
}

function ensureAuditDir(vaultRoot: string): void {
  mkdirSync(join(vaultRoot, '.hearth'), { recursive: true, mode: 0o755 });
}

/**
 * Append an event. Acquires a process-level advisory lock; safe under
 * concurrent writers. Best-effort on errors — audit failures should not
 * block the actual operation (we'd rather have a missing log line than a
 * failed apply).
 */
export async function audit(vaultRoot: string, entry: Omit<AuditEntry, 'ts' | 'vault'>): Promise<void> {
  const full: AuditEntry = {
    ts: new Date().toISOString(),
    vault: vaultRoot,
    ...entry,
  };
  const path = auditLogPath(vaultRoot);
  ensureAuditDir(vaultRoot);
  // Touch the file so lockfile can lock it
  if (!existsSync(path)) appendFileSync(path, '', { mode: 0o600 });
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 20, maxTimeout: 200 } }).catch(() => null);
  try {
    appendFileSync(path, JSON.stringify(full) + '\n', { mode: 0o600 });
  } finally {
    if (release) await release();
  }
}

/**
 * Sync variant for paths where async is awkward (kernel hot path). Skips
 * lockfile to avoid sync-over-async; uses O_APPEND atomicity (Linux/macOS
 * guarantee single writes < PIPE_BUF are atomic). Trade-off: slightly more
 * tear risk under heavy concurrent load; v0.4 acceptable, v0.5 may revisit.
 */
export function auditSync(vaultRoot: string, entry: Omit<AuditEntry, 'ts' | 'vault'>): void {
  const full: AuditEntry = {
    ts: new Date().toISOString(),
    vault: vaultRoot,
    ...entry,
  };
  const path = auditLogPath(vaultRoot);
  ensureAuditDir(vaultRoot);
  appendFileSync(path, JSON.stringify(full) + '\n', { mode: 0o600 });
}

export interface AuditQueryOptions {
  /** Show entries newer than this Date or ISO string. */
  since?: Date | string;
  /** Filter to events of these types. */
  events?: AuditEvent[];
  /** Limit (most recent first). */
  limit?: number;
}

/** Read the audit log, optionally filtered. Returns most-recent-first. */
export function readAudit(vaultRoot: string, opts: AuditQueryOptions = {}): AuditEntry[] {
  const path = auditLogPath(vaultRoot);
  if (!existsSync(path)) return [];
  const sinceMs = opts.since
    ? (opts.since instanceof Date ? opts.since.getTime() : new Date(opts.since).getTime())
    : 0;
  const events = opts.events ? new Set(opts.events) : null;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out: AuditEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (sinceMs && new Date(e.ts).getTime() < sinceMs) continue;
      if (events && !events.has(e.event)) continue;
      out.push(e);
    } catch {
      // Skip malformed lines rather than failing entirely
    }
  }
  out.reverse();
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Parse a "since" string like "7d", "24h", "30m". Returns Date or null. */
export function parseSince(s: string): Date | null {
  const m = /^(\d+)([dhm])$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  const ms = unit === 'd' ? n * 86_400_000 : unit === 'h' ? n * 3_600_000 : n * 60_000;
  return new Date(Date.now() - ms);
}
