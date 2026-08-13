// hearth Phase 2a [HF3] — vault_query MCP tool `federate` flag tests
//
// This is the honesty-guarantee test: with `federate` absent or false,
// vault_query MUST behave exactly as it always has — no federated source is
// consulted, and the result is byte-for-byte what the plain local query()
// produces. Only `federate: true` opts into the federatedQuery() router.
//
// Exercises the real MCP wiring (ListTools schema + CallTool handler) over
// an in-memory client/server transport pair — no mocking library, no
// subprocess. The federate:true path is driven through the same
// federatedQueryFn injection seam ServerContext now exposes for tests
// (mirroring the queryFn/sourceQueryFn seams federatedQuery() itself takes),
// so we can assert "no source consulted" as a hard fact (the injected
// function's call count) rather than inferring it from output alone.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.ts';
import { query, NO_ANSWER, type QueryResult } from '../src/core/query.ts';
import { sha256 } from '../src/core/hash.ts';

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
  const root = mkdtempSync(join(tmpdir(), 'hearth-mcp-fed-'));
  for (const d of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA_FIXTURE);
  return root;
}

/** Vault with exactly one verified claim, matching "what is hearth?". */
function makeVaultWithClaim(): string {
  const vault = makeVault();
  const quote = 'Hearth is a personal AI runtime for your markdown vault.';
  writeFileSync(join(vault, 'raw', 'a.md'), quote);
  const fm = [
    '---',
    'type: "concept"',
    'status: "draft"',
    'author: "agent:extract"',
    'claims:',
    `  - text: ${JSON.stringify(quote)}`,
    '    source: "raw/a.md"',
    '    anchor:',
    '      type: line',
    '      line_start: 1',
    '      line_end: 1',
    `      quote: ${JSON.stringify(quote)}`,
    `      quote_hash: ${JSON.stringify(sha256(quote))}`,
    '    confidence: high',
    '---',
    '',
    '# Intro',
    '',
  ];
  mkdirSync(join(vault, '01 Topics'), { recursive: true });
  writeFileSync(join(vault, '01 Topics', 'intro.md'), fm.join('\n'));
  return vault;
}

async function connectedClient(ctx: Parameters<typeof createMcpServer>[0]): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => { await client.close(); } };
}

function parseResultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected a single text content part');
  }
  return first.text;
}

describe('vault_query MCP tool: ListTools schema', () => {
  it('exposes an optional boolean `federate` param; `question` remains the only required one', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault });
    try {
      const { tools } = await client.listTools();
      const vaultQuery = tools.find(t => t.name === 'vault_query');
      expect(vaultQuery).toBeDefined();
      expect(vaultQuery!.inputSchema.required).toEqual(['question']);
      expect((vaultQuery!.inputSchema.properties as Record<string, unknown>).federate).toEqual({ type: 'boolean' });
    } finally {
      await close();
    }
  });
});

describe('vault_query: federate absent/false — the honesty guarantee', () => {
  it('federate omitted: no source is consulted (federatedQueryFn never called), result equals plain local query()', async () => {
    const vault = makeVaultWithClaim();
    let federatedCalls = 0;
    const { client, close } = await connectedClient({
      vaultRoot: vault,
      federatedQueryFn: async (): Promise<QueryResult> => {
        federatedCalls++;
        throw new Error('federatedQueryFn must not be invoked when federate is absent');
      },
    });
    try {
      const result = await client.callTool({ name: 'vault_query', arguments: { question: 'what is hearth?' } });
      expect(federatedCalls).toBe(0);

      const expected = query(vault, 'what is hearth?');
      expect(JSON.parse(parseResultText(result))).toEqual(expected);
    } finally {
      await close();
    }
  });

  it('federate: false: no source is consulted, result equals plain local query()', async () => {
    const vault = makeVaultWithClaim();
    let federatedCalls = 0;
    const { client, close } = await connectedClient({
      vaultRoot: vault,
      federatedQueryFn: async (): Promise<QueryResult> => {
        federatedCalls++;
        throw new Error('federatedQueryFn must not be invoked when federate is false');
      },
    });
    try {
      const result = await client.callTool({ name: 'vault_query', arguments: { question: 'what is hearth?', federate: false } });
      expect(federatedCalls).toBe(0);

      const expected = query(vault, 'what is hearth?');
      expect(JSON.parse(parseResultText(result))).toEqual(expected);
    } finally {
      await close();
    }
  });

  it('federate omitted, no verified claim → literal NO_ANSWER text (unchanged behavior)', async () => {
    const vault = makeVault();
    const { client, close } = await connectedClient({ vaultRoot: vault });
    try {
      const result = await client.callTool({ name: 'vault_query', arguments: { question: 'what is hearth?' } });
      expect(parseResultText(result)).toBe(NO_ANSWER);
    } finally {
      await close();
    }
  });
});

