# Consumer Permission Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make hearth a per-consumer × per-source permission broker: each consuming app authenticates as a named consumer (id + token) and receives a grant (vault r|none, source allowlist) that hearth enforces in its query path, with every query audited.

**Architecture:** A new `core/consumer-registry.ts` module owns the `~/.hearth/consumers.json` grant store (hashed tokens, constant-time verify) and the pure `filterSourcesForConsumer` helper. `hearth mcp serve` resolves the consumer identity at spawn (id+token via flags/env) into `ServerContext.consumer` (`null`=owner-full | grant | denied-marker). `federatedQuery` and the `vault_query` handler enforce the grant (denied→refuse touching nothing; `vault:'none'`→no local leg; sources→allowlist-filtered) and write a hashed `query` audit event. A `hearth consumer add/list/rm` CLI manages grants.

**Tech Stack:** Bun + TypeScript, `@modelcontextprotocol/sdk`, `node:crypto` (sha256 + `timingSafeEqual`), `node:util` `parseArgs`. Tests: `bun test` in `tests/`.

## Global Constraints

- **hearth-only.** No wechat-cc changes. Keep every addition channel/consumer-neutral — hearth must not learn what "wechat-cc" is.
- **Fail-closed.** An invalid/unknown consumer (`denied` marker) must be refused for EVERY `vault_query` — including pure-local `federate:false`. A denied consumer learns nothing: neither `queryFn` nor any `sourceQueryFn` runs. Malformed/missing `consumers.json` → empty grants (no access granted by accident).
- **Backward-compat / owner-full.** When no `--consumer` (and no `HEARTH_CONSUMER_ID`) is passed, `ctx.consumer` is `null` = owner-full. `federatedQuery(..., { consumer: null })` and `createMcpServer({ vaultRoot })` (no consumer) must be **byte-identical** to today's Phase 2a behavior. Existing tests must pass unchanged.
- **Secret hygiene.** Store only `token_hash = "sha256:" + hex(sha256(token))`, never the plaintext token. `consumers.json` is written `mode: 0o600`. Token comparison uses `timingSafeEqual` (from `core/token-crypto.ts`) on equal-length hex buffers — never `===` on the token/hash.
- **Audit privacy.** The `query` audit event stores the question **hashed** (`question_sha256`), never plaintext.
- **Style.** Match hearth's throw-proof loaders (`loadSources` degrades to empty, never throws). Reuse `b64url`, `timingSafeEqual`, `loadOrCreateSecret`-adjacent conventions from `core/token-crypto.ts`. Reuse the existing `audit()` async writer (as `vault_lint`/`vault_doctor` handlers do).
- **Commits:** no `git add -A`; do not stage `package.json`/`bun.lock`. Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Non-goals (do NOT build):** ingest-side consumer scoping, intra-source path scope, token TTL/rotation, a shared multi-tenant server, strict-mode (deny no-consumer), RRF/freshness. See spec §Non-goals.

---

## File Structure

- **Create** `src/core/consumer-registry.ts` — grant store + resolve + management + `filterSourcesForConsumer` (Task 1).
- **Create** `tests/consumer-registry.test.ts` (Task 1).
- **Modify** `src/mcp-server.ts` — `ServerContext.consumer`, `createMcpServer`/`startStdioServer` signature, `vault_query` handler enforcement + audit (Tasks 2, 3).
- **Modify** `src/core/query.ts` — `federatedQuery` `consumer` opt (Task 3).
- **Modify** `src/core/audit.ts` — add `'query'` to `AuditEvent` (Task 3).
- **Create** `tests/consumer-enforcement.test.ts` — federatedQuery + handler matrix (Task 3).
- **Modify** `src/cli/index.ts` — `resolveServeConsumer` + `cmdMcp` wiring (Task 2), `cmdConsumer` + parseArgs options + switch case (Task 4).
- **Create** `tests/cli-consumer.test.ts` (Task 4).

---

## Task 1: Consumer registry module

**Files:**
- Create: `src/core/consumer-registry.ts`
- Test: `tests/consumer-registry.test.ts`

