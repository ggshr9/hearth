// Hearth runtime API — the surface channel adapters import.
//
// v0.3.0 surface: ingestFromChannel() takes a normalized inbound message,
// materializes it under ~/.hearth/channel-inbox/<channel>/<message_id>.md,
// runs it through the existing AgentAdapter → validator → pending pipeline,
// and returns a small summary the channel can echo back.
//
// Important: this function never writes the vault. It only writes:
//   1. the channel-inbox source materialization (under hearth's state dir)
//   2. the pending ChangePlan (under hearth's state dir)
// The actual vault apply still goes through `kernel.apply` / `pending apply`,
// which lives outside the channel surface.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sha256 } from './core/hash.ts';
import { loadSchema, SchemaError } from './core/schema.ts';
import { PendingStore } from './core/pending-store.ts';
import { validateChangePlan, PlanValidationError } from './core/plan-validator.ts';
import { renderPlanReview } from './core/plan-review.ts';
import { MockAgentAdapter } from './ingest/mock-adapter.ts';
import { ClaudeAgentAdapter } from './ingest/claude-adapter.ts';
import { createKernel } from './core/vault-kernel.ts';
import { audit } from './core/audit.ts';
import type { AgentAdapter } from './core/agent-adapter.ts';
import type { ChangePlan } from './core/types.ts';

export interface InboundMsg {
  /** Channel identifier — "wechat", "telegram", "discord", "cli", ... */
  channel: string;
  /** Stable message id from the source channel; used as filename key. */
  message_id: string;
  /** Sender id from the channel (chat_id / user_id / handle). */
  from: string;
  /** Inbound text (may be empty if the message is purely a URL or attachment). */
  text?: string;
  /** Inbound URL — v0.3.0 stores it as text; no fetch. */
  url?: string;
  /** ISO 8601 receive time at the channel adapter. */
  received_at: string;
}

export interface ChannelIngestOptions {
  vaultRoot: string;
  agent?: 'mock' | 'claude';
  /** Override hearth state dir for testing. Default: ~/.hearth */
  hearthStateDir?: string;
  /** Inject an adapter directly (bypasses agent name). For tests. */
  adapterOverride?: AgentAdapter;
  /** Inject a pending store (test isolation). Default: <stateDir>/pending */
  pendingStoreOverride?: PendingStore;
}

export interface ChannelIngestResult {
  ok: boolean;
  /** Set when ok=true. */
  change_id?: string;
  pending_path?: string;
  risk?: 'low' | 'medium' | 'high';
  op_count?: number;
  requires_review?: boolean;
  /** Materialized source file under <hearthStateDir>/channel-inbox/<channel>/. */
  source_path?: string;
  /** Human-readable line the channel can send back. */
  summary: string;
  /** Set when ok=false. */
  error?: string;
}

function defaultStateDir(): string {
  return join(homedir(), '.hearth');
}

function safeFilename(s: string): string {
  // Strip path separators and control chars, preserve unicode.
  return s.replace(/[\x00\/\\]/g, '_').slice(0, 120);
}

/**
 * Materialize an inbound message into a hearth source .md file under the
 * channel-inbox. Channel adapters never write to the vault directly; they
 * stage source content here, and the kernel pipeline takes it from there.
 */
function materializeInbound(msg: InboundMsg, channelInboxDir: string): { path: string; content: string } {
  const dir = join(channelInboxDir, safeFilename(msg.channel));
  mkdirSync(dir, { recursive: true });
  const filename = safeFilename(msg.message_id) + '.md';
  const path = join(dir, filename);

  const lines: string[] = [
    '---',
    `channel: ${JSON.stringify(msg.channel)}`,
    `message_id: ${JSON.stringify(msg.message_id)}`,
    `from: ${JSON.stringify(msg.from)}`,
    `received_at: ${JSON.stringify(msg.received_at)}`,
  ];
  if (msg.url) lines.push(`url: ${JSON.stringify(msg.url)}`);
  lines.push('---', '');

  if (msg.text) lines.push(msg.text);
  if (msg.url && !msg.text) {
    // v0.3.0 deliberately does NOT fetch URLs. We just record the URL as
    // the body so the agent can produce a "to-read" placeholder page.
    // URL extraction lives in v0.5.
    lines.push(`Shared URL (not fetched in v0.3): ${msg.url}`);
  }
  if (!msg.text && !msg.url) {
    lines.push('(empty inbound message)');
  }
  lines.push('');

  const content = lines.join('\n');
  writeFileSync(path, content, { mode: 0o600 });
  return { path, content };
}

