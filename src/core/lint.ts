// Lint — read-only auditor. Proposes, never commits (v0.1).
//
// v0.1.2 checks:
//   1. citation-drift: claim's anchor.quote no longer in source, or quote_hash mismatch
//   2. single-source-stable: status: stable page supported by only one source
//   3. orphan: page not referenced by any other wiki page or MOC
//   4. raw-append-only: catch any raw/ files that were modified after creation (sanity)
//
// Contradiction detection deliberately deferred — it requires LLM and produces
// noisy output without one. Keep lint deterministic + cheap until proven otherwise.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import matter from 'gray-matter';
import { buildClaimIndex, type ClaimRecord } from './citations.ts';
import { ruleFor, type Schema } from './schema.ts';

export type LintSeverity = 'warn' | 'error';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  page: string;
  message: string;
  /** Optional pointer the user can act on (e.g. claim text, source path). */
  hint?: string;
}

export interface LintReport {
  ok: boolean;
  findings: LintFinding[];
  /** Total wiki pages scanned. */
  pages_scanned: number;
  /** Total claims scanned. */
  claims_scanned: number;
}

interface ParsedPage {
  path: string;
  data: Record<string, unknown>;
  body: string;
}

function listWikiPages(vaultRoot: string, schema: Schema): ParsedPage[] {
  const out: ParsedPage[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        const rel = relative(vaultRoot, full);
        // Skip raw/ — those are sources, not wiki pages
        if (rel === 'raw' || rel.startsWith('raw/')) continue;
        // Skip dirs the agent has 'none' on (e.g. 00 Inbox/) — those are not
        // hearth's surface; lint is about agent-managed pages
        const rule = ruleFor(schema, rel + '/');
        if (rule && rule.agent === 'none') continue;
        walk(full);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      const rel = relative(vaultRoot, full);
      if (rel === 'SCHEMA.md' || rel === 'README.md' || rel === 'index.md') continue;
      try {
        const parsed = matter(readFileSync(full, 'utf8'));
        out.push({ path: rel, data: parsed.data as Record<string, unknown>, body: parsed.content });
      } catch { continue; }
    }
  }
  walk(vaultRoot);
  return out;
}

function lintCitationDrift(invalidRecords: ClaimRecord[]): LintFinding[] {
  return invalidRecords.map(r => ({
    rule: 'citation-drift',
    severity: r.status === 'malformed' ? 'error' : 'warn',
    page: r.page,
    message: `${r.status}: "${r.claim.text.slice(0, 80)}${r.claim.text.length > 80 ? '…' : ''}"`,
    ...(r.detail ? { hint: r.detail } : {}),
  }));
}

function lintSingleSourceStable(pages: ParsedPage[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const p of pages) {
    if (p.data.status !== 'stable') continue;
    const sources = Array.isArray(p.data.sources) ? p.data.sources : [];
    if (sources.length <= 1) {
      findings.push({
        rule: 'single-source-stable',
        severity: 'warn',
        page: p.path,
        message: `status: stable but supported by only ${sources.length} source(s); add a second source or downgrade to draft`,
      });
    }
  }
  return findings;
}

function extractWikilinks(body: string): string[] {
  // [[name]] or [[name|alias]]
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) out.push(m[1].trim());
  }
  return out;
}

function lintOrphans(pages: ParsedPage[]): LintFinding[] {
  // Build the set of "linked-to" page basenames from any page's body.
  const linked = new Set<string>();
  for (const p of pages) {
    for (const link of extractWikilinks(p.body)) {
      // Strip directory prefixes — Obsidian-style wikilinks may be bare names
      const base = link.split('/').pop() ?? link;
      linked.add(base);
      linked.add(base.toLowerCase());
    }
  }
  const findings: LintFinding[] = [];
  for (const p of pages) {
    // MOCs are entry points; not expected to be linked TO from elsewhere
    if (p.data.type === 'moc') continue;
    const fname = p.path.split('/').pop()?.replace(/\.md$/, '') ?? '';
    if (!linked.has(fname) && !linked.has(fname.toLowerCase())) {
      findings.push({
        rule: 'orphan',
        severity: 'warn',
        page: p.path,
        message: 'no wikilinks point to this page from any MOC or sibling',
      });
    }
  }
  return findings;
}

function lintRawAppendOnly(vaultRoot: string): LintFinding[] {
  // v0.1 sanity: every file in raw/ should have an mtime >= ctime + 0
  // (i.e. not modified after creation). Not all filesystems give us a
  // reliable ctime separate from mtime, so this is a soft check that
  // catches the obvious case where mtime > ctime.
  const findings: LintFinding[] = [];
  const rawDir = join(vaultRoot, 'raw');
  if (!existsSync(rawDir)) return findings;
  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      // mtime > birthtime + 1s tolerance → was modified after creation
      const birth = (st.birthtimeMs && st.birthtimeMs > 0) ? st.birthtimeMs : st.ctimeMs;
      if (st.mtimeMs > birth + 1000) {
        findings.push({
          rule: 'raw-append-only',
          severity: 'error',
          page: relative(vaultRoot, full),
          message: 'raw/ file modified after creation; raw/ is append-only by SCHEMA.md contract',
        });
      }
    }
  }
  walk(rawDir);
  return findings;
}

export function lint(vaultRoot: string, schema: Schema): LintReport {
  const pages = listWikiPages(vaultRoot, schema);
  const idx = buildClaimIndex(vaultRoot);
  const findings: LintFinding[] = [
    ...lintCitationDrift(idx.invalid()),
    ...lintSingleSourceStable(pages),
    ...lintOrphans(pages),
    ...lintRawAppendOnly(vaultRoot),
  ];
  return {
    ok: findings.length === 0,
    findings,
    pages_scanned: pages.length,
    claims_scanned: idx.records.length,
  };
}
