// Query — deliberately conservative. v0.1.2 does keyword match against the
// verified claim index, never against raw markdown. If no verified claim
// matches, the answer is the literal string "no answer found in vault".
//
// That's the entire algorithm. Resist the urge to make it smarter before the
// rest of the system is sturdy. The point of v0.1.2 is to prove the
// "doesn't fabricate" property, not to win a benchmark.

import { buildClaimIndex, type ClaimRecord } from './citations.ts';

export const NO_ANSWER = 'no answer found in vault';

export interface QueryHit {
  page: string;
  claim_text: string;
  source: string;
  anchor_summary: string;     // human-readable: "L74-L79", "page 12", etc.
  confidence: 'high' | 'medium' | 'low';
  match_score: number;
}

export interface QueryResult {
  question: string;
  hits: QueryHit[];
  /** When hits is empty, this is the verbatim string callers must show. */
  no_answer_message: typeof NO_ANSWER;
}

function tokenize(text: string): string[] {
  // Split on non-alphanumeric (incl. CJK we leave as a single block per
  // character cluster — keep it simple for v0.1).
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2);
}

function scoreClaim(question: string, rec: ClaimRecord): number {
  const qtokens = new Set(tokenize(question));
  if (qtokens.size === 0) return 0;
  const haystack = (rec.claim.text + ' ' + rec.page + ' ' + rec.claim.source).toLowerCase();
  let hits = 0;
  for (const t of qtokens) {
    if (haystack.includes(t)) hits++;
  }
  return hits / qtokens.size; // fraction of question tokens found
}

function anchorSummary(rec: ClaimRecord): string {
  const a = rec.claim.anchor;
  if (a.type === 'line') return `L${a.line_start}-L${a.line_end}`;
  if (a.type === 'page') return `page ${a.page}`;
  if (a.type === 'timestamp') return `t=${a.timestamp}`;
  if (a.type === 'css') return `selector ${a.selector}`;
  return '';
}

export function query(vaultRoot: string, question: string, opts: { limit?: number; minScore?: number } = {}): QueryResult {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0.34; // at least 1/3 of question tokens must hit
  const idx = buildClaimIndex(vaultRoot);
  const verified = idx.verified();
  const ranked = verified
    .map(rec => ({ rec, score: scoreClaim(question, rec) }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const hits: QueryHit[] = ranked.map(({ rec, score }) => ({
    page: rec.page,
    claim_text: rec.claim.text,
    source: rec.claim.source,
    anchor_summary: anchorSummary(rec),
    confidence: rec.claim.confidence,
    match_score: Math.round(score * 100) / 100,
  }));

  return { question, hits, no_answer_message: NO_ANSWER };
}
