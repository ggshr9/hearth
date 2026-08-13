// tests/consumer-registry.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import {
  addConsumer, resolveConsumer, listConsumers, removeConsumer,
  loadConsumers, hashToken, filterSourcesForConsumer, consumerCanReadVault,
} from '../src/core/consumer-registry.ts';
import type { FederatedSource } from '../src/core/source-registry.ts';
import { resolveServeConsumer } from '../src/cli/index.ts';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'hearth-consumers-')); }

test('addConsumer writes a 0600 file with a hashed (not plaintext) token, returns plaintext once', () => {
  const dir = tmp();
  const { token } = addConsumer({ id: 'codex', sources: ['wechat-cc'], vault: 'r', stateDir: dir });
  expect(token.length).toBeGreaterThan(20);
  const path = join(dir, 'consumers.json');
  const raw = readFileSync(path, 'utf8');
  expect(raw).not.toContain(token);                 // plaintext never stored
  expect(raw).toContain(hashToken(token));          // hash stored
  expect(statSync(path).mode & 0o777).toBe(0o600);  // 0600
});

test('addConsumer forces 0600 even when consumers.json pre-exists at looser perms', () => {
  const dir = tmp();
  const path = join(dir, 'consumers.json');
  require('node:fs').writeFileSync(path, JSON.stringify({ version: 1, consumers: [] }), { mode: 0o644 });
  expect(statSync(path).mode & 0o777).toBe(0o644); // sanity: pre-existing loose perms
  addConsumer({ id: 'codex', sources: ['wechat-cc'], vault: 'r', stateDir: dir });
  expect(statSync(path).mode & 0o777).toBe(0o600); // overwrite must force 0600, not just create
});

test('resolveConsumer accepts the right token, rejects wrong token and unknown id', () => {
  const dir = tmp();
  const { token } = addConsumer({ id: 'codex', sources: ['wechat-cc'], vault: 'r', stateDir: dir });
  const ok = resolveConsumer('codex', token, dir);
  expect('denied' in ok).toBe(false);
  expect((ok as any).sources).toEqual(['wechat-cc']);
  expect((ok as any).vault).toBe('r');
  expect(resolveConsumer('codex', 'wrong-token', dir)).toEqual({ denied: 'bad_token', id: 'codex' });
  expect(resolveConsumer('ghost', token, dir)).toEqual({ denied: 'unknown_id', id: 'ghost' });
});

test('loadConsumers on missing or malformed file returns empty grants (fail-closed)', () => {
  const dir = tmp();
  expect(loadConsumers(dir)).toEqual([]);                       // missing
  require('node:fs').writeFileSync(join(dir, 'consumers.json'), '{ not json', { mode: 0o600 });
  expect(loadConsumers(dir)).toEqual([]);                       // malformed
});

test('listConsumers never exposes token hashes; add is upsert by id; remove works', () => {
  const dir = tmp();
  addConsumer({ id: 'a', sources: '*', vault: 'r', stateDir: dir });
  addConsumer({ id: 'a', sources: [], vault: 'none', stateDir: dir }); // upsert
  const list = listConsumers(dir);
  expect(list.length).toBe(1);
  expect(list[0]).toEqual({ id: 'a', vault: 'none', sources: [] });
  expect(JSON.stringify(list)).not.toContain('sha256:');
  expect(removeConsumer('a', dir)).toBe(true);
  expect(loadConsumers(dir)).toEqual([]);
  expect(removeConsumer('a', dir)).toBe(false);                // idempotent
});

test('filterSourcesForConsumer + consumerCanReadVault honor grants', () => {
  const S = (id: string): FederatedSource =>
    ({ id, transport: { kind: 'stdio', command: 'x' }, query_tool: 'q' } as FederatedSource);
  const all = [S('wechat-cc'), S('other')];
  expect(filterSourcesForConsumer(all, null).map(s => s.id)).toEqual(['wechat-cc', 'other']); // owner=all
  expect(filterSourcesForConsumer(all, { id: 'c', vault: 'r', sources: '*' }).map(s => s.id)).toEqual(['wechat-cc', 'other']);
  expect(filterSourcesForConsumer(all, { id: 'c', vault: 'r', sources: ['wechat-cc'] }).map(s => s.id)).toEqual(['wechat-cc']);
  expect(filterSourcesForConsumer(all, { id: 'c', vault: 'none', sources: [] })).toEqual([]);
  expect(consumerCanReadVault(null)).toBe(true);
  expect(consumerCanReadVault({ id: 'c', vault: 'r', sources: '*' })).toBe(true);
  expect(consumerCanReadVault({ id: 'c', vault: 'none', sources: [] })).toBe(false);
});

test('resolveServeConsumer: owner when nothing passed, denied on partial creds, grant on valid', () => {
  const dir = tmp();
  const { token } = addConsumer({ id: 'codex', sources: '*', vault: 'r', stateDir: dir });
  expect(resolveServeConsumer({ stateDir: dir })).toBe(null);                                  // owner-full
  expect(resolveServeConsumer({ id: 'codex', stateDir: dir })).toEqual({ denied: 'bad_token', id: 'codex' }); // id, no token
  expect(resolveServeConsumer({ token: 'x', stateDir: dir })).toEqual({ denied: 'bad_token' }); // token, no id
  const ok = resolveServeConsumer({ id: 'codex', token, stateDir: dir });
  expect('denied' in (ok as any)).toBe(false);
  expect((ok as any).id).toBe('codex');
});