describe('vault_query: federate:true — the federated router path', () => {
  it('calls federatedQueryFn with (vaultRoot, question, {stateDir}) and returns its merged/labeled result verbatim', async () => {
    const vault = makeVaultWithClaim();
    const stateDir = mkdtempSync(join(tmpdir(), 'hearth-mcp-fed-state-'));
    let sawArgs: unknown[] = [];
    const canned: QueryResult = {
      question: 'what is hearth?',
      hits: [
        {
          page: '01 Topics/intro.md',
          claim_text: 'Hearth is a personal AI runtime for your markdown vault.',
          source: 'raw/a.md',
          anchor_summary: 'L1-L1',
          confidence: 'high',
          match_score: 0.6,
          origin: 'vault',
          verified_by: 'vault',
        },
        {
          page: '',
          claim_text: 'Federated answer from wxvault.',
          source: 'chat:alice',
          anchor_summary: 'msg#1',
          confidence: 'medium',
          match_score: 0.9,
          origin: 'federated',
          verified_by: 'wxvault',
        },
      ],
      no_answer_message: NO_ANSWER,
    };

    const { client, close } = await connectedClient({
      vaultRoot: vault,
      stateDir,
      federatedQueryFn: async (vaultRoot, question, opts): Promise<QueryResult> => {
        sawArgs = [vaultRoot, question, opts];
        return canned;
      },
    });
    try {
      const result = await client.callTool({ name: 'vault_query', arguments: { question: 'what is hearth?', federate: true } });
      expect(sawArgs[0]).toBe(vault);
      expect(sawArgs[1]).toBe('what is hearth?');
      expect((sawArgs[2] as { stateDir?: string } | undefined)?.stateDir).toBe(stateDir);

      const parsed = JSON.parse(parseResultText(result));
      expect(parsed).toEqual(canned);
      expect(parsed.hits.find((h: { origin: string }) => h.origin === 'federated').verified_by).toBe('wxvault');
      expect(parsed.hits.find((h: { origin: string }) => h.origin === 'vault').verified_by).toBe('vault');
    } finally {
      await close();
    }
  });

  it('federate:true with no injected seam falls through to the real federatedQuery() (smoke test, no throw, no sources registered → local-only)', async () => {
    const vault = makeVaultWithClaim();
    const stateDir = mkdtempSync(join(tmpdir(), 'hearth-mcp-fed-state-'));
    const { client, close } = await connectedClient({ vaultRoot: vault, stateDir });
    try {
      const result = await client.callTool({ name: 'vault_query', arguments: { question: 'what is hearth?', federate: true } });
      const parsed = JSON.parse(parseResultText(result));
      expect(parsed.hits.length).toBeGreaterThan(0);
      for (const hit of parsed.hits) {
        expect(hit.origin).toBe('vault');
        expect(hit.verified_by).toBe('vault');
      }
    } finally {
      await close();
    }
  });
});
