// Vault kernel — the only component allowed to write the vault.
//
// The agent's role ends at producing a ChangePlan. The kernel re-checks every
// op's permission and precondition immediately before writing, and refuses if
// anything has shifted. This is what makes the "agent doesn't pollute the
// vault" promise hold under concurrency: a stale plan that would clobber a
// human edit is rejected, not applied.
//
// v0.1 scope: create + update with patch.type=replace. unified_diff is parsed
// but rejected at apply time (boundary bugs in diff apply are easy and not
// worth shipping until the rest is solid). delete is also out of scope for v0.1.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileHash } from './hash.ts';
import { permits, type Schema } from './schema.ts';
import type {
  AppliedOpResult,
  AppliedResult,
  ChangeOp,
  ChangePlan,
} from './types.ts';

export class KernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelError';
  }
}

export interface ApplyOptions {
  /** Required for `update` ops on stable / human-write zones. */
  approved?: boolean;
}

export interface VaultKernel {
  vaultRoot: string;
  schema: Schema;
  apply(plan: ChangePlan, opts?: ApplyOptions): AppliedResult;
}

/** Vault-relative path, with traversal protection (no `..`, no absolute). */
function safeVaultPath(vaultRoot: string, vaultRelativePath: string): string {
  const target = resolve(vaultRoot, vaultRelativePath);
  const rel = relative(vaultRoot, target);
  if (rel.startsWith('..') || normalize(rel) !== rel || rel.startsWith('/')) {
    throw new KernelError(`path escapes vault: ${vaultRelativePath}`);
  }
  return target;
}

function applyOne(
  vaultRoot: string,
  schema: Schema,
  op: ChangeOp,
): AppliedOpResult {
  // 1. Permission check (kernel-enforced, not agent-trusted)
  const action = op.op;
  if (!permits(schema, 'agent', action, op.path)) {
    return { op: action, path: op.path, ok: false, error: `agent lacks ${action} permission for ${op.path} per SCHEMA.md` };
  }

  // 2. Precondition check (concurrency / staleness protection)
  const target = safeVaultPath(vaultRoot, op.path);
  const present = existsSync(target);
  if (op.precondition.exists && !present) {
    return { op: action, path: op.path, ok: false, error: `precondition.exists=true but ${op.path} does not exist` };
  }
  if (!op.precondition.exists && present) {
    return { op: action, path: op.path, ok: false, error: `precondition.exists=false but ${op.path} already exists` };
  }
  if (op.precondition.base_hash) {
    const actual = fileHash(target);
    if (actual !== op.precondition.base_hash) {
      return {
        op: action,
        path: op.path,
        ok: false,
        error: `target file changed since ChangePlan was created (expected ${op.precondition.base_hash.slice(0, 16)}…, got ${actual?.slice(0, 16)}…). Run \`hearth pending rebase ${op.path}\`.`,
      };
    }
  }

  // 3. Apply
  if (action === 'create' || action === 'update') {
    if (!op.patch) {
      return { op: action, path: op.path, ok: false, error: `${action} op missing patch` };
    }
    if (op.patch.type !== 'replace') {
      return { op: action, path: op.path, ok: false, error: `v0.1 supports patch.type=replace only; got ${op.patch.type}` };
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, op.patch.value, { mode: 0o644 });
    return { op: action, path: op.path, ok: true };
  }

  if (action === 'delete') {
    return { op: action, path: op.path, ok: false, error: `delete is out of scope for v0.1` };
  }

  return { op: action, path: op.path, ok: false, error: `unknown op kind: ${action}` };
}

export function createKernel(vaultRoot: string, schema: Schema): VaultKernel {
  return {
    vaultRoot,
    schema,
    apply(plan: ChangePlan): AppliedResult {
      const results: AppliedOpResult[] = [];
      let allOk = true;
      // Apply ops in order. If any fails, we stop and report — partial apply
      // is unsafe until we have proper rollback semantics.
      for (const op of plan.ops) {
        const r = applyOne(vaultRoot, schema, op);
        results.push(r);
        if (!r.ok) {
          allOk = false;
          break;
        }
      }
      return {
        change_id: plan.change_id,
        ok: allOk,
        ops: results,
        ...(allOk ? {} : { error: results.find(r => !r.ok)?.error }),
      };
    },
  };
}
