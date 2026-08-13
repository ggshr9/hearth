// hearth Phase 2a [HF1] — federated source registry tests
//
// loadSources() is fail-safe by contract: it must never throw, regardless of
// what's on disk (missing file, malformed JSON, invalid entries). Federation
// is opt-in additive functionality; a broken sources.json must never break
// vault-only query.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSources } from '../src/core/source-registry.ts';

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'hearth-sources-'));
}

describe('loadSources: fail-safe federated source registry', () => {
  it('missing sources.json → []', () => {
    const stateDir = makeStateDir();
    expect(loadSources(stateDir)).toEqual([]);
  });

  it('malformed JSON → [] (never throws)', () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, 'sources.json'), '{ not valid json ][');
    expect(() => loadSources(stateDir)).not.toThrow();
    expect(loadSources(stateDir)).toEqual([]);
  });

  it('valid entries are parsed as-is', () => {
    const stateDir = makeStateDir();
    const sources = [
      {
        id: 'wxvault',
        description: 'WeChat vault MCP',
        transport: { kind: 'stdio', command: 'wxvault-mcp', args: ['--stdio'], env: { FOO: 'bar' } },
        query_tool: 'search_messages',
      },
    ];
    writeFileSync(join(stateDir, 'sources.json'), JSON.stringify(sources));
    expect(loadSources(stateDir)).toEqual(sources);
  });

  it('invalid entries are dropped, valid entries kept', () => {
    const stateDir = makeStateDir();
    const valid = {
      id: 'good-source',
      transport: { kind: 'stdio', command: 'good-cmd' },
      query_tool: 'query',
    };
    const missingId = { transport: { kind: 'stdio', command: 'x' }, query_tool: 'q' };
    const emptyId = { id: '', transport: { kind: 'stdio', command: 'x' }, query_tool: 'q' };
    const badKind = { id: 'bad-kind', transport: { kind: 'http', command: 'x' }, query_tool: 'q' };
    const missingCommand = { id: 'no-cmd', transport: { kind: 'stdio' }, query_tool: 'q' };
    const missingQueryTool = { id: 'no-tool', transport: { kind: 'stdio', command: 'x' } };
    writeFileSync(
      join(stateDir, 'sources.json'),
      JSON.stringify([valid, missingId, emptyId, badKind, missingCommand, missingQueryTool]),
    );
    expect(loadSources(stateDir)).toEqual([valid]);
  });

  it('non-array JSON → [] (never throws)', () => {
    const stateDir = makeStateDir();
    writeFileSync(join(stateDir, 'sources.json'), JSON.stringify({ id: 'not-an-array' }));
    expect(() => loadSources(stateDir)).not.toThrow();
    expect(loadSources(stateDir)).toEqual([]);
  });

  it('defaults to ~/.hearth/sources.json when no stateDir is given', () => {
    expect(() => loadSources()).not.toThrow();
  });
});
