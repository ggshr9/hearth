// hearth MCP server — the v0.4 surface for any MCP-aware agent runtime
// (Claude Code, Cursor, Codex, Continue.dev, ...) to operate on a vault.
//
// Tools (read):
//   vault_search, vault_read, vault_pending_list, vault_pending_show,
//   vault_lint, vault_doctor, vault_query
// Tools (mutation):
//   vault_plan_ingest         → returns ChangePlan, queues to pending
//   vault_apply_change        → token-gated; without token returns
//                                REQUIRES_HUMAN_APPROVAL with CLI hint
//   vault_plan_submit         → channel-trusted; validates + queues a
//                                pre-built ChangePlan. Never writes the vault.
//   vault_apply_for_owner     → channel-trusted; applies a pending plan under
//                                channel-ownership auth (no token). High-risk
//                                (requires_review) plans are left pending.
// Resources:
//   hearth://schema, hearth://vault-map, hearth://pending,
//   hearth://lint-report, hearth://agent-instructions
// Prompts:
//   ingest_workflow, query_with_citations, lint_fix_workflow,
//   restructure_discussion

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadSchema, schemaVersionHash, schemaLastModified } from './core/schema.ts';
import { PendingStore } from './core/pending-store.ts';
import { createKernel } from './core/vault-kernel.ts';
import { buildClaimIndex } from './core/citations.ts';
import { lint } from './core/lint.ts';
import { query, federatedQuery, NO_ANSWER } from './core/query.ts';
import { runDoctor } from './cli/doctor.ts';
import { ingestFromChannel, applyForOwner } from './runtime.ts';
import { audit } from './core/audit.ts';
import { verifyAndConsume, TokenError } from './core/approval-token.ts';
import { validateChangePlan, PlanValidationError } from './core/plan-validator.ts';
import { ErrorCode } from './core/types.ts';
import { AGENT_INSTRUCTIONS } from './core/agent-instructions.ts';
import { filterSourcesForConsumer, consumerCanReadVault, type ConsumerIdentity } from './core/consumer-registry.ts';
import { loadSources } from './core/source-registry.ts';

interface ServerContext {
  vaultRoot: string;
  /**
   * Phase 3: the authenticated consumer this server process serves.
   * undefined/null = owner-full (backward-compatible; existing spawns and
   * the owner's own tools). A ResolvedConsumer scopes the query path; a
   * DeniedConsumer marker makes every vault_query fail closed.
   */
  consumer?: ConsumerIdentity;
  /** Override hearth state dir (pending queue, channel inbox, and the
   *  federated source registry's sources.json). Defaults to ~/.hearth.
   *  Primarily for tests; production stdio startup leaves this unset and
   *  gets the real per-user state dir. One field for the whole ~/.hearth
   *  story — pending-store, runtime.ts's channel path, and federatedQuery
   *  all resolve the same override. */
  hearthStateDir?: string;
  /**
   * Phase 2a (HF3) test seam: override the federatedQuery function used by
   * the vault_query `federate: true` path. Defaults to the real
   * federatedQuery. Lets tests assert "no source is consulted" as a hard
   * fact (call count) when federate is absent/false, without a mocking
   * library or a real MCP source.
   */
  federatedQueryFn?: typeof federatedQuery;
}

/** Resolve the hearth state dir the same way runtime.ts's channel-side
 *  functions do (ctx override, else ~/.hearth). Kept local to avoid
 *  widening runtime.ts's private default just for this. */
function stateDirFor(ctx: ServerContext): string {
  return ctx.hearthStateDir ?? join(homedir(), '.hearth');
}

function jsonContent(obj: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorContent(code: keyof typeof ErrorCode, message: string, hint?: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...(hint ? { hint } : {}) } }, null, 2) }],
    isError: true,
  };
}

