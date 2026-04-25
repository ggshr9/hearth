// Mock ingest agent — v0.1 deterministic stub.
//
// Real LLM integration arrives in v0.1's second half. For now, ingest is
// pure: it takes a markdown source, copies it into raw/ via a ChangePlan,
// and proposes a single source-summary page in 01 Topics/. This is enough
// to validate the kernel + transaction model end-to-end before LLM
// non-determinism enters.

import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { sha256 } from '../core/hash.ts';
import { loadSchema, permits, type Schema } from '../core/schema.ts';
import type { ChangePlan, ChangeOp } from '../core/types.ts';

export interface MockIngestResult {
  plan: ChangePlan;
}

function changeIdFor(now: Date): string {
  // YYYYMMDDTHHMM-<rand4> e.g. 20260425T1154-ab12
  const iso = now.toISOString(); // 2026-04-25T11:54:37.123Z
  const stamp = iso.slice(0, 16).replace(/[-:]/g, ''); // → 20260425T1154
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48);
}

function pickTargetDir(schema: Schema): string {
  // Prefer a dir explicitly named for hearth, otherwise the first dir where
  // agent has at least 'add' (create) permission. raw/ is excluded — it's
  // the source store, not where wiki pages live.
  const eligible = schema.rules.filter(r =>
    r.dir !== 'raw/' &&
    permits(schema, 'agent', 'create', r.dir + 'sample.md')
  );
  if (eligible.length === 0) {
    throw new Error('mockIngest: no SCHEMA rule grants the agent create permission outside raw/. Add a `## hearth permissions` section with at least one agent=rw or agent=add directory.');
  }
  // Prefer something that looks like a hearth landing zone
  const named = eligible.find(r => /hearth|inbox|topics|notes/i.test(r.dir));
  return (named ?? eligible[0]!).dir;
}

export function mockIngest(sourcePath: string, opts: { vaultRoot: string; now?: Date } = { vaultRoot: '' }): MockIngestResult {
  if (!existsSync(sourcePath)) {
    throw new Error(`source not found: ${sourcePath}`);
  }
  const ext = extname(sourcePath).toLowerCase();
  if (ext !== '.md' && ext !== '.txt') {
    throw new Error(`v0.1 ingest supports .md and .txt only; got ${ext}`);
  }
  const content = readFileSync(sourcePath, 'utf8');
  const sourceId = sha256(content);
  const fname = basename(sourcePath);
  const slug = slugify(fname);
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  // Op 1: copy source into raw/ (create — no precondition.exists yet, must not exist)
  const rawPath = `raw/${fname}`;
  const op1: ChangeOp = {
    op: 'create',
    path: rawPath,
    reason: 'preserve original source under append-only raw/',
    precondition: { exists: false },
    patch: { type: 'replace', value: content },
    body_preview: content.slice(0, 200),
  };

  // Op 2: source-summary page in the schema-chosen target dir
  const schema = loadSchema(opts.vaultRoot);
  const targetDir = pickTargetDir(schema);
  const summaryBody = [
    '---',
    'type: source-summary',
    'status: draft',
    `created: ${today}`,
    `updated: ${today}`,
    `sources: [${rawPath}]`,
    'author: agent:extract',
    'review_required: true',
    `generated_by: hearth-mock-ingest@0.1`,
    '---',
    '',
    `# ${slug}`,
    '',
    `Stub summary for [${rawPath}](../${rawPath}). Mock ingest produced this — replace with real LLM extraction in the next iteration.`,
    '',
    '## First lines of source',
    '',
    '```',
    content.split('\n').slice(0, 20).join('\n'),
    '```',
    '',
  ].join('\n');
  const summaryPath = `${targetDir}${slug}-summary.md`;
  const op2: ChangeOp = {
    op: 'create',
    path: summaryPath,
    reason: 'new source-summary page',
    precondition: { exists: false },
    patch: { type: 'replace', value: summaryBody },
    body_preview: summaryBody.slice(0, 200),
  };

  const plan: ChangePlan = {
    change_id: changeIdFor(now),
    source_id: sourceId,
    risk: 'low',
    ops: [op1, op2],
    requires_review: true,
    created_at: now.toISOString(),
    note: 'mock ingest — deterministic stub for v0.1 kernel validation',
  };
  return { plan };
}
