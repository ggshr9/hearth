# source-files Province Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `examples/source-files/` — a standalone MCP stdio province that federates keyword search over local directories (txt/md + Office/PDF content) and emits hearth-compatible hits — as the second federated source for validating hearth's Phase-3 permission broker on real 2-source data.

**Architecture:** A self-contained sub-package (its own `package.json`, isolating `officeparser`). Four modules layered bottom-up: `extract.ts` (file → text), `index-store.ts` (walk roots → in-memory records), `search.ts` (question → ranked snippet hits, rank-normalized), `server.ts` (MCP stdio server exposing one `files_query({question})→{hits}` tool). Imports nothing from hearth — implements only the wire contract in `src/core/federated-client.ts`.

**Tech Stack:** Bun + TypeScript, `@modelcontextprotocol/sdk` (^1.29.0, same as hearth), `officeparser` (^7 — docx/pptx/xlsx/pdf text). Tests: `bun test` inside `examples/source-files/`.

## Global Constraints

- **Self-contained package.** All code lives under `examples/source-files/`. It has its OWN `package.json` + `bun.lock` (name `@hearth/source-files`, private) — these ARE committed (new package). hearth's ROOT `package.json`/`bun.lock` and `src/**` are NOT touched by Tasks 1-4.
- **Imports nothing from hearth.** The province satisfies only the MCP wire contract; no `../../src/...` imports. The hit payload must be `JSON.stringify({ hits })` where each hit is `{ claim_text: string (required), source, anchor_summary, confidence, match_score }` — the shape `src/core/federated-client.ts` parses.
- **stdout is sacred (MCP protocol).** Every log/diagnostic goes to `process.stderr`, never `process.stdout` or `console.log`. An extractor or lib that prints to stdout corrupts the protocol — route or suppress it.
- **Throw-proof.** A corrupt/locked/oversized file is skipped (stderr warning), never crashes the walk. An empty/no-root config yields an empty index and `{hits:[]}`, never a crash.
- **Fair ranking.** Province hits are rank-normalized `match_score = 1/(1+index)` so they interleave fairly in hearth's cross-source merge (mirrors wechat-cc's fix).
- **Commits:** stage only files under `examples/source-files/`; commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Non-goals (do NOT build):** media content/ASR transcription (media = filename/metadata only), embedding retrieval, persistent/incremental index, other provinces. See spec §Non-goals.

---

## File Structure

- `examples/source-files/package.json` — package manifest (Task 1).
- `examples/source-files/tsconfig.json` — minimal typecheck config (Task 1).
- `examples/source-files/src/extract.ts` — file → `{text, isMedia}` (Task 1).
- `examples/source-files/src/index-store.ts` — walk roots → `IndexRecord[]` (Task 2).
- `examples/source-files/src/search.ts` — question → ranked `Hit[]` (Task 3).
- `examples/source-files/src/server.ts` — `createFilesServer` + `main` (Task 4).
- `examples/source-files/README.md` — run + register + "copy me" (Task 4).
- `examples/source-files/tests/*.test.ts` — per task.
- `examples/source-files/tests/fixtures/` — sample files.

---

## Task 1: Package scaffold + text extraction

**Files:**
- Create: `examples/source-files/package.json`, `examples/source-files/tsconfig.json`
- Create: `examples/source-files/src/extract.ts`
- Create: `examples/source-files/tests/extract.test.ts`
- Create: `examples/source-files/tests/fixtures/` (sample files)

**Interfaces:**
- Produces:
  - `interface Extracted { text: string; isMedia: boolean }`
  - `async function extractFile(path: string): Promise<Extracted | null>` — `null` = unsupported/failed/skip.
  - `function classify(path: string): 'text' | 'office' | 'media' | 'skip'`

- [ ] **Step 1: Write `examples/source-files/package.json`**

```json
{
  "name": "@hearth/source-files",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "hearth reference federated province: keyword search over local files (txt/md + Office/PDF).",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "serve": "bun src/server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "officeparser": "^7.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Write `examples/source-files/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "allowImportingTsExtensions": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: `bun install` in the package dir**

Run: `cd examples/source-files && bun install`
Expected: creates `node_modules` + `bun.lock`; `officeparser` and the SDK resolve. Confirm `officeparser` exposes `parseOfficeAsync` (check `node_modules/officeparser` exports; the function is the v7 async API). If the export name differs in the installed version, adapt the import in Step 5 and note it.

