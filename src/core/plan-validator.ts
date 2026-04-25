// ChangePlan runtime validator.
//
// Defends against malformed agent output (Claude can drift from JSON schema,
// add extra fields, miss required ones, propose paths outside the SCHEMA).
// Runs BEFORE the plan enters the pending queue — so a misbehaving agent
// can't poison the queue, let alone the vault.

import type { ChangePlan, ChangeOp, Patch, Precondition } from './types.ts';
import { permits, type Schema } from './schema.ts';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

export class PlanValidationError extends Error {
  constructor(message: string, public readonly issues: string[] = []) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

const VALID_RISK = new Set(['low', 'medium', 'high']);
const VALID_OP = new Set(['create', 'update', 'delete']);
const VALID_PATCH_TYPE = new Set(['replace', 'unified_diff']);

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function checkPrecondition(p: unknown, issues: string[], opIdx: number): p is Precondition {
  if (!isObject(p)) { issues.push(`op[${opIdx}].precondition: not an object`); return false; }
  if (typeof p.exists !== 'boolean') { issues.push(`op[${opIdx}].precondition.exists: must be boolean`); return false; }
  if (p.base_hash !== undefined && !isString(p.base_hash)) {
    issues.push(`op[${opIdx}].precondition.base_hash: must be string`);
    return false;
  }
  if (p.exists && !p.base_hash) {
    issues.push(`op[${opIdx}].precondition: when exists=true, base_hash is required`);
    return false;
  }
  return true;
}

function checkPatch(p: unknown, issues: string[], opIdx: number): p is Patch {
  if (!isObject(p)) { issues.push(`op[${opIdx}].patch: not an object`); return false; }
  if (!isString(p.type) || !VALID_PATCH_TYPE.has(p.type)) {
    issues.push(`op[${opIdx}].patch.type: must be one of ${[...VALID_PATCH_TYPE].join('|')}, got ${String(p.type)}`);
    return false;
  }
  if (!isString(p.value)) { issues.push(`op[${opIdx}].patch.value: must be string`); return false; }
  return true;
}

function checkOp(o: unknown, issues: string[], idx: number, schema: Schema, vaultRoot: string): o is ChangeOp {
  if (!isObject(o)) { issues.push(`op[${idx}]: not an object`); return false; }
  if (!isString(o.op) || !VALID_OP.has(o.op)) { issues.push(`op[${idx}].op: must be one of ${[...VALID_OP].join('|')}`); return false; }
  if (!isString(o.path)) { issues.push(`op[${idx}].path: must be string`); return false; }
  if (!isString(o.reason)) { issues.push(`op[${idx}].reason: must be string`); return false; }
  if (!checkPrecondition(o.precondition, issues, idx)) return false;

  // Path safety mirrors what the kernel will check — we re-check here so we
  // can reject the plan before it enters the pending queue
  if (isAbsolute(o.path)) { issues.push(`op[${idx}].path: absolute path not allowed (${o.path})`); return false; }
  const target = resolve(vaultRoot, o.path);
  const rel = relative(vaultRoot, target);
  if (rel.startsWith('..') || normalize(rel) !== rel) {
    issues.push(`op[${idx}].path: escapes vault (${o.path})`);
    return false;
  }

  // SCHEMA permission check — agent must already have permission to do this
  if (!permits(schema, 'agent', o.op as 'create' | 'update' | 'delete', o.path)) {
    issues.push(`op[${idx}]: agent lacks ${o.op} permission for ${o.path} per SCHEMA.md`);
    return false;
  }

  if (o.op === 'create' || o.op === 'update') {
    if (!checkPatch(o.patch, issues, idx)) return false;
  }

  // v0.1 op-kind support
  if (o.op === 'delete') {
    issues.push(`op[${idx}]: delete is out of scope for v0.1`);
    return false;
  }

  return true;
}

/** Validate a parsed JSON object claims to be a ChangePlan. Throws on failure. */
export function validateChangePlan(raw: unknown, ctx: { schema: Schema; vaultRoot: string }): ChangePlan {
  const issues: string[] = [];
  if (!isObject(raw)) throw new PlanValidationError('not an object', ['root: not an object']);
  if (!isString(raw.change_id)) issues.push('change_id: missing or not a string');
  if (!isString(raw.source_id)) issues.push('source_id: missing or not a string');
  if (!isString(raw.risk) || !VALID_RISK.has(raw.risk)) issues.push(`risk: must be one of ${[...VALID_RISK].join('|')}`);
  if (typeof raw.requires_review !== 'boolean') issues.push('requires_review: must be boolean');
  if (!isString(raw.created_at)) issues.push('created_at: missing or not a string');
  if (!Array.isArray(raw.ops)) {
    issues.push('ops: must be an array');
    throw new PlanValidationError('plan failed validation', issues);
  }
  if (raw.ops.length === 0) issues.push('ops: must contain at least one op');
  raw.ops.forEach((o, i) => checkOp(o, issues, i, ctx.schema, ctx.vaultRoot));

  if (issues.length > 0) {
    throw new PlanValidationError(`plan failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`, issues);
  }
  return raw as ChangePlan;
}
