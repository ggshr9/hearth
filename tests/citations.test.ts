// hearth v0.1.2 — citations + lint + query tests (DoD 5/6/7 + ChatGPT spec)

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/core/hash.ts';
import { loadSchema } from '../src/core/schema.ts';
import { createKernel } from '../src/core/vault-kernel.ts';
import { verifyClaim, buildClaimIndex } from '../src/core/citations.ts';
import { lint } from '../src/core/lint.ts';
import { query, NO_ANSWER } from '../src/core/query.ts';
import type { Claim, ChangePlan } from '../src/core/types.ts';

const SCHEMA_FIXTURE = `---
type: meta
---

# Test

| dir         | human | agent |
|-------------|-------|-------|
| raw/        | add   | add   |
| 00 Inbox/   | rw    | none  |
| 01 Topics/  | r     | rw    |
| 02 Maps/    | r     | rw    |
| 99 Assets/  | rw    | add   |
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-cit-'));
  for (const d of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA_FIXTURE);
  return root;
}

function writeSource(vault: string, name: string, content: string): string {
  const p = join(vault, 'raw', name);
  writeFileSync(p, content);
  return `raw/${name}`;
}

function writeWikiPage(vault: string, relPath: string, frontmatter: Record<string, unknown>, body: string): string {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join('\n');
  const claims = (frontmatter.claims as Claim[] | undefined);
  // gray-matter handles structured YAML — write it directly
  const fm = ['---', ...Object.entries(frontmatter).filter(([k]) => k !== 'claims').map(([k, v]) => `${k}: ${JSON.stringify(v)}`)];
  if (claims) {
    fm.push('claims:');
    for (const c of claims) {
      fm.push(`  - text: ${JSON.stringify(c.text)}`);
      fm.push(`    source: ${JSON.stringify(c.source)}`);
      fm.push(`    anchor:`);
      const a = c.anchor;
      if (a.type === 'line') {
        fm.push(`      type: line`);
        fm.push(`      line_start: ${a.line_start}`);
        fm.push(`      line_end: ${a.line_end}`);
        fm.push(`      quote: ${JSON.stringify(a.quote)}`);
        fm.push(`      quote_hash: ${JSON.stringify(a.quote_hash)}`);
      }
      fm.push(`    confidence: ${c.confidence}`);
    }
  }
  fm.push('---', '', body);
  void yaml;
  const full = join(vault, relPath);
  mkdirSync(join(vault, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(full, fm.join('\n') + '\n');
  return relPath;
}

describe('citations: claim verification', () => {
  it('Test 5a: verified — quote exists + hash matches', () => {
    const vault = makeVault();
    const quote = 'Hearth is a personal AI runtime.';
    writeSource(vault, 'a.md', `# A\n\n${quote}\n`);

    const claim: Claim = {
      text: quote,
      source: 'raw/a.md',
      anchor: { type: 'line', line_start: 3, line_end: 3, quote, quote_hash: sha256(quote) },
      confidence: 'high',
    };
    expect(verifyClaim(vault, claim).status).toBe('verified');
  });

  it('Test 5b: source_missing — referenced source not in vault', () => {
    const vault = makeVault();
    const claim: Claim = {
      text: 'foo',
      source: 'raw/does-not-exist.md',
      anchor: { type: 'line', line_start: 1, line_end: 1, quote: 'foo', quote_hash: sha256('foo') },
      confidence: 'high',
    };
    expect(verifyClaim(vault, claim).status).toBe('source_missing');
  });

  it('Test 5c: quote_missing — source exists but quote not in it', () => {
    const vault = makeVault();
    writeSource(vault, 'a.md', 'Some other text entirely.\n');
    const claim: Claim = {
      text: 'foo',
      source: 'raw/a.md',
      anchor: { type: 'line', line_start: 1, line_end: 1, quote: 'this quote is fictional', quote_hash: sha256('this quote is fictional') },
      confidence: 'high',
    };
    expect(verifyClaim(vault, claim).status).toBe('quote_missing');
  });

  it('Test 5d: hash_mismatch — quote present, hash wrong', () => {
    const vault = makeVault();
    const real = 'real quote here';
    writeSource(vault, 'a.md', real);
    const claim: Claim = {
      text: 'something',
      source: 'raw/a.md',
      anchor: { type: 'line', line_start: 1, line_end: 1, quote: real, quote_hash: sha256('different content') },
      confidence: 'high',
    };
    expect(verifyClaim(vault, claim).status).toBe('hash_mismatch');
  });

  it('buildClaimIndex walks the vault and aggregates verified vs invalid', () => {
    const vault = makeVault();
    const quote = 'A real quote that exists.';
    writeSource(vault, 'src1.md', `# Src1\n\n${quote}\n`);

    writeWikiPage(vault, '01 Topics/p1.md', { type: 'concept', status: 'draft', author: 'agent:wiki' }, '# P1\n');
    writeWikiPage(vault, '01 Topics/p2.md', {
      type: 'concept', status: 'draft', author: 'agent:wiki',
      claims: [
        { text: quote, source: 'raw/src1.md', anchor: { type: 'line', line_start: 3, line_end: 3, quote, quote_hash: sha256(quote) }, confidence: 'high' },
        { text: 'fake', source: 'raw/missing.md', anchor: { type: 'line', line_start: 1, line_end: 1, quote: 'fake', quote_hash: sha256('fake') }, confidence: 'low' },
      ],
    }, '# P2\n');

    const idx = buildClaimIndex(vault);
    expect(idx.records).toHaveLength(2);
    expect(idx.verified()).toHaveLength(1);
    expect(idx.invalid()).toHaveLength(1);
    expect(idx.invalid()[0]?.status).toBe('source_missing');
  });
});

