// Keyword search over the in-memory index. Honest token-overlap scoring (no
// embeddings — matches hearth's own conservative query). Hits are rank-
// normalized 1/(1+index) so they interleave fairly in hearth's cross-source merge.
import { basename } from 'node:path';
import type { IndexRecord } from './index-store.ts';

export interface Hit {
  claim_text: string;
  source: string;
  anchor_summary: string;
  confidence: 'high' | 'medium' | 'low';
  match_score: number;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+|[一-鿿]/g)) {
    const t = m[0];
    if (/[一-鿿]/.test(t) || t.length >= 2) out.push(t);
  }
  return out;
}

export function search(index: IndexRecord[], question: string, limit = 8): Hit[] {
  const qTokens = new Set(tokenize(question));
  if (qTokens.size === 0) return [];

  const scored: { rec: IndexRecord; score: number }[] = [];
  for (const rec of index) {
    const hay = tokenize(rec.text + ' ' + basename(rec.relPath));
    const haySet = new Set(hay);
    let coverage = 0;
    for (const t of qTokens) if (haySet.has(t)) coverage++;
    if (coverage === 0) continue;
    let occ = 0;
    for (const t of hay) if (qTokens.has(t)) occ++;
    scored.push({ rec, score: coverage * 1000 + occ }); // coverage dominates, occurrences tie-break
  }
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ rec }, index) => {
    const { claim_text, anchor } = snippet(rec, qTokens);
    return {
      claim_text,
      source: rec.relPath,
      anchor_summary: anchor,
      confidence: index === 0 ? 'high' : index <= 2 ? 'medium' : 'low',
      match_score: 1 / (1 + index),
    };
  });
}

function snippet(rec: IndexRecord, qTokens: Set<string>): { claim_text: string; anchor: string } {
  if (rec.isMedia || rec.text.trim() === '') {
    return { claim_text: `${basename(rec.relPath)} (media file)`, anchor: `${rec.relPath} (media)` };
  }
  const lines = rec.text.split(/\r?\n/);
  let bestLine = 0, bestHits = -1;
  for (let i = 0; i < lines.length; i++) {
    const lt = new Set(tokenize(lines[i]!));
    let h = 0;
    for (const t of qTokens) if (lt.has(t)) h++;
    if (h > bestHits) { bestHits = h; bestLine = i; }
  }
  const start = Math.max(0, bestLine - 1), end = Math.min(lines.length, bestLine + 2);
  let text = lines.slice(start, end).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length > 300) text = text.slice(0, 297) + '...';
  return { claim_text: text || basename(rec.relPath), anchor: `${rec.relPath}:${bestLine + 1}` };
}
