// SCHEMA.md parser — minimal v0.1.
//
// Reads the permission table out of the user's SCHEMA.md. Supports a small
// markdown-table format:
//
//   | dir          | human | agent |
//   |--------------|-------|-------|
//   | raw/         | add   | add   |
//   | 00 Inbox/    | rw    | none  |
//   | 01 Topics/   | r     | rw    |
//
// Permission values:
//   none — no access at all
//   r    — read only
//   add  — may add files (create), may not modify or delete existing
//   rw   — full read/write/create/update; delete still requires explicit ops
//
// SCHEMA.md is required. No SCHEMA, no compile.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Permission = 'none' | 'r' | 'add' | 'rw';
export type Actor = 'human' | 'agent';

export interface SchemaRule {
  /** Directory path (with trailing slash), relative to vault root. */
  dir: string;
  human: Permission;
  agent: Permission;
}

export interface Schema {
  rules: SchemaRule[];
  /** Raw text, in case lint or other consumers need it. */
  raw: string;
  /** Path to the SCHEMA.md file. */
  path: string;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

const VALID: Permission[] = ['none', 'r', 'add', 'rw'];

function normalizePerm(token: string): Permission {
  const t = token.trim().toLowerCase();
  if ((VALID as string[]).includes(t)) return t as Permission;
  throw new SchemaError(`invalid permission token: "${token}" (expected one of ${VALID.join('|')})`);
}

function parseTable(raw: string): SchemaRule[] {
  // Find the first markdown table whose header contains dir/human/agent
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerCols: string[] = [];
  const rules: SchemaRule[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.includes('|')) {
      if (inTable) inTable = false;
      continue;
    }
    const cells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => !(c === '' && (idx === 0 || idx === arr.length - 1)));
    if (!inTable) {
      const lower = cells.map(c => c.toLowerCase());
      if (lower.includes('dir') && lower.includes('human') && lower.includes('agent')) {
        headerCols = lower;
        inTable = true;
        // Skip the separator line if present
        const next = lines[i + 1] ?? '';
        if (/^[\s|:-]+$/.test(next)) i++;
      }
      continue;
    }
    const dirIdx = headerCols.indexOf('dir');
    const humanIdx = headerCols.indexOf('human');
    const agentIdx = headerCols.indexOf('agent');
    if (cells.length < headerCols.length) continue;
    const dir = cells[dirIdx] ?? '';
    if (!dir || dir.startsWith('-')) continue;
    rules.push({
      dir: dir.endsWith('/') ? dir : dir + '/',
      human: normalizePerm(cells[humanIdx] ?? 'none'),
      agent: normalizePerm(cells[agentIdx] ?? 'none'),
    });
  }
  return rules;
}

export function loadSchema(vaultRoot: string): Schema {
  const path = join(vaultRoot, 'SCHEMA.md');
  if (!existsSync(path)) {
    throw new SchemaError(`SCHEMA.md not found at ${path}. hearth refuses to compile without an explicit schema. Run \`hearth init <vault> --template default\` to bootstrap one.`);
  }
  const raw = readFileSync(path, 'utf8');
  const rules = parseTable(raw);
  if (rules.length === 0) {
    throw new SchemaError(`SCHEMA.md at ${path} contains no parseable permission table (expected | dir | human | agent | header).`);
  }
  return { rules, raw, path };
}

/** Find the rule that governs a given vault-relative path. Most-specific match wins. */
export function ruleFor(schema: Schema, vaultRelativePath: string): SchemaRule | null {
  const norm = vaultRelativePath.replace(/^\/+/, '');
  let best: SchemaRule | null = null;
  for (const r of schema.rules) {
    if (norm.startsWith(r.dir.replace(/^\/+/, ''))) {
      if (!best || r.dir.length > best.dir.length) best = r;
    }
  }
  return best;
}

/** Check whether actor may perform action on path under schema. */
export function permits(
  schema: Schema,
  actor: Actor,
  action: 'create' | 'update' | 'delete' | 'read',
  vaultRelativePath: string,
): boolean {
  const rule = ruleFor(schema, vaultRelativePath);
  if (!rule) return false;
  const perm = rule[actor];
  if (perm === 'none') return false;
  if (action === 'read') return perm !== 'none';
  if (action === 'create') return perm === 'add' || perm === 'rw';
  if (action === 'update') return perm === 'rw';
  if (action === 'delete') return perm === 'rw';
  return false;
}
