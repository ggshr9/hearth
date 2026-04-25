// Citation verification — the second trust pillar in code form.
//
// Every assertion in an agent-written page must carry a structured anchor
// (anchor.quote + anchor.quote_hash). citations.ts walks the vault, parses
// every page's claims[], and reports per-claim verification status.
//
// quote_hash is THE source of truth: sha256(anchor.quote, utf-8). line_start /
// line_end are fast hints we use first, then validate against the hash.
//
// v0.1: only markdown/text source verification (anchor.type === 'line').
// PDF / URL / timestamp anchors arrive with their respective extractors.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import matter from 'gray-matter';
import { sha256 } from './hash.ts';
import type { Claim, AnchorLine } from './types.ts';

export type ClaimStatus =
  | 'verified'
  | 'source_missing'
  | 'quote_missing'
  | 'hash_mismatch'
  | 'malformed'
  | 'unverifiable_in_v0_1';

export interface ClaimRecord {
  /** vault-relative path of the wiki page that carries this claim */
  page: string;
  claim: Claim;
  status: ClaimStatus;
  /** human-readable reason if status !== 'verified' */
  detail?: string;
}

export interface ClaimIndex {
  /** every claim found in any wiki page, with verification result */
  records: ClaimRecord[];
  /** quick lookups */
  verified(): ClaimRecord[];
  invalid(): ClaimRecord[];
}

function isAnchorLine(a: Claim['anchor']): a is AnchorLine {
  return a.type === 'line';
}

/** Verify a single claim against its source. Pure: no writes. */
export function verifyClaim(vaultRoot: string, claim: Claim): { status: ClaimStatus; detail?: string } {
  if (!claim.text || !claim.source || !claim.anchor) {
    return { status: 'malformed', detail: 'claim missing text / source / anchor' };
  }

  const sourcePath = join(vaultRoot, claim.source);
  if (!existsSync(sourcePath)) {
    return { status: 'source_missing', detail: `source not found: ${claim.source}` };
  }

  // v0.1: only line-based anchors verified end-to-end.
  if (!isAnchorLine(claim.anchor)) {
    return { status: 'unverifiable_in_v0_1', detail: `anchor.type=${claim.anchor.type} verification arrives with the matching extractor` };
  }

  const a = claim.anchor;
  if (!a.quote || !a.quote_hash) {
    return { status: 'malformed', detail: 'line anchor missing quote / quote_hash' };
  }

  const sourceText = readFileSync(sourcePath, 'utf8');

  // Find the quote anywhere in the source. line_start/end are hints; we
  // tolerate drift of the line numbers as long as the exact quote still
  // exists somewhere. The hash is computed against anchor.quote (NOT the
  // source slice) — this means the hash is stable across source line shifts
  // so long as the quoted text itself still lives in the source.
  if (!sourceText.includes(a.quote)) {
    return { status: 'quote_missing', detail: `quote not found in ${claim.source}` };
  }

  const recomputed = sha256(a.quote);
  if (recomputed !== a.quote_hash) {
    return { status: 'hash_mismatch', detail: `quote_hash mismatch (expected ${a.quote_hash.slice(0, 22)}…, recomputed ${recomputed.slice(0, 22)}…)` };
  }

  return { status: 'verified' };
}

/** Walk all wiki pages with frontmatter `claims:`, verify each. */
export function buildClaimIndex(vaultRoot: string): ClaimIndex {
  const records: ClaimRecord[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      // Skip dotfiles and hearth-internal dirs
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        // Skip raw/ (sources, not wiki pages with claims)
        const rel = relative(vaultRoot, full);
        if (rel === 'raw' || rel.startsWith('raw/')) continue;
        walk(full);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      const rel = relative(vaultRoot, full);
      // Skip SCHEMA.md / README.md / index.md
      if (rel === 'SCHEMA.md' || rel === 'README.md' || rel === 'index.md') continue;

      let parsed;
      try { parsed = matter(readFileSync(full, 'utf8')); } catch { continue; }
      const data = parsed.data as { claims?: unknown };
      if (!Array.isArray(data.claims)) continue;
      for (const c of data.claims as Claim[]) {
        const result = verifyClaim(vaultRoot, c);
        records.push({ page: rel, claim: c, status: result.status, ...(result.detail ? { detail: result.detail } : {}) });
      }
    }
  }

  walk(vaultRoot);

  return {
    records,
    verified: () => records.filter(r => r.status === 'verified'),
    invalid: () => records.filter(r => r.status !== 'verified' && r.status !== 'unverifiable_in_v0_1'),
  };
}
