#!/usr/bin/env bun
// hearth CLI v0.1 — init / ingest / pending list / show / apply
//
// No LLM in this cut. The mock ingest agent produces deterministic
// ChangePlans; the kernel applies them after permission + precondition checks.
// Once this loop is proven, real Claude Agent SDK integration arrives.

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, SchemaError } from '../core/schema.ts';
import { createKernel } from '../core/vault-kernel.ts';
import { PendingStore } from '../core/pending-store.ts';
import { MockAgentAdapter } from '../ingest/mock-adapter.ts';
import { ClaudeAgentAdapter } from '../ingest/claude-adapter.ts';
import { sha256 } from '../core/hash.ts';
import { validateChangePlan, PlanValidationError } from '../core/plan-validator.ts';
import type { AgentAdapter } from '../core/agent-adapter.ts';
import { query, NO_ANSWER } from '../core/query.ts';
import { lint } from '../core/lint.ts';
import { ingestFromChannel } from '../runtime.ts';
import { buildProposal, applyProposal, renderProposalSummary } from './adopt.ts';
import { runDoctor, renderDoctorReport } from './doctor.ts';
import { startStdioServer } from '../mcp-server.ts';
import { audit, readAudit, parseSince } from '../core/audit.ts';
import { issueToken } from '../core/approval-token.ts';
import { runSetup } from './setup.ts';

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

async function cmdIngest(positionals: string[], values: Record<string, string | boolean | undefined>): Promise<void> {
  const source = positionals[0];
  if (!source) fail('ingest: missing <source>. usage: hearth ingest <file.md> [--vault <dir>] [--agent mock|claude]');
  const vault = resolve((values.vault as string) ?? process.cwd());
  let schema;
  try { schema = loadSchema(vault); }
  catch (e) {
    if (e instanceof SchemaError) fail(e.message);
    throw e;
  }

  const agentName = (values.agent as string) ?? 'mock';
  let adapter: AgentAdapter;
  try {
    if (agentName === 'mock') adapter = new MockAgentAdapter();
    else if (agentName === 'claude') adapter = new ClaudeAgentAdapter();
    else fail(`unknown --agent: ${agentName} (expected mock|claude)`);
  } catch (e) {
    fail((e as Error).message);
  }

  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) fail(`source not found: ${sourcePath}`);
  const content = readFileSync(sourcePath, 'utf8');
  const sourceId = sha256(content);
  const { basename } = await import('node:path');
  const fname = basename(sourcePath);

  // Read existing wiki pages for the agent's context (best-effort, capped)
  const existingPages: string[] = [];
  function walkPages(dir: string, prefix = ''): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'raw' || name === 'node_modules') continue;
      const full = join(dir, name);
      let st;
      try { st = (require('node:fs') as typeof import('node:fs')).statSync(full); } catch { continue; }
      const rel = prefix ? `${prefix}/${name}` : name;
      if (st.isDirectory()) walkPages(full, rel);
      else if (name.endsWith('.md') && rel !== 'SCHEMA.md' && rel !== 'README.md' && rel !== 'index.md') {
        existingPages.push(rel);
      }
    }
  }
  walkPages(vault);

  process.stdout.write(`→ planning ingest with --agent ${adapter!.name}…\n`);
  let plan;
  try {
    plan = await adapter!.planIngest(
      { sourcePath, vaultRelativeRaw: `raw/${fname}`, content, sourceId },
      { vaultRoot: vault, schema, existingPages },
    );
  } catch (e) {
    fail(`agent failed to produce a ChangePlan: ${(e as Error).message}`);
  }

  // Re-validate even mock output, defense in depth
  try {
    plan = validateChangePlan(plan, { schema, vaultRoot: vault });
  } catch (e) {
    if (e instanceof PlanValidationError) {
      process.stderr.write(`hearth: agent produced invalid plan — refused to enter pending queue\n`);
      for (const issue of e.issues) process.stderr.write(`  - ${issue}\n`);
      process.exit(1);
    }
    throw e;
  }

  const store = new PendingStore();
  const savedPath = store.save(plan);
  process.stdout.write(`✓ created ChangePlan ${plan.change_id}\n`);
  process.stdout.write(`  ${plan.ops.length} ops · risk=${plan.risk} · review=${plan.requires_review}\n`);
  process.stdout.write(`  ${savedPath}\n`);
  process.stdout.write(`  no wiki files modified\n`);
  process.stdout.write(`  next: hearth pending show ${plan.change_id}  (then apply)\n`);
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
      void audit(vault, { event: 'changeplan.applied', initiated_by: 'cli', data: { change_id: id, ops: result.ops.length } });
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