export function createMcpServer(ctx: ServerContext): Server {
  const server = new Server(
    { name: 'hearth', version: '0.4.0-alpha' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // ── Tools ────────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'vault_search',
        description: 'Search vault wiki pages by keyword (ripgrep over verified claim text).',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
      },
      {
        name: 'vault_read',
        description: 'Read a single vault file (markdown). Path is vault-relative.',
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
      {
        name: 'vault_query',
        description: 'Conservative query: returns verified claims with citations, or the literal "no answer found in vault". Set federate:true to also merge in answers from registered federated sources (labeled origin:"federated", never re-verified by hearth).',
        inputSchema: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string' },
            federate: { type: 'boolean' },
          },
        },
      },
      {
        name: 'vault_lint',
        description: 'Read-only audit. Returns LintReport.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'vault_doctor',
        description: 'Health check. Returns DoctorReport.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'vault_pending_list',
        description: 'List pending ChangePlans awaiting human approval.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'vault_pending_show',
        description: 'Show one pending ChangePlan in detail.',
        inputSchema: {
          type: 'object',
          required: ['change_id'],
          properties: { change_id: { type: 'string' } },
        },
      },
      {
        name: 'vault_plan_ingest',
        description: 'Propose ingesting a source. Returns a ChangePlan placed in the pending queue. Does NOT modify the vault.',
        inputSchema: {
          type: 'object',
          required: ['source_text'],
          properties: {
            source_text: { type: 'string', description: 'Inline markdown / text content to ingest.' },
            origin: { type: 'string', description: 'Optional source label (URL, channel id, etc.).' },
            schema_hash_seen: { type: 'string', description: 'The hearth://schema version_hash you read; mismatch triggers STALE_CONTEXT.' },
          },
        },
      },
      {
        name: 'vault_apply_change',
        description: 'Apply a previously-queued ChangePlan. Requires an approval_token issued by a human-direct surface (CLI / channel). Without token: returns REQUIRES_HUMAN_APPROVAL.',
        inputSchema: {
          type: 'object',
          required: ['change_id'],
          properties: {
            change_id: { type: 'string' },
            approval_token: { type: 'string' },
          },
        },
      },
      {
        name: 'vault_plan_submit',
        description: 'Submit a pre-built ChangePlan from a trusted channel. Validated against SCHEMA.md and queued to pending. Does NOT modify the vault — use vault_apply_for_owner to apply it.',
        inputSchema: {
          type: 'object',
          required: ['change_plan'],
          properties: {
            change_plan: { type: 'object', description: 'A ChangePlan object built by the caller (not generated here).' },
            origin: { type: 'string', description: 'Optional label for where this plan came from (channel id, etc.).' },
          },
        },
      },
      {
        name: 'vault_apply_for_owner',
        description: 'Apply a pending ChangePlan under channel-ownership authentication — the caller vouches for the owner, no approval_token needed. High-risk plans (requires_review) are left pending instead of applied.',
        inputSchema: {
          type: 'object',
          required: ['change_id', 'owner_id', 'channel'],
          properties: {
            change_id: { type: 'string' },
            owner_id: { type: 'string', description: 'Identity string for the audit log (e.g. the owning user id on the channel).' },
            channel: { type: 'string', description: 'Channel identifier for the audit log (e.g. the channel this call came from).' },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    // Audit every tool call
    await audit(ctx.vaultRoot, {
      event: 'mcp.tool_called',
      initiated_by: 'mcp',
      data: { tool: name, args_keys: Object.keys(args) },
    }).catch(() => {});

    try {
      const schema = loadSchema(ctx.vaultRoot);

      if (name === 'vault_search') {
        const q = String(args.query ?? '');
        const idx = buildClaimIndex(ctx.vaultRoot);
        const matches = idx.verified().filter(r => r.claim.text.toLowerCase().includes(q.toLowerCase()));
        return jsonContent({ matches: matches.slice(0, 20).map(r => ({ page: r.page, claim: r.claim.text, source: r.claim.source })) });
      }

      if (name === 'vault_read') {
        const p = String(args.path ?? '');
        const full = join(ctx.vaultRoot, p);
        if (!full.startsWith(ctx.vaultRoot)) return errorContent('PERMISSION_DENIED', `path escapes vault: ${p}`);
        if (!existsSync(full)) return errorContent('PERMISSION_DENIED', `not found: ${p}`);
        return { content: [{ type: 'text' as const, text: readFileSync(full, 'utf8') }] };
      }

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
        // Honesty guarantee: federate defaults to off. Absent or false takes
        // the exact same path hearth's local-only query has always taken —
        // no source-registry read, no federated MCP call, nothing that could
        // make vault_query answer with content hearth never verified itself.
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

      if (name === 'vault_lint') {
        const report = lint(ctx.vaultRoot, schema);
        await audit(ctx.vaultRoot, { event: 'lint.run', initiated_by: 'mcp', data: { findings: report.findings.length } }).catch(() => {});
        return jsonContent(report);
      }

      if (name === 'vault_doctor') {
        const report = runDoctor(ctx.vaultRoot);
        await audit(ctx.vaultRoot, { event: 'doctor.run', initiated_by: 'mcp', data: { ok: report.ok } }).catch(() => {});
        return jsonContent(report);
      }

      if (name === 'vault_pending_list') {
        const store = new PendingStore();
        const plans = store.list().map(p => ({ change_id: p.change_id, risk: p.risk, ops: p.ops.length, requires_review: p.requires_review, created_at: p.created_at }));
        return jsonContent({ plans });
      }

      if (name === 'vault_pending_show') {
        const id = String(args.change_id ?? '');
        const store = new PendingStore();
        try {
          return jsonContent(store.load(id));
        } catch (e) {
          return errorContent('PLAN_VALIDATION_FAILED', (e as Error).message);
        }
      }

      if (name === 'vault_plan_ingest') {
        // Stale-schema guard
        const seen = args.schema_hash_seen ? String(args.schema_hash_seen) : null;
        const current = schemaVersionHash(ctx.vaultRoot);
        if (seen && current && seen !== current) {
          return errorContent('STALE_CONTEXT', 'SCHEMA.md has changed since you last read hearth://schema', `Re-read hearth://schema and retry. (saw ${seen.slice(0, 22)}…, now ${current.slice(0, 22)}…)`);
        }
        const text = String(args.source_text ?? '');
        const origin = String(args.origin ?? `mcp-${Date.now()}`);
        const result = await ingestFromChannel(
          { channel: 'mcp', message_id: origin, from: 'mcp-agent', text, received_at: new Date().toISOString() },
          { vaultRoot: ctx.vaultRoot, agent: 'mock' },  // mock for v0.4; real Claude later
        );
        if (!result.ok) return errorContent('PLAN_VALIDATION_FAILED', result.summary, result.error);
        await audit(ctx.vaultRoot, {
          event: 'changeplan.created',
          initiated_by: 'mcp',
          data: { change_id: result.change_id, ops: result.op_count, risk: result.risk },
        }).catch(() => {});
        return jsonContent({
          change_id: result.change_id,
          risk: result.risk,
          ops: result.op_count,
          requires_review: result.requires_review,
          summary: result.summary,
          how_to_apply: `vault_apply_change requires an approval_token. The user can issue one via:\n  CLI: hearth pending apply ${result.change_id} --vault ${ctx.vaultRoot}\n  channel: /hearth apply ${result.change_id}`,
        });
      }

      if (name === 'vault_apply_change') {
        const id = String(args.change_id ?? '');
        const tokenStr = args.approval_token ? String(args.approval_token) : null;
        const store = new PendingStore();
        let plan;
        try { plan = store.load(id); }
        catch (e) { return errorContent('PLAN_VALIDATION_FAILED', `pending plan not found: ${id}`); }

        if (!tokenStr) {
          return errorContent(
            'REQUIRES_HUMAN_APPROVAL',
            'vault_apply_change via MCP requires an approval_token issued by a human-direct surface',
            `Surface to the user: "Please apply ChangePlan ${id} by running:\n  hearth pending apply ${id} --vault ${ctx.vaultRoot}\nor via channel: /hearth apply ${id}\nThen pass the issued token back to me."`,
          );
        }

        try {
          const payload = verifyAndConsume({ token: tokenStr, change_id: id, required_scope: plan.risk });
          await audit(ctx.vaultRoot, { event: 'approval_token.consumed', initiated_by: 'mcp', data: { jti: payload.jti, change_id: id } }).catch(() => {});
        } catch (e) {
          if (e instanceof TokenError) {
            await audit(ctx.vaultRoot, { event: 'approval_token.rejected', initiated_by: 'mcp', data: { reason: e.reason, change_id: id } }).catch(() => {});
            return errorContent('STALE_TOKEN', e.message, 'Request a fresh approval cycle from the user.');
          }
          throw e;
        }

        const kernel = createKernel(ctx.vaultRoot, schema);
        const result = kernel.apply(plan);
        if (!result.ok) {
          if (result.error?.includes('target file changed')) {
            return errorContent('REBASE_REQUIRED', result.error, 'Re-fetch base files via vault_read, regenerate the affected op, propose a new ChangePlan.');
          }
          return errorContent('PLAN_VALIDATION_FAILED', result.error ?? 'apply failed');
        }
        store.remove(id);
        await audit(ctx.vaultRoot, { event: 'changeplan.applied', initiated_by: 'mcp', data: { change_id: id, ops: result.ops.length } }).catch(() => {});
        return jsonContent(result);
      }

      if (name === 'vault_plan_submit') {
        let plan;
        try {
          plan = validateChangePlan(args.change_plan, { schema, vaultRoot: ctx.vaultRoot });
        } catch (e) {
          if (e instanceof PlanValidationError) {
            return errorContent('PLAN_VALIDATION_FAILED', e.message, e.issues.length ? e.issues.join('\n  - ') : undefined);
          }
          throw e;
        }
        const store = new PendingStore(join(stateDirFor(ctx), 'pending'));
        store.save(plan);
        await audit(ctx.vaultRoot, {
          event: 'changeplan.created',
          initiated_by: 'mcp',
          data: { change_id: plan.change_id, ops: plan.ops.length, risk: plan.risk, origin: args.origin ? String(args.origin) : undefined },
        }).catch(() => {});
        return jsonContent({
          change_id: plan.change_id,
          risk: plan.risk,
          ops: plan.ops.length,
          requires_review: plan.requires_review,
        });
      }

      if (name === 'vault_apply_for_owner') {
        const id = String(args.change_id ?? '');
        const ownerId = String(args.owner_id ?? '');
        const channel = String(args.channel ?? '');
        const store = new PendingStore(join(stateDirFor(ctx), 'pending'));
        let plan;
        try { plan = store.load(id); }
        catch (e) { return errorContent('PLAN_VALIDATION_FAILED', `pending plan not found: ${id}`); }

        if (plan.requires_review) {
          return jsonContent({
            ok: false,
            requires_review: true,
            change_id: id,
            rendered: 'high-risk plan left pending for review',
          });
        }

        const result = await applyForOwner(id, {
          vaultRoot: ctx.vaultRoot,
          ownerId,
          channel,
          hearthStateDir: ctx.hearthStateDir,
        });
        return jsonContent(result);
      }

      return errorContent('PLAN_VALIDATION_FAILED', `unknown tool: ${name}`);
    } catch (e) {
      return errorContent('PLAN_VALIDATION_FAILED', `tool ${name} threw: ${(e as Error).message}`);
    }
  });

  // ── Resources ────────────────────────────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'hearth://schema',             mimeType: 'text/markdown', name: 'SCHEMA.md' },
      { uri: 'hearth://vault-map',          mimeType: 'application/json', name: 'Vault map' },
      { uri: 'hearth://pending',            mimeType: 'application/json', name: 'Pending ChangePlans' },
      { uri: 'hearth://lint-report',        mimeType: 'application/json', name: 'Latest lint report' },
      { uri: 'hearth://agent-instructions', mimeType: 'text/markdown', name: 'How to be a good hearth agent' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === 'hearth://schema') {
      const p = join(ctx.vaultRoot, 'SCHEMA.md');
      const text = existsSync(p) ? readFileSync(p, 'utf8') : '(no SCHEMA.md — run `hearth adopt`)';
      const versionHash = schemaVersionHash(ctx.vaultRoot) ?? 'none';
      const lastMod = schemaLastModified(ctx.vaultRoot) ?? 'none';
      return { contents: [{ uri, mimeType: 'text/markdown', text: `<!-- version_hash: ${versionHash} | last_modified: ${lastMod} -->\n${text}` }] };
    }
    if (uri === 'hearth://vault-map') {
      const map = vaultMap(ctx.vaultRoot);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(map, null, 2) }] };
    }
    if (uri === 'hearth://pending') {
      const store = new PendingStore();
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(store.list(), null, 2) }] };
    }
    if (uri === 'hearth://lint-report') {
      const schema = loadSchema(ctx.vaultRoot);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(lint(ctx.vaultRoot, schema), null, 2) }] };
    }
    if (uri === 'hearth://agent-instructions') {
      return { contents: [{ uri, mimeType: 'text/markdown', text: AGENT_INSTRUCTIONS }] };
    }
    throw new Error(`unknown resource: ${uri}`);
  });

  // ── Prompts ──────────────────────────────────────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: 'ingest_workflow',        description: 'How to ingest a source into the vault correctly.' },
      { name: 'query_with_citations',   description: 'Answer a user question only from verified vault claims.' },
      { name: 'lint_fix_workflow',      description: 'Walk the user through fixing lint findings.' },
      { name: 'restructure_discussion', description: 'Discuss a proposed restructure before any moves.' },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const name = req.params.name;
    const prompts: Record<string, string> = {
      ingest_workflow: `When the user gives you content to put into their vault:\n1. Read hearth://schema to find writable target dirs.\n2. Call vault_plan_ingest({ source_text, origin, schema_hash_seen }).\n3. Surface the resulting ChangePlan summary to the user with the suggested CLI command. Do NOT call vault_apply_change yourself — it will return REQUIRES_HUMAN_APPROVAL.`,
      query_with_citations: `When the user asks a question about their notes:\n1. Call vault_query({ question }).\n2. If hits returned, present them with their citations (source, anchor, confidence). Quote the claim text verbatim.\n3. If no hits, reply exactly "no answer found in vault" — do NOT fabricate or fall back to general knowledge.`,
      lint_fix_workflow: `When the user wants to clean up the vault:\n1. Call vault_lint to get findings.\n2. Group findings by rule. Show the user a summary first.\n3. For each finding the user wants to fix, propose a vault_plan_ingest (or follow-up plan) — never auto-fix.`,
      restructure_discussion: `Restructure is high-risk. Before proposing any moves:\n1. Confirm the user's intent in plain language.\n2. Read hearth://vault-map to see current structure.\n3. Generate a structured proposal in 07 Hearth Proposals/ as a *view*, not a move.\n4. Only after user approves the proposal, plan the actual moves as ChangePlans (one per move).`,
    };
    const text = prompts[name];
    if (!text) throw new Error(`unknown prompt: ${name}`);
    return {
      description: name,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
    };
  });

  return server;
}

function vaultMap(vaultRoot: string): { dirs: { path: string; mdFiles: number }[] } {
  const skipDirs = new Set(['.git', '.obsidian', 'node_modules', '.hearth', '.stfolder', '.stversions']);
  const out: { path: string; mdFiles: number }[] = [];
  function walk(dir: string, prefix = ''): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    let mdHere = 0;
    for (const name of entries) {
      if (name.startsWith('.') || skipDirs.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, prefix ? `${prefix}/${name}` : name);
      else if (name.endsWith('.md')) mdHere++;
    }
    out.push({ path: prefix || '<root>', mdFiles: mdHere });
  }
  walk(vaultRoot);
  return { dirs: out.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function startStdioServer(vaultRoot: string, consumer?: ConsumerIdentity): Promise<void> {
  const server = createMcpServer({ vaultRoot, consumer });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