- [ ] **Step 4: Write the failing tests**

```ts
// examples/source-files/tests/extract.test.ts
import { test, expect } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile, classify } from '../src/extract.ts';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'sf-extract-')); }

test('classify routes by extension', () => {
  expect(classify('/a/b.md')).toBe('text');
  expect(classify('/a/b.TXT')).toBe('text');
  expect(classify('/a/b.docx')).toBe('office');
  expect(classify('/a/b.pdf')).toBe('office');
  expect(classify('/a/b.mp4')).toBe('media');
  expect(classify('/a/b.png')).toBe('skip');
});

test('extractFile reads text files directly', async () => {
  const dir = tmp();
  const p = join(dir, 'note.md');
  writeFileSync(p, '# Title\nquarterly revenue forecast');
  const ex = await extractFile(p);
  expect(ex).not.toBeNull();
  expect(ex!.isMedia).toBe(false);
  expect(ex!.text).toContain('quarterly revenue');
});

test('extractFile marks media as metadata-only (empty text, isMedia)', async () => {
  const dir = tmp();
  const p = join(dir, 'clip.mp4');
  writeFileSync(p, Buffer.from([0x00, 0x01, 0x02])); // not real mp4; extractor must not read content
  const ex = await extractFile(p);
  expect(ex).toEqual({ text: '', isMedia: true });
});

test('extractFile returns null for unsupported types', async () => {
  const dir = tmp();
  const p = join(dir, 'image.png');
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  expect(await extractFile(p)).toBeNull();
});

test('extractFile is throw-proof: a corrupt office file → null, not a throw', async () => {
  const dir = tmp();
  const p = join(dir, 'broken.docx');
  writeFileSync(p, Buffer.from('this is not a real docx zip'));
  const ex = await extractFile(p); // officeparser will throw internally; extractFile must catch → null
  expect(ex).toBeNull();
});

// Office/PDF happy path — real fixture (see Step 6).
test('extractFile extracts text from a real .docx fixture', async () => {
  const ex = await extractFile(join(import.meta.dir, 'fixtures', 'sample.docx'));
  expect(ex).not.toBeNull();
  expect(ex!.isMedia).toBe(false);
  expect(ex!.text.toLowerCase()).toContain('hearth');
});
```

- [ ] **Step 5: Write `examples/source-files/src/extract.ts`**

```ts
// Extract searchable text from a file. Text types are read directly; Office/PDF
// go through officeparser; media is metadata-only (no content — transcription
// is a non-goal); everything else is skipped. Throw-proof: any failure → null.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseOfficeAsync } from 'officeparser';

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.text', '.log', '.csv']);
const OFFICE_EXTS = new Set(['.docx', '.pptx', '.xlsx', '.pdf', '.odt', '.odp', '.ods']);
const MEDIA_EXTS = new Set(['.mp3', '.mp4', '.m4a', '.wav', '.mov', '.avi', '.mkv', '.flac', '.aac', '.webm', '.ogg']);

export interface Extracted { text: string; isMedia: boolean }

export function classify(path: string): 'text' | 'office' | 'media' | 'skip' {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXTS.has(ext)) return 'text';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (MEDIA_EXTS.has(ext)) return 'media';
  return 'skip';
}

export async function extractFile(path: string): Promise<Extracted | null> {
  const kind = classify(path);
  try {
    if (kind === 'text') return { text: await readFile(path, 'utf8'), isMedia: false };
    if (kind === 'office') return { text: String(await parseOfficeAsync(path) ?? ''), isMedia: false };
    if (kind === 'media') return { text: '', isMedia: true };
    return null;
  } catch (err) {
    process.stderr.write(`[source-files] extract failed for ${path}: ${(err as Error).message}\n`);
    return null;
  }
}
```

- [ ] **Step 6: Create the `.docx` fixture**