async function cmdChannel(positionals: string[], values: Record<string, string | boolean | undefined>): Promise<void> {
  const sub = positionals[0];
  if (sub !== 'ingest') fail(`channel: unknown subcommand "${sub}". expected: ingest`);

  const channel = (values.channel as string) ?? 'cli';
  const messageId = (values['message-id'] as string) ?? `cli-${Date.now()}`;
  const from = (values.from as string) ?? 'cli-user';
  const text = (values.text as string) ?? '';
  const url = values.url as string | undefined;
  if (!text && !url) fail('channel ingest: need --text "..." or --url <url>');

  const vault = resolve((values.vault as string) ?? process.cwd());
  const agent = ((values.agent as string) ?? 'mock') as 'mock' | 'claude';
  const result = await ingestFromChannel(
    {
      channel,
      message_id: messageId,
      from,
      ...(text ? { text } : {}),
      ...(url ? { url } : {}),
      received_at: new Date().toISOString(),
    },
    { vaultRoot: vault, agent },
  );

  if (!result.ok) {
    process.stderr.write(`✗ ${result.summary}\n`);
    if (result.error) process.stderr.write(`  ${result.error.split('\n').join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${result.summary}\n`);
  process.stdout.write(`  source materialized: ${result.source_path}\n`);
  process.stdout.write(`  pending: ${result.pending_path}\n`);
}

function cmdAdopt(positionals: string[], values: Record<string, string | boolean | undefined>): void {
  const target = positionals[0];
  if (!target) fail('adopt: missing <vault-dir>. usage: hearth adopt <vault-dir> [--dry-run] [--yes]');
  const proposal = buildProposal(target);
  process.stdout.write(renderProposalSummary(proposal) + '\n\n');

  if (values['dry-run']) {
    process.stdout.write('--dry-run: no changes written.\n');
    return;
  }

  if (!values.yes) {
    process.stdout.write('Pass --yes to apply (or --dry-run to preview only). No changes made.\n');
    return;
  }

  const result = applyProposal(proposal);
  if (result.appendedToSchema) process.stdout.write(`✓ appended canonical block to ${result.schemaPath}\n`);
  if (result.createdInbox) process.stdout.write(`✓ created ${result.inboxPath}\n`);
  void audit(proposal.scan.vaultRoot, { event: 'adopt.applied', initiated_by: 'cli', data: { appended: result.appendedToSchema, created: result.createdInbox } });
  if (result.warnings.length > 0) {
    process.stdout.write('\nwarnings:\n');
    for (const w of result.warnings) process.stdout.write(`  ⚠ ${w}\n`);
  }
  process.stdout.write('\nNext: hearth doctor --vault ' + proposal.scan.vaultRoot + '\n');
}

function cmdDoctor(_positionals: string[], values: Record<string, string | boolean | undefined>): void {
  const vault = resolve((values.vault as string) ?? process.cwd());
  const report = runDoctor(vault);
  process.stdout.write(renderDoctorReport(report) + '\n');
  if (!report.ok) process.exit(1);
}

async function cmdMcp(positionals: string[], values: Record<string, string | boolean | undefined>): Promise<void> {
  const sub = positionals[0];
  if (sub !== 'serve') fail(`mcp: unknown subcommand "${sub}". expected: serve`);
  const vault = resolve((values.vault as string) ?? process.env.HEARTH_VAULT ?? process.cwd());
  if (!existsSync(join(vault, 'SCHEMA.md'))) {
    fail(`mcp serve: ${vault} has no SCHEMA.md. Run \`hearth adopt ${vault}\` first.`);
  }
  // No stdout chatter — MCP uses stdout for protocol. Log to stderr only.
  process.stderr.write(`hearth mcp serve: vault=${vault}\n`);
  await startStdioServer(vault);
}

function cmdLog(positionals: string[], values: Record<string, string | boolean | undefined>): void {
  void positionals;
  const vault = resolve((values.vault as string) ?? process.cwd());
  const sinceStr = values.since as string | undefined;
  const since = sinceStr ? parseSince(sinceStr) ?? undefined : undefined;
  const limit = values.limit ? parseInt(String(values.limit), 10) : 50;
  const entries = readAudit(vault, { since, limit });
  if (entries.length === 0) {
    process.stdout.write('(no audit entries)\n');
    return;
  }
  for (const e of entries) {
    const tag = e.event.padEnd(28);
    const by = (e.initiated_by ?? '?').padEnd(16);
    const data = e.data ? '  ' + JSON.stringify(e.data) : '';
    process.stdout.write(`${e.ts}  ${tag} ${by}${data}\n`);
  }
}

async function cmdSetup(_positionals: string[], _values: Record<string, string | boolean | undefined>): Promise<void> {
  // Find hearth's own repo root (where this script lives)
  const here = dirname(fileURLToPath(import.meta.url));
  const hearthRepoRoot = resolve(here, '..', '..');
  const code = await runSetup({ hearthRepoRoot });
  process.exit(code);
}

function help(): void {
  process.stdout.write(`hearth v0.1.0-alpha

usage:
  hearth setup                                    interactive one-command onboarding (recommended)
  hearth init <vault-dir> [--template default] [--force]
  hearth ingest <file.md> [--vault <dir>] [--agent mock|claude]
  hearth pending list
  hearth pending show <change_id>
  hearth pending apply <change_id> [--vault <dir>]
  hearth query "<question>" [--vault <dir>]
  hearth lint [--vault <dir>]
  hearth channel ingest --channel <name> --message-id <id> --from <id> --text "..." [--vault <dir>] [--agent mock|claude]
  hearth adopt <vault-dir> [--dry-run] [--yes]
  hearth doctor [--vault <dir>]
  hearth mcp serve [--vault <dir>]
  hearth log [--vault <dir>] [--since 7d|24h|30m] [--limit N]

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
      agent: { type: 'string' },
      channel: { type: 'string' },
      'message-id': { type: 'string' },
      from: { type: 'string' },
      text: { type: 'string' },
      url: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      since: { type: 'string' },
      limit: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  switch (cmd) {
    case 'init': return cmdInit(positionals, values);
    case 'ingest': void cmdIngest(positionals, values); return;
    case 'pending': return cmdPending(positionals, values);
    case 'query': return cmdQuery(positionals, values);
    case 'lint': return cmdLint(positionals, values);
    case 'channel': void cmdChannel(positionals, values); return;
    case 'adopt': return cmdAdopt(positionals, values);
    case 'doctor': return cmdDoctor(positionals, values);
    case 'mcp': void cmdMcp(positionals, values); return;
    case 'log': return cmdLog(positionals, values);
    case 'setup': void cmdSetup(positionals, values); return;
    case 'help': return help();
    default: fail(`unknown command: ${cmd}. run "hearth help"`);
  }
}

main();
