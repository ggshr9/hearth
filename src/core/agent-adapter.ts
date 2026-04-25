// AgentAdapter — the seam between hearth and any "thing that produces ChangePlans".
//
// Intentionally narrow. The adapter takes a source and the vault context,
// returns a ChangePlan. It does NOT touch the filesystem and does NOT bypass
// the kernel. Everything that happens after planIngest() goes through the
// existing preflight-then-write pipeline; agent's opinion is advisory, kernel
// is authoritative.
//
// v0.1.3 ships two implementations:
//   - MockAgentAdapter:   deterministic stub (default, used in tests)
//   - ClaudeAgentAdapter: calls Anthropic Claude with a strict JSON schema

import type { ChangePlan } from './types.ts';
import type { Schema } from './schema.ts';

export interface IngestInput {
  /** Absolute path on the user's filesystem to the source file. */
  sourcePath: string;
  /** Vault-relative path under raw/ where the original lands. */
  vaultRelativeRaw: string;
  /** Source content (utf-8). */
  content: string;
  /** sha256 of content; used as ChangePlan.source_id. */
  sourceId: string;
}

export interface VaultContext {
  vaultRoot: string;
  schema: Schema;
  /** Vault-relative paths of existing wiki pages, for the agent's awareness. */
  existingPages: string[];
}

export interface AgentAdapter {
  /** Stable name, surfaced in ChangePlan.note for traceability. */
  readonly name: string;
  planIngest(input: IngestInput, ctx: VaultContext): Promise<ChangePlan>;
}