**Interfaces:**
- Consumes: `FederatedSource` from `./source-registry.ts`; `b64url`, `timingSafeEqual` from `./token-crypto.ts`; `createHash`, `randomBytes` from `node:crypto`.
- Produces:
  - `type VaultAccess = 'r' | 'none'`
  - `interface ConsumerGrant { id: string; vault: VaultAccess; sources: '*' | string[] }`
  - `interface ResolvedConsumer extends ConsumerGrant {}` (a verified grant)
  - `interface DeniedConsumer { denied: 'unknown_id' | 'bad_token'; id?: string }`
  - `type ConsumerIdentity = ResolvedConsumer | DeniedConsumer | null` (null = owner-full)
  - `function hashToken(token: string): string` → `"sha256:"+hex`
  - `function loadConsumers(stateDir?: string): ConsumerGrant[]` (throw-proof; each entry also carries its stored `token_hash` internally — see note)
  - `function resolveConsumer(id: string, token: string, stateDir?: string): ResolvedConsumer | DeniedConsumer`
  - `function addConsumer(args: { id: string; sources: '*' | string[]; vault: VaultAccess; stateDir?: string }): { token: string }`
  - `function listConsumers(stateDir?: string): ConsumerGrant[]` (no hashes)
  - `function removeConsumer(id: string, stateDir?: string): boolean`
  - `function filterSourcesForConsumer(sources: FederatedSource[], consumer: ResolvedConsumer | null): FederatedSource[]`
  - `function consumerCanReadVault(consumer: ResolvedConsumer | null): boolean`

**Note on the stored shape:** on-disk each consumer is `{ id, token_hash, vault, sources }`. `ConsumerGrant` (the public type) omits `token_hash`; `loadConsumers`/`listConsumers` return grants without hashes. `resolveConsumer` reads the file directly (needs the hash) rather than going through `loadConsumers`. Define an internal `interface StoredConsumer extends ConsumerGrant { token_hash: string }` and an internal `readStore(stateDir): { version: number; consumers: StoredConsumer[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd <hearth> && bun test tests/consumer-registry.test.ts`
Expected: FAIL (module `../src/core/consumer-registry.ts` not found).

- [ ] **Step 3: Write `src/core/consumer-registry.ts`**

