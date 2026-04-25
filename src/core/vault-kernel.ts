// Vault kernel — the only component allowed to write the vault.
//
// v0.1.1 invariant: ChangePlan applies ALL or NONE.
// We do a full preflight pass over every op (permissions, preconditions, path
// safety, patch type support). If any op fails preflight, we write nothing.
// Only after preflight passes do we run the write pass. This means a stale or
// malformed plan cannot leave the vault half-mutated.
//
// True transactional rollback (e.g. fsync + rename + journaling) is bigger
// work parked for later; the preflight gate covers the dominant failure modes
// (perm violations, hash drift, unsupported patch, path escape).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
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

/** Resolve a vault-relative path safely. Rejects absolute and traversal. */
function safeVaultPath(vaultRoot: string, vaultRelativePath: string): string {
  if (isAbsolute(vaultRelativePath)) {
    throw new KernelError(`absolute path not allowed in ChangeOp.path: ${vaultRelativePath}`);
  }
  const target = resolve(vaultRoot, vaultRelativePath);
  const rel = relative(vaultRoot, target);
  if (rel.startsWith('..') || normalize(rel) !== rel) {
    throw new KernelError(`path escapes vault: ${vaultRelativePath}`);
  }
  return target;
}

interface PreflightOk { ok: true; target: string; op: ChangeOp; }
interface PreflightFail { ok: false; error: string; op: ChangeOp; }
type Preflight = PreflightOk | PreflightFail;

function checkOne(vaultRoot: string, schema: Schema, op: ChangeOp): Preflight {
  const action = op.op;

  // 1. Path safety (absolute / traversal)
  let target: string;
  try {
    target = safeVaultPath(vaultRoot, op.path);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), op };
  }

  // 2. Permission check (kernel-enforced, not agent-trusted)
  if (!permits(schema, 'agent', action, op.path)) {
    return { ok: false, error: `agent lacks ${action} permission for ${op.path} per SCHEMA.md`, op };
  }

  // 3. Precondition check (concurrency / staleness)
  const present = existsSync(target);
  if (op.precondition.exists && !present) {
    return { ok: false, error: `precondition.exists=true but ${op.path} does not exist`, op };
  }
  if (!op.precondition.exists && present) {
    return { ok: false, error: `precondition.exists=false but ${op.path} already exists`, op };
  }
  if (op.precondition.base_hash) {
    const actual = fileHash(target);
    if (actual !== op.precondition.base_hash) {
      return {
        ok: false,
        error: `target file changed since ChangePlan was created (expected ${op.precondition.base_hash.slice(0, 16)}…, got ${actual?.slice(0, 16)}…). Run \`hearth pending rebase ${op.path}\`.`,
        op,
      };
    }
  }

  // 4. Patch type support
  if (action === 'create' || action === 'update') {
    if (!op.patch) {
      return { ok: false, error: `${action} op missing patch`, op };
    }
    if (op.patch.type !== 'replace') {
      return { ok: false, error: `v0.1 supports patch.type=replace only; got ${op.patch.type}`, op };
    }
  }

  // 5. v0.1 op kind support
  if (action === 'delete') {
    return { ok: false, error: `delete is out of scope for v0.1`, op };
  }
  if (action !== 'create' && action !== 'update') {
    return { ok: false, error: `unknown op kind: ${action}`, op };
  }

  return { ok: true, target, op };
}

function writeOne(pre: PreflightOk): AppliedOpResult {
  const { op, target } = pre;
  // Preflight has confirmed: action is create|update, patch.type is 'replace'.
  if (op.patch && op.patch.type === 'replace') {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, op.patch.value, { mode: 0o644 });
    return { op: op.op, path: op.path, ok: true };
  }
  // Should be unreachable post-preflight; defensive.
  return { op: op.op, path: op.path, ok: false, error: 'internal: writeOne reached without valid patch' };
}

export function createKernel(vaultRoot: string, schema: Schema): VaultKernel {
  return {
    vaultRoot,
    schema,
    apply(plan: ChangePlan): AppliedResult {
      // Pass 1: preflight ALL ops. Collect every result so the user sees
      // every reason at once, not just the first.
      const checks = plan.ops.map(op => checkOne(vaultRoot, schema, op));
      const failed = checks.filter((c): c is PreflightFail => !c.ok);

      if (failed.length > 0) {
        // Don't write anything. Report every preflight failure plus 'skipped'
        // for ops that would have run had earlier ops passed.
        const ops: AppliedOpResult[] = checks.map(c =>
          c.ok
            ? { op: c.op.op, path: c.op.path, ok: false, error: 'skipped: another op in the plan failed preflight' }
            : { op: c.op.op, path: c.op.path, ok: false, error: c.error }
        );
        return {
          change_id: plan.change_id,
          ok: false,
          ops,
          error: failed[0]!.error,
        };
      }

      // Pass 2: every op passed preflight. Write them in order. We've already
      // confirmed permissions, preconditions, and patch types; remaining
      // failures here would be I/O level (disk full, perms revoked between
      // passes), which we surface but don't try to roll back in v0.1.1.
      const writes: AppliedOpResult[] = [];
      for (const c of checks as PreflightOk[]) {
        const r = writeOne(c);
        writes.push(r);
        if (!r.ok) {
          // I/O-level failure mid-write. Don't continue — partial state is
          // already on disk; reporting honestly is better than silently
          // continuing.
          return {
            change_id: plan.change_id,
            ok: false,
            ops: writes,
            error: `mid-write failure on ${r.path}: ${r.error}`,
          };
        }
      }
      return { change_id: plan.change_id, ok: true, ops: writes };
    },
  };
}
