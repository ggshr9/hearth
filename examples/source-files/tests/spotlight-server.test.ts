import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpotlightServer, parseSpotlightArgs } from '../src/spotlight-server.ts';
import { hitsFromPaths } from '../src/spotlight.ts';

test('parseSpotlightArgs collects --onlyin (repeatable), --name, --limit', () => {
  expect(parseSpotlightArgs(['--onlyin', '/a', '--onlyin', '/b', '--name', 'docs_query', '--limit', '10']))
    .toEqual({ onlyIn: ['/a', '/b'], toolName: 'docs_query', limit: 10 });
  expect(parseSpotlightArgs([])).toEqual({ onlyIn: [], toolName: 'files_query', limit: 40 });
});

test('files_query returns a valid {hits} payload using an injected mdfind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-spotsrv-'));
  const a = join(dir, 'q.md'); writeFileSync(a, 'project atlas quarterly revenue');
  const fakeMdfind = async () => [a]; // pretend Spotlight matched this file
  const server = createSpotlightServer('files_query', { onlyIn: [], limit: 40 }, { mdfind: fakeMdfind as any, hitsFromPaths });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res: any = await client.callTool({ name: 'files_query', arguments: { question: 'atlas revenue' } });
  const parsed = JSON.parse(res.content[0].text);
  expect(Array.isArray(parsed.hits)).toBe(true);
  expect(parsed.hits.length).toBe(1);
  expect(typeof parsed.hits[0].claim_text).toBe('string');
  expect(parsed.hits[0].source).toContain('q.md');
  await client.close();
});

test('unknown tool -> isError + {hits:[]}; empty candidates -> {hits:[]}', async () => {
  const emptyMdfind = async () => [];
  const server = createSpotlightServer('files_query', { onlyIn: [], limit: 40 }, { mdfind: emptyMdfind as any, hitsFromPaths });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const bad: any = await client.callTool({ name: 'nope', arguments: {} });
  expect(bad.isError).toBeTruthy();
  const empty: any = await client.callTool({ name: 'files_query', arguments: { question: 'anything' } });
  expect(JSON.parse(empty.content[0].text)).toEqual({ hits: [] });
  await client.close();
});
