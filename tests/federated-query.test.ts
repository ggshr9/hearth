// hearth Phase 2a [HF3] — federatedQuery router tests
//
// federatedQuery() concats hearth's own local query() hits with hits pulled
// from every registered federated source, and does NOTHING else: no
// re-verification, no re-scoring beyond a [0,1] clamp for a common sort
// scale, no dropping federated hits to make room for the local `limit`.
// Local hits stay origin:'vault'/verified_by:'vault'; federated hits keep
// whatever origin/verified_by queryFederatedSource already stamped them
// with. Mixing those up would be a fabrication regression, not just a bug.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { federatedQuery, NO_ANSWER, type QueryHit, type QueryResult } from '../src/core/query.ts';
import type { FederatedSource } from '../src/core/source-registry.ts';

function makeStateDir(sources: FederatedSource[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-federated-query-'));
  writeFileSync(join(dir, 'sources.json'), JSON.stringify(sources));
  return dir;
}

function makeSource(id: string): FederatedSource {
  return { id, transport: { kind: 'stdio', command: 'fake-cmd' }, query_tool: 'query' };
}

function localHit(overrides: Partial<QueryHit> = {}): QueryHit {
  return {
    page: 'Local Page',
    claim_text: 'local claim',
    source: 'local-src',
    anchor_summary: 'L1-L2',
    confidence: 'high',
    match_score: 0.5,
    origin: 'vault',
    verified_by: 'vault',
    ...overrides,
  };
}

function fedHit(sourceId: string, overrides: Partial<QueryHit> = {}): QueryHit {
  return {
    page: '',
    claim_text: 'federated claim',
    source: 'chat:someone',
    anchor_summary: 'msg#1',
    confidence: 'medium',
    match_score: 0.7,
    origin: 'federated',
    verified_by: sourceId,
    ...overrides,
  };
}

function fakeLocalResult(question: string, hits: QueryHit[]): () => QueryResult {
  return () => ({ question, hits, no_answer_message: NO_ANSWER });
}

describe('federatedQuery: merges local vault hits + federated source hits', () => {
  it('merges local and one federated source, sorted by match_score desc, labels preserved', async () => {
    const stateDir = makeStateDir([makeSource('wxvault')]);
    const question = 'when is the trip?';
    const local = [localHit({ match_score: 0.4 })];
    const federated = [fedHit('wxvault', { match_score: 0.9 })];

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, local),
      sourceQueryFn: async (source, q) => {
        expect(source.id).toBe('wxvault');
        expect(q).toBe(question);
        return federated;
      },
    });

    expect(result.question).toBe(question);
    expect(result.no_answer_message).toBe(NO_ANSWER);
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({ origin: 'federated', verified_by: 'wxvault', match_score: 0.9 });
    expect(result.hits[1]).toMatchObject({ origin: 'vault', verified_by: 'vault', match_score: 0.4 });
  });

  it('sorts a mixed set of local + multi-source hits purely by match_score desc', async () => {
    const stateDir = makeStateDir([makeSource('a'), makeSource('b')]);
    const question = 'q';
    const local = [localHit({ match_score: 0.5, claim_text: 'mid' })];

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, local),
      sourceQueryFn: async source => {
        if (source.id === 'a') return [fedHit('a', { match_score: 0.95, claim_text: 'top' })];
        return [fedHit('b', { match_score: 0.1, claim_text: 'bottom' })];
      },
    });

    expect(result.hits.map(h => h.claim_text)).toEqual(['top', 'mid', 'bottom']);
  });

  it('a source returning [] does not remove local hits (fail-open at the router level too)', async () => {
    const stateDir = makeStateDir([makeSource('empty-source')]);
    const question = 'q';
    const local = [localHit()];

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, local),
      sourceQueryFn: async () => [],
    });

    expect(result.hits).toEqual(local);
  });

  it('both local and every source empty → hits is []', async () => {
    const stateDir = makeStateDir([makeSource('s1'), makeSource('s2')]);
    const question = 'q';

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, []),
      sourceQueryFn: async () => [],
    });

    expect(result.hits).toEqual([]);
    expect(result.no_answer_message).toBe(NO_ANSWER);
  });

  it('no registered sources → local hits only, no sourceQueryFn calls', async () => {
    const stateDir = makeStateDir([]);
    const question = 'q';
    const local = [localHit()];
    let calls = 0;

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, local),
      sourceQueryFn: async () => {
        calls++;
        return [];
      },
    });

    expect(calls).toBe(0);
    expect(result.hits).toEqual(local);
  });

  it('collects hits from every registered source, not just the first', async () => {
    const stateDir = makeStateDir([makeSource('a'), makeSource('b'), makeSource('c')]);
    const question = 'q';

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, []),
      sourceQueryFn: async source => [fedHit(source.id, { match_score: 0.5, claim_text: `from-${source.id}` })],
    });

    expect(result.hits.map(h => h.claim_text).sort()).toEqual(['from-a', 'from-b', 'from-c']);
  });

  it('clamps an out-of-range federated match_score into [0,1]', async () => {
    const stateDir = makeStateDir([makeSource('wild')]);
    const question = 'q';

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, []),
      sourceQueryFn: async () => [
        fedHit('wild', { match_score: 5, claim_text: 'too-high' }),
        fedHit('wild', { match_score: -3, claim_text: 'too-low' }),
      ],
    });

    const byClaim = Object.fromEntries(result.hits.map(h => [h.claim_text, h.match_score]));
    expect(byClaim['too-high']).toBe(1);
    expect(byClaim['too-low']).toBe(0);
  });

  it('a sourceQueryFn that throws directly (bypassing queryFederatedSource fail-open) is swallowed defensively — local hits still returned', async () => {
    const stateDir = makeStateDir([makeSource('flaky')]);
    const question = 'q';
    const local = [localHit()];

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, local),
      sourceQueryFn: async () => {
        throw new Error('boom — should never propagate');
      },
    });

    expect(result.hits).toEqual(local);
  });

  it('never re-verifies or re-scores federated hits — passes them through untouched apart from the [0,1] clamp', async () => {
    const stateDir = makeStateDir([makeSource('wxvault')]);
    const question = 'q';
    const federated = [
      fedHit('wxvault', {
        match_score: 0.9,
        claim_text: 'unverifiable-by-hearth claim',
        confidence: 'low',
        source: 'chat:bob',
        anchor_summary: 'msg#7',
      }),
    ];

    const result = await federatedQuery('/fake/vault', question, {
      stateDir,
      queryFn: fakeLocalResult(question, []),
      sourceQueryFn: async () => federated,
    });

    expect(result.hits).toEqual(federated);
  });

  it('defaults to the real query() and queryFederatedSource() when no seams are given (smoke test, no throw)', async () => {
    const stateDir = makeStateDir([]);
    await expect(federatedQuery('/nonexistent/vault/path', 'anything', { stateDir })).resolves.toBeDefined();
  });
});
