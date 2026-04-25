// hearth adopt — interactive (or scripted) installation into an existing vault.
//
// Two principles:
//   1. NEVER touch user files. Only:
//        - append a canonical "## hearth permissions" block to SCHEMA.md
//        - create the dedicated hearth-inbox directory
//   2. Default to conservative permissions: agent=r on all existing dirs;
//      agent=rw ONLY in the dedicated hearth-inbox. Trust escalates manually,
//      one dir at a time.
//
// This is the canonical entry point for users with existing vaults — NOT
// `hearth init` (greenfield) and NOT manual SCHEMA editing.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadSchema, SchemaError, type Permission, type SchemaRule } from '../core/schema.ts';

export interface AdoptScan {
  vaultRoot: string;
  schemaPath: string;
  schemaExists: boolean;
  /** Rules parsed from any existing table (canonical or human). [] if SCHEMA absent. */
  existingRules: SchemaRule[];
  /** True iff `## hearth permissions` section is already present. */
  hasCanonicalBlock: boolean;
  /** True iff a directory matching the hearth-inbox naming convention exists. */
  hasHearthInbox: boolean;
  /** Vault-relative path of the detected hearth-inbox dir, or the proposed default. */
  hearthInboxDir: string;
  /** Top-level directories in the vault. */
  topDirs: string[];
  /** Total .md files (excluding .obsidian/ etc). */
  mdFileCount: number;
}

export interface AdoptProposal {
  scan: AdoptScan;
  /** The canonical block we propose to append, or '' if already present. */
  blockToAppend: string;
  /** True iff we propose to mkdir the hearth-inbox dir. */
  willCreateHearthInbox: boolean;
}

const HEARTH_INBOX_NAME = '06 Hearth Inbox';

/** Walk only top-level dirs; skip .obsidian, node_modules, .git, etc. */
function listTopDirs(vaultRoot: string): string[] {
  const skip = new Set(['node_modules']);
  const out: string[] = [];
  for (const name of readdirSync(vaultRoot)) {
    // Skip all dotfile dirs (.git/.obsidian/.stfolder/.stversions/.DS_Store/.vscode/.trash/etc)
    if (name.startsWith('.')) continue;
    if (skip.has(name)) continue;
    const full = join(vaultRoot, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(name);
  }
  return out.sort();
}

function countMdFiles(vaultRoot: string): number {
  const skip = new Set(['.obsidian', '.git', 'node_modules', '.trash']);
  let n = 0;
  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skip.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.md')) n++;
    }
  }
  walk(vaultRoot);
  return n;
}

function looksLikeHearthInbox(name: string): boolean {
  return /hearth.*inbox|inbox.*hearth|hearth/i.test(name);
}

export function scanVault(vaultRoot: string): AdoptScan {
  const schemaPath = join(vaultRoot, 'SCHEMA.md');
  const schemaExists = existsSync(schemaPath);

  let existingRules: SchemaRule[] = [];
  let hasCanonicalBlock = false;
  if (schemaExists) {
    const raw = readFileSync(schemaPath, 'utf8');
    hasCanonicalBlock = /##\s+hearth\s+permissions/i.test(raw);
    try {
      existingRules = loadSchema(vaultRoot).rules;
    } catch (e) {
      if (!(e instanceof SchemaError)) throw e;
      // SCHEMA exists but has no parseable table — that's fine for adoption,
      // we'll add one.
    }
  }

  const topDirs = listTopDirs(vaultRoot);
  const detectedInbox = topDirs.find(looksLikeHearthInbox);
  const hearthInboxDir = detectedInbox ?? HEARTH_INBOX_NAME;
  const hasHearthInbox = !!detectedInbox && existsSync(join(vaultRoot, hearthInboxDir));

  return {
    vaultRoot,
    schemaPath,
    schemaExists,
    existingRules,
    hasCanonicalBlock,
    hasHearthInbox,
    hearthInboxDir,
    topDirs,
    mdFileCount: countMdFiles(vaultRoot),
  };
}

/**
 * Build a conservative permission block. Defaults:
 *   - agent gets at most 'r' on every existing dir we recognize
 *   - agent gets 'rw' ONLY on the dedicated hearth-inbox (which we'll create
 *     if missing)
 *   - raw/ stays add+add (Karpathy convention; both human and agent append)
 *   - 99 Assets/ stays human=rw, agent=add (assets are append-only by agent)
 *   - SCHEMA.md / README.md / index.md remain implicitly human-only
 */
