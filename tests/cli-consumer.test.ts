import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdConsumer } from '../src/cli/index.ts';
import { resolveConsumer } from '../src/core/consumer-registry.ts';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'hearth-cli-consumer-')); }
function capture(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as any).write = (s: string) => { out += s; return true; };
  try { fn(); } finally { (process.stdout as any).write = orig; }
  return out;
}

test('consumer add prints a working token exactly once and stores only the hash', () => {
  const dir = tmp();
  const out = capture(() => cmdConsumer(['add', 'codex'], { sources: 'wechat-cc', vault: 'r', 'state-dir': dir }));
  const m = out.match(/token[:\s]+([A-Za-z0-9_-]{20,})/);
  expect(m).not.toBeNull();
  const token = m![1];
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
