#!/usr/bin/env bun
// hearth CLI v0.1 — init / ingest / pending list / show / apply
//
// No LLM in this cut. The mock ingest agent produces deterministic
// ChangePlans; the kernel applies them after permission + precondition checks.
// Once this loop is proven, real Claude Agent SDK integration arrives.

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, SchemaError } from '../core/schema.ts';
import { createKernel } from '../core/vault-kernel.ts';
import { PendingStore } from '../core/pending-store.ts';
import { mockIngest } from '../ingest/mock.ts';
import { query, NO_ANSWER } from '../core/query.ts';
import { lint } from '../core/lint.ts';

function fail(msg: string): never {
  process.stderr.write(`hearth: ${msg}\n`);
  process.exit(1);
}

function findExamplesDir(): string {
  // when running from `bun src/cli/index.ts`, __dirname is .../src/cli
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'examples');
}

function cmdInit(positionals: string[], values: Record<string, string | boolean | undefined>): void {
  const target = positionals[0];
  if (!target) fail('init: missing <vault-dir>. usage: hearth init <vault-dir> [--template default]');
  const vault = resolve(target);
  const template = (values.template as string) ?? 'default';

  if (existsSync(vault) && readdirSync(vault).length > 0 && !values.force) {
    fail(`init: ${vault} is not empty. pass --force to bootstrap inside an existing directory.`);
  }
  mkdirSync(vault, { recursive: true });

  // Copy template SCHEMA.md from examples/default-vault/SCHEMA.md
  const tmplDir = join(findExamplesDir(), `${template}-vault`);
  const tmplSchema = join(tmplDir, 'SCHEMA.md');
  if (!existsSync(tmplSchema)) fail(`init: template "${template}" not found at ${tmplDir}`);
  copyFileSync(tmplSchema, join(vault, 'SCHEMA.md'));

  // Create starter folders per the default permission table
  for (const dir of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(vault, dir), { recursive: true });
  }

  process.stdout.write(`✓ initialized hearth vault at ${vault} (template: ${template})\n`);
  process.stdout.write(`  next: hearth ingest <file.md> --vault ${vault}\n`);
}

function cmdIngest(positionals: string[], values: Record<string, string | boolean | undefined>): void {
  const source = positionals[0];
  if (!source) fail('ingest: missing <source>. usage: hearth ingest <file.md> [--vault <dir>]');
  const vault = resolve((values.vault as string) ?? process.cwd());
  let schema;
  try { schema = loadSchema(vault); }
  catch (e) {
    if (e instanceof SchemaError) fail(e.message);
    throw e;
  }
  const { plan } = mockIngest(resolve(source), { vaultRoot: vault });
  const store = new PendingStore();
  const path = store.save(plan);
  process.stdout.write(`✓ created ChangePlan ${plan.change_id}\n`);
  process.stdout.write(`  ${plan.ops.length} ops · risk=${plan.risk} · review=${plan.requires_review}\n`);
  process.stdout.write(`  ${path}\n`);
  process.stdout.write(`  no wiki files modified\n`);
  process.stdout.write(`  next: hearth pending show ${plan.change_id}  (then apply)\n`);
  // Suppress unused-var warning while schema is intentionally validated above.
  void schema;
}

