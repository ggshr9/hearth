import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpotlightServer, parseSpotlightArgs } from '../src/spotlight-server.ts';
import { hitsFromPaths, DOC_EXTS } from '../src/spotlight.ts';

test('parseSpotlightArgs collects --onlyin (repeatable), --name, --limit', () => {
  expect(parseSpotlightArgs(['--onlyin', '/a', '--onlyin', '/b', '--name', 'docs_query', '--limit', '10']))
    .toEqual({ onlyIn: ['/a', '/b'], toolName: 'docs_query', limit: 10, exclude: [], allowExts: DOC_EXTS as string[] });
  expect(parseSpotlightArgs([])).toEqual({ onlyIn: [], toolName: 'files_query', limit: 40, exclude: [], allowExts: DOC_EXTS as string[] });
});

test('files_query returns a valid {hits} payload using an injected mdfind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-spotsrv-'));
  const a = join(dir, 'q.md'); writeFileSync(a, 'project atlas quarterly revenue');
  const fakeMdfind = async () => [a]; // pretend Spotlight matched this file
  const server = createSpotlightServer('files_query', { onlyIn: [], limit: 40, exclude: [], allowExts: DOC_EXTS as string[] }, { mdfind: fakeMdfind as any, hitsFromPaths });
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
  const server = createSpotlightServer('files_query', { onlyIn: [], limit: 40, exclude: [], allowExts: DOC_EXTS as string[] }, { mdfind: emptyMdfind as any, hitsFromPaths });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const bad: any = await client.callTool({ name: 'nope', arguments: {} });
  expect(bad.isError).toBeTruthy();
  const empty: any = await client.callTool({ name: 'files_query', arguments: { question: 'anything' } });
  expect(JSON.parse(empty.content[0].text)).toEqual({ hits: [] });
  await client.close();
});

test('parseSpotlightArgs parses --exclude (repeatable), --ext, --all-types', () => {
  expect(parseSpotlightArgs(['--exclude', 'a', '--exclude', 'b'])).toMatchObject({ exclude: ['a', 'b'], allowExts: DOC_EXTS });
  expect(parseSpotlightArgs(['--ext', 'pdf,md']).allowExts).toEqual(['pdf', 'md']);
  expect(parseSpotlightArgs(['--all-types']).allowExts).toBeNull();
  expect(parseSpotlightArgs([]).allowExts).toEqual(DOC_EXTS as string[]);
});

test('files_query filters junk + source code out of results (default doc mode)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-scope-'));
  const doc = join(dir, 'q3.md'); writeFileSync(doc, 'project atlas quarterly revenue');
  const code = join(dir, 'index.ts'); writeFileSync(code, 'const atlas = "revenue"');
  const junk = join(dir, 'node_modules'); require('node:fs').mkdirSync(junk); const junkFile = join(junk, 'readme.md'); writeFileSync(junkFile, 'atlas revenue');
  // injected mdfind returns all three; filter must keep only the doc
  const fakeMdfind = async () => [doc, code, junkFile];
  const server = createSpotlightServer('files_query', { onlyIn: [], limit: 30, exclude: [], allowExts: DOC_EXTS as string[] }, { mdfind: fakeMdfind as any, hitsFromPaths });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res: any = await client.callTool({ name: 'files_query', arguments: { question: 'atlas revenue' } });
  const sources = JSON.parse(res.content[0].text).hits.map((h: any) => h.source);
  expect(sources.some((s: string) => s.includes('q3.md'))).toBe(true);
  expect(sources.some((s: string) => s.includes('index.ts'))).toBe(false);   // code excluded
  expect(sources.some((s: string) => s.includes('node_modules'))).toBe(false); // junk excluded
  await client.close();
});

test('--all-types lets a code file through (junk still excluded)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-scope-all-'));
  const code = join(dir, 'index.ts'); writeFileSync(code, 'atlas revenue lives here');
  const fakeMdfind = async () => [code];
  const server = createSpotlightServer('files_query', { onlyIn: [], limit: 30, exclude: [], allowExts: null }, { mdfind: fakeMdfind as any, hitsFromPaths });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res: any = await client.callTool({ name: 'files_query', arguments: { question: 'atlas revenue' } });
  expect(JSON.parse(res.content[0].text).hits.length).toBe(1);
  await client.close();
});
