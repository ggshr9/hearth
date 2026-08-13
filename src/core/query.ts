// Query — deliberately conservative. v0.1.2 does keyword match against the
// verified claim index, never against raw markdown. If no verified claim
// matches, the answer is the literal string "no answer found in vault".
//
// That's the entire algorithm. Resist the urge to make it smarter before the
// rest of the system is sturdy. The point of v0.1.2 is to prove the
// "doesn't fabricate" property, not to win a benchmark.

import { buildClaimIndex, type ClaimRecord } from './citations.ts';
import { loadSources, type FederatedSource } from './source-registry.ts';
import { queryFederatedSource } from './federated-client.ts';
import { filterSourcesForConsumer, consumerCanReadVault, type ResolvedConsumer } from './consumer-registry.ts';

export const NO_ANSWER = 'no answer found in vault';

export interface QueryHit {
  page: string;
  claim_text: string;
  source: string;
  anchor_summary: string;     // human-readable: "L74-L79", "page 12", etc.
  confidence: 'high' | 'medium' | 'low';
  match_score: number;
  /** Phase 2a (federated query): where this hit came from. Local vault hits
   *  are always 'vault'; a federated source sets this to 'federated'. */
  origin: 'vault' | 'federated';
  /** Who verified this hit. Local vault hits are always verified by the
   *  vault's own citation pipeline ('vault'); a federated hit carries the
   *  id of the external source that produced it. */
  verified_by: 'vault' | string;
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
    origin: 'vault',
    verified_by: 'vault',
  }));

  return { question, hits, no_answer_message: NO_ANSWER };
}

/**
 * federatedQuery — Phase 2a (HF3) router.
 *
 * Merges hearth's own local query() hits with hits pulled from every
 * registered federated source (source-registry.ts + federated-client.ts).
 * This function does exactly one thing beyond concatenation: it clamps every
 * hit's match_score into [0,1] so local and federated scores sit on a common
 * scale, then sorts the merged list by that score, descending.
 *
 * It deliberately does NOT re-verify or re-score federated hits against
 * buildClaimIndex/verifyClaim — those hits already carry origin:'federated'
 * and verified_by:<source id>, i.e. someone else's vault already vouched for
 * them. Hearth cannot verify claims it never ingested; feeding federated
 * hits through its own citation pipeline would either throw (they're not in
 * the index) or, worse, silently relabel them as hearth-verified. Local hits
 * keep origin:'vault'/verified_by:'vault' exactly as query() produced them.
 *
 * Fail-open: queryFederatedSource() already degrades any single source's
 * failure (connect error, timeout, malformed response) to []. The loop below
 * additionally wraps each call in try/catch so that even a caller-supplied
 * sourceQueryFn (test seam) — or a future source-registry surprise — that
 * throws directly cannot take down the whole federated query; it degrades to
 * [] for that source and the rest proceeds normally.
 */
export async function federatedQuery(
  vaultRoot: string,
  question: string,
  opts?: {
    stateDir?: string;
    limit?: number;
    minScore?: number;
    queryFn?: typeof query;
    sourceQueryFn?: (source: FederatedSource, question: string) => Promise<QueryHit[]>;
    /** Phase 3: the consumer this query is being run on behalf of. `null`
     *  (default) means the owner — unrestricted vault access + all sources,
     *  i.e. exactly today's Phase 2a behavior. A ResolvedConsumer gates the
     *  local vault leg via consumerCanReadVault() and filters the source
     *  fan-out via filterSourcesForConsumer() *before* any source is
     *  queried — an ungranted source's sourceQueryFn is never invoked. */
    consumer?: ResolvedConsumer | null;
  },
): Promise<QueryResult> {
  const queryFn = opts?.queryFn ?? query;
  const sourceQueryFn = opts?.sourceQueryFn ?? queryFederatedSource;
  const consumer = opts?.consumer ?? null;

  const local = consumerCanReadVault(consumer)
    ? queryFn(vaultRoot, question, { limit: opts?.limit, minScore: opts?.minScore }).hits
    : [];

  const sources = filterSourcesForConsumer(loadSources(opts?.stateDir), consumer);
  const federated: QueryHit[] = [];
  for (const source of sources) {
    try {
      federated.push(...(await sourceQueryFn(source, question)));
    } catch (err) {
      // Defensive only: queryFederatedSource itself is already fail-open.
      // This guards against a non-standard sourceQueryFn (tests, or a
      // future source-registry surprise) throwing directly.
      console.warn(`[hearth] federatedQuery: source "${source.id}" threw unexpectedly (should have fail-opened):`, err);
    }
  }

  const clamp = (score: number): number => Math.max(0, Math.min(1, score));
  const hits = [...local, ...federated]
    .map(hit => ({ ...hit, match_score: clamp(hit.match_score) }))
    .sort((a, b) => b.match_score - a.match_score);

  return { question, hits, no_answer_message: NO_ANSWER };
}