function cmdPending(positionals: string[], values: Record<string, string | boolean | undefined>): void {
  const sub = positionals[0];
  const store = new PendingStore();
  if (!sub || sub === 'list') {
    const plans = store.list();
    if (plans.length === 0) {
      process.stdout.write('(no pending plans)\n');
      return;
    }
    for (const p of plans) {
      process.stdout.write(`${p.change_id}  ${p.risk.padEnd(6)}  ${p.ops.length} ops  ${p.created_at}\n`);
    }
    return;
  }
  if (sub === 'show') {
    const id = positionals[1];
    if (!id) fail('pending show: missing <change_id>');
    const plan = store.load(id);
    process.stdout.write(`change_id: ${plan.change_id}\n`);
    process.stdout.write(`source_id: ${plan.source_id}\n`);
    process.stdout.write(`risk: ${plan.risk}  requires_review: ${plan.requires_review}\n`);
    process.stdout.write(`created: ${plan.created_at}\n`);
    if (plan.note) process.stdout.write(`note: ${plan.note}\n`);
    process.stdout.write(`\n${plan.ops.length} ops:\n`);
    for (const op of plan.ops) {
      process.stdout.write(`  [${op.op}] ${op.path}\n`);
      process.stdout.write(`    reason: ${op.reason}\n`);
      process.stdout.write(`    precondition: ${JSON.stringify(op.precondition)}\n`);
      if (op.body_preview) {
        const preview = op.body_preview.split('\n').slice(0, 3).join('\n      ');
        process.stdout.write(`    preview:\n      ${preview}\n`);
      }
    }
    return;
  }
  if (sub === 'apply') {
    const id = positionals[1];
    if (!id) fail('pending apply: missing <change_id>');
    const vault = resolve((values.vault as string) ?? process.cwd());
    let schema;
    try { schema = loadSchema(vault); }
    catch (e) {
      if (e instanceof SchemaError) fail(e.message);
      throw e;
    }
    const plan = store.load(id);
    const kernel = createKernel(vault, schema);
    const result = kernel.apply(plan);
    if (result.ok) {
      process.stdout.write(`✓ applied ${result.ops.length} ops\n`);
      for (const r of result.ops) process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${r.op} ${r.path}\n`);
      store.remove(id);
      process.stdout.write(`  removed from pending queue\n`);
    } else {
      process.stderr.write(`✗ apply failed: ${result.error}\n`);
      for (const r of result.ops) process.stderr.write(`  ${r.ok ? '✓' : '✗'} ${r.op} ${r.path}${r.error ? ' — ' + r.error : ''}\n`);
      process.exit(1);
    }
    return;
  }
  fail(`pending: unknown subcommand "${sub}". expected: list | show | apply`);
}

function cmdQuery(positionals: string[], values: Record<string, string | boolean | undefined>): void {
  const question = positionals[0];
  if (!question) fail('query: missing <question>. usage: hearth query "<question>" [--vault <dir>]');
  const vault = resolve((values.vault as string) ?? process.cwd());
  let schema;
  try { schema = loadSchema(vault); }
  catch (e) {
    if (e instanceof SchemaError) fail(e.message);
    throw e;
  }
  void schema;
  const result = query(vault, question);
  if (result.hits.length === 0) {
    process.stdout.write(`${NO_ANSWER}\n`);
    process.exit(2); // distinct exit code so scripts can branch
  }
  process.stdout.write(`Found ${result.hits.length} grounded claim(s):\n\n`);
  for (const h of result.hits) {
    process.stdout.write(`• ${h.claim_text}\n`);
    process.stdout.write(`    Source: ${h.source} (${h.anchor_summary})\n`);
    process.stdout.write(`    Page:   ${h.page}\n`);
    process.stdout.write(`    Confidence: ${h.confidence}  match=${h.match_score}\n\n`);
  }
}

function cmdLint(positionals: string[], values: Record<string, string | boolean | undefined>): void {
  void positionals;
  const vault = resolve((values.vault as string) ?? process.cwd());
  let schema;
  try { schema = loadSchema(vault); }
  catch (e) {
    if (e instanceof SchemaError) fail(e.message);
    throw e;
  }
  const report = lint(vault, schema);
  process.stdout.write(`Scanned ${report.pages_scanned} page(s), ${report.claims_scanned} claim(s).\n`);
  if (report.findings.length === 0) {
    process.stdout.write(`✓ no findings\n`);
    return;
  }
  for (const f of report.findings) {
    const tag = f.severity === 'error' ? '✗' : '⚠';
    process.stdout.write(`${tag} [${f.rule}] ${f.page}\n`);
    process.stdout.write(`    ${f.message}\n`);
    if (f.hint) process.stdout.write(`    hint: ${f.hint}\n`);
  }
  // lint is read-only; non-zero exit only on 'error' severity findings
  const hasError = report.findings.some(f => f.severity === 'error');
  if (hasError) process.exit(1);
}

function help(): void {
  process.stdout.write(`hearth v0.1.0-alpha

usage:
  hearth init <vault-dir> [--template default] [--force]
  hearth ingest <file.md> [--vault <dir>]
  hearth pending list
  hearth pending show <change_id>
  hearth pending apply <change_id> [--vault <dir>]
  hearth query "<question>" [--vault <dir>]
  hearth lint [--vault <dir>]

This is the v0.1 deterministic core loop. No LLM yet — mock ingest produces
ChangePlans; kernel enforces SCHEMA.md permissions + preconditions on apply.
See docs/SPEC.md and docs/ROADMAP.md.
`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') { help(); return; }
  const cmd = args[0];
  const rest = args.slice(1);
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      vault: { type: 'string' },
      template: { type: 'string' },
      force: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });
  switch (cmd) {
    case 'init': return cmdInit(positionals, values);
    case 'ingest': return cmdIngest(positionals, values);
    case 'pending': return cmdPending(positionals, values);
    case 'query': return cmdQuery(positionals, values);
    case 'lint': return cmdLint(positionals, values);
    case 'help': return help();
    default: fail(`unknown command: ${cmd}. run "hearth help"`);
  }
}

main();
