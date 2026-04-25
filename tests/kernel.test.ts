// hearth v0.1 — the 4 core DoD tests from docs/ROADMAP.md
//
// 1. no SCHEMA.md, no compile
// 2. ingest creates ChangePlan, not wiki files
// 3. pending apply respects SCHEMA permission table
// 4. update op fails on base_hash mismatch
//
// (Tests 5-7 — query-no-grounding, lint-read-only, raw/ append-only — arrive
// alongside the query/lint implementations.)

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSchema, SchemaError, permits } from '../src/core/schema.ts';
import { createKernel } from '../src/core/vault-kernel.ts';
import { mockIngest } from '../src/ingest/mock.ts';
import { sha256, fileHash } from '../src/core/hash.ts';
import { PendingStore } from '../src/core/pending-store.ts';
import type { ChangePlan } from '../src/core/types.ts';

const SCHEMA_FIXTURE = `---
type: meta
---

# Test Vault Contract

| dir         | human | agent |
|-------------|-------|-------|
| raw/        | add   | add   |
| 00 Inbox/   | rw    | none  |
| 01 Topics/  | r     | rw    |
| 02 Maps/    | r     | rw    |
| 99 Assets/  | rw    | add   |
`;

function makeVault(withSchema: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-vault-'));
  for (const d of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  if (withSchema) {
    writeFileSync(join(root, 'SCHEMA.md'), SCHEMA_FIXTURE);
  }
  return root;
}

function makeSource(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-src-'));
  const path = join(dir, 'sample.md');
  writeFileSync(path, '# Sample\n\nThis is a test source for hearth.\n');
  return path;
}

describe('hearth v0.1 — core trust loop', () => {
  describe('Test 1: no SCHEMA.md → no compile', () => {
    it('loadSchema throws SchemaError when SCHEMA.md is absent', () => {
      const vault = makeVault(false);
      expect(() => loadSchema(vault)).toThrow(SchemaError);
      expect(() => loadSchema(vault)).toThrow(/SCHEMA\.md not found/);
    });

    it('loadSchema succeeds when SCHEMA.md is present', () => {
      const vault = makeVault(true);
      const schema = loadSchema(vault);
      expect(schema.rules.length).toBeGreaterThan(0);
    });
  });

  describe('Test 2: ingest creates ChangePlan, writes nothing', () => {
    it('mockIngest produces a ChangePlan with no side effects on the vault', () => {
      const vault = makeVault(true);
      const source = makeSource();
      // Snapshot every wiki dir before ingest
      const before = readdirSync(join(vault, '01 Topics'));
      const beforeRaw = readdirSync(join(vault, 'raw'));

      const { plan } = mockIngest(source, { vaultRoot: vault });

      // Plan exists, has the expected shape
      expect(plan.change_id).toMatch(/^\d{8}T\d{4}-/);
      expect(plan.ops).toHaveLength(2);
      expect(plan.requires_review).toBe(true);
      expect(plan.ops[0]?.op).toBe('create');
      expect(plan.ops[0]?.path).toMatch(/^raw\//);
      expect(plan.ops[1]?.op).toBe('create');
      expect(plan.ops[1]?.path).toMatch(/^01 Topics\//);

      // Vault is unchanged — no wiki files written by the ingest call itself
      expect(readdirSync(join(vault, '01 Topics'))).toEqual(before);
      expect(readdirSync(join(vault, 'raw'))).toEqual(beforeRaw);
    });
  });

  describe('Test 3: pending apply respects SCHEMA permission table', () => {
    let vault: string;
    let store: PendingStore;
    let plan: ChangePlan;

    beforeEach(() => {
      vault = makeVault(true);
      const dir = mkdtempSync(join(tmpdir(), 'hearth-pending-'));
      store = new PendingStore(dir);
      const source = makeSource();
      plan = mockIngest(source, { vaultRoot: vault }).plan;
    });

    it('applies a valid plan and writes only allowed paths', () => {
      const schema = loadSchema(vault);
      const kernel = createKernel(vault, schema);
      const result = kernel.apply(plan);

      expect(result.ok).toBe(true);
      expect(result.ops.every(o => o.ok)).toBe(true);

      // Verify the writes landed where the SCHEMA allows agent rw / add
      expect(existsSync(join(vault, plan.ops[0]!.path))).toBe(true);
      expect(existsSync(join(vault, plan.ops[1]!.path))).toBe(true);
    });

    it('rejects an op that targets a human-only zone (00 Inbox/)', () => {
      const schema = loadSchema(vault);
      const kernel = createKernel(vault, schema);

      const badPlan: ChangePlan = {
        ...plan,
        change_id: 'test-bad',
        ops: [{
          op: 'create',
          path: '00 Inbox/agent-should-not-write-here.md',
          reason: 'attempted violation',
          precondition: { exists: false },
          patch: { type: 'replace', value: '# Nope\n' },
        }],
      };

      const result = kernel.apply(badPlan);
      expect(result.ok).toBe(false);
      expect(result.ops[0]?.error).toMatch(/agent lacks create permission/);
      expect(existsSync(join(vault, '00 Inbox/agent-should-not-write-here.md'))).toBe(false);
    });

    it('rejects an op that targets a path outside any SCHEMA rule', () => {
      const schema = loadSchema(vault);
      const kernel = createKernel(vault, schema);

      const badPlan: ChangePlan = {
        ...plan,
        change_id: 'test-out-of-scope',
        ops: [{
          op: 'create',
          path: 'arbitrary/path.md',
          reason: 'no rule covers this dir',
          precondition: { exists: false },
          patch: { type: 'replace', value: '# Nope\n' },
        }],
      };
      const result = kernel.apply(badPlan);
      expect(result.ok).toBe(false);
      expect(result.ops[0]?.error).toMatch(/agent lacks/);
    });
  });

  describe('Test 4: update op fails on base_hash mismatch (concurrency / staleness)', () => {
    it('apply rejects an update whose base_hash no longer matches', () => {
      const vault = makeVault(true);
      const schema = loadSchema(vault);
      const kernel = createKernel(vault, schema);

      // Bootstrap: write an existing concept page
      const conceptPath = '01 Topics/RAG.md';
      const original = '# RAG\n\nOriginal content.\n';
      writeFileSync(join(vault, conceptPath), original);
      const baseHash = sha256(original);

      // User edits the file in their editor (e.g. Obsidian) AFTER plan was made
      writeFileSync(join(vault, conceptPath), '# RAG\n\nHuman-edited content.\n');

      // Plan that thinks the file is still at original
      const stalePlan: ChangePlan = {
        change_id: 'test-stale',
        source_id: 'sha256:fake',
        risk: 'low',
        ops: [{
          op: 'update',
          path: conceptPath,
          reason: 'agent thinks it is updating the original',
          precondition: { exists: true, base_hash: baseHash },
          patch: { type: 'replace', value: '# RAG\n\nAGENT-OVERWRITTEN.\n' },
        }],
        requires_review: true,
        created_at: new Date().toISOString(),
      };

      const result = kernel.apply(stalePlan);
      expect(result.ok).toBe(false);
      expect(result.ops[0]?.error).toMatch(/target file changed since ChangePlan/);
      // Crucially: human's edit is still there. The agent did NOT clobber it.
      expect(readFileSync(join(vault, conceptPath), 'utf8')).toContain('Human-edited content');
    });

    it('apply succeeds when base_hash still matches', () => {
      const vault = makeVault(true);
      const schema = loadSchema(vault);
      const kernel = createKernel(vault, schema);

      const path = '01 Topics/concept.md';
      const original = '# Concept\n\nv1.\n';
      writeFileSync(join(vault, path), original);
      const baseHash = sha256(original);

      const plan: ChangePlan = {
        change_id: 'test-fresh',
        source_id: 'sha256:fake',
        risk: 'low',
        ops: [{
          op: 'update',
          path,
          reason: 'normal update',
          precondition: { exists: true, base_hash: baseHash },
          patch: { type: 'replace', value: '# Concept\n\nv2.\n' },
        }],
        requires_review: true,
        created_at: new Date().toISOString(),
      };

      const result = kernel.apply(plan);
      expect(result.ok).toBe(true);
      expect(readFileSync(join(vault, path), 'utf8')).toContain('v2');
    });
  });

  describe('schema permission helpers', () => {
    it('agent may add to raw/ but not modify', () => {
      const vault = makeVault(true);
      const schema = loadSchema(vault);
      expect(permits(schema, 'agent', 'create', 'raw/foo.md')).toBe(true);
      expect(permits(schema, 'agent', 'update', 'raw/foo.md')).toBe(false);
      expect(permits(schema, 'agent', 'delete', 'raw/foo.md')).toBe(false);
    });

    it('agent has full rw on 01 Topics/ and 02 Maps/', () => {
      const vault = makeVault(true);
      const schema = loadSchema(vault);
      expect(permits(schema, 'agent', 'create', '01 Topics/x.md')).toBe(true);
      expect(permits(schema, 'agent', 'update', '01 Topics/x.md')).toBe(true);
      expect(permits(schema, 'agent', 'create', '02 Maps/y.md')).toBe(true);
    });

    it('agent has zero access to 00 Inbox/', () => {
      const vault = makeVault(true);
      const schema = loadSchema(vault);
      expect(permits(schema, 'agent', 'create', '00 Inbox/draft.md')).toBe(false);
      expect(permits(schema, 'agent', 'update', '00 Inbox/draft.md')).toBe(false);
      expect(permits(schema, 'agent', 'read', '00 Inbox/draft.md')).toBe(false);
    });
  });
});
