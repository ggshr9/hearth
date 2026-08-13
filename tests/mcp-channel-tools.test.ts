// hearth — channel-trusted MCP tools: vault_plan_submit + vault_apply_for_owner
//
// These two tools let a trusted first-party channel (e.g. a chat-cc runtime)
// submit a *pre-built* ChangePlan and apply it under channel-ownership auth
// (no approval token — the channel's own auth IS the authentication, per
// SPEC §11 / the human-direct path already used by runtime.ts#applyForOwner).
//
// vault_plan_submit NEVER writes the vault — it validates + queues only.
// vault_apply_for_owner applies low-risk plans immediately, but leaves any
// plan with requires_review=true pending untouched — the MCP layer is the
// one place that enforces that gate before calling applyForOwner.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.ts';
import { PendingStore } from '../src/core/pending-store.ts';
import { auditLogPath } from '../src/core/audit.ts';
import type { ChangePlan } from '../src/core/types.ts';

const SCHEMA = `---
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
  const root = mkdtempSync(join(tmpdir(), 'hearth-mcp-ch-vault-'));
  for (const d of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'hearth-mcp-ch-state-'));
}

function makePlan(overrides: Partial<ChangePlan> = {}): ChangePlan {
  return {
    change_id: `cp-${Math.random().toString(36).slice(2)}`,
    source_id: 'source-abc',
    risk: 'low',
    requires_review: false,
    created_at: new Date().toISOString(),
    ops: [
      {
        op: 'create',
        path: '01 Topics/channel-submit-test.md',
        reason: 'submitted by trusted channel',
        precondition: { exists: false },
        patch: { type: 'replace', value: '# Channel submit test\n\ncontent from the channel.\n' },
      },
    ],
    ...overrides,
  };
}

/** Connect a fresh Client<->Server pair over an in-memory transport. */
async function connect(ctx: { vaultRoot: string; hearthStateDir?: string }): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(ctx);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[];
  const block = content.find(c => c.type === 'text');
  if (!block?.text) throw new Error('tool result has no text content block');
  return block.text;
}

describe('vault_plan_submit', () => {
  it('validates + queues a well-formed pre-built ChangePlan; never writes the vault', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { client, close } = await connect({ vaultRoot: vault, hearthStateDir: stateDir });
    const plan = makePlan();

    const before = existsSync(join(vault, '01 Topics', 'channel-submit-test.md'));
    expect(before).toBe(false);

    const result = await client.callTool({
      name: 'vault_plan_submit',
      arguments: { change_plan: plan, origin: 'test-channel' },
    });
    await close();

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(body.change_id).toBe(plan.change_id);
    expect(body.risk).toBe('low');
    expect(body.ops).toBe(1);
    expect(body.requires_review).toBe(false);

    // Queued to pending — this is the only side effect.
    const store = new PendingStore(join(stateDir, 'pending'));
    const loaded = store.load(plan.change_id);
    expect(loaded.change_id).toBe(plan.change_id);

    // NEVER writes the vault.
    expect(existsSync(join(vault, '01 Topics', 'channel-submit-test.md'))).toBe(false);
  });

  it('rejects a path-escaping plan with PLAN_VALIDATION_FAILED; nothing is queued', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { client, close } = await connect({ vaultRoot: vault, hearthStateDir: stateDir });

    const badPlan = makePlan({
      change_id: 'cp-escape',
      ops: [
        {
          op: 'create',
          path: '../../etc/passwd',
          reason: 'malicious escape attempt',
          precondition: { exists: false },
          patch: { type: 'replace', value: 'pwned' },
        },
      ],
    });

    const result = await client.callTool({
      name: 'vault_plan_submit',
      arguments: { change_plan: badPlan },
    });
    await close();

    expect(result.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body.error.code).toBe('PLAN_VALIDATION_FAILED');

    const store = new PendingStore(join(stateDir, 'pending'));
    expect(() => store.load('cp-escape')).toThrow();
  });
});

describe('vault_apply_for_owner', () => {
  it('applies a low-risk owner plan: vault written, plan removed from pending, audited as channel:*', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const store = new PendingStore(join(stateDir, 'pending'));
    const plan = makePlan({ change_id: 'cp-apply-low' });
    store.save(plan);

    const { client, close } = await connect({ vaultRoot: vault, hearthStateDir: stateDir });
    const result = await client.callTool({
      name: 'vault_apply_for_owner',
      arguments: { change_id: plan.change_id, owner_id: 'owner-123', channel: 'test-channel' },
    });
    await close();

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(body.ok).toBe(true);
    expect(body.change_id).toBe(plan.change_id);
    expect(body.ops_applied).toBe(1);

    // Vault written.
    const written = join(vault, '01 Topics', 'channel-submit-test.md');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toContain('content from the channel');

    // Plan removed from pending.
    expect(() => store.load(plan.change_id)).toThrow();

    // Audited as channel:*, no approval token involved.
    await new Promise(r => setTimeout(r, 50));
    const log = readFileSync(auditLogPath(vault), 'utf8');
    expect(log).toContain('"event":"changeplan.applied"');
    expect(log).toContain('"initiated_by":"channel:test-channel"');
  });

  it('leaves a requires_review plan pending untouched — does not apply high-risk plans', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const store = new PendingStore(join(stateDir, 'pending'));
    const plan = makePlan({
      change_id: 'cp-apply-high',
      risk: 'high',
      requires_review: true,
      ops: [
        {
          op: 'create',
          path: '01 Topics/high-risk-test.md',
          reason: 'high risk change requiring human review',
          precondition: { exists: false },
          patch: { type: 'replace', value: '# High risk\n' },
        },
      ],
    });
    store.save(plan);

    const { client, close } = await connect({ vaultRoot: vault, hearthStateDir: stateDir });
    const result = await client.callTool({
      name: 'vault_apply_for_owner',
      arguments: { change_id: plan.change_id, owner_id: 'owner-123', channel: 'test-channel' },
    });
    await close();

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(body).toEqual({
      ok: false,
      requires_review: true,
      change_id: plan.change_id,
      rendered: 'high-risk plan left pending for review',
    });

    // Vault untouched.
    expect(existsSync(join(vault, '01 Topics', 'high-risk-test.md'))).toBe(false);

    // Plan is still pending.
    const stillPending = store.load(plan.change_id);
    expect(stillPending.change_id).toBe(plan.change_id);
  });

  it('unknown change_id returns PLAN_VALIDATION_FAILED', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { client, close } = await connect({ vaultRoot: vault, hearthStateDir: stateDir });

    const result = await client.callTool({
      name: 'vault_apply_for_owner',
      arguments: { change_id: 'does-not-exist', owner_id: 'owner-123', channel: 'test-channel' },
    });
    await close();

    expect(result.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body.error.code).toBe('PLAN_VALIDATION_FAILED');
  });
});
