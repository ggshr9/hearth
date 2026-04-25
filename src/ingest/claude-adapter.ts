// ClaudeAgentAdapter — calls Anthropic Claude with a tool_use schema that
// pins the output shape to ChangePlan. The adapter does NOT do file I/O and
// does NOT apply the plan; it returns it for the kernel pipeline to handle.
//
// Two layers of defense between Claude and the vault:
//   1. Tool schema constrains the JSON shape Claude can emit
//   2. plan-validator.ts re-validates after parse; malformed plans never
//      reach the pending queue
//
// The real protection is the kernel itself: even a perfectly-shaped plan
// from Claude still goes through preflight (perms + preconditions + path
// safety) before any byte hits disk.

import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from '../core/hash.ts';
import { validateChangePlan, PlanValidationError } from '../core/plan-validator.ts';
import { permits } from '../core/schema.ts';
import type { AgentAdapter, IngestInput, VaultContext } from '../core/agent-adapter.ts';
import type { ChangePlan } from '../core/types.ts';

export interface ClaudeAdapterOptions {
  apiKey?: string;
  model?: string;
  /** Optional override for testing — supply a fake Anthropic client. */
  client?: Pick<Anthropic, 'messages'>;
}

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly name = 'claude';
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly model: string;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.model = opts.model ?? process.env.HEARTH_CLAUDE_MODEL ?? 'claude-sonnet-4-6';
    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ClaudeAgentAdapter: ANTHROPIC_API_KEY not set (pass via env or constructor)');
      }
      this.client = new Anthropic({ apiKey });
    }
  }

  async planIngest(input: IngestInput, ctx: VaultContext): Promise<ChangePlan> {
    // Restrict Claude's path universe to dirs the schema allows agent writes to
    const writableDirs = ctx.schema.rules
      .filter(r => permits(ctx.schema, 'agent', 'create', r.dir + 'sample.md'))
      .map(r => r.dir)
      .sort();

    const sys = [
      'You are an ingest agent for hearth, a personal AI runtime over a markdown vault.',
      'Your only job: produce a single ChangePlan that summarizes the given source into the vault.',
      'You MUST use the submit_change_plan tool. Do not write prose.',
      '',
      'Hard rules:',
      '- The original source has ALREADY been written to raw/ by the caller. Do not re-create it.',
      `- You may only propose paths under these prefixes: ${writableDirs.join(', ')}`,
      '- For each create/update op, set precondition.exists correctly. For updates, include precondition.base_hash (you do not have file hashes; for updates skip this turn — only propose creates in v0.1).',
      '- patch.type must be "replace". patch.value is the full file content.',
      '- Wiki page bodies must include a frontmatter block (---) with required fields: type, status, sources, created, updated, author. status starts as "draft". author is "agent:extract" for direct summaries, "agent:wiki" for syntheses.',
      '- For each substantive claim in a generated page, include a claims[] entry with anchor.type=line, anchor.quote (exact excerpt from the source), anchor.line_start/line_end (best-effort line numbers in the source), and confidence.',
      '',
      'Return one ChangePlan with risk="low", requires_review=true, ops typically 1-3 entries (one source-summary in 01 Topics/, optionally a concept page or MOC update). Keep it small for v0.1.',
    ].join('\n');

    const today = new Date().toISOString().slice(0, 10);
    const userMessage = [
      `Source path (already in vault): ${input.vaultRelativeRaw}`,
      `Source content (truncated to first 8000 chars):`,
      '',
      input.content.slice(0, 8000),
      '',
      `Today's date: ${today}`,
      `Existing wiki pages (for context only): ${ctx.existingPages.slice(0, 50).join(', ') || '(none)'}`,
    ].join('\n');

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: sys,
      tools: [{
        name: 'submit_change_plan',
        description: 'Submit a ChangePlan describing the wiki writes proposed for this source.',
        input_schema: {
          type: 'object',
          required: ['change_id', 'source_id', 'risk', 'ops', 'requires_review', 'created_at'],
          properties: {
            change_id: { type: 'string' },
            source_id: { type: 'string' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            ops: {
              type: 'array',
              items: {
                type: 'object',
                required: ['op', 'path', 'reason', 'precondition'],
                properties: {
                  op: { type: 'string', enum: ['create', 'update'] },
                  path: { type: 'string' },
                  reason: { type: 'string' },
                  precondition: {
                    type: 'object',
                    required: ['exists'],
                    properties: {
                      exists: { type: 'boolean' },
                      base_hash: { type: 'string' },
                    },
                  },
                  patch: {
                    type: 'object',
                    required: ['type', 'value'],
                    properties: {
                      type: { type: 'string', enum: ['replace'] },
                      value: { type: 'string' },
                    },
                  },
                  body_preview: { type: 'string' },
                },
              },
            },
            requires_review: { type: 'boolean' },
            created_at: { type: 'string' },
            note: { type: 'string' },
          },
        },
      }],
      tool_choice: { type: 'tool', name: 'submit_change_plan' },
      messages: [{ role: 'user', content: userMessage }],
    });

    // Find the tool_use block
    const toolUse = resp.content.find((b): b is Extract<typeof resp.content[number], { type: 'tool_use' }> => b.type === 'tool_use');
    if (!toolUse) {
      throw new Error('ClaudeAgentAdapter: response missing tool_use block');
    }

    // Validate before returning. Any drift gets caught here, not in the kernel.
    let plan: ChangePlan;
    try {
      plan = validateChangePlan(toolUse.input, { schema: ctx.schema, vaultRoot: ctx.vaultRoot });
    } catch (err) {
      if (err instanceof PlanValidationError) {
        throw new Error(`ClaudeAgentAdapter: ${err.message}\n  - ${err.issues.join('\n  - ')}`);
      }
      throw err;
    }

    // Pin source_id to what the kernel will see; Claude often guesses
    plan.source_id = input.sourceId;
    plan.note = (plan.note ? plan.note + ' · ' : '') + 'generated by hearth/claude-adapter';
    return plan;
  }
}
