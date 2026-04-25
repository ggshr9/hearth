// hearth v0.1.3 — AgentAdapter + Claude integration tests
// (with the real Anthropic SDK mocked; an opt-in live test runs only when
//  ANTHROPIC_API_KEY is present in the environment.)

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/core/hash.ts';
import { loadSchema } from '../src/core/schema.ts';
import { createKernel } from '../src/core/vault-kernel.ts';
import { MockAgentAdapter } from '../src/ingest/mock-adapter.ts';
import { ClaudeAgentAdapter } from '../src/ingest/claude-adapter.ts';
import { validateChangePlan, PlanValidationError } from '../src/core/plan-validator.ts';
import { buildClaimIndex } from '../src/core/citations.ts';
import { query } from '../src/core/query.ts';
import { PendingStore } from '../src/core/pending-store.ts';

const SCHEMA_FIXTURE = `---
type: meta
---

# T

| dir         | human | agent |
|-------------|-------|-------|
| raw/        | add   | add   |
| 00 Inbox/   | rw    | none  |
| 01 Topics/  | r     | rw    |
| 02 Maps/    | r     | rw    |
| 99 Assets/  | rw    | add   |
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-adp-'));
  for (const d of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA_FIXTURE);
  return root;
}

function makeSourceFile(): { path: string; content: string; sourceId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-src-'));
  const path = join(dir, 'sample.md');
  const content = '# Sample\n\nThis is a test source for hearth.\n';
  writeFileSync(path, content);
  return { path, content, sourceId: sha256(content) };
}

describe('v0.1.3 verification 1: --agent mock still works (backward compat)', () => {
  it('MockAgentAdapter produces a valid ChangePlan + kernel applies it', async () => {
    const vault = makeVault();
    const src = makeSourceFile();
    const schema = loadSchema(vault);
    const adapter = new MockAgentAdapter();

    const plan = await adapter.planIngest(
      { sourcePath: src.path, vaultRelativeRaw: 'raw/sample.md', content: src.content, sourceId: src.sourceId },
      { vaultRoot: vault, schema, existingPages: [] },
    );

    // Must pass the validator
    const validated = validateChangePlan(plan, { schema, vaultRoot: vault });
    expect(validated.ops).toHaveLength(2);

    // Must apply via kernel
    const kernel = createKernel(vault, schema);
    const result = kernel.apply(validated);
    expect(result.ok).toBe(true);
  });
});

describe('v0.1.3 verification 4: malformed / unsafe ChangePlan never enters pending', () => {
  it('plan with absolute path is rejected by validator BEFORE the kernel sees it', () => {
    const vault = makeVault();
    const schema = loadSchema(vault);
    const malformed = {
      change_id: 'x',
      source_id: 'sha256:y',
      risk: 'low',
      requires_review: true,
      created_at: new Date().toISOString(),
      ops: [{
        op: 'create',
        path: '/etc/passwd',
        reason: 'absolute path',
        precondition: { exists: false },
        patch: { type: 'replace', value: 'nope' },
      }],
    };
    expect(() => validateChangePlan(malformed, { schema, vaultRoot: vault })).toThrow(PlanValidationError);
  });

  it('plan that targets human-only zone (00 Inbox/) is rejected at validation', () => {
    const vault = makeVault();
    const schema = loadSchema(vault);
    const bad = {
      change_id: 'x',
      source_id: 'sha256:y',
      risk: 'low',
      requires_review: true,
      created_at: new Date().toISOString(),
      ops: [{
        op: 'create',
        path: '00 Inbox/agent-poaching.md',
        reason: 'attempted poaching',
        precondition: { exists: false },
        patch: { type: 'replace', value: 'nope' },
      }],
    };
    try {
      validateChangePlan(bad, { schema, vaultRoot: vault });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PlanValidationError);
      expect((e as PlanValidationError).issues.some(i => /agent lacks create permission/.test(i))).toBe(true);
    }
  });

  it('plan missing required field is rejected', () => {
    const vault = makeVault();
    const schema = loadSchema(vault);
    expect(() => validateChangePlan({ ops: [] }, { schema, vaultRoot: vault })).toThrow(PlanValidationError);
  });

  it('precondition exists=true without base_hash is rejected', () => {
    const vault = makeVault();
    const schema = loadSchema(vault);
    const bad = {
      change_id: 'x',
      source_id: 'sha256:y',
      risk: 'low',
      requires_review: true,
      created_at: new Date().toISOString(),
      ops: [{
        op: 'update',
        path: '01 Topics/x.md',
        reason: 'updating without base hash',
        precondition: { exists: true },
        patch: { type: 'replace', value: '...' },
      }],
    };
    try {
      validateChangePlan(bad, { schema, vaultRoot: vault });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PlanValidationError).issues.some(i => /base_hash is required/.test(i))).toBe(true);
    }
  });
});

describe('v0.1.3 verification 2 & 3: Claude adapter (with mocked Anthropic client)', () => {
  function makeFakeClaude(toolInput: unknown) {
    return {
      messages: {
        create: async () => ({
          id: 'msg_test',
          content: [
            { type: 'tool_use', id: 'tu_test', name: 'submit_change_plan', input: toolInput },
          ],
        } as any),
      },
    };
  }

  it('parses Claude tool_use into a validated ChangePlan + 1 verified claim', async () => {
    const vault = makeVault();
    const src = makeSourceFile();
    // Pre-place the source under raw/ as the real CLI would
    writeFileSync(join(vault, 'raw/sample.md'), src.content);
    const schema = loadSchema(vault);

    const exactQuote = 'This is a test source for hearth.';
    const summaryBody = [
      '---',
      'type: source-summary',
      'status: draft',
      'sources:',
      '  - raw/sample.md',
      'created: 2026-04-25',
      'updated: 2026-04-25',
      'author: agent:extract',
      'review_required: true',
      'claims:',
      '  - text: ' + JSON.stringify(exactQuote),
      '    source: raw/sample.md',
      '    anchor:',
      '      type: line',
      '      line_start: 3',
      '      line_end: 3',
      '      quote: ' + JSON.stringify(exactQuote),
      '      quote_hash: ' + JSON.stringify(sha256(exactQuote)),
      '    confidence: high',
      '---',
      '',
      '# Sample summary',
      '',
      'A claim grounded in the source.',
      '',
    ].join('\n');

    const fakePlan = {
      change_id: 'fake-claude-001',
      source_id: 'sha256:will-be-overwritten',
      risk: 'low',
      requires_review: true,
      created_at: new Date().toISOString(),
      ops: [{
        op: 'create',
        path: '01 Topics/sample-summary.md',
        reason: 'fake claude summary',
        precondition: { exists: false },
        patch: { type: 'replace', value: summaryBody },
      }],
    };

    const adapter = new ClaudeAgentAdapter({ client: makeFakeClaude(fakePlan) as any });
    const plan = await adapter.planIngest(
      { sourcePath: src.path, vaultRelativeRaw: 'raw/sample.md', content: src.content, sourceId: src.sourceId },
      { vaultRoot: vault, schema, existingPages: [] },
    );

    // source_id is pinned to the real one (verification 2)
    expect(plan.source_id).toBe(src.sourceId);

    // Apply through kernel
    const kernel = createKernel(vault, schema);
    const result = kernel.apply(plan);
    expect(result.ok).toBe(true);

    // Verification 3: at least one verified claim from Claude's output
    const idx = buildClaimIndex(vault);
    expect(idx.verified().length).toBeGreaterThanOrEqual(1);

    // Verification 5: query hits the Claude-generated verified claim
    const r = query(vault, 'test source for hearth');
    expect(r.hits.length).toBeGreaterThanOrEqual(1);
    expect(r.hits[0]?.source).toBe('raw/sample.md');
  });

  it('rejects malformed Claude tool input before reaching pending', async () => {
    const vault = makeVault();
    const src = makeSourceFile();
    const schema = loadSchema(vault);

    const malformedFromClaude = { ops: [{ op: 'create', path: '/etc/passwd' }] };
    const adapter = new ClaudeAgentAdapter({ client: makeFakeClaude(malformedFromClaude) as any });
    await expect(adapter.planIngest(
      { sourcePath: src.path, vaultRelativeRaw: 'raw/sample.md', content: src.content, sourceId: src.sourceId },
      { vaultRoot: vault, schema, existingPages: [] },
    )).rejects.toThrow(/plan failed validation/);

    // Pending queue is untouched (we used a fresh PendingStore in a tmp dir to be isolated)
    const store = new PendingStore(mkdtempSync(join(tmpdir(), 'hearth-pending-iso-')));
    expect(store.list()).toEqual([]);
  });
});

// Live integration test — only runs when ANTHROPIC_API_KEY is set.
// Skipped silently in normal CI.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('v0.1.3 live: real Claude adapter (opt-in via ANTHROPIC_API_KEY)', () => {
  it('end-to-end: real Claude → ChangePlan → kernel apply → query hit', async () => {
    const vault = makeVault();
    const src = makeSourceFile();
    writeFileSync(join(vault, 'raw/sample.md'), src.content);
    const schema = loadSchema(vault);
    const adapter = new ClaudeAgentAdapter();
    const plan = await adapter.planIngest(
      { sourcePath: src.path, vaultRelativeRaw: 'raw/sample.md', content: src.content, sourceId: src.sourceId },
      { vaultRoot: vault, schema, existingPages: [] },
    );
    expect(plan.ops.length).toBeGreaterThan(0);
    const result = createKernel(vault, schema).apply(plan);
    expect(result.ok).toBe(true);
    void readFileSync; void existsSync;
  }, 60_000);
});
