# Spotlight-backed files province Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a Spotlight-backed (`mdfind`) MCP server variant to `examples/source-files/` — whole-disk recall via Spotlight, precision hits via the existing `extract.ts` + `search.ts` — so hearth can federate over the user's scattered files.

**Architecture:** Two new modules in the existing `examples/source-files/` package: `spotlight.ts` (`mdfind` wrapper with an injectable exec seam + `hitsFromPaths` that reuses `extractFile`/`search`) and `spotlight-server.ts` (an MCP stdio server exposing `files_query` over Spotlight). No changes to the existing walk-mode modules; heavy reuse of extract/search.

**Tech Stack:** Bun + TypeScript, `@modelcontextprotocol/sdk`, `Bun.spawn` for `/usr/bin/mdfind`. Reuses `extract.ts`, `search.ts`, `index-store.ts` (`IndexRecord`).

## Global Constraints

- All new files under `examples/source-files/`; stage only those. Existing walk-mode files (`server.ts`, `index-store.ts`, `search.ts`, `extract.ts`) are NOT modified (except the README).
- **stdout is the MCP protocol** — all logging via `process.stderr`, never stdout/console.log.
- **Fail-open, never crash:** `mdfind` missing / non-zero exit / empty → `[]`. macOS-only; on non-macOS the wrapper degrades to empty, the server still runs.
- **Injectable seams for tests:** `mdfind(..., exec?)` takes an exec function; `createSpotlightServer(..., deps?)` takes `{mdfind, hitsFromPaths}` — so unit tests need no real Spotlight.
- **Hit shape** unchanged — `search()`'s `Hit` (satisfies hearth's `RawFederatedHit`, string `claim_text`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Non-goals:** non-macOS Spotlight, `kMDItem*` predicate syntax, cross-query extraction cache, media transcription.

---

## File Structure
- Create `examples/source-files/src/spotlight.ts` (Task 1)
- Create `examples/source-files/tests/spotlight.test.ts` (Task 1)
- Create `examples/source-files/src/spotlight-server.ts` (Task 2)
- Create `examples/source-files/tests/spotlight-server.test.ts` (Task 2)
- Modify `examples/source-files/README.md` (Task 2)

---

## Task 1: `mdfind` wrapper + candidate→hits assembly

**Files:** Create `src/spotlight.ts`, `tests/spotlight.test.ts`

**Interfaces:**
- Consumes: `extractFile` from `./extract.ts`; `search`, `Hit` from `./search.ts`; `IndexRecord` from `./index-store.ts`.
- Produces:
  - `type ExecFn = (argv: string[]) => Promise<string>`
  - `async function mdfind(question: string, opts?: { onlyIn?: string[]; limit?: number }, exec?: ExecFn): Promise<string[]>`
  - `async function hitsFromPaths(paths: string[], question: string): Promise<Hit[]>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/spotlight.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mdfind, hitsFromPaths } from '../src/spotlight.ts';

test('mdfind builds -onlyin argv + query, parses newline paths, caps at limit', async () => {
  let seen: string[] = [];
  const fakeExec = async (argv: string[]) => { seen = argv; return '/a/one.md\n/a/two.md\n/a/three.md\n'; };
  const paths = await mdfind('revenue', { onlyIn: ['/docs', '/more'], limit: 2 }, fakeExec);
  expect(seen).toEqual(['-onlyin', '/docs', '-onlyin', '/more', 'revenue']);
  expect(paths).toEqual(['/a/one.md', '/a/two.md']);
});

test('mdfind returns [] on empty question and on exec failure (fail-open)', async () => {
  expect(await mdfind('   ', {}, async () => 'x')).toEqual([]);
  expect(await mdfind('q', {}, async () => { throw new Error('boom'); })).toEqual([]);
});

test('hitsFromPaths extracts + ranks real temp files, skips unextractable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-spot-'));
  const a = join(dir, 'q.md'); writeFileSync(a, 'quarterly revenue forecast up');
  const b = join(dir, 'other.md'); writeFileSync(b, 'unrelated kittens');
  const c = join(dir, 'img.png'); writeFileSync(c, Buffer.from([0x89]));
  const hits = await hitsFromPaths([a, b, c], 'quarterly revenue');
  expect(hits.length).toBe(1);
  expect(hits[0]!.source).toContain('q.md');
  expect(hits[0]!.anchor_summary).toContain('q.md:1');
  expect(hits[0]!.match_score).toBe(1);
});

test('mdfind real smoke — runs and returns an array (fail-open if mdfind absent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-spot-real-'));
  const paths = await mdfind('the', { onlyIn: [dir], limit: 5 });
  expect(Array.isArray(paths)).toBe(true);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd examples/source-files && bun test tests/spotlight.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/spotlight.ts`**

