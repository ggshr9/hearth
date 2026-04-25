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
import { MockAgentAdapter } from './ingest/mock-adapter.ts';
import { ClaudeAgentAdapter } from './ingest/claude-adapter.ts';
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