/**
 * Channel-side entry point. Materializes the message, runs the agent
 * adapter, validates the plan, queues it. Never writes the vault directly.
 */
export async function ingestFromChannel(
  msg: InboundMsg,
  opts: ChannelIngestOptions,
): Promise<ChannelIngestResult> {
  const stateDir = opts.hearthStateDir ?? defaultStateDir();
  const channelInboxDir = join(stateDir, 'channel-inbox');

  // 1. Schema must exist; otherwise refuse before doing anything.
  let schema;
  try {
    schema = loadSchema(opts.vaultRoot);
  } catch (e) {
    if (e instanceof SchemaError) {
      return { ok: false, summary: 'vault has no SCHEMA.md — hearth refuses to compile', error: e.message };
    }
    throw e;
  }

  // 2. Materialize the inbound message under the channel-inbox.
  const { path: sourcePath, content } = materializeInbound(msg, channelInboxDir);
  const sourceId = sha256(content);

  // 3. Pick the adapter.
  let adapter: AgentAdapter;
  if (opts.adapterOverride) {
    adapter = opts.adapterOverride;
  } else {
    const agentName = opts.agent ?? 'mock';
    try {
      adapter = agentName === 'claude' ? new ClaudeAgentAdapter() : new MockAgentAdapter();
    } catch (e) {
      return { ok: false, summary: `adapter init failed: ${(e as Error).message}`, error: (e as Error).message, source_path: sourcePath };
    }
  }

  // 4. Plan.
  let plan: ChangePlan;
  try {
    plan = await adapter.planIngest(
      { sourcePath, vaultRelativeRaw: `raw/inbox-${msg.channel}-${safeFilename(msg.message_id)}.md`, content, sourceId },
      { vaultRoot: opts.vaultRoot, schema, existingPages: [] },
    );
  } catch (e) {
    return { ok: false, summary: `agent failed: ${(e as Error).message}`, error: (e as Error).message, source_path: sourcePath };
  }

  // 5. Validator. Bad plans never reach the pending queue.
  try {
    plan = validateChangePlan(plan, { schema, vaultRoot: opts.vaultRoot });
  } catch (e) {
    if (e instanceof PlanValidationError) {
      return {
        ok: false,
        summary: `agent produced invalid ChangePlan (${e.issues.length} issue${e.issues.length === 1 ? '' : 's'}); refused`,
        error: e.message + '\n  - ' + e.issues.join('\n  - '),
        source_path: sourcePath,
      };
    }
    throw e;
  }

  // Pin source_id to the materialized source's hash.
  plan.source_id = sourceId;
  plan.source_path = sourcePath;

  // 6. Save to pending. Vault stays untouched.
  const store = opts.pendingStoreOverride ?? new PendingStore(join(stateDir, 'pending'));
  const savedPath = store.save(plan);

  const summary = `pending ChangePlan ${plan.change_id} · risk=${plan.risk} · ${plan.ops.length} op${plan.ops.length === 1 ? '' : 's'} · review=${plan.requires_review} · apply via: hearth pending apply ${plan.change_id}`;
  return {
    ok: true,
    change_id: plan.change_id,
    pending_path: savedPath,
    risk: plan.risk,
    op_count: plan.ops.length,
    requires_review: plan.requires_review,
    source_path: sourcePath,
    summary,
  };
}

// ── v0.3.1 channel-side review surface ────────────────────────────────────
//
// Channel adapters (wechat-cc, telegram-cc, ...) need to surface the pending
// queue, render a single ChangePlan, and apply it. Owner authentication is
// the channel adapter's responsibility (e.g. wechat-cc allowlist); hearth
// here trusts its caller. Direct apply is a "human-direct" path per SPEC §11
// — no token needed, the channel ownership IS the authentication.
//
// All three return chat-friendly strings already; the channel just forwards
// them. Errors come back as { ok: false, summary } so the channel can echo
// the same way it echoes successes.

export interface PendingListOptions {
  hearthStateDir?: string;
  /** Cap displayed entries; oldest dropped. Default 10. */
  limit?: number;
}

export interface PendingListItem {
  change_id: string;
  risk: 'low' | 'medium' | 'high';
  op_count: number;
  created_at: string;
  requires_review: boolean;
  /** First op's target path — gives the user a "going to X" anchor. */
  primary_path: string;
  /** Short human-readable preview of what the plan is about. */
  preview: string;
}

export interface PendingListResult {
  items: PendingListItem[];
  /** Pre-rendered, ready to send back through the channel. */
  rendered: string;
}

