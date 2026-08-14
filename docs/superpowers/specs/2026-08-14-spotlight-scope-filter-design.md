# Spotlight source scope filter (junk-exclude + document-type allowlist) — Design

**Date**: 2026-08-14
**Status**: Design (brainstorm 2026-08-14, diagnosed on real data; content-policy default decided). Extends `examples/source-files/` (the Spotlight source, merged in the `spotlight-source` slice).

## The problem (diagnosed on real data)

The Spotlight source (`spotlight-server.ts`) scoped at `~/Documents`+`Desktop`+`Downloads` returns almost entirely **noise** for real queries: running `mdfind` for "revenue" / "meeting notes" / "design", the top candidates are dominated by (a) **build/dep/cache junk** — `node_modules/`, `target/debug/…`, `dist/`, `hf-embedding-cache/vocab.txt`, `.cjs.map` — and (b) **source code** — `.ts`/`.go`/`.py`. The user's actual **documents** (pdf/docx/pptx) don't surface at all, buried under code repos. `mdfind` returns everything Spotlight indexed; the walk-mode skip-list never applied to it. Because the current pipeline caps candidates to `limit` (40) *before* any filtering, the extract budget is spent on junk.

## Goal

Make the Spotlight source return **documents**, not build junk or source code, by adding two filter layers applied to `mdfind` candidates *before* extraction — a junk-path exclude (always on) and a document-type extension allowlist (default on, configurable). Fetch a larger candidate pool so filtering doesn't starve the extract budget. Re-register the real source with the tuned scope and verify the noise is gone.

## Decisions (content policy)

- **Layer 1 — junk-path exclude (always on):** drop any candidate whose path contains a build/dep/cache directory segment. Default set: `node_modules`, `.git`, `.svn`, `.hg`, `dist`, `build`, `out`, `target`, `.next`, `.nuxt`, `.turbo`, `coverage`, `__pycache__`, `.venv`, `venv`, `site-packages`, `.tox`, `.mypy_cache`, `.pytest_cache`, `.gradle`, `.cargo`, `DerivedData`, and any segment containing `cache` (e.g. `hf-embedding-cache`, `.cache`). Matched by **path segment** (split on `/`), not raw substring, to avoid false hits like `build-plan.md`.
- **Layer 2 — document-type allowlist (default on, overridable):** keep only documents + notes. Default extension set: office `pdf,doc,docx,ppt,pptx,xls,xlsx`; iWork `pages,key,numbers`; text/notes `txt,md,markdown,rtf,rtfd,odt,ods,odp,csv,tex`. This **excludes source code** (`.ts/.js/.go/.py/.rs/.c/.h/.json/.yaml/.sh/.map/.lock/.log/.xml/.html/.css` …). Rationale (from the user): "scattered files = txt/word/ppt/pdf" — the intent is documents; the user's own repo design-docs (`.md`) ARE knowledge and stay in (dep READMEs are already dropped by the node_modules junk-exclude), while `.ts/.go` source is noise for a document search.
- **Configurable, not locked:** `--ext <csv>` overrides the allowlist; `--all-types` disables the allowlist (keep junk-exclude only, i.e. "everything but build junk"); `--exclude <substr>` (repeatable) adds to the junk set. So a user who wants code search can `--all-types` or `--ext ts,go,py`.

## Scope (`examples/source-files/`)