describe('lint: read-only auditor', () => {
  it('Test 6: lint is read-only — vault hash unchanged before & after run', () => {
    const vault = makeVault();
    const quote = 'a stable verified quote';
    writeSource(vault, 'a.md', quote);
    writeWikiPage(vault, '01 Topics/p.md', {
      type: 'concept', status: 'draft', author: 'agent:wiki',
      claims: [{ text: quote, source: 'raw/a.md', anchor: { type: 'line', line_start: 1, line_end: 1, quote, quote_hash: sha256(quote) }, confidence: 'high' }],
    }, '# P\n');

    function snapshotMtimes(): Record<string, number> {
      const out: Record<string, number> = {};
      function walk(dir: string): void {
        const { readdirSync, statSync } = require('node:fs');
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else out[full] = st.mtimeMs;
        }
      }
      walk(vault);
      return out;
    }

    const before = snapshotMtimes();
    const schema = loadSchema(vault);
    const report = lint(vault, schema);
    const after = snapshotMtimes();

    expect(report).toBeDefined();
    expect(Object.keys(before)).toEqual(Object.keys(after));
    for (const k of Object.keys(before)) {
      expect(after[k]).toBe(before[k]);
    }
  });

  it('detects citation-drift when claim quote no longer exists in source', () => {
    const vault = makeVault();
    const wrongQuote = 'a quote not actually present';
    writeSource(vault, 'a.md', 'this source contains entirely different text');
    writeWikiPage(vault, '01 Topics/p.md', {
      type: 'concept', status: 'draft', author: 'agent:wiki',
      claims: [{ text: wrongQuote, source: 'raw/a.md', anchor: { type: 'line', line_start: 1, line_end: 1, quote: wrongQuote, quote_hash: sha256(wrongQuote) }, confidence: 'high' }],
    }, '# P\n');
    writeWikiPage(vault, '02 Maps/m.md', { type: 'moc' }, '# M\n\n[[p]]\n');

    const schema = loadSchema(vault);
    const report = lint(vault, schema);
    const drift = report.findings.filter(f => f.rule === 'citation-drift');
    expect(drift.length).toBeGreaterThan(0);
    expect(drift[0]?.message).toMatch(/quote_missing/);
  });

  it('detects single-source-stable when stable page has only one source', () => {
    const vault = makeVault();
    writeSource(vault, 'a.md', 'q');
    writeWikiPage(vault, '01 Topics/lonely.md', { type: 'concept', status: 'stable', sources: ['raw/a.md'] }, '# Lonely\n');
    writeWikiPage(vault, '02 Maps/m.md', { type: 'moc' }, '# M\n\n[[lonely]]\n');

    const schema = loadSchema(vault);
    const report = lint(vault, schema);
    const f = report.findings.find(x => x.rule === 'single-source-stable');
    expect(f).toBeDefined();
    expect(f?.message).toMatch(/only 1 source/);
  });

  it('detects orphan: page not linked from any other wiki page', () => {
    const vault = makeVault();
    writeWikiPage(vault, '01 Topics/orphan.md', { type: 'concept', status: 'draft' }, '# Orphan\n');
    // No MOC linking to it
    const schema = loadSchema(vault);
    const report = lint(vault, schema);
    const f = report.findings.find(x => x.rule === 'orphan');
    expect(f?.page).toBe('01 Topics/orphan.md');
  });
});

