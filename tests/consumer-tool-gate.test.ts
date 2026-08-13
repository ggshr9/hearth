// tests/consumer-tool-gate.test.ts
//
// Security-critical regression test for the Task 3 round-1 fix: a
// third-party consumer must not be able to bypass the per-consumer grant by
// calling vault_read / vault_search / any owner-only tool directly. Only
// vault_query was gated in the first pass — this exercises the hoisted gate
// in the CallToolRequestSchema handler that now covers every tool.
//
// Uses the real MCP wiring (createMcpServer + InMemoryTransport + Client),
// same harness pattern as tests/mcp-server-federate.test.ts.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.ts';
import { NO_ANSWER } from '../src/core/query.ts';

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

const SECRET = 'THE-SECRET-IS-swordfish-42';

/** A vault with one raw file holding a known secret string. */
function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-gate-'));
  for (const d of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA_FIXTURE);
  writeFileSync(join(root, 'raw', 'secret.md'), SECRET);
  return root;
}

async function connectedClient(ctx: Parameters<typeof createMcpServer>[0]): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => { await client.close(); } };
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected a single text content part');
  }
  return first.text;
}

describe('denied consumer: bad token — every tool refused, vault never touched', () => {
  it('vault_read is refused (PoC path) and the secret never leaves the server', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      const result = await client.callTool({ name: 'vault_read', arguments: { path: 'raw/secret.md' } });
      expect(result.isError).toBe(true);
      const body = JSON.parse(firstText(result));
      expect(body.error.code).toBe('PERMISSION_DENIED');
      expect(firstText(result)).not.toContain(SECRET);
    } finally {
      await close();
    }
  });

  it('vault_search is refused', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      const result = await client.callTool({ name: 'vault_search', arguments: { query: 'secret' } });
      expect(result.isError).toBe(true);
      const body = JSON.parse(firstText(result));
      expect(body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await close();
    }
  });

  it('vault_query is refused as PERMISSION_DENIED (not a 200-shaped denied:true body)', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      const result = await client.callTool({ name: 'vault_query', arguments: { question: 'what is the secret?' } });
      expect(result.isError).toBe(true);
      const body = JSON.parse(firstText(result));
      expect(body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await close();
    }
  });

  it('an owner-only tool (vault_plan_submit) is refused too', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      const result = await client.callTool({ name: 'vault_plan_submit', arguments: { change_plan: {} } });
      expect(result.isError).toBe(true);
      const body = JSON.parse(firstText(result));
      expect(body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await close();
    }
  });
});

describe("resolved consumer, vault:'none' — no vault read grant", () => {
  it('vault_read is refused; secret never returned', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'none', sources: [] } });
    try {
      const result = await client.callTool({ name: 'vault_read', arguments: { path: 'raw/secret.md' } });
      expect(result.isError).toBe(true);
      const body = JSON.parse(firstText(result));
      expect(body.error.code).toBe('PERMISSION_DENIED');
      expect(firstText(result)).not.toContain(SECRET);
    } finally {
      await close();
    }
  });

  it('vault_search is refused', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'none', sources: [] } });
    try {
      const result = await client.callTool({ name: 'vault_search', arguments: { query: 'secret' } });
      expect(result.isError).toBe(true);
      const body = JSON.parse(firstText(result));
      expect(body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await close();
    }
  });

  it('vault_query is still callable (federated-only / NO_ANSWER, not an error)', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'none', sources: [] } });
    try {
      const result = await client.callTool({ name: 'vault_query', arguments: { question: 'what is the secret?' } });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe(NO_ANSWER);
    } finally {
      await close();
    }
  });
});

describe("resolved consumer, vault:'r' — read grant", () => {
  it('vault_read succeeds and returns the secret', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'r', sources: [] } });
    try {
      const result = await client.callTool({ name: 'vault_read', arguments: { path: 'raw/secret.md' } });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain(SECRET);
    } finally {
      await close();
    }
  });

  it('vault_plan_submit (owner-only) is still refused', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'r', sources: [] } });
    try {
      const result = await client.callTool({ name: 'vault_plan_submit', arguments: { change_plan: {} } });
      expect(result.isError).toBe(true);
      const body = JSON.parse(firstText(result));
      expect(body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await close();
    }
  });
});

describe('owner (no consumer field) — unrestricted, byte-identical to pre-Phase-3', () => {
  it('vault_read succeeds', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault });
    try {
      const result = await client.callTool({ name: 'vault_read', arguments: { path: 'raw/secret.md' } });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain(SECRET);
    } finally {
      await close();
    }
  });

  it('vault_plan_submit reaches its normal handler (not gate-refused) — fails on plan validation, not permission', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault });
    try {
      const result = await client.callTool({ name: 'vault_plan_submit', arguments: { change_plan: {} } });
      expect(result.isError).toBe(true);
      const body = JSON.parse(firstText(result));
      // Reaches the real vault_plan_submit handler and fails plan
      // validation (empty {} is not a valid ChangePlan) — NOT the gate's
      // PERMISSION_DENIED / owner_only_tool refusal.
      expect(body.error.code).toBe('PLAN_VALIDATION_FAILED');
    } finally {
      await close();
    }
  });
});