/** Best-effort one-liner: try the agent's note, then first op's body
 *  preview first non-frontmatter line, then first op's reason. Trim hard. */
function summarizePlan(plan: ChangePlan): string {
  const stripBody = (s: string): string => {
    const lines = s.split('\n');
    let i = 0;
    if (lines[0]?.trim() === '---') {
      i = 1;
      while (i < lines.length && lines[i]?.trim() !== '---') i++;
      i++; // skip closing fence
    }
    while (i < lines.length && (lines[i]?.trim() === '' || lines[i]?.trim().startsWith('#'))) i++;
    return (lines[i] ?? '').trim();
  };

  const op0 = plan.ops[0];
  const candidates: string[] = [];
  // body_preview reflects the actual source content the user submitted —
  // most informative for "what is this plan about". note (agent's free
  // commentary) and reason fall back behind it.
  if (op0?.body_preview) candidates.push(stripBody(op0.body_preview));
  if (plan.note) candidates.push(plan.note);
  if (op0?.reason) candidates.push(op0.reason);
  for (const c of candidates) {
    const t = c.replace(/\s+/g, ' ').trim();
    if (t.length > 0) return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }
  return '(no preview)';
}

export function listPending(opts: PendingListOptions = {}): PendingListResult {
  const stateDir = opts.hearthStateDir ?? defaultStateDir();
  const store = new PendingStore(join(stateDir, 'pending'));
  const plans = store.list();
  const limit = opts.limit ?? 10;
  const shown = plans.slice(-limit).reverse();
  const items: PendingListItem[] = shown.map(p => ({
    change_id: p.change_id,
    risk: p.risk,
    op_count: p.ops.length,
    created_at: p.created_at,
    requires_review: p.requires_review,
    primary_path: p.ops[0]?.path ?? '(no ops)',
    preview: summarizePlan(p),
  }));

  if (plans.length === 0) {
    return { items, rendered: '(no pending plans)' };
  }
  const lines = [`📋 pending (${plans.length}${plans.length > limit ? `, latest ${limit}` : ''})`, ''];
  for (const it of items) {
    const review = it.requires_review ? '👁' : ' ';
    lines.push(`${review} ${it.change_id}  ${it.risk}  ${it.op_count}op  ${it.created_at.slice(11, 16)}`);
    lines.push(`  → ${it.primary_path}`);
    lines.push(`  ${it.preview}`);
    lines.push('');
  }
  if (plans.length > limit) lines.push(`…${plans.length - limit} older not shown`);
  return { items, rendered: lines.join('\n').trimEnd() };
}

export interface PendingShowOptions {
  hearthStateDir?: string;
  /** Cap each op's body preview lines. Default 6. */
  previewLines?: number;
}

export interface PendingShowResult {
  ok: boolean;
  change_id?: string;
  /** Pre-rendered, ready to send back through the channel. */
  rendered: string;
  error?: string;
}

export function showPending(changeId: string, opts: PendingShowOptions = {}): PendingShowResult {
  const stateDir = opts.hearthStateDir ?? defaultStateDir();
  const store = new PendingStore(join(stateDir, 'pending'));
  let plan: ChangePlan;
  try {
    plan = store.load(changeId);
  } catch (e) {
    return { ok: false, rendered: `❌ pending plan not found: ${changeId}`, error: (e as Error).message };
  }
  const previewN = opts.previewLines ?? 6;
  const lines: string[] = [
    `🔥 ${plan.change_id}`,
    `risk: ${plan.risk}    review: ${plan.requires_review}    ops: ${plan.ops.length}`,
    `created: ${plan.created_at}`,
  ];
  if (plan.note) lines.push(`note: ${plan.note}`);
  lines.push('');
  for (const op of plan.ops) {
    lines.push(`[${op.op}] ${op.path}`);
    lines.push(`  reason: ${op.reason}`);
    if (op.body_preview) {
      const preview = op.body_preview.split('\n').slice(0, previewN).join('\n  ');
      lines.push('  preview:', '  ' + preview);
    }
  }
  return { ok: true, change_id: plan.change_id, rendered: lines.join('\n') };
}

// ── markdown rendering for share-page surfaces ─────────────────────────
//
// Channel adapters (wechat-cc share_page, telegram inline html, future
// Local Console) want a self-contained markdown document. We delegate to
// the canonical renderPlanReview layer so all surfaces (CLI / HTTP /
// channel) render from the same place.

export interface RenderPlanOptions {
  hearthStateDir?: string;
  /** How many body-preview lines to include per op. Default: see DEFAULT_OP_BODY_LINES in core/plan-review.ts. */
  maxOpBodyLines?: number;
  /** Suffix line at the bottom (e.g. "Reply `/hearth apply <id>` to commit."). */
  applyHint?: string;
}

