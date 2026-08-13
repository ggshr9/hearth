import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdConsumer } from '../src/cli/index.ts';
import { resolveConsumer, listConsumers } from '../src/core/consumer-registry.ts';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'hearth-cli-consumer-')); }
function capture(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as any).write = (s: string) => { out += s; return true; };
  try { fn(); } finally { (process.stdout as any).write = orig; }
  return out;
}
// fail() writes to stderr then calls process.exit(1); intercept both so a
// rejected-input test doesn't kill the whole `bun test` process.
function captureFail(fn: () => void): { stderr: string; exited: boolean } {
  const origExit = process.exit;
  const origErr = process.stderr.write.bind(process.stderr);
  let stderr = '';
  let exited = false;
  (process as any).exit = (_code?: number) => { exited = true; throw new Error('__test_exit__'); };
  (process.stderr as any).write = (s: string) => { stderr += s; return true; };
  try {
    fn();
  } catch (e) {
    if (!(e instanceof Error && e.message === '__test_exit__')) throw e;
  } finally {
    process.exit = origExit;
    (process.stderr as any).write = origErr;
  }
  return { stderr, exited };
}

test('consumer add prints a working token exactly once and stores only the hash', () => {
  const dir = tmp();
  const out = capture(() => cmdConsumer(['add', 'codex'], { sources: 'wechat-cc', vault: 'r', 'state-dir': dir }));
  const m = out.match(/token[:\s]+([A-Za-z0-9_-]{20,})/);
  expect(m).not.toBeNull();
  const token = m![1]!;
  // the printed token actually authenticates
  const resolved = resolveConsumer('codex', token, dir);
  expect('denied' in (resolved as any)).toBe(false);
  expect((resolved as any).sources).toEqual(['wechat-cc']);
  // stored file has the hash, not the plaintext
  const raw = readFileSync(join(dir, 'consumers.json'), 'utf8');
  expect(raw).not.toContain(token);
});

test('consumer list shows id/vault/sources, not hashes; rm removes', () => {
  const dir = tmp();
  capture(() => cmdConsumer(['add', 'a'], { sources: '*', vault: 'none', 'state-dir': dir }));
  const list = capture(() => cmdConsumer(['list'], { 'state-dir': dir }));
  expect(list).toContain('a');
  expect(list).toContain('none');
  expect(list).not.toContain('sha256:');
  const rm = capture(() => cmdConsumer(['rm', 'a'], { 'state-dir': dir }));
  expect(rm.toLowerCase()).toContain('removed');
  const list2 = capture(() => cmdConsumer(['list'], { 'state-dir': dir }));
  expect(list2).not.toContain(' a ');
});

test('consumer add --sources "" creates a vault-only consumer with no federated sources', () => {
  const dir = tmp();
  const out = capture(() => cmdConsumer(['add', 'guest'], { sources: '', vault: 'r', 'state-dir': dir }));
  expect(out).toContain('token:');
  const guest = listConsumers(dir).find(c => c.id === 'guest');
  expect(guest).toBeDefined();
  expect(guest!.sources).toEqual([]);
});

test('consumer add warns and rotates the token when the id already exists', () => {
  const dir = tmp();
  const out1 = capture(() => cmdConsumer(['add', 'dup'], { sources: 'x', vault: 'r', 'state-dir': dir }));
  expect(out1).not.toContain('already existed');

  const out2 = capture(() => cmdConsumer(['add', 'dup'], { sources: 'y', vault: 'r', 'state-dir': dir }));
  expect(out2).toContain('already existed');
  expect(out2.toLowerCase()).toContain('invalid');
});

test('consumer add rejects an id with unsafe characters', () => {
  const dir = tmp();
  const { stderr, exited } = captureFail(() =>
    cmdConsumer(['add', 'weird"id'], { sources: 'x', vault: 'r', 'state-dir': dir }),
  );
  expect(exited).toBe(true);
  expect(stderr).toContain('must match');
});