describe('query: deliberately conservative', () => {
  it('Test 7: no verified claim → exactly "no answer found in vault"', () => {
    const vault = makeVault();
    // Vault is empty — no wiki pages, no claims
    const schema = loadSchema(vault);
    void schema;
    const r = query(vault, 'what is hearth?');
    expect(r.hits).toEqual([]);
    expect(r.no_answer_message).toBe(NO_ANSWER);
    expect(NO_ANSWER).toBe('no answer found in vault'); // literal string, contract
  });

  it('returns matching verified claims with citations', () => {
    const vault = makeVault();
    const quote = 'Hearth is a personal AI runtime for your markdown vault.';
    writeSource(vault, 'a.md', quote);
    writeWikiPage(vault, '01 Topics/intro.md', {
      type: 'concept', status: 'draft', author: 'agent:extract',
      claims: [{ text: quote, source: 'raw/a.md', anchor: { type: 'line', line_start: 1, line_end: 1, quote, quote_hash: sha256(quote) }, confidence: 'high' }],
    }, '# Intro\n');

    const r = query(vault, 'what is hearth?');
    expect(r.hits.length).toBeGreaterThan(0);
    const hit = r.hits[0]!;
    expect(hit.claim_text).toBe(quote);
    expect(hit.source).toBe('raw/a.md');
    expect(hit.anchor_summary).toBe('L1-L1');
    expect(hit.confidence).toBe('high');
  });

  it('does NOT return claims that fail verification (drift / missing source)', () => {
    const vault = makeVault();
    // Source missing for the claim — should NOT surface in query results
    writeWikiPage(vault, '01 Topics/bad.md', {
      type: 'concept', status: 'draft', author: 'agent:wiki',
      claims: [{ text: 'fabricated', source: 'raw/missing.md', anchor: { type: 'line', line_start: 1, line_end: 1, quote: 'fabricated', quote_hash: sha256('fabricated') }, confidence: 'high' }],
    }, '# Bad\n');

    const r = query(vault, 'fabricated');
    expect(r.hits).toEqual([]);
    expect(r.no_answer_message).toBe(NO_ANSWER);
  });
});

describe('kernel: raw/ append-only is permission-enforced (Test 7)', () => {
  it('update op on existing raw/ file is rejected by the kernel (not just lint)', () => {
    const vault = makeVault();
    writeSource(vault, 'fixed.md', 'original');
    const schema = loadSchema(vault);
    const kernel = createKernel(vault, schema);

    const plan: ChangePlan = {
      change_id: 'test-raw-update',
      source_id: 'sha256:fake',
      risk: 'low',
      ops: [{
        op: 'update',
        path: 'raw/fixed.md',
        reason: 'attempted modification of append-only zone',
        precondition: { exists: true, base_hash: sha256('original') },
        patch: { type: 'replace', value: 'tampered' },
      }],
      requires_review: true,
      created_at: new Date().toISOString(),
    };

    const result = kernel.apply(plan);
    expect(result.ok).toBe(false);
    expect(result.ops[0]?.error).toMatch(/agent lacks update permission for raw\//);
    // Original content preserved
    expect(readFileSync(join(vault, 'raw/fixed.md'), 'utf8')).toBe('original');
  });

  it('create op into raw/ remains permitted (append, not modify)', () => {
    const vault = makeVault();
    const schema = loadSchema(vault);
    const kernel = createKernel(vault, schema);
    const plan: ChangePlan = {
      change_id: 'test-raw-create',
      source_id: 'sha256:fake',
      risk: 'low',
      ops: [{
        op: 'create',
        path: 'raw/new.md',
        reason: 'append a new source',
        precondition: { exists: false },
        patch: { type: 'replace', value: 'new content' },
      }],
      requires_review: true,
      created_at: new Date().toISOString(),
    };
    expect(kernel.apply(plan).ok).toBe(true);
    expect(statSync(join(vault, 'raw/new.md')).isFile()).toBe(true);
  });
});
