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
  // Strip markdown emphasis, parenthetical commentary, whitespace.
  const stripped = token
    .replace(/\([^)]*\)/g, '')              // ASCII parens
    .replace(/（[^）]*）/g, '')                 // CJK parens
    .replace(/\*+/g, '')                      // markdown bold/italic markers
    .trim()
    .toLowerCase();

  if ((VALID as string[]).includes(stripped)) return stripped as Permission;

  // Chinese tokens (and English aliases): order matters — match compounds first
  if (/读写|read[\s-]*write|rw/i.test(stripped)) return 'rw';
  if (/(读|read).*(添加|add)|(添加|add).*(读|read)/i.test(stripped)) return 'add';
  if (/^只读$|read[\s-]*only|^r$/i.test(stripped)) return 'r';
  if (/^添加$|^add$/i.test(stripped)) return 'add';
  if (/^读$|^r$|read/i.test(stripped)) return 'r';
  if (/^无$|none|no\s*access/i.test(stripped)) return 'none';

  throw new SchemaError(`invalid permission token: "${token}" (expected ${VALID.join('|')} or Chinese 无/只读/读/添加/读+添加/读写)`);
}

const HEADER_DIR_KEYS = new Set(['dir', '区域', 'directory', 'path', '路径']);
const HEADER_HUMAN_KEYS = new Set(['human', '人', 'user']);
const HEADER_AGENT_KEYS = new Set(['agent', 'ai', 'llm', 'bot']);

function isDirHeader(s: string): boolean { return HEADER_DIR_KEYS.has(s); }
function isHumanHeader(s: string): boolean { return HEADER_HUMAN_KEYS.has(s); }
function isAgentHeader(s: string): boolean { return HEADER_AGENT_KEYS.has(s); }

function parseTable(raw: string): SchemaRule[] {
  // Prefer the canonical `## hearth permissions` section if present —
  // user's broader SCHEMA.md may have a more elaborate human-readable
  // table (Chinese descriptions, range rows, etc.) that we don't try to
  // interpret. The canonical section is the machine-readable contract.
  const canonicalMatch = raw.match(/##\s+hearth\s+permissions[\s\S]*?(?=\n##\s|$)/i);
  const scope = canonicalMatch ? canonicalMatch[0] : raw;

  const lines = scope.split(/\r?\n/);
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
      const lower = cells.map(c => c.toLowerCase().replace(/[`*]/g, '').trim());
      if (lower.some(isDirHeader) && lower.some(isHumanHeader) && lower.some(isAgentHeader)) {
        headerCols = lower;
        inTable = true;
        const next = lines[i + 1] ?? '';
        if (/^[\s|:-]+$/.test(next)) i++;
      }
      continue;
    }
    const dirIdx = headerCols.findIndex(isDirHeader);
    const humanIdx = headerCols.findIndex(isHumanHeader);
    const agentIdx = headerCols.findIndex(isAgentHeader);
    if (cells.length < Math.max(dirIdx, humanIdx, agentIdx) + 1) continue;
    let dir = cells[dirIdx] ?? '';
    // Clean common decorations: backticks, leading/trailing whitespace
    dir = dir.replace(/[`]/g, '').trim();
    if (!dir || dir.startsWith('-')) continue;
    let human: Permission, agent: Permission;
    try {
      human = normalizePerm(cells[humanIdx] ?? 'none');
      agent = normalizePerm(cells[agentIdx] ?? 'none');
    } catch {
      // Skip rows we can't parse rather than failing the whole load —
      // user's SCHEMA may contain commentary rows the parser doesn't
      // need to understand.
      continue;
    }
    rules.push({
      dir: dir.endsWith('/') ? dir : dir + '/',
      human,
      agent,
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