Create `examples/source-files/tests/fixtures/sample.docx` containing the word "hearth" (and some other text). Primary path — generate a real one:
```bash
cd examples/source-files/tests/fixtures
python3 -c "from docx import Document; d=Document(); d.add_paragraph('hearth reference province quarterly notes'); d.save('sample.docx')" \
  || pip3 install --quiet python-docx && python3 -c "from docx import Document; d=Document(); d.add_paragraph('hearth reference province quarterly notes'); d.save('sample.docx')"
```
If python-docx is unavailable in-env and cannot be installed, assemble a minimal valid `.docx` (it is a zip of `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`) with the `zip` CLI, putting "hearth" inside `word/document.xml`'s `<w:t>`. If BOTH are infeasible, skip only the `sample.docx` happy-path test (`test.skip`) with a comment, keep all other extract tests, and note in the report that live Office extraction was verified manually against a real file — do NOT delete the extractFile office branch or fake the fixture.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd examples/source-files && bun test tests/extract.test.ts`
Expected: PASS (all extract tests; the `.docx` test passes with a real fixture or is explicitly skipped per Step 6).

- [ ] **Step 8: Commit**

```bash
git add examples/source-files/package.json examples/source-files/tsconfig.json examples/source-files/bun.lock examples/source-files/src/extract.ts examples/source-files/tests/extract.test.ts examples/source-files/tests/fixtures
git commit -m "feat(source-files): package scaffold + text/Office/PDF extraction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: In-memory index (walk roots)

**Files:**
- Create: `examples/source-files/src/index-store.ts`
- Create: `examples/source-files/tests/index-store.test.ts`

**Interfaces:**
- Consumes: `extractFile` from `./extract.ts`.
- Produces:
  - `interface IndexRecord { relPath: string; rootLabel: string; absPath: string; text: string; isMedia: boolean }`
  - `async function buildIndex(roots: string[]): Promise<IndexRecord[]>`

- [ ] **Step 1: Write the failing tests**

```ts
// examples/source-files/tests/index-store.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../src/index-store.ts';

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sf-index-'));
  writeFileSync(join(root, 'a.md'), 'alpha content one');
  writeFileSync(join(root, 'b.txt'), 'bravo content two');
  writeFileSync(join(root, 'clip.mp4'), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, 'pic.png'), Buffer.from([0x89])); // unsupported → skipped
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'junk.md'), 'should be skipped');
  mkdirSync(join(root, '.hidden'), { recursive: true });
  writeFileSync(join(root, '.hidden', 'secret.md'), 'should be skipped');
  return root;
}

test('buildIndex walks a root, extracts text, skips node_modules/dotdirs/unsupported', async () => {
  const root = seedRoot();
  const idx = await buildIndex([root]);
  const rels = idx.map(r => r.relPath).sort();
  expect(rels).toEqual(['a.md', 'b.txt', 'clip.mp4']); // png/node_modules/.hidden excluded
  const a = idx.find(r => r.relPath === 'a.md')!;
  expect(a.text).toContain('alpha content');
  expect(a.isMedia).toBe(false);
  const clip = idx.find(r => r.relPath === 'clip.mp4')!;
  expect(clip.isMedia).toBe(true);
  expect(clip.text).toBe('');
});

test('buildIndex handles multiple roots and a missing root gracefully', async () => {
  const root = seedRoot();
  const idx = await buildIndex([root, '/no/such/dir/xyz']);
  expect(idx.length).toBe(3); // missing root contributes nothing, no throw
});

