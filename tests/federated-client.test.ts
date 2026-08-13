// hearth Phase 2a [HF2] — minimal MCP client for federated sources
//
// queryFederatedSource() is fail-open by contract: any problem talking to a
// federated source (connect failure, rejected call, hang, malformed
// response) degrades to [] rather than throwing or hanging hearth's own
// query(). Local vault query must never be at the mercy of an external MCP
// server's behavior.
//
// buildClient() (the test seam) is deliberately SYNCHRONOUS, mirroring the
// real implementation: the handle (and its close()) must exist before
// connect() is ever awaited, so a source that hangs during connect/handshake
// can still be torn down via close() instead of orphaning its child process.

import { describe, expect, it } from 'vitest';
import { queryFederatedSource, type MinimalMcpClient } from '../src/core/federated-client.ts';
import type { FederatedSource } from '../src/core/source-registry.ts';

function makeSource(overrides: Partial<FederatedSource> = {}): FederatedSource {
  return {
    id: 'wxvault',
    transport: { kind: 'stdio', command: 'wxvault-mcp', args: ['--stdio'] },
    query_tool: 'search_messages',
    ...overrides,
  };
}

describe('queryFederatedSource: fail-open MCP client', () => {
  it('well-formed hits are mapped to full QueryHit[] with origin/verified_by set', async () => {
    const source = makeSource();
    let closed = false;
    const hits = await queryFederatedSource(source, 'when is the trip?', {
      buildClient: (): MinimalMcpClient => ({
        connect: async () => {},
        call: async (tool, args) => {
          expect(tool).toBe('search_messages');
          expect(args).toEqual({ question: 'when is the trip?' });
          return JSON.stringify({
            hits: [
              {
                claim_text: 'The trip is on the 5th.',
                source: 'chat:alice',
                anchor_summary: 'msg#42',
                confidence: 'high',
                match_score: 0.9,
              },
              {
                // minimal hit: exercise defaults
                claim_text: 'Some other claim.',
              },
            ],
          });
        },
        close: async () => {
          closed = true;
        },
      }),
    });

    expect(hits).toEqual([
      {
        page: '',
        claim_text: 'The trip is on the 5th.',
        source: 'chat:alice',
        anchor_summary: 'msg#42',
        confidence: 'high',
        match_score: 0.9,
        origin: 'federated',
        verified_by: 'wxvault',
      },
      {
        page: '',
        claim_text: 'Some other claim.',
        source: 'wxvault',
        anchor_summary: '',
        confidence: 'low',
        match_score: 0,
        origin: 'federated',
        verified_by: 'wxvault',
      },
    ]);
    expect(closed).toBe(true);
  });

  it('malformed JSON from the source → [] (no throw)', async () => {
    const source = makeSource();
    let closed = false;
    const hits = await queryFederatedSource(source, 'question', {
      buildClient: (): MinimalMcpClient => ({
        connect: async () => {},
        call: async () => 'not valid json {{{',
        close: async () => {
          closed = true;
        },
      }),
    });
    expect(hits).toEqual([]);
    expect(closed).toBe(true);
  });

  it('well-formed JSON with the wrong shape → [] (no throw)', async () => {
    const source = makeSource();
    const hits = await queryFederatedSource(source, 'question', {
      buildClient: (): MinimalMcpClient => ({
        connect: async () => {},
        call: async () => JSON.stringify({ notHits: 'oops' }),
        close: async () => {},
      }),
    });
    expect(hits).toEqual([]);
  });

  it('buildClient itself throwing (e.g. bad transport config) → [] (no throw)', async () => {
    const source = makeSource();
    const hits = await queryFederatedSource(source, 'question', {
      buildClient: (): MinimalMcpClient => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(hits).toEqual([]);
  });

  it('connect() rejecting (handshake failure) → [] and close() is still called', async () => {
    const source = makeSource();
    let closed = false;
    const hits = await queryFederatedSource(source, 'question', {
      buildClient: (): MinimalMcpClient => ({
        connect: async () => {
          throw new Error('ECONNREFUSED');
        },
        call: async () => '',
        close: async () => {
          closed = true;
        },
      }),
    });
    expect(hits).toEqual([]);
    expect(closed).toBe(true);
  });

  it('a call() that rejects → [] and close() is still called', async () => {
    const source = makeSource();
    let closed = false;
    const hits = await queryFederatedSource(source, 'question', {
      buildClient: (): MinimalMcpClient => ({
        connect: async () => {},
        call: async () => {
          throw new Error('boom');
        },
        close: async () => {
          closed = true;
        },
      }),
    });
    expect(hits).toEqual([]);
    expect(closed).toBe(true);
  });

  it('a close() that itself throws is swallowed (still returns hits)', async () => {
    const source = makeSource();
    const hits = await queryFederatedSource(source, 'question', {
      buildClient: (): MinimalMcpClient => ({
        connect: async () => {},
        call: async () => JSON.stringify({ hits: [{ claim_text: 'ok' }] }),
        close: async () => {
          throw new Error('close failed');
        },
      }),
    });
    expect(hits.length).toBe(1);
  });

  it('a call() that hangs past timeoutMs → [] within ~timeout, and close() is called', async () => {
    const source = makeSource();
    let closed = false;
    const start = Date.now();
    const hits = await queryFederatedSource(source, 'question', {
      timeoutMs: 50,
      buildClient: (): MinimalMcpClient => ({
        connect: async () => {},
        call: () => new Promise<string>(() => {}), // never resolves
        close: async () => {
          closed = true;
        },
      }),
    });
    const elapsed = Date.now() - start;
    expect(hits).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
    expect(closed).toBe(true);
  });

  it('a connect() that hangs (handshake never answers) past timeoutMs → [] AND close() is still called (regression: must not orphan the child)', async () => {
    const source = makeSource();
    let closed = false;
    const start = Date.now();
    const hits = await queryFederatedSource(source, 'question', {
      timeoutMs: 50,
      buildClient: (): MinimalMcpClient => ({
        connect: () => new Promise<void>(() => {}), // hangs forever — simulates a spawned child that never answers `initialize`
        call: async () => JSON.stringify({ hits: [{ claim_text: 'unreachable' }] }),
        close: async () => {
          closed = true;
        },
      }),
    });
    const elapsed = Date.now() - start;
    expect(hits).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
    // The critical regression check: even though connect() never resolved,
    // the handle must already exist in the outer scope so close() (which
    // tears down the spawned child) is still invoked.
    expect(closed).toBe(true);
  });
});