function proposeBlock(scan: AdoptScan): string {
  const rules: { dir: string; human: Permission; agent: Permission }[] = [];

  // Hard defaults if those well-known dirs exist
  if (scan.topDirs.includes('raw') || scan.existingRules.some(r => r.dir === 'raw/')) {
    rules.push({ dir: 'raw/', human: 'add', agent: 'add' });
  }
  // For each top-level dir that ISN'T raw/ or hearth-inbox or 99 Assets/, default to agent=r
  const conservative = scan.topDirs.filter(d =>
    d !== 'raw' &&
    d !== HEARTH_INBOX_NAME &&
    d !== scan.hearthInboxDir &&
    d !== '99 Assets'
  );
  for (const d of conservative) {
    rules.push({ dir: d + '/', human: 'rw', agent: 'r' });
  }
  // 99 Assets/ if present
  if (scan.topDirs.includes('99 Assets')) {
    rules.push({ dir: '99 Assets/', human: 'rw', agent: 'add' });
  }
  // The dedicated hearth-inbox: agent=rw (only writable zone for the agent)
  rules.push({ dir: scan.hearthInboxDir + '/', human: 'rw', agent: 'rw' });

  const lines: string[] = [
    '',
    '## hearth permissions',
    '',
    "Machine-readable contract for [hearth](https://github.com/ggshr9/hearth). Generated by `hearth adopt`. Edit by hand to grant the agent broader access — the default is read-only on existing dirs, write-only inside the dedicated Hearth Inbox.",
    '',
    '| dir              | human | agent |',
    '|------------------|-------|-------|',
  ];
  for (const r of rules) {
    lines.push(`| ${r.dir.padEnd(16)} | ${r.human.padEnd(5)} | ${r.agent.padEnd(5)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function buildProposal(vaultRoot: string): AdoptProposal {
  const scan = scanVault(resolve(vaultRoot));
  return {
    scan,
    blockToAppend: scan.hasCanonicalBlock ? '' : proposeBlock(scan),
    willCreateHearthInbox: !scan.hasHearthInbox,
  };
}

export interface AdoptApplyResult {
  appendedToSchema: boolean;
  createdInbox: boolean;
  schemaPath: string;
  inboxPath?: string;
  /** Empty after a successful adopt — surfaces problems otherwise. */
  warnings: string[];
}

export function applyProposal(proposal: AdoptProposal): AdoptApplyResult {
  const warnings: string[] = [];
  const result: AdoptApplyResult = {
    appendedToSchema: false,
    createdInbox: false,
    schemaPath: proposal.scan.schemaPath,
    warnings,
  };

  if (!proposal.scan.schemaExists) {
    // Bootstrap a minimal SCHEMA.md if the user has none. This is a creation,
    // not a modification.
    writeFileSync(proposal.scan.schemaPath, '---\ntype: meta\n---\n\n# Vault SCHEMA\n', { mode: 0o644 });
  }

  if (proposal.blockToAppend) {
    const current = readFileSync(proposal.scan.schemaPath, 'utf8');
    const sep = current.endsWith('\n') ? '' : '\n';
    writeFileSync(proposal.scan.schemaPath, current + sep + proposal.blockToAppend, { mode: 0o644 });
    result.appendedToSchema = true;
  }

  if (proposal.willCreateHearthInbox) {
    const inboxPath = join(proposal.scan.vaultRoot, proposal.scan.hearthInboxDir);
    mkdirSync(inboxPath, { recursive: true });
    result.createdInbox = true;
    result.inboxPath = inboxPath;
  }

  // Verify the new schema parses
  try {
    const parsed = loadSchema(proposal.scan.vaultRoot);
    if (parsed.rules.length === 0) warnings.push('schema parsed with zero rules');
  } catch (e) {
    warnings.push(`schema failed to parse after adopt: ${(e as Error).message}`);
  }

  return result;
}

/** Render a human-friendly summary of what `hearth adopt --dry-run` would do. */
export function renderProposalSummary(proposal: AdoptProposal): string {
  const { scan } = proposal;
  const lines: string[] = [];
  lines.push(`vault: ${scan.vaultRoot}`);
  lines.push(`  SCHEMA.md: ${scan.schemaExists ? '✓ present' : '✗ absent (will create)'}`);
  lines.push(`  canonical "## hearth permissions" block: ${scan.hasCanonicalBlock ? '✓ already present' : '✗ will append'}`);
  lines.push(`  hearth-inbox dir: ${scan.hasHearthInbox ? `✓ "${scan.hearthInboxDir}/" present` : `✗ will create "${scan.hearthInboxDir}/"`}`);
  lines.push(`  top dirs (${scan.topDirs.length}): ${scan.topDirs.join(', ')}`);
  lines.push(`  markdown files: ${scan.mdFileCount}`);
  lines.push(`  existing rules parsed: ${scan.existingRules.length}`);
  lines.push('');
  if (proposal.blockToAppend) {
    lines.push('Will append to SCHEMA.md:');
    lines.push('---');
    lines.push(proposal.blockToAppend.trim());
    lines.push('---');
  } else {
    lines.push('No SCHEMA changes needed.');
  }
  if (proposal.willCreateHearthInbox) {
    lines.push(`Will mkdir: ${proposal.scan.hearthInboxDir}/`);
  }
  return lines.join('\n');
}
