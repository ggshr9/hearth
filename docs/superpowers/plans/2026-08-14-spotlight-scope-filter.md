# Spotlight scope filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Spotlight source (`examples/source-files/spotlight-server.ts`) return documents, not build/dep/cache junk or source code — a junk-path exclude (always on) + a document-type extension allowlist (default on, configurable), applied to mdfind candidates before extraction, over a larger candidate pool.

**Architecture:** Add a pure `filterCandidates(paths, opts)` to `spotlight.ts` (junk-segment exclude + ext allowlist). The server fetches a large mdfind pool, filters, slices to the extract limit, then extracts. New flags `--exclude`/`--ext`/`--all-types`.

**Tech Stack:** Bun + TypeScript. `bun test` inside `examples/source-files/`.

## Global Constraints
- Only `examples/source-files/` changes. `spotlight.ts` (extend), `spotlight-server.ts` (wire + flags), README. The walk-mode `server.ts`/`index-store.ts`/`search.ts`/`extract.ts` are NOT touched.
- Junk exclude matches by **path segment** (split on `/`), case-insensitive, plus any segment containing `cache` — never raw substring (so a FILE `build-plan.md` is not dropped, only a `build/` DIR).
- `filterCandidates` and `parseSpotlightArgs` are pure/deterministic — unit-tested directly.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Non-goals: mdfind UTI predicates, walk-mode changes, media content.

---

## Task 1: `filterCandidates` + default sets (`spotlight.ts`)

**Files:** Modify `examples/source-files/src/spotlight.ts`; Create `examples/source-files/tests/spotlight-filter.test.ts`

**Interfaces:**
- Produces (add to `spotlight.ts`):
  - `const JUNK_SEGMENTS: ReadonlySet<string>` (build/dep/cache dir names)
  - `const DOC_EXTS: readonly string[]` (document + note extensions)
  - `interface CandidateFilter { exclude?: string[]; allowExts?: string[] | null }`
  - `function filterCandidates(paths: string[], opts?: CandidateFilter): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
// examples/source-files/tests/spotlight-filter.test.ts
import { test, expect } from 'bun:test';
import { filterCandidates, JUNK_SEGMENTS, DOC_EXTS } from '../src/spotlight.ts';

const mixed = [
  '/U/me/Documents/notes/q3.pdf',
  '/U/me/Documents/report.docx',
  '/U/me/Documents/notes/plan.md',
  '/U/me/Documents/notes/build-plan.md',            // FILE named build-* — must NOT be dropped
  '/U/me/Documents/app/src/index.ts',               // source code
  '/U/me/Documents/svc/main.go',                    // source code
  '/U/me/Documents/app/node_modules/pkg/readme.md', // junk dir
  '/U/me/Documents/app/dist/out.md',                // junk dir
  '/U/me/Documents/app/target/debug/x.md',          // junk dir
  '/U/me/Documents/data/hf-embedding-cache/vocab.txt', // cache substring
  '/U/me/Documents/app/.git/COMMIT_EDITMSG',        // junk dir
];

test('default (DOC_EXTS) keeps documents, drops junk dirs AND source code', () => {
  const out = filterCandidates(mixed, { allowExts: DOC_EXTS });
  expect(out).toEqual([
    '/U/me/Documents/notes/q3.pdf',
    '/U/me/Documents/report.docx',
    '/U/me/Documents/notes/plan.md',
    '/U/me/Documents/notes/build-plan.md',
  ]);
});

test('allowExts null keeps source code but STILL drops junk dirs', () => {
  const out = filterCandidates(mixed, { allowExts: null });
  expect(out).toContain('/U/me/Documents/app/src/index.ts');
  expect(out).toContain('/U/me/Documents/svc/main.go');
  expect(out).not.toContain('/U/me/Documents/app/node_modules/pkg/readme.md');
  expect(out).not.toContain('/U/me/Documents/data/hf-embedding-cache/vocab.txt');
  expect(out).not.toContain('/U/me/Documents/app/.git/COMMIT_EDITMSG');
});

test('exclude adds a junk segment (case-insensitive)', () => {
  const out = filterCandidates(['/U/me/Documents/Secret/a.pdf', '/U/me/Documents/ok/b.pdf'], { allowExts: DOC_EXTS, exclude: ['secret'] });
  expect(out).toEqual(['/U/me/Documents/ok/b.pdf']);
});

test('DOC_EXTS excludes source-code extensions; JUNK_SEGMENTS covers node_modules', () => {
  expect(DOC_EXTS).toContain('pdf'); expect(DOC_EXTS).toContain('md');
  expect(DOC_EXTS).not.toContain('ts'); expect(DOC_EXTS).not.toContain('go');
  expect(JUNK_SEGMENTS.has('node_modules')).toBe(true);
});
```