### A. `src/spotlight.ts` — `filterCandidates` (new, pure)
- `interface CandidateFilter { exclude?: string[]; allowExts?: string[] | null }` — `exclude` = extra junk segments (merged with the built-in `JUNK_SEGMENTS`); `allowExts` = the extension allowlist (`null`/absent when `--all-types`, meaning "no type filter").
- `function filterCandidates(paths: string[], opts?: CandidateFilter): string[]` — drops a path if any of its `/`-split segments is in the effective junk set (case-insensitive; a segment matches if it equals a junk name OR contains `cache`), then, when `allowExts` is a non-empty array, keeps only paths whose lowercased extension is in it. Returns the surviving paths in input order (mdfind order preserved; final ranking is still by `search()`'s token overlap downstream).
- Export the default sets `JUNK_SEGMENTS` and `DOC_EXTS` so the server + tests reference the canonical lists.

### B. `src/spotlight-server.ts` — wire the filter + flags
- `parseSpotlightArgs` gains: `--exclude <substr>` (repeatable → `exclude: string[]`), `--ext <csv>` (→ `allowExts: string[]`), `--all-types` (→ sets `allowExts: null`, i.e. type filter off). Default when neither `--ext` nor `--all-types` given: `allowExts = DOC_EXTS`.
- The `files_query` handler: `mdfind(question, { onlyIn, limit: pool })` where `pool = Math.max(limit * 6, 200)` (fetch a large candidate pool so filtering doesn't starve), then `filterCandidates(paths, { exclude, allowExts })`, then `.slice(0, limit)` (the extract/return budget, default still ~30), then `hitsFromPaths`. So `--limit` now means "documents to extract & return after filtering."
- `main()` logs the effective scope + filter mode to stderr (paths, ext-mode = `docs`/`all`/custom).
- README: document `--exclude` / `--ext` / `--all-types`, the default doc-type behavior, and note that build/dep/cache dirs are always excluded.

## Verification
- **Unit — `filterCandidates`:** a mixed path list (node_modules/.git/target/dist/`hf-embedding-cache/vocab.txt` junk + `.ts`/`.go` code + `.pdf`/`.docx`/`.md`/`.txt` docs) → junk dropped by segment; with default `allowExts` the `.ts`/`.go` dropped and docs kept; with `allowExts: null` code kept but junk still dropped; `--exclude`-added segment honored; segment-match doesn't false-drop `build-plan.md` (a FILE named build-*, not a `build/` dir).
- **Unit — `parseSpotlightArgs`:** `--exclude a --exclude b` → `['a','b']`; `--ext pdf,md` → `['pdf','md']`; `--all-types` → `allowExts:null`; default → `allowExts:DOC_EXTS`.
- **Unit — server:** with an injected `mdfind` returning a junk+code+doc mix over real temp files, `files_query` returns hits ONLY from the doc files (junk + code absent from `source`), and `--all-types` lets a code file through.
- **VERIFY-AGAINST-REAL (owner machine):** re-run the three diagnostic queries ("revenue"/"meeting notes"/"design") through the tuned server over `~/Documents`+`Desktop`+`Downloads` → the JUNK (node_modules/target/vocab.txt) and `.ts`/`.go` are gone; real documents (+ the user's own `.md` design docs) surface. Then update the registered `~/.hearth/sources.json` `files` entry to the tuned command and confirm an owner federated query returns clean document hits.

## Non-goals
- **mdfind content-type predicates** (`kMDItemContentTypeTree`) — a post-filter on extensions is simpler + deterministic for v1; a Spotlight-UTI predicate is a later refinement.
- **Per-query dynamic scope** / semantic dedup — out of scope.
- **Changing the walk-mode server** (`server.ts`) — this only tunes the Spotlight mode.
- **Media content** — unchanged (filename-only; media exts aren't in DOC_EXTS by default, so media is excluded from the default doc view unless `--ext` adds them — acceptable; media content search is a separate deferred slice).

## Risks
- **Over-filtering hides a wanted file type:** the allowlist could drop a document type the user cares about (e.g. `.epub`, `.msg`). Mitigation: `--ext`/`--all-types` escape hatches + a sensible broad default; easy to extend `DOC_EXTS`.
- **Candidate pool cost:** fetching a larger mdfind pool (200+) then filtering is cheap (mdfind is instant; filtering is string ops); extraction is still capped at `limit`. No material cost.
- **Segment-match edge cases:** a legitimately-named directory colliding with a junk segment (e.g. a real folder literally named `build/`) would be excluded. Accepted — those names are overwhelmingly build dirs; `--exclude` is additive only (no way to un-exclude a default), so if it bites, widen via a follow-up. Documented.