export interface RenderPlanResult {
  ok: boolean;
  change_id?: string;
  /** Title suitable for share-page — short. */
  title?: string;
  /** Full markdown body. */
  markdown: string;
  error?: string;
}

export function renderPlanMarkdown(changeId: string, opts: RenderPlanOptions = {}): RenderPlanResult {
  const stateDir = opts.hearthStateDir ?? defaultStateDir();
  const store = new PendingStore(join(stateDir, 'pending'));
  let plan: ChangePlan;
  try { plan = store.load(changeId); }
  catch (e) {
    return { ok: false, markdown: `# Plan not found\n\n\`${changeId}\` is no longer pending.`, error: (e as Error).message };
  }
  const out = renderPlanReview(plan, { format: 'markdown', maxOpBodyLines: opts.maxOpBodyLines });
  // TypeScript cannot narrow the union through the function boundary;
  // this guard turns out.text from string|undefined into string without
  // a non-null assertion. The throw path is structurally unreachable.
  if (out.format !== 'markdown') throw new Error('renderPlanReview did not return markdown');
  let markdown = out.text;
  // Footer is always appended (separator + apply-hint line) — keeps the
  // original renderPlanMarkdown contract that channel publishers like
  // wechat-cc expect. Callers wanting a footer-free document can pass
  // applyHint: '' (empty string still triggers the separator) — that
  // edge case is acknowledged but not currently exercised.
  markdown += '\n\n---\n\n';
  if (opts.applyHint) {
    markdown += opts.applyHint;
  } else {
    markdown += `To commit, reply: \`/hearth apply ${plan.change_id}\``;
  }
  return {
    ok: true,
    change_id: plan.change_id,
    title: `Hearth · ${plan.ops.length}-op ChangePlan (${plan.risk})`,
    markdown,
  };
}

export interface ApplyForOwnerOptions {
  vaultRoot: string;
  hearthStateDir?: string;
  /** Identity string for audit log (e.g. wechat user_id). */
  ownerId: string;
  /** Channel name for audit log (e.g. "wechat"). */
  channel: string;
}

export interface ApplyForOwnerResult {
  ok: boolean;
  change_id: string;
  /** Pre-rendered, ready to send back through the channel. */
  rendered: string;
  ops_applied?: number;
  error?: string;
}

export async function applyForOwner(
  changeId: string,
  opts: ApplyForOwnerOptions,
): Promise<ApplyForOwnerResult> {
  const stateDir = opts.hearthStateDir ?? defaultStateDir();
  const store = new PendingStore(join(stateDir, 'pending'));

  let schema;
  try { schema = loadSchema(opts.vaultRoot); }
  catch (e) {
    if (e instanceof SchemaError) {
      return { ok: false, change_id: changeId, rendered: `❌ vault has no SCHEMA.md`, error: e.message };
    }
    throw e;
  }

  let plan: ChangePlan;
  try { plan = store.load(changeId); }
  catch (e) {
    return { ok: false, change_id: changeId, rendered: `❌ pending plan not found: ${changeId}`, error: (e as Error).message };
  }

  const kernel = createKernel(opts.vaultRoot, schema);
  const result = kernel.apply(plan);

  if (result.ok) {
    store.remove(changeId);
    void audit(opts.vaultRoot, {
      event: 'changeplan.applied',
      initiated_by: `channel:${opts.channel}`,
      data: { change_id: changeId, ops: result.ops.length, owner_id: opts.ownerId },
    });
    const lines = [
      `✅ applied ${changeId}`,
      `${result.ops.length} op${result.ops.length === 1 ? '' : 's'} written`,
    ];
    for (const r of result.ops) lines.push(`  ${r.ok ? '✓' : '✗'} ${r.op} ${r.path}`);
    return { ok: true, change_id: changeId, ops_applied: result.ops.length, rendered: lines.join('\n') };
  }

  void audit(opts.vaultRoot, {
    event: 'changeplan.rejected',
    initiated_by: `channel:${opts.channel}`,
    data: { change_id: changeId, error: result.error, owner_id: opts.ownerId },
  });
  const lines = [`❌ apply failed: ${changeId}`, result.error ?? '(unknown error)'];
  for (const r of result.ops) {
    if (!r.ok) lines.push(`  ✗ ${r.op} ${r.path} — ${r.error ?? ''}`);
  }
  return { ok: false, change_id: changeId, rendered: lines.join('\n'), error: result.error };
}