```ts
// Consumer permission registry — per-consumer × per-source grants at
// ~/.hearth/consumers.json. hearth is a broker: a consuming app authenticates
// as a named consumer (id + bearer token) and gets a grant (vault r|none,
// source allowlist). We store only the token HASH; verification is
// constant-time. Malformed/missing store => no grants (fail-closed).

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { b64url, timingSafeEqual } from './token-crypto.ts';
import type { FederatedSource } from './source-registry.ts';

export type VaultAccess = 'r' | 'none';
export interface ConsumerGrant { id: string; vault: VaultAccess; sources: '*' | string[] }
export interface ResolvedConsumer extends ConsumerGrant {}
export interface DeniedConsumer { denied: 'unknown_id' | 'bad_token'; id?: string }
export type ConsumerIdentity = ResolvedConsumer | DeniedConsumer | null;

interface StoredConsumer extends ConsumerGrant { token_hash: string }
interface Store { version: number; consumers: StoredConsumer[] }

function defaultStateDir(): string { return join(homedir(), '.hearth'); }
function storePath(stateDir?: string): string { return join(stateDir ?? defaultStateDir(), 'consumers.json'); }

export function hashToken(token: string): string {
  return 'sha256:' + createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Read raw store, throw-proof. Missing/malformed/invalid => empty. */
function readStore(stateDir?: string): Store {
  const path = storePath(stateDir);
  if (!existsSync(path)) return { version: 1, consumers: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { console.warn(`[hearth] consumer-registry: malformed JSON in ${path}:`, err); return { version: 1, consumers: [] }; }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as any).consumers)) {
    console.warn(`[hearth] consumer-registry: ${path} missing consumers[]; ignoring`);
    return { version: 1, consumers: [] };
  }
  const consumers = ((parsed as any).consumers as unknown[]).filter(isStored) as StoredConsumer[];
  return { version: 1, consumers };
}

function isStored(e: unknown): e is StoredConsumer {
  if (typeof e !== 'object' || e === null) return false;
  const c = e as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) return false;
  if (typeof c.token_hash !== 'string') return false;
  if (c.vault !== 'r' && c.vault !== 'none') return false;
  if (c.sources !== '*' && !Array.isArray(c.sources)) return false;
  return true;
}

function writeStore(store: Store, stateDir?: string): void {
  const dir = stateDir ?? defaultStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(storePath(stateDir), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

function toGrant(c: StoredConsumer): ConsumerGrant { return { id: c.id, vault: c.vault, sources: c.sources }; }

export function loadConsumers(stateDir?: string): ConsumerGrant[] {
  return readStore(stateDir).consumers.map(toGrant);
}
export function listConsumers(stateDir?: string): ConsumerGrant[] { return loadConsumers(stateDir); }

export function resolveConsumer(id: string, token: string, stateDir?: string): ResolvedConsumer | DeniedConsumer {
  const found = readStore(stateDir).consumers.find(c => c.id === id);
  if (!found) return { denied: 'unknown_id', id };
  const a = Buffer.from(hashToken(token), 'utf8');
  const b = Buffer.from(found.token_hash, 'utf8');
  if (!timingSafeEqual(a, b)) return { denied: 'bad_token', id };
  return toGrant(found);
}

export function addConsumer(args: { id: string; sources: '*' | string[]; vault: VaultAccess; stateDir?: string }): { token: string } {
  const token = b64url(randomBytes(24));
  const store = readStore(args.stateDir);
  const entry: StoredConsumer = { id: args.id, token_hash: hashToken(token), vault: args.vault, sources: args.sources };
  const idx = store.consumers.findIndex(c => c.id === args.id);
  if (idx >= 0) store.consumers[idx] = entry; else store.consumers.push(entry);
  writeStore(store, args.stateDir);
  return { token };
}

export function removeConsumer(id: string, stateDir?: string): boolean {
  const store = readStore(stateDir);
  const before = store.consumers.length;
  store.consumers = store.consumers.filter(c => c.id !== id);
  if (store.consumers.length === before) return false;
  writeStore(store, stateDir);
  return true;
}

/** Owner (null) sees all sources; a grant filters to its allowlist ('*' = all). */
export function filterSourcesForConsumer(sources: FederatedSource[], consumer: ResolvedConsumer | null): FederatedSource[] {
  if (consumer === null) return sources;
  if (consumer.sources === '*') return sources;
  const allow = new Set(consumer.sources);
  return sources.filter(s => allow.has(s.id));
}

export function consumerCanReadVault(consumer: ResolvedConsumer | null): boolean {
  return consumer === null || consumer.vault === 'r';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <hearth> && bun test tests/consumer-registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/consumer-registry.ts tests/consumer-registry.test.ts
git commit -m "feat(consumer): grant registry + token verify + source filter

~/.hearth/consumers.json store (0600, hashed tokens), constant-time
resolveConsumer, add/list/remove, and the pure filterSourcesForConsumer /
consumerCanReadVault helpers the query path enforces with. Fail-closed:
missing/malformed store => no grants.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Consumer identity at spawn

**Files:**
- Modify: `src/mcp-server.ts` (`ServerContext`, `createMcpServer` unchanged, `startStdioServer` signature)
- Modify: `src/cli/index.ts` (`resolveServeConsumer` + `cmdMcp` + parseArgs options)
- Test: `tests/consumer-registry.test.ts` (append `resolveServeConsumer` cases) — or a new `tests/cli-consumer-serve.test.ts`

**Interfaces:**
- Consumes: `resolveConsumer`, `ResolvedConsumer`, `DeniedConsumer`, `ConsumerIdentity` from `../core/consumer-registry.ts`.
- Produces:
  - `ServerContext.consumer?: ConsumerIdentity` (in mcp-server.ts; `undefined`/`null` both mean owner-full).
  - `startStdioServer(vaultRoot: string, consumer?: ConsumerIdentity): Promise<void>` (new optional param, default owner-full).
  - `resolveServeConsumer(opts: { id?: string; token?: string; stateDir?: string }): ConsumerIdentity` (exported from `cli/index.ts`) — no id+no token → `null` (owner); id XOR token present → `{ denied: 'bad_token', id }`; both present → `resolveConsumer(...)`.

- [ ] **Step 1: Add the failing test**

```ts
// append to tests/consumer-registry.test.ts
import { resolveServeConsumer } from '../src/cli/index.ts';

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <hearth> && bun test tests/consumer-registry.test.ts -t resolveServeConsumer`
Expected: FAIL (`resolveServeConsumer` is not exported).

- [ ] **Step 3: Implement**

In `src/mcp-server.ts`:
- Import: `import type { ConsumerIdentity } from './core/consumer-registry.ts';`
- Add to `ServerContext`:
```ts
  /**
   * Phase 3: the authenticated consumer this server process serves.
   * undefined/null = owner-full (backward-compatible; existing spawns and
   * the owner's own tools). A ResolvedConsumer scopes the query path; a
   * DeniedConsumer marker makes every vault_query fail closed.
   */
  consumer?: ConsumerIdentity;
