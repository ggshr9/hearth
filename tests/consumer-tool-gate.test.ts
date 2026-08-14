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

function resourceText(c: { text?: string; blob?: string }): string {
  if (typeof c.text !== 'string') throw new Error('expected text resource content, got blob');
  return c.text;
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

// ── resources/read — sibling JSON-RPC surface, same broker ────────────────
//
// Round-2 fix: hearth://pending, hearth://schema, hearth://vault-map, and
// hearth://lint-report were completely ungated on the resources channel —
// a denied or vault:'none' consumer could call readResource() directly and
// get e.g. every pending ChangePlan's full patch content (unreviewed file
// bodies) or the raw vault SCHEMA.md, bypassing the tool gate entirely.

describe('resources/read gate: denied consumer — every vault-derived resource rejected', () => {
  it('hearth://schema rejects', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      await expect(client.readResource({ uri: 'hearth://schema' })).rejects.toBeTruthy();
    } finally {
      await close();
    }
  });

  it('hearth://vault-map rejects', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      await expect(client.readResource({ uri: 'hearth://vault-map' })).rejects.toBeTruthy();
    } finally {
      await close();
    }
  });

  it('hearth://pending rejects (the PoC path — full pending-plan bodies never leak)', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      await expect(client.readResource({ uri: 'hearth://pending' })).rejects.toBeTruthy();
    } finally {
      await close();
    }
  });

  it('ListResources advertises nothing vault-derived (agent-instructions only, if anything)', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      const { resources } = await client.listResources();
      expect(resources.map(r => r.uri)).toEqual(['hearth://agent-instructions']);
    } finally {
      await close();
    }
  });
});

describe("resources/read gate: vault:'none' resolved consumer", () => {
  it('hearth://schema, hearth://vault-map, hearth://lint-report all rejected', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'none', sources: [] } });
    try {
      await expect(client.readResource({ uri: 'hearth://schema' })).rejects.toBeTruthy();
      await expect(client.readResource({ uri: 'hearth://vault-map' })).rejects.toBeTruthy();
      await expect(client.readResource({ uri: 'hearth://lint-report' })).rejects.toBeTruthy();
    } finally {
      await close();
    }
  });

  it('hearth://pending rejected (owner-only, independent of vault grant)', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'none', sources: [] } });
    try {
      await expect(client.readResource({ uri: 'hearth://pending' })).rejects.toBeTruthy();
    } finally {
      await close();
    }
  });

  it('hearth://agent-instructions succeeds (static guidance, no vault data)', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'none', sources: [] } });
    try {
      const result = await client.readResource({ uri: 'hearth://agent-instructions' });
      expect(resourceText(result.contents[0]!)).toBeTruthy();
    } finally {
      await close();
    }
  });
});

describe("resources/read gate: vault:'r' resolved consumer", () => {
  it('hearth://schema and hearth://vault-map succeed', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'r', sources: [] } });
    try {
      const schema = await client.readResource({ uri: 'hearth://schema' });
      expect(resourceText(schema.contents[0]!)).toBeTruthy();
      const map = await client.readResource({ uri: 'hearth://vault-map' });
      expect(resourceText(map.contents[0]!)).toBeTruthy();
    } finally {
      await close();
    }
  });

  it('hearth://pending still rejected — owner-only regardless of vault:r', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'r', sources: [] } });
    try {
      await expect(client.readResource({ uri: 'hearth://pending' })).rejects.toBeTruthy();
    } finally {
      await close();
    }
  });

  it('ListResources advertises schema/vault-map/lint-report/agent-instructions but not pending', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'r', sources: [] } });
    try {
      const { resources } = await client.listResources();
      const uris = resources.map(r => r.uri).sort();
      expect(uris).toEqual(['hearth://agent-instructions', 'hearth://lint-report', 'hearth://schema', 'hearth://vault-map']);
    } finally {
      await close();
    }
  });
});

describe('resources/read gate: owner (no consumer field) — unrestricted, byte-identical to before', () => {
  it('every resource reads successfully, including hearth://pending', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault });
    try {
      for (const uri of ['hearth://schema', 'hearth://vault-map', 'hearth://pending', 'hearth://lint-report', 'hearth://agent-instructions']) {
        const result = await client.readResource({ uri });
        expect(resourceText(result.contents[0]!)).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  it('ListResources advertises all five resources', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault });
    try {
      const { resources } = await client.listResources();
      expect(resources.map(r => r.uri).sort()).toEqual([
        'hearth://agent-instructions', 'hearth://lint-report', 'hearth://pending', 'hearth://schema', 'hearth://vault-map',
      ]);
    } finally {
      await close();
    }
  });
});

// ── tools/list — advertise only what the consumer can actually call ──────
//
// Round-3 fix: ListTools used to hand every consumer the full 11-tool menu
// regardless of grant, inconsistent with ListResources (which already
// filters). Now it filters via the same CONSUMER_READ_TOOLS set the
// CallTool gate uses, so what's advertised matches what's callable.

describe('tools/list gate', () => {
  it('owner (no consumer field) sees all tools, including owner-only ones', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault });
    try {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('vault_plan_submit');
      expect(names.length).toBeGreaterThanOrEqual(11);
    } finally {
      await close();
    }
  });

  it("resolved consumer, vault:'r' — exactly the read/query surface, no owner-only tools", async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'r', sources: [] } });
    try {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name).sort();
      expect(names).toEqual(['vault_query', 'vault_read', 'vault_search']);
      expect(names).not.toContain('vault_plan_submit');
    } finally {
      await close();
    }
  });

  it("resolved consumer, vault:'none' — only vault_query (no vault_read/vault_search, no owner-only tools)", async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { id: 'c', vault: 'none', sources: [] } });
    try {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      expect(names).toEqual(['vault_query']);
    } finally {
      await close();
    }
  });

  it('denied consumer — empty tool list', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault, consumer: { denied: 'bad_token', id: 'x' } });
    try {
      const { tools } = await client.listTools();
      expect(tools).toEqual([]);
    } finally {
      await close();
    }
  });
});