```ts
// Spotlight-backed recall: query macOS Spotlight (mdfind) for whole-disk
// candidates, then reuse extract.ts/search.ts to turn the top candidates into
// precise, anchored hits. Fail-open: mdfind absent/failed/empty -> []. macOS-only.
import { homedir } from 'node:os';
import { extractFile } from './extract.ts';
import { search, type Hit } from './search.ts';
import type { IndexRecord } from './index-store.ts';

export type ExecFn = (argv: string[]) => Promise<string>;

const defaultExec: ExecFn = async (argv) => {
  const proc = Bun.spawn(['/usr/bin/mdfind', ...argv], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`mdfind exited ${code}`);
  return out;
};

export async function mdfind(
  question: string,
  opts?: { onlyIn?: string[]; limit?: number },
  exec: ExecFn = defaultExec,
): Promise<string[]> {
  const q = question.trim();
  if (!q) return [];
  const argv: string[] = [];
  for (const dir of opts?.onlyIn ?? []) argv.push('-onlyin', dir);
  argv.push(q);
  let out: string;
  try {
    out = await exec(argv);
  } catch (err) {
    process.stderr.write(`[source-files] mdfind failed: ${(err as Error).message}\n`);
    return [];
  }
  const paths = out.split('\n').map(s => s.trim()).filter(Boolean);
  return paths.slice(0, opts?.limit ?? 40);
}

function displayPath(abs: string): string {
  const home = homedir();
  return abs.startsWith(home) ? '~' + abs.slice(home.length) : abs;
}

export async function hitsFromPaths(paths: string[], question: string): Promise<Hit[]> {
  const index: IndexRecord[] = [];
  for (const abs of paths) {
    const ex = await extractFile(abs);
    if (ex === null) continue;
    index.push({ relPath: displayPath(abs), rootLabel: 'spotlight', absPath: abs, text: ex.text, isMedia: ex.isMedia });
  }
  return search(index, question);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd examples/source-files && bun test tests/spotlight.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/source-files/src/spotlight.ts examples/source-files/tests/spotlight.test.ts
git commit -m "feat(source-files): mdfind wrapper + candidate->hits assembly (Spotlight recall)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Spotlight MCP server + README

**Files:** Create `src/spotlight-server.ts`, `tests/spotlight-server.test.ts`; Modify `README.md`

**Interfaces:**
- Consumes: `mdfind`, `hitsFromPaths` from `./spotlight.ts`; `@modelcontextprotocol/sdk`.
- Produces:
  - `function parseSpotlightArgs(argv: string[]): { onlyIn: string[]; toolName: string; limit: number }`
  - `interface SpotlightDeps { mdfind: typeof import('./spotlight.ts').mdfind; hitsFromPaths: typeof import('./spotlight.ts').hitsFromPaths }`
  - `function createSpotlightServer(toolName: string, opts: { onlyIn: string[]; limit: number }, deps?: SpotlightDeps): Server`
  - `async function main(argv: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/spotlight-server.test.ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `cd examples/source-files && bun test tests/spotlight-server.test.ts`
Expected: FAIL (module not found). (If SDK import paths differ, cross-reference `tests/server.test.ts` — same imports.)

- [ ] **Step 3: Write `src/spotlight-server.ts`**

```ts
// MCP stdio server, Spotlight mode: files_query({question}) over macOS
// Spotlight (mdfind) for whole-disk recall + extract/search for precise hits.
// stdout is the MCP transport — all logging to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mdfind, hitsFromPaths } from './spotlight.ts';

export function parseSpotlightArgs(argv: string[]): { onlyIn: string[]; toolName: string; limit: number } {
  const onlyIn: string[] = [];
  let toolName = 'files_query';
  let limit = 40;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--onlyin' && argv[i + 1] !== undefined) onlyIn.push(argv[++i]!);
    else if (argv[i] === '--name' && argv[i + 1] !== undefined) toolName = argv[++i]!;
    else if (argv[i] === '--limit' && argv[i + 1] !== undefined) {
      const n = parseInt(argv[++i]!, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { onlyIn, toolName, limit };
}

export interface SpotlightDeps { mdfind: typeof mdfind; hitsFromPaths: typeof hitsFromPaths }

export function createSpotlightServer(
  toolName: string,
  opts: { onlyIn: string[]; limit: number },
  deps: SpotlightDeps = { mdfind, hitsFromPaths },
): Server {
  const server = new Server({ name: 'source-files-spotlight', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: toolName,
      description: 'Whole-disk file search via macOS Spotlight (mdfind). Returns snippet hits with file:line anchors.',
      inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== toolName) {
      return { content: [{ type: 'text', text: JSON.stringify({ hits: [] }) }], isError: true };
    }
    const question = String((req.params.arguments ?? {}).question ?? '');
    const paths = await deps.mdfind(question, { onlyIn: opts.onlyIn, limit: opts.limit });
    const hits = await deps.hitsFromPaths(paths, question);
    return { content: [{ type: 'text', text: JSON.stringify({ hits }) }] };
  });
  return server;
}

export async function main(argv: string[]): Promise<void> {
  const { onlyIn, toolName, limit } = parseSpotlightArgs(argv);
  process.stderr.write(`[source-files] spotlight mode: scope=${onlyIn.length ? onlyIn.join(',') : 'whole-disk'} limit=${limit} tool=${toolName}\n`);
  const server = createSpotlightServer(toolName, { onlyIn, limit });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd examples/source-files && bun test tests/spotlight-server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Update README**

Add a "Spotlight mode (macOS)" section to `examples/source-files/README.md` documenting the two modes:
- **Walk mode** — `bun src/server.ts --root <dir>` (bounded folder; cross-platform).
- **Spotlight mode** — `bun src/spotlight-server.ts [--onlyin <dir>] [--limit 40]` (whole-disk via Spotlight; macOS only; respects Spotlight Privacy exclusions; no startup crawl).
Show the `sources.json` entry for Spotlight mode:
```json
[ { "id": "files", "transport": { "kind": "stdio", "command": "bun",
    "args": ["/abs/path/to/examples/source-files/src/spotlight-server.ts", "--onlyin", "/abs/path/to/your/docs"] },
  "query_tool": "files_query" } ]
```
Note Spotlight mode is macOS-only and extracts up to `--limit` candidates per query (tune down if slow).

- [ ] **Step 6: Full package suite + typecheck**

Run: `cd examples/source-files && bun test && bun run typecheck`
Expected: all green (walk-mode + spotlight-mode suites), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add examples/source-files/src/spotlight-server.ts examples/source-files/tests/spotlight-server.test.ts examples/source-files/README.md
git commit -m "feat(source-files): Spotlight MCP server (mdfind whole-disk mode) + README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-task gate (controller-run) — VERIFY-AGAINST-REAL + durable registration
After Task 2: register the Spotlight source in the REAL `~/.hearth/sources.json` pointing at `~/Documents/hearth/examples/source-files/src/spotlight-server.ts` (`--onlyin ~/Documents` to bound the smoke), then run an owner `vault_query{federate:true}`/`hearth query` for a term known in the user's files → confirm real hits with real `file:line` anchors from actual on-disk documents, federated (nothing in the vault). Report the raw hits.

## Self-Review
- Spec coverage: §A→Task 1 (mdfind + hitsFromPaths), §B→Task 2 (server), §C→Task 2 Step 5 (README), verify→post-task gate.
- Type consistency: `ExecFn`, `mdfind`, `hitsFromPaths` (Task 1) consumed by `createSpotlightServer`/`SpotlightDeps` (Task 2). `Hit` reused from search.ts unchanged. Injectable seams (`exec`, `deps`) present for tests.
- No placeholders; all steps carry real code. Reuses extract/search — no duplication.
- stdout discipline: all logging stderr; asserted structurally by the MCP round-trip test.