```
- Change `startStdioServer`:
```ts
export async function startStdioServer(vaultRoot: string, consumer?: ConsumerIdentity): Promise<void> {
  const server = createMcpServer({ vaultRoot, consumer });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

In `src/cli/index.ts`:
- Import: `import { resolveConsumer, type ConsumerIdentity } from '../core/consumer-registry.ts';` (match existing relative import depth — sibling files use `./core/...`? cli is at `src/cli/`, core at `src/core/`, so use `../core/consumer-registry.ts`).
- Add exported resolver:
```ts
export function resolveServeConsumer(opts: { id?: string; token?: string; stateDir?: string }): ConsumerIdentity {
  const id = opts.id?.trim() || undefined;
  const token = opts.token || undefined;
  if (!id && !token) return null;                                  // owner-full
  if (!id || !token) return { denied: 'bad_token', ...(id ? { id } : {}) }; // both required together
  return resolveConsumer(id, token, opts.stateDir);
}
```
- In `cmdMcp`, after the SCHEMA.md check, before `startStdioServer`:
```ts
  const consumer = resolveServeConsumer({
    id: (values.consumer as string | undefined) ?? process.env.HEARTH_CONSUMER_ID,
    token: (values['consumer-token'] as string | undefined) ?? process.env.HEARTH_CONSUMER_TOKEN,
    // stateDir omitted → ~/.hearth (same place addConsumer writes)
  });
  if (consumer && 'denied' in consumer) {
    process.stderr.write(`hearth mcp serve: consumer auth failed (${consumer.denied}); serving in DENIED mode (all queries refused)\n`);
  } else if (consumer) {
    process.stderr.write(`hearth mcp serve: consumer=${consumer.id} vault=${consumer.vault} sources=${consumer.sources === '*' ? '*' : consumer.sources.join(',')}\n`);
  }
  await startStdioServer(vault, consumer);
```
  (Replace the existing `await startStdioServer(vault);` line.)
- Add to the `parseArgs` `options` map: `consumer: { type: 'string' }, 'consumer-token': { type: 'string' },`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <hearth> && bun test tests/consumer-registry.test.ts`
Expected: PASS (6 tests). Also run `bun test tests/mcp-server-federate.test.ts` — the owner-full path (`createMcpServer({ vaultRoot })`, consumer undefined) must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts src/cli/index.ts tests/consumer-registry.test.ts
git commit -m "feat(consumer): resolve consumer identity at mcp serve spawn

ServerContext.consumer + startStdioServer(vaultRoot, consumer?). cmdMcp
reads --consumer/--consumer-token (or HEARTH_CONSUMER_ID/TOKEN env, the
recommended path) and resolves to owner-full (no creds) | grant | denied.
No creds => byte-identical to Phase 2a.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Enforcement + audit in the query path

**Files:**
- Modify: `src/core/query.ts` (`federatedQuery` gains `consumer` opt)
- Modify: `src/core/audit.ts` (add `'query'` to `AuditEvent`)
- Modify: `src/mcp-server.ts` (`vault_query` handler: denial refuse, vault-grant gate, pass consumer, audit)
- Test: `tests/consumer-enforcement.test.ts`

**Interfaces:**
- Consumes: `filterSourcesForConsumer`, `consumerCanReadVault`, `ResolvedConsumer`, `ConsumerIdentity` from `./consumer-registry.ts` (query.ts) / `./core/consumer-registry.ts` (mcp-server.ts); `hashToken` for the audit question hash (or inline `createHash`).
- Produces:
  - `federatedQuery(vaultRoot, question, opts?)` with added `opts.consumer?: ResolvedConsumer | null` (default `null` = owner). Local `queryFn` leg runs iff `consumerCanReadVault(consumer)`; sources filtered via `filterSourcesForConsumer(loadSources(...), consumer)`.
  - `AuditEvent` union includes `'query'`.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd <hearth> && bun test tests/consumer-enforcement.test.ts`
Expected: FAIL (`federatedQuery` ignores `consumer`; owner test may pass but the vault:none / allowlist tests fail because all sources are queried and queryFn always runs).

- [ ] **Step 3: Implement**

In `src/core/audit.ts`, add `'query'` to the `AuditEvent` union (e.g. after `'mcp.tool_called'`):
```ts
  | 'query'
```

In `src/core/query.ts` `federatedQuery`:
- Import: `import { filterSourcesForConsumer, consumerCanReadVault, type ResolvedConsumer } from './consumer-registry.ts';`
- Add `consumer?: ResolvedConsumer | null;` to the `opts` type.
- Replace the local + source-gathering block:
```ts
  const consumer = opts?.consumer ?? null;
  const local = consumerCanReadVault(consumer)
    ? queryFn(vaultRoot, question, { limit: opts?.limit, minScore: opts?.minScore }).hits
    : [];

  const sources = filterSourcesForConsumer(loadSources(opts?.stateDir), consumer);
  const federated: QueryHit[] = [];
  for (const source of sources) {
    try { federated.push(...(await sourceQueryFn(source, question))); }
    catch (err) { console.warn(`[hearth] federatedQuery: source "${source.id}" threw unexpectedly (should have fail-opened):`, err); }
  }
```
(The clamp/sort/return tail is unchanged.)

In `src/mcp-server.ts` `vault_query` handler — replace the whole `if (name === 'vault_query') { ... }` block:
```ts
      if (name === 'vault_query') {
        const question = String(args.question ?? '');
        const consumer = ctx.consumer ?? null;
        const qhash = 'sha256:' + createHash('sha256').update(question, 'utf8').digest('hex');

        // Fail-closed: a denied consumer is refused for EVERY query (even
        // pure-local), and neither the vault nor any source is touched.
        if (consumer && 'denied' in consumer) {
          await audit(ctx.vaultRoot, { event: 'query', initiated_by: 'mcp',
            data: { consumer: consumer.id ?? 'unknown', denied: true, reason: consumer.denied,
                    question_sha256: qhash, vault_included: false, sources_consulted: [] } }).catch(() => {});
          return jsonContent({ answer: `permission denied: ${consumer.denied}`, hits: [], denied: true });
        }

        const grant = consumer as (import('./core/consumer-registry.ts').ResolvedConsumer | null);
        const federate = args.federate === true;
        const vaultIncluded = consumerCanReadVault(grant);

        let result;
        let sourcesConsulted: string[] = [];
        if (federate) {
          result = await (ctx.federatedQueryFn ?? federatedQuery)(ctx.vaultRoot, question, { stateDir: stateDirFor(ctx), consumer: grant });
          sourcesConsulted = filterSourcesForConsumer(loadSources(stateDirFor(ctx)), grant).map(s => s.id);
        } else if (vaultIncluded) {
          result = query(ctx.vaultRoot, question);
        } else {
          result = { question, hits: [], no_answer_message: NO_ANSWER };
        }

        await audit(ctx.vaultRoot, { event: 'query', initiated_by: 'mcp',
          data: { consumer: grant?.id ?? 'owner', denied: false, question_sha256: qhash,
                  vault_included: vaultIncluded, sources_consulted: sourcesConsulted } }).catch(() => {});

        if (result.hits.length === 0) return { content: [{ type: 'text' as const, text: NO_ANSWER }] };
        return jsonContent(result);
      }
```
- Add imports to mcp-server.ts: `import { createHash } from 'node:crypto';`, `import { filterSourcesForConsumer, consumerCanReadVault } from './core/consumer-registry.ts';`, and `import { loadSources } from './core/source-registry.ts';` (if not already imported — check; query.ts imports it, mcp-server may not).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <hearth> && bun test tests/consumer-enforcement.test.ts tests/mcp-server-federate.test.ts tests/federated-query.test.ts`
Expected: PASS — the three new enforcement tests, AND the existing federate/query suites unchanged (owner-full byte-identical).

- [ ] **Step 5: Commit**

```bash
git add src/core/query.ts src/core/audit.ts src/mcp-server.ts tests/consumer-enforcement.test.ts
git commit -m "feat(consumer): enforce grants in query path + hashed query audit

federatedQuery honors consumer: vault leg gated by consumerCanReadVault,
sources filtered by allowlist (ungranted sources never queried). vault_query
refuses denied consumers absolutely (even federate:false), touching neither
vault nor sources. Every query writes a 'query' audit event with the
question hashed (never plaintext). Owner (consumer=null) unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Management CLI (`hearth consumer add/list/rm`)

**Files:**
- Modify: `src/cli/index.ts` (`cmdConsumer`, parseArgs `sources` option, switch `case 'consumer'`)
- Test: `tests/cli-consumer.test.ts`

**Interfaces:**
- Consumes: `addConsumer`, `listConsumers`, `removeConsumer` from `../core/consumer-registry.ts`.
- Produces: `cmdConsumer(positionals, values)` routed from `main()`'s switch. CLI: `hearth consumer add <id> --sources <csv|*> [--vault r|none] [--state-dir <dir>]`, `hearth consumer list [--state-dir <dir>]`, `hearth consumer rm <id> [--state-dir <dir>]`.

**Note:** the tests drive `cmdConsumer` directly (not a subprocess) so they can pass `--state-dir` to a tmp dir and capture `process.stdout.write`. `cmdConsumer` must therefore read `values['state-dir']` and pass it through as `stateDir`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/cli-consumer.test.ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd <hearth> && bun test tests/cli-consumer.test.ts`
Expected: FAIL (`cmdConsumer` not exported).

- [ ] **Step 3: Implement**

In `src/cli/index.ts`:
- Import: extend the consumer-registry import to `import { resolveConsumer, addConsumer, listConsumers, removeConsumer, type ConsumerIdentity } from '../core/consumer-registry.ts';`
- Add `sources: { type: 'string' },` to the `parseArgs` `options` map (alongside the Task 2 `consumer`/`consumer-token` additions).
- Add the command:
```ts
export function cmdConsumer(positionals: string[], values: Record<string, string | boolean | undefined>): void {
  const sub = positionals[0];
  const stateDir = (values['state-dir'] as string | undefined) ?? undefined;

  if (sub === 'add') {
    const id = positionals[1];
    if (!id) fail('consumer add: missing <id>. usage: hearth consumer add <id> --sources <csv|*> [--vault r|none]');
    const rawSources = (values.sources as string | undefined);
    if (!rawSources) fail('consumer add: missing --sources <csv|*> (e.g. --sources wechat-cc  or  --sources "*")');
    const sources: '*' | string[] = rawSources.trim() === '*' ? '*' : rawSources.split(',').map(s => s.trim()).filter(Boolean);
    const vault = (values.vault as string | undefined) ?? 'r';
    if (vault !== 'r' && vault !== 'none') fail(`consumer add: --vault must be r|none (got "${vault}")`);
    const { token } = addConsumer({ id, sources, vault, stateDir });
    const srcLabel = sources === '*' ? '*' : sources.join(',');
    process.stdout.write(
      `✓ consumer "${id}" added (vault=${vault}, sources=${srcLabel})\n\n` +
      `token: ${token}\n\n` +
      `⚠ This token is shown ONLY now — hearth stores only its hash. Save it.\n` +
      `Wire the consuming app's MCP server to launch hearth with:\n` +
      `  command: hearth\n  args: ["mcp","serve","--vault","<vault>"]\n` +
      `  env: { "HEARTH_CONSUMER_ID": "${id}", "HEARTH_CONSUMER_TOKEN": "${token}" }\n` +
      `(env is preferred over --consumer-token so the token isn't visible in ps.)\n`,
    );
    return;
  }

  if (!sub || sub === 'list') {
    const list = listConsumers(stateDir);
    if (list.length === 0) { process.stdout.write('no consumers registered.\n'); return; }
    process.stdout.write('id                    vault   sources\n');
    for (const c of list) {
      const srcs = c.sources === '*' ? '*' : c.sources.join(',');
      process.stdout.write(`${c.id.padEnd(20)}  ${c.vault.padEnd(6)}  ${srcs}\n`);
    }
    return;
  }

  if (sub === 'rm') {
    const id = positionals[1];
    if (!id) fail('consumer rm: missing <id>. usage: hearth consumer rm <id>');
    const removed = removeConsumer(id, stateDir);
    process.stdout.write(removed ? `✓ consumer "${id}" removed\n` : `consumer "${id}" not found (nothing removed)\n`);
    return;
  }

  fail(`consumer: unknown subcommand "${sub}". expected: add | list | rm`);
}
```
- Add to `main()`'s switch: `case 'consumer': return cmdConsumer(positionals, values);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <hearth> && bun test tests/cli-consumer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite**

Run: `cd <hearth> && bun test`
Expected: all suites green (new + existing; owner-full paths unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts tests/cli-consumer.test.ts
git commit -m "feat(consumer): hearth consumer add|list|rm management CLI

add generates a bearer token (printed once, only the hash stored) and emits
an env-based MCP-config snippet; list shows id/vault/sources (no hashes);
rm revokes. --sources csv|* , --vault r|none , --state-dir for tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Verify-against-real (after Task 4, before finishing)

Not a task — a manual gate the controller runs (or dispatches) once all tasks are green, per spec §Verification:

1. In the hearth clone, build a throwaway vault + a `sources.json` pointing at the real wechat-cc `federated_query` (as used in Phase 2a verify). Use a tmp `--state-dir` OR the real `~/.hearth`.
2. `hearth consumer add codex --sources wechat-cc --vault r` and `hearth consumer add guest --sources "" --vault r` (guest: vault-only, no sources).
3. Spawn `HEARTH_CONSUMER_ID=codex HEARTH_CONSUMER_TOKEN=<tok> hearth mcp serve --vault <v>`; issue `vault_query{question, federate:true}` → expect vault hits + wechat federated hits.
4. Spawn as `guest` → expect vault hits, **zero** federated hits.
5. Spawn with a wrong token → `vault_query` returns `{ denied: true }`, zero hits.
6. Spawn with **no** consumer env → unchanged full federate (owner).
7. Confirm `~/.hearth/consumers.json` (or the tmp state dir) is `0600` and contains only `sha256:` hashes; `hearth log --vault <v>` shows one `query` event per call with hashed `question_sha256` and correct `sources_consulted`.

Record the result in the ledger; do not commit throwaway vault/state artifacts.

---

## Self-Review

- **Spec coverage:** A→Task 1 (registry+token+filter helper); B→Task 2 (spawn identity); C→Task 3 (enforcement in federatedQuery + vault_query); D→Task 3 (audit); E→Task 4 (CLI). Verify-against-real → the manual gate. All spec scope items map to a task.
- **Type consistency:** `ConsumerGrant`/`ResolvedConsumer`/`DeniedConsumer`/`ConsumerIdentity` defined in Task 1, consumed unchanged in Tasks 2–4. `filterSourcesForConsumer`/`consumerCanReadVault` signatures used identically in Task 3. `resolveServeConsumer` (Task 2) and `cmdConsumer` (Task 4) both exported from `cli/index.ts` for direct unit testing. `startStdioServer(vaultRoot, consumer?)` new param matched at the single call site in `cmdMcp`.
- **Placeholder scan:** none — every step carries real code.
- **Backward-compat:** owner-full (`consumer==null`/undefined) explicitly asserted unchanged in Tasks 2–3 by re-running `mcp-server-federate`/`federated-query` suites; `federatedQuery` default `consumer=null` preserves the Phase 2a path.
```