- [ ] **Step 2: Run to verify fail** — `cd examples/source-files && bun test tests/spotlight-filter.test.ts` → FAIL (not exported).

- [ ] **Step 3: Add to `src/spotlight.ts`** (after the imports / before `mdfind`, keep existing code intact)

```ts
/** Build / dependency / cache directory names — a candidate is dropped if any
 *  of its path segments matches one of these (case-insensitive), or contains
 *  "cache" (e.g. hf-embedding-cache). Matched per-SEGMENT, so a file named
 *  "build-plan.md" is kept while a "build/" directory is excluded. */
export const JUNK_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.turbo', 'coverage', '__pycache__', '.venv', 'venv',
  'site-packages', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.cargo',
  'deriveddata',
]);

/** Document + note extensions kept by default (source code excluded). */
export const DOC_EXTS: readonly string[] = [
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
  'pages', 'key', 'numbers',
  'txt', 'md', 'markdown', 'rtf', 'rtfd', 'odt', 'ods', 'odp', 'csv', 'tex',
];

export interface CandidateFilter { exclude?: string[]; allowExts?: string[] | null }

function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Drop build/dep/cache junk (by path segment) and, when allowExts is a
 *  non-empty list, keep only those extensions. mdfind order is preserved. */
export function filterCandidates(paths: string[], opts?: CandidateFilter): string[] {
  const junk = new Set([...JUNK_SEGMENTS, ...(opts?.exclude ?? [])].map(s => s.toLowerCase()));
  const allow = opts?.allowExts && opts.allowExts.length > 0
    ? new Set(opts.allowExts.map(e => e.toLowerCase().replace(/^\./, '')))
    : null;
  const out: string[] = [];
  for (const p of paths) {
    let isJunk = false;
    for (const seg of p.split('/')) {
      const sl = seg.toLowerCase();
      if (junk.has(sl) || sl.includes('cache')) { isJunk = true; break; }
    }
    if (isJunk) continue;
    if (allow && !allow.has(extOf(p))) continue;
    out.push(p);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass** — `cd examples/source-files && bun test tests/spotlight-filter.test.ts` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/source-files/src/spotlight.ts examples/source-files/tests/spotlight-filter.test.ts
git commit -m "feat(source-files): filterCandidates — junk-path exclude + doc-type allowlist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire the filter + flags into the Spotlight server

**Files:** Modify `examples/source-files/src/spotlight-server.ts`, `examples/source-files/tests/spotlight-server.test.ts`, `examples/source-files/README.md`

**Interfaces:**
- Consumes: `filterCandidates`, `DOC_EXTS` from `./spotlight.ts` (Task 1).
- Produces:
  - `parseSpotlightArgs(argv)` returns `{ onlyIn, toolName, limit, exclude: string[], allowExts: string[] | null }`
  - `createSpotlightServer(toolName, opts, deps?)` where `opts: { onlyIn: string[]; limit: number; exclude: string[]; allowExts: string[] | null }`

- [ ] **Step 1: Write the failing tests** (extend `spotlight-server.test.ts`)

```ts
// add to examples/source-files/tests/spotlight-server.test.ts
import { parseSpotlightArgs, createSpotlightServer } from '../src/spotlight-server.ts';
import { DOC_EXTS } from '../src/spotlight.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hitsFromPaths } from '../src/spotlight.ts';

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
```

- [ ] **Step 2: Run to verify fail** — `cd examples/source-files && bun test tests/spotlight-server.test.ts` → FAIL.

- [ ] **Step 3: Implement in `src/spotlight-server.ts`**

Add imports: `import { mdfind, hitsFromPaths, filterCandidates, DOC_EXTS } from './spotlight.ts';`

Replace `parseSpotlightArgs`:
```ts
export function parseSpotlightArgs(argv: string[]): { onlyIn: string[]; toolName: string; limit: number; exclude: string[]; allowExts: string[] | null } {
  const onlyIn: string[] = [];
  const exclude: string[] = [];
  let toolName = 'files_query';
  let limit = 40;
  let allowExts: string[] | null = DOC_EXTS as string[];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--onlyin' && argv[i + 1] !== undefined) onlyIn.push(argv[++i]!);
    else if (argv[i] === '--name' && argv[i + 1] !== undefined) toolName = argv[++i]!;
    else if (argv[i] === '--exclude' && argv[i + 1] !== undefined) exclude.push(argv[++i]!);
    else if (argv[i] === '--ext' && argv[i + 1] !== undefined) allowExts = argv[++i]!.split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--all-types') allowExts = null;
    else if (argv[i] === '--limit' && argv[i + 1] !== undefined) {
      const n = parseInt(argv[++i]!, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { onlyIn, toolName, limit, exclude, allowExts };
}
```

Update `SpotlightDeps` opts type + `createSpotlightServer` signature to `opts: { onlyIn: string[]; limit: number; exclude: string[]; allowExts: string[] | null }`, and the handler:
```ts
    const question = String((req.params.arguments ?? {}).question ?? '');
    const pool = Math.max(opts.limit * 6, 200);
    const raw = await deps.mdfind(question, { onlyIn: opts.onlyIn, limit: pool });
    const candidates = filterCandidates(raw, { exclude: opts.exclude, allowExts: opts.allowExts }).slice(0, opts.limit);
    const hits = await deps.hitsFromPaths(candidates, question);
    return { content: [{ type: 'text', text: JSON.stringify({ hits }) }] };
```

Update `main()` to thread the new fields + log the filter mode:
```ts
  const { onlyIn, toolName, limit, exclude, allowExts } = parseSpotlightArgs(argv);
  const mode = allowExts === null ? 'all-types' : `docs(${allowExts.length} exts)`;
  process.stderr.write(`[source-files] spotlight mode: scope=${onlyIn.length ? onlyIn.join(',') : 'whole-disk'} limit=${limit} filter=${mode} tool=${toolName}\n`);
  const server = createSpotlightServer(toolName, { onlyIn, limit, exclude, allowExts });
```

- [ ] **Step 4: Run to verify pass** — `cd examples/source-files && bun test tests/spotlight-server.test.ts` → PASS.

- [ ] **Step 5: Update README** — add a "Filtering" subsection under Spotlight mode: build/dep/cache dirs are always excluded; by default only document + note types (list DOC_EXTS categories) are returned; `--ext <csv>` overrides the type allowlist, `--all-types` disables it (everything but build junk), `--exclude <substr>` (repeatable) adds a junk segment. Update the Spotlight `sources.json` snippet's `args` to show the tuned defaults are automatic (no flags needed for doc mode).

- [ ] **Step 6: Full package suite + typecheck** — `cd examples/source-files && bun test && bun run typecheck` → all green.

- [ ] **Step 7: Commit**

```bash
git add examples/source-files/src/spotlight-server.ts examples/source-files/tests/spotlight-server.test.ts examples/source-files/README.md
git commit -m "feat(source-files): Spotlight server filter wiring (--exclude/--ext/--all-types) + candidate pool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-task gate (controller-run) — VERIFY-AGAINST-REAL + re-register
1. Re-run the three diagnostic queries ("revenue"/"meeting notes"/"design") through the tuned server (real mdfind over `~/Documents`+`Desktop`+`Downloads`) → confirm node_modules/target/vocab.txt/`.ts`/`.go` are gone and real documents (+ the user's own `.md` design docs) surface. Report before/after.
2. The registered `~/.hearth/sources.json` `files` entry already runs `spotlight-server.ts`; since doc-mode is the default (no flag), the tuned behavior applies automatically after the code is on `~/Documents/hearth` (pull main). Confirm an owner federated query returns clean document hits.

## Self-Review
- Spec coverage: §A→Task 1 (filterCandidates + sets); §B→Task 2 (flags + handler + pool + README); verify→gate.
- Type consistency: `CandidateFilter`/`filterCandidates`/`DOC_EXTS`/`JUNK_SEGMENTS` (Task 1) consumed by the server (Task 2); `parseSpotlightArgs`/`createSpotlightServer` opts extended consistently (both gain `exclude`/`allowExts`).
- No placeholders; segment-vs-file distinction tested (`build-plan.md` kept). Pool filters before the extract limit so junk can't starve the budget.
```