test('buildIndex returns [] for no roots', async () => {
  expect(await buildIndex([])).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd examples/source-files && bun test tests/index-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `examples/source-files/src/index-store.ts`**

```ts
// Build an in-memory index by walking each root once at startup. Skips
// node_modules/.git/dotdirs, oversized files, and unsupported types. Rebuilt
// on restart (persistent/incremental indexing is a non-goal).
import { readdir, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { extractFile } from './extract.ts';

export interface IndexRecord {
  relPath: string;
  rootLabel: string;
  absPath: string;
  text: string;
  isMedia: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', 'target']);
const MAX_BYTES = 10 * 1024 * 1024;

export async function buildIndex(roots: string[]): Promise<IndexRecord[]> {
  const records: IndexRecord[] = [];
  for (const root of roots) {
    await walk(root, root, records);
  }
  return records;
}

async function walk(root: string, dir: string, out: IndexRecord[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable/missing dir → contribute nothing
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // dotfiles + dotdirs
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(root, abs, out);
      continue;
    }
    if (!e.isFile()) continue;
    let size = 0;
    try { size = (await stat(abs)).size; } catch { continue; }
    if (size > MAX_BYTES) continue;
    const ex = await extractFile(abs);
    if (ex === null) continue;
    out.push({ relPath: relative(root, abs), rootLabel: basename(root), absPath: abs, text: ex.text, isMedia: ex.isMedia });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd examples/source-files && bun test tests/index-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/source-files/src/index-store.ts examples/source-files/tests/index-store.test.ts
git commit -m "feat(source-files): in-memory index walker (skip-list, size cap, throw-proof)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Keyword search + ranked snippet hits

**Files:**
- Create: `examples/source-files/src/search.ts`
- Create: `examples/source-files/tests/search.test.ts`

**Interfaces:**
- Consumes: `IndexRecord` from `./index-store.ts`.
- Produces:
  - `interface Hit { claim_text: string; source: string; anchor_summary: string; confidence: 'high'|'medium'|'low'; match_score: number }`
  - `function tokenize(text: string): string[]`
  - `function search(index: IndexRecord[], question: string, limit?: number): Hit[]` (default limit 8)

- [ ] **Step 1: Write the failing tests**

```ts
// examples/source-files/tests/search.test.ts
import { test, expect } from 'bun:test';
import { search, tokenize } from '../src/search.ts';
import type { IndexRecord } from '../src/index-store.ts';

function rec(relPath: string, text: string, isMedia = false): IndexRecord {
  return { relPath, rootLabel: 'root', absPath: '/x/' + relPath, text, isMedia };
}

test('tokenize lowercases, splits on non-alphanumeric, keeps CJK chars, drops 1-char latin', () => {
  expect(tokenize('Hello, World! a')).toEqual(['hello', 'world']);
  expect(tokenize('营收 forecast')).toContain('营');
  expect(tokenize('营收 forecast')).toContain('forecast');
});

test('search returns the best-matching file top-ranked with a file:line anchor', () => {
  const idx = [
    rec('notes/q3.md', 'line one\nquarterly revenue forecast is up\nline three'),
    rec('other.md', 'unrelated content about cats'),
  ];
  const hits = search(idx, 'quarterly revenue');
  expect(hits.length).toBe(1);
  expect(hits[0]!.source).toBe('notes/q3.md');
  expect(hits[0]!.anchor_summary).toBe('notes/q3.md:2');
  expect(hits[0]!.claim_text).toContain('quarterly revenue forecast');
  expect(hits[0]!.match_score).toBe(1); // 1/(1+0)
  expect(hits[0]!.confidence).toBe('high');
});

test('multi-file matches are rank-normalized (strictly descending, first=1.0)', () => {
  const idx = [
    rec('a.md', 'revenue revenue revenue forecast'),   // higher coverage+occurrence
    rec('b.md', 'forecast only here'),
    rec('c.md', 'nothing relevant'),
  ];
  const hits = search(idx, 'revenue forecast');
  expect(hits.map(h => h.source)).toEqual(['a.md', 'b.md']); // c excluded (0 matches)
  expect(hits[0]!.match_score).toBe(1);
  expect(hits[1]!.match_score).toBeCloseTo(0.5, 5);
  expect(hits[0]!.match_score).toBeGreaterThan(hits[1]!.match_score);
});

test('media files match on filename and report a media anchor', () => {
  const hits = search([rec('talks/keynote-revenue.mp4', '', true)], 'revenue');
  expect(hits.length).toBe(1);
  expect(hits[0]!.anchor_summary).toContain('(media)');
  expect(hits[0]!.claim_text.toLowerCase()).toContain('keynote-revenue');
});

test('no-match question returns []', () => {
  expect(search([rec('a.md', 'cats and dogs')], 'quarterly revenue')).toEqual([]);
});

test('empty question returns []', () => {
  expect(search([rec('a.md', 'anything')], '   ')).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd examples/source-files && bun test tests/search.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `examples/source-files/src/search.ts`**

```ts
// Keyword search over the in-memory index. Honest token-overlap scoring (no
// embeddings — matches hearth's own conservative query). Hits are rank-
// normalized 1/(1+index) so they interleave fairly in hearth's cross-source merge.
import { basename } from 'node:path';
import type { IndexRecord } from './index-store.ts';

export interface Hit {
  claim_text: string;
  source: string;
  anchor_summary: string;
  confidence: 'high' | 'medium' | 'low';
  match_score: number;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+|[一-鿿]/g)) {
    const t = m[0];
    if (/[一-鿿]/.test(t) || t.length >= 2) out.push(t);
  }
  return out;
}

export function search(index: IndexRecord[], question: string, limit = 8): Hit[] {
  const qTokens = new Set(tokenize(question));
  if (qTokens.size === 0) return [];

  const scored: { rec: IndexRecord; score: number }[] = [];
  for (const rec of index) {
    const hay = tokenize(rec.text + ' ' + basename(rec.relPath));
    const haySet = new Set(hay);
    let coverage = 0;
    for (const t of qTokens) if (haySet.has(t)) coverage++;
    if (coverage === 0) continue;
    let occ = 0;
    for (const t of hay) if (qTokens.has(t)) occ++;
    scored.push({ rec, score: coverage * 1000 + occ }); // coverage dominates, occurrences tie-break
  }
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ rec }, index) => {
    const { claim_text, anchor } = snippet(rec, qTokens);
    return {
      claim_text,
      source: rec.relPath,
      anchor_summary: anchor,
      confidence: index === 0 ? 'high' : index <= 2 ? 'medium' : 'low',
      match_score: 1 / (1 + index),
    };
  });
}

function snippet(rec: IndexRecord, qTokens: Set<string>): { claim_text: string; anchor: string } {
  if (rec.isMedia || rec.text.trim() === '') {
    return { claim_text: `${basename(rec.relPath)} (media file)`, anchor: `${rec.relPath} (media)` };
  }
  const lines = rec.text.split(/\r?\n/);
  let bestLine = 0, bestHits = -1;
  for (let i = 0; i < lines.length; i++) {
    const lt = new Set(tokenize(lines[i]!));
    let h = 0;
    for (const t of qTokens) if (lt.has(t)) h++;
    if (h > bestHits) { bestHits = h; bestLine = i; }
  }
  const start = Math.max(0, bestLine - 1), end = Math.min(lines.length, bestLine + 2);
  let text = lines.slice(start, end).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length > 300) text = text.slice(0, 297) + '...';
  return { claim_text: text || basename(rec.relPath), anchor: `${rec.relPath}:${bestLine + 1}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd examples/source-files && bun test tests/search.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/source-files/src/search.ts examples/source-files/tests/search.test.ts
git commit -m "feat(source-files): keyword search with rank-normalized snippet hits

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: MCP stdio server + README

**Files:**
- Create: `examples/source-files/src/server.ts`
- Create: `examples/source-files/tests/server.test.ts`
- Create: `examples/source-files/README.md`

**Interfaces:**
- Consumes: `buildIndex`/`IndexRecord` from `./index-store.ts`; `search` from `./search.ts`; `@modelcontextprotocol/sdk`.
- Produces:
  - `function parseArgs(argv: string[]): { roots: string[]; toolName: string }`
  - `function createFilesServer(index: IndexRecord[], toolName: string): Server` — the configured MCP server (testable without stdio).
  - `async function main(argv: string[]): Promise<void>` — parse args, build index, connect stdio.

- [ ] **Step 1: Write the failing test (MCP round-trip via InMemoryTransport)**

```ts
// examples/source-files/tests/server.test.ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd examples/source-files && bun test tests/server.test.ts`
Expected: FAIL (module not found). (If the SDK's `inMemory.js` import path differs in the installed version, adjust to the correct path — check `node_modules/@modelcontextprotocol/sdk`; hearth's own tests import the same primitives, cross-reference `../../../tests/*federate*.test.ts` or `consumer-tool-gate.test.ts`.)

- [ ] **Step 3: Write `examples/source-files/src/server.ts`**

```ts
// MCP stdio province: exposes one tool `files_query({question}) -> {hits}` over
// the wire contract hearth's federated-client expects. stdout is the MCP
// transport — ALL logging goes to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildIndex, type IndexRecord } from './index-store.ts';
import { search } from './search.ts';

export function parseArgs(argv: string[]): { roots: string[]; toolName: string } {
  const roots: string[] = [];
  let toolName = 'files_query';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1] !== undefined) roots.push(argv[++i]!);
    else if (argv[i] === '--name' && argv[i + 1] !== undefined) toolName = argv[++i]!;
  }
  return { roots, toolName };
}

export function createFilesServer(index: IndexRecord[], toolName: string): Server {
  const server = new Server({ name: 'source-files', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: toolName,
      description: 'Keyword search over local files (txt/md + Office/PDF). Returns snippet hits with file:line anchors.',
      inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== toolName) {
      return { content: [{ type: 'text', text: JSON.stringify({ hits: [] }) }], isError: true };
    }
    const question = String((req.params.arguments ?? {}).question ?? '');
    const hits = search(index, question);
    return { content: [{ type: 'text', text: JSON.stringify({ hits }) }] };
  });
  return server;
}

export async function main(argv: string[]): Promise<void> {
  const { roots, toolName } = parseArgs(argv);
  process.stderr.write(`[source-files] indexing ${roots.length} root(s): ${roots.join(', ') || '(none)'}\n`);
  const index = await buildIndex(roots);
  process.stderr.write(`[source-files] indexed ${index.length} file(s); tool=${toolName}\n`);
  const server = createFilesServer(index, toolName);
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd examples/source-files && bun test tests/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write `examples/source-files/README.md`**

Include: what it is (hearth reference federated province), how to run (`bun src/server.ts --root <dir> [--root <dir2>] [--name files_query]`), the exact `~/.hearth/sources.json` entry to register it:
```json
{ "id": "files", "description": "Local files (txt/md + Office/PDF)",
  "transport": { "kind": "stdio", "command": "bun",
    "args": ["/abs/path/to/examples/source-files/src/server.ts", "--root", "/abs/path/to/your/docs"] },
  "query_tool": "files_query" }
```
the v1 scope (text + Office/PDF content; media = filename only) and non-goals (no ASR, no embeddings, re-walks at startup), and a one-line "copy this directory to build your own province — implement one `{question}→{hits}` tool."

- [ ] **Step 6: Run the whole package suite + typecheck**

Run: `cd examples/source-files && bun test && bun run typecheck`
Expected: all tests green; typecheck clean (or only unavoidable SDK type noise — fix any error in this package's own code).

- [ ] **Step 7: Commit**

```bash
git add examples/source-files/src/server.ts examples/source-files/tests/server.test.ts examples/source-files/README.md
git commit -m "feat(source-files): MCP stdio server (files_query) + README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-tasks (controller-run gates, not subagent tasks)

### Gate 1 — VERIFY-AGAINST-REAL (multi-source broker validation)
Per spec §B — the whole point. The controller runs (or dispatches) this after Task 4:
1. `hearth init ~/Documents/tendhearth/vault`; add 1-2 seed pages so the local leg has content.
2. Register two sources in `~/.hearth/sources.json`: the `files` province (pointed at a real docs dir) and `wechat-cc` (Phase-2a `federated_query`). If wechat-cc won't stand up (see spec Risk), register a **second files root** as source #2 instead and note it.
3. `hearth consumer add notes-only --sources files`; `... chat-only --sources <source2>`; `... both --sources files,<source2>`.
4. Spawn `hearth mcp serve --consumer <id>` (token via env) for each; run `vault_query{question, federate:true}` with a question that matches both domains. Assert: notes-only → files hits only; chat-only → source2 hits only; both → merged, each `verified_by` its source, raw never in vault; audit `sources_consulted` correct.
5. Record the observed cross-source ranking for Gate 2.

### Gate 2 — Phase 2b decision (conditional code change)
From Gate 1's observed merge order: if one source is demonstrably buried, implement a minimal RRF/interleave in `src/core/query.ts`'s merge tail (with a unit test proving fair interleave) — this becomes a real SDD task at that point. If the flat-merge interleaves acceptably, record "Phase 2b stays closed — flat-merge adequate at 2 sources" in the ledger and make no code change.

---

## Self-Review

- **Spec coverage:** §A (province) → Tasks 1-4 (extract/index/search/server); §B (validation) → Gate 1; §C (ranking) → Gate 2. README + reference-province framing → Task 4 Step 5.
- **Type consistency:** `Extracted` (T1) → consumed by `buildIndex` (T2); `IndexRecord` (T2) → consumed by `search` (T3) and `createFilesServer` (T4); `Hit` (T3) shape is exactly `federated-client`'s `RawFederatedHit` superset (claim_text required string + source/anchor_summary/confidence/match_score) — asserted in T4's round-trip test. `parseArgs`/`createFilesServer`/`main` (T4) match the single call site in `import.meta.main`.
- **Placeholder scan:** none — every step has real code. The one contingency (Office fixture generation) has an explicit primary path + fallback + no-fake rule.
- **Independence:** the package imports nothing from hearth; the only hearth-side change is the CONDITIONAL Gate-2 ranking fix, gated on observation.
- **stdout discipline:** every diagnostic uses `process.stderr`; asserted structurally by the server round-trip test (a stray stdout write would corrupt the JSON-RPC and fail the parse).
```
