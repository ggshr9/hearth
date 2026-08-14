import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFilesServer, parseArgs } from '../src/server.ts';
import type { IndexRecord } from '../src/index-store.ts';

function rec(relPath: string, text: string): IndexRecord {
  return { relPath, rootLabel: 'root', absPath: '/x/' + relPath, text, isMedia: false };
}

test('parseArgs collects repeatable --root and optional --name', () => {
  expect(parseArgs(['--root', '/a', '--root', '/b'])).toEqual({ roots: ['/a', '/b'], toolName: 'files_query' });
  expect(parseArgs(['--root', '/a', '--name', 'docs_query'])).toEqual({ roots: ['/a'], toolName: 'docs_query' });
  expect(parseArgs([])).toEqual({ roots: [], toolName: 'files_query' });
});

test('files_query returns a federated-client-valid {hits} payload over MCP', async () => {
  const index = [rec('q3.md', 'quarterly revenue forecast up 12%')];
  const server = createFilesServer(index, 'files_query');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const res: any = await client.callTool({ name: 'files_query', arguments: { question: 'quarterly revenue' } });
  const text = res.content[0].text;
  const parsed = JSON.parse(text);
  expect(Array.isArray(parsed.hits)).toBe(true);
  expect(parsed.hits.length).toBe(1);
  // must satisfy federated-client's RawFederatedHit: claim_text is a string
  expect(typeof parsed.hits[0].claim_text).toBe('string');
  expect(parsed.hits[0].source).toBe('q3.md');
  expect(parsed.hits[0].match_score).toBe(1);
  await client.close();
});

test('files_query on a no-match question returns {hits:[]}', async () => {
  const server = createFilesServer([rec('a.md', 'cats')], 'files_query');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res: any = await client.callTool({ name: 'files_query', arguments: { question: 'quarterly revenue' } });
  expect(JSON.parse(res.content[0].text)).toEqual({ hits: [] });
  await client.close();
});

test('calling an unknown tool name returns isError with {hits:[]}, no throw', async () => {
  const server = createFilesServer([rec('a.md', 'cats')], 'files_query');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res: any = await client.callTool({ name: 'not_a_real_tool', arguments: { question: 'anything' } });
  expect(res.isError).toBeTruthy();
  expect(JSON.parse(res.content[0].text)).toEqual({ hits: [] });
  await client.close();
});

test('an empty index returns {hits:[]} for any question', async () => {
  const server = createFilesServer([], 'files_query');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res: any = await client.callTool({ name: 'files_query', arguments: { question: 'anything' } });
  expect(JSON.parse(res.content[0].text)).toEqual({ hits: [] });
  await client.close();
});
