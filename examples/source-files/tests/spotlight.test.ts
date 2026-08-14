// tests/spotlight.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { mdfind, hitsFromPaths, displayPath } from '../src/spotlight.ts';

test('mdfind builds -onlyin argv + query, parses newline paths, caps at limit', async () => {
  let seen: string[] = [];
  const fakeExec = async (argv: string[]) => { seen = argv; return '/a/one.md\n/a/two.md\n/a/three.md\n'; };
  const paths = await mdfind('revenue', { onlyIn: ['/docs', '/more'], limit: 2 }, fakeExec);
  expect(seen).toEqual(['-onlyin', '/docs', '-onlyin', '/more', 'revenue']);
  expect(paths).toEqual(['/a/one.md', '/a/two.md']);
});

test('mdfind returns [] on empty question and on exec failure (fail-open)', async () => {
  expect(await mdfind('   ', {}, async () => 'x')).toEqual([]);
  expect(await mdfind('q', {}, async () => { throw new Error('boom'); })).toEqual([]);
});

test('mdfind strips leading dashes so a leading-dash query does not error out as a flag', async () => {
  let seen: string[] = [];
  const fakeExec = async (argv: string[]) => { seen = argv; return ''; };
  await mdfind('-revenue', { onlyIn: ['/d'] }, fakeExec);
  expect(seen[seen.length - 1]).toBe('revenue');
});

test('mdfind returns [] without calling exec when query is all dashes', async () => {
  let called = false;
  const fakeExec = async (argv: string[]) => { called = true; return ''; };
  const paths = await mdfind('---', {}, fakeExec);
  expect(paths).toEqual([]);
  expect(called).toBe(false);
});

test('hitsFromPaths extracts + ranks real temp files, skips unextractable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-spot-'));
  const a = join(dir, 'q.md'); writeFileSync(a, 'quarterly revenue forecast up');
  const b = join(dir, 'other.md'); writeFileSync(b, 'unrelated kittens');
  const c = join(dir, 'img.png'); writeFileSync(c, Buffer.from([0x89]));
  const hits = await hitsFromPaths([a, b, c], 'quarterly revenue');
  expect(hits.length).toBe(1);
  expect(hits[0]!.source).toContain('q.md');
  expect(hits[0]!.anchor_summary).toContain('q.md:1');
  expect(hits[0]!.match_score).toBe(1);
});

test('mdfind real smoke — runs and returns an array (fail-open if mdfind absent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-spot-real-'));
  const paths = await mdfind('the', { onlyIn: [dir], limit: 5 });
  expect(Array.isArray(paths)).toBe(true);
});

test('displayPath home-relativizes paths under home, but leaves prefix-colliding siblings unchanged', () => {
  const home = homedir();
  expect(displayPath(join(home, 'docs', 'f.txt'))).toBe('~' + join('/docs', 'f.txt'));
  const sibling = home + '-backup/secret.txt';
  expect(displayPath(sibling)).toBe(sibling);
});
