// hearth Phase 2a [HF2] — minimal MCP client for federated sources
//
// queryFederatedSource() is fail-open by contract: any problem talking to a
// federated source (connect failure, rejected call, hang, malformed
// response) degrades to [] rather than throwing or hanging hearth's own
// query(). Local vault query must never be at the mercy of an external MCP
// server's behavior.

import { describe, expect, it } from 'vitest';
import { queryFederatedSource } from '../src/core/federated-client.ts';
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
      makeClient: async () => ({
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
      makeClient: async () => ({
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
      makeClient: async () => ({
        call: async () => JSON.stringify({ notHits: 'oops' }),
        close: async () => {},
      }),
    });
    expect(hits).toEqual([]);
  });

  it('makeClient itself throwing (connect failure) → [] (no throw)', async () => {
    const source = makeSource();
    const hits = await queryFederatedSource(source, 'question', {
      makeClient: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(hits).toEqual([]);
  });

  it('a call() that rejects → [] and close() is still called', async () => {
    const source = makeSource();
    let closed = false;
    const hits = await queryFederatedSource(source, 'question', {
      makeClient: async () => ({
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
      makeClient: async () => ({
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
      makeClient: async () => ({
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
});
