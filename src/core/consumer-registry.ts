// Consumer permission registry — per-consumer × per-source grants at
// ~/.hearth/consumers.json. hearth is a broker: a consuming app authenticates
// as a named consumer (id + bearer token) and gets a grant (vault r|none,
// source allowlist). We store only the token HASH; verification is
// constant-time. Malformed/missing store => no grants (fail-closed).

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
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
  if (c.sources !== '*') {
    if (!Array.isArray(c.sources)) return false;
    if (!c.sources.every(s => typeof s === 'string')) return false;
  }
  return true;
}

function writeStore(store: Store, stateDir?: string): void {
  const dir = stateDir ?? defaultStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = storePath(stateDir);
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync mode is create-only; force 0600 on overwrite too
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
