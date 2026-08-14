// tests/consumer-enforcement.test.ts
import { test, expect } from 'bun:test';
import { federatedQuery, type QueryHit, type QueryResult } from '../src/core/query.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'hearth-enforce-')); }
function hit(source: string, origin: 'vault' | 'federated'): QueryHit {
  return { page: 'p', claim_text: 'c', source, anchor_summary: 'a',
    confidence: 'high', match_score: 0.9, origin, verified_by: origin === 'vault' ? 'vault' : source };
}
// Two registered sources so we can prove allowlist filtering.
function seedSources(dir: string): void {
  writeFileSync(join(dir, 'sources.json'), JSON.stringify([
    { id: 'wechat-cc', transport: { kind: 'stdio', command: 'x' }, query_tool: 'q' },
    { id: 'other',     transport: { kind: 'stdio', command: 'y' }, query_tool: 'q' },
  ]), { mode: 0o600 });
}

test('owner (consumer=null) hits vault + all sources (Phase 2a unchanged)', async () => {
  const dir = tmp(); seedSources(dir);
  const seen: string[] = [];
  const queryFn = (() => ({ question: 'x', hits: [hit('vault', 'vault')], no_answer_message: 'no answer found in vault' } as QueryResult)) as any;
  const sourceQueryFn = async (s: any) => { seen.push(s.id); return [hit(s.id, 'federated')]; };
  const r = await federatedQuery('/v', 'q', { stateDir: dir, consumer: null, queryFn, sourceQueryFn });
  expect(seen.sort()).toEqual(['other', 'wechat-cc']);
  expect(r.hits.some(h => h.origin === 'vault')).toBe(true);
});

test('vault:none consumer never calls queryFn; only granted source fans out', async () => {
  const dir = tmp(); seedSources(dir);
  let localCalls = 0; const seen: string[] = [];
  const queryFn = ((..._a: any[]) => { localCalls++; return { question: 'x', hits: [hit('vault', 'vault')], no_answer_message: 'no answer found in vault' }; }) as any;
  const sourceQueryFn = async (s: any) => { seen.push(s.id); return [hit(s.id, 'federated')]; };
  const r = await federatedQuery('/v', 'q', { stateDir: dir, consumer: { id: 'c', vault: 'none', sources: ['wechat-cc'] }, queryFn, sourceQueryFn });
  expect(localCalls).toBe(0);                          // no vault leg
  expect(seen).toEqual(['wechat-cc']);                 // 'other' filtered out
  expect(r.hits.every(h => h.origin === 'federated')).toBe(true);
});

test('source allowlist blocks ungranted source entirely (spy never called)', async () => {
  const dir = tmp(); seedSources(dir);
  const seen: string[] = [];
  const queryFn = (() => ({ question: 'x', hits: [], no_answer_message: 'no answer found in vault' } as QueryResult)) as any;
  const sourceQueryFn = async (s: any) => { seen.push(s.id); return []; };
  await federatedQuery('/v', 'q', { stateDir: dir, consumer: { id: 'c', vault: 'r', sources: ['wechat-cc'] }, queryFn, sourceQueryFn });
  expect(seen).toEqual(['wechat-cc']);                 // 'other' never queried
});
