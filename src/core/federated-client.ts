// Federated MCP client — Phase 2a (HF2).
//
// A minimal MCP client that lets hearth's query() reach out to a registered
// FederatedSource (see source-registry.ts) and fold its answer into the
// local hit list. This is the untrusted seam of federation: only the
// source's returned answer text crosses back into hearth. Hearth sends the
// source nothing but the question string — no vault content, no other
// context.
//
// Fail-open by contract: a federated source is someone else's process,
// reachable over stdio, with no guarantee it is fast, well-behaved, or even
// running. ANY failure — connect error, rejected call, malformed/unexpected
// response shape, or a call (or even connect/handshake) that simply never
// returns — must degrade to [] rather than throwing or hanging. A slow or
// broken federated source must never break (or even delay past
// `timeoutMs`) hearth's own query.
//
// Important: `buildClient()` is synchronous and returns a handle BEFORE the
// MCP `connect()`/handshake is awaited. StdioClientTransport spawns the
// child process as part of connect/start, so the handle (and its `close`)
// must exist in the outer scope before we ever await anything that might
// hang — otherwise a source that spawns but never answers `initialize`
// would win the timeout race while leaving its child process orphaned,
// which is exactly the failure mode this module exists to prevent.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FederatedSource } from './source-registry.ts';
import type { QueryHit } from './query.ts';

const DEFAULT_TIMEOUT_MS = 5000;

/** Minimal shape the rest of this module needs from an MCP client — real or
 *  faked in tests. Built synchronously (`buildClient`); `connect()` does the
 *  actual handshake and may hang or fail. `call` returns the tool's text
 *  response already joined from its content parts. `close()` must be safe
 *  to call even if `connect()` never completed (it should still tear down
 *  whatever was started, e.g. SIGTERM the child process). */
export interface MinimalMcpClient {
  connect(): Promise<void>;
  call(tool: string, args: unknown): Promise<string>;
  close(): Promise<void>;
}

interface RawFederatedHit {
  claim_text: string;
  source?: string;
  anchor_summary?: string;
  confidence?: 'high' | 'medium' | 'low';
  match_score?: number;
}

interface RawFederatedResponse {
  hits: RawFederatedHit[];
}

function isRawFederatedResponse(value: unknown): value is RawFederatedResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.hits)) return false;
  return v.hits.every(
    h => typeof h === 'object' && h !== null && typeof (h as Record<string, unknown>).claim_text === 'string',
  );
}

/**
 * Synchronously constructs the transport + client and returns a handle.
 * Nothing here awaits: `new StdioClientTransport(...)` and `new Client(...)`
 * are both synchronous constructors. The child process is spawned later,
 * inside `connect()` — but the returned handle's `close()` is valid to call
 * regardless of whether `connect()` was ever awaited to completion, so a
 * caller can always tear this down even if `connect()` hangs.
 */
function defaultBuildClient(source: FederatedSource): MinimalMcpClient {
  const transport = new StdioClientTransport({
    command: source.transport.command,
    args: source.transport.args,
    env: source.transport.env,
  });
  const client = new Client({ name: 'hearth-federate', version: '0.1' }, { capabilities: {} });

  return {
    connect: () => client.connect(transport),
    call: async (tool: string, args: unknown) => {
      const result = await client.callTool({ name: tool, arguments: args as Record<string, unknown> | undefined });
      const content = result.content;
      if (!Array.isArray(content)) return '';
      return content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join('');
    },
    close: () => client.close(),
  };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`federated query timed out after ${ms}ms`)), ms);
  });
}

/**
 * Query a single federated source and map its response into hearth's own
 * QueryHit shape. Never throws — any failure (build, connect, call,
 * timeout, malformed response) resolves to []. Always attempts to close the
 * handle, best-effort, swallowing any close error — including when the
 * timeout wins because `connect()` itself hung, so a wedged source can
 * never orphan its own child process.
 */
export async function queryFederatedSource(
  source: FederatedSource,
  question: string,
  opts?: {
    timeoutMs?: number;
    buildClient?: (s: FederatedSource) => MinimalMcpClient;
  },
): Promise<QueryHit[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const buildClient = opts?.buildClient ?? defaultBuildClient;

  let handle: MinimalMcpClient | undefined;
  try {
    // buildClient() is synchronous — the handle (and its close()) exists
    // before we await anything, so `finally` can always tear it down even
    // if connect() itself hangs past the timeout.
    handle = buildClient(source);
    const hits = await Promise.race([
      (async () => {
        await handle!.connect();
        const text = await handle!.call(source.query_tool, { question });
        const parsed: unknown = JSON.parse(text);
        if (!isRawFederatedResponse(parsed)) return [];
        return parsed.hits.map(
          (raw): QueryHit => ({
            page: '',
            claim_text: raw.claim_text,
            source: raw.source ?? source.id,
            anchor_summary: raw.anchor_summary ?? '',
            confidence: raw.confidence ?? 'low',
            match_score: typeof raw.match_score === 'number' ? raw.match_score : 0,
            origin: 'federated',
            verified_by: source.id,
          }),
        );
      })(),
      timeout(timeoutMs),
    ]);
    return hits;
  } catch (err) {
    console.warn(`[hearth] federated-client: query to source "${source.id}" failed:`, err);
    return [];
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // best-effort close; never let a close error propagate
      }
    }
  }
}
