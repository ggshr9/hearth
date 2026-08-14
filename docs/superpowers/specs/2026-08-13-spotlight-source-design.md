# Spotlight-backed files province (`mdfind`) — Design

**Date**: 2026-08-13
**Status**: Design agreed in brainstorm (2026-08-13); execution approved ("go").
**Repo**: `ggshr9/hearth`, extends `examples/source-files/`. Context: memory note `hearth-memory-infra`. Follows the merged `source-files` province (PR #4) and the Phase-3 broker.

## The direction

The walk-a-`--root` province (already shipped) fits a **bounded folder**, but a user's real files are **scattered across the whole disk**. On macOS the correct answer is not to re-crawl the disk ourselves — it's to **federate to Spotlight**, the built-in, always-on, whole-disk content index (the same index behind ⌘-Space), queried via the stock `mdfind` CLI. This adds a **Spotlight-backed variant** of the province: `mdfind` for whole-disk recall, then reuse the existing `extract.ts` + `search.ts` snippet/ranking on the top candidates for precision hits with `file:line` anchors.

## Goal

Ship a Spotlight-backed MCP server in `examples/source-files/` — `query({question})` runs `mdfind` (optionally scoped with `-onlyin`), extracts + snippet-ranks the top candidates via the existing modules, and returns hearth-compatible hits. Register it in the real `~/.hearth/sources.json` as the durable "search all my scattered files" source.

## Why this shape (grounded)

- `mdfind` is `/usr/bin/mdfind`, stock on every macOS; `/` indexing is enabled here. `mdfind [-onlyin DIR] QUERY` returns newline-separated absolute paths, content+metadata matched, instant, no startup crawl. It respects the user's Spotlight Privacy exclusions — a natural privacy boundary.
- The existing province already has everything needed to turn a candidate path into a good hit: `extractFile(path)` (txt/md + Office/PDF text; media metadata-only) and `search(IndexRecord[], question)` (token-overlap coverage-tier scoring, rank-normalized `1/(1+index)`, `file:line` snippet). So the Spotlight server = **mdfind (recall) → build a small per-query index from the top candidates (extract each) → `search()` (precision + anchors + ranking) → `{hits}`.** Maximal reuse; the only new logic is the `mdfind` wrapper + candidate assembly + the server shell.

## Scope (`examples/source-files/`)

### A. `src/spotlight.ts` (new)
- `async function mdfind(question: string, opts?: { onlyIn?: string[]; limit?: number }, exec?: ExecFn): Promise<string[]>` — builds argv (`-onlyin` per dir, then the query string), runs `mdfind` via an **injectable `exec` seam** (default: spawn `/usr/bin/mdfind`), parses newline-separated absolute paths, drops blanks, caps at `limit` (default 40 candidates). Throw-proof: `mdfind` missing / non-zero exit / empty → `[]` (never throws; stderr warning). `ExecFn = (argv: string[]) => Promise<string>` returns stdout.
- `async function hitsFromPaths(paths: string[], question: string): Promise<Hit[]>` — builds `IndexRecord[]` from the candidate paths (reuse `extractFile`; `relPath` = a home-relative display path via a small helper, `absPath` = the path, `rootLabel` = 'spotlight'), then returns `search(index, question)` (reuse). Files that fail extraction are skipped. This gives whole-disk recall (mdfind) + our own precise snippet/rank on the candidates.

### B. `src/spotlight-server.ts` (new)
- `parseSpotlightArgs(argv): { onlyIn: string[]; toolName: string; limit: number }` — optional repeatable `--onlyin <dir>` (scope; default = whole disk), `--name <tool>` (default `files_query`), `--limit <n>` (candidate cap, default 40).
- `createSpotlightServer(toolName, opts, deps?)` — MCP `Server` with one tool `files_query({question})`; handler: `paths = await mdfind(question, {onlyIn, limit})` then `hits = await hitsFromPaths(paths, question)` → `{content:[{type:'text',text:JSON.stringify({hits})}]}`. `deps` lets tests inject a fake `mdfind`. stdout stays clean (all logging to stderr).
- `main(argv)` — parse, log scope to stderr, connect `StdioServerTransport`. `import.meta.main` guard.

### C. README + reference note
Update `examples/source-files/README.md`: two server modes — the **walk mode** (`src/server.ts --root DIR`, bounded folder) and the **Spotlight mode** (`src/spotlight-server.ts [--onlyin DIR]`, whole-disk via Spotlight, macOS only). Show the `sources.json` entry for each. Note Spotlight mode is macOS-only and respects Spotlight Privacy exclusions.

## Verification

- **Unit — `spotlight.ts`:** `mdfind` builds correct argv (`-onlyin` per dir + query), parses newline paths, caps at limit, and returns `[]` on exec failure / empty — all via an injected `exec` seam (no real Spotlight needed). Plus ONE real smoke test: `mdfind('hearth', {onlyIn:[<a dir with a known file>]})` returns a non-empty path list on this machine (skipped gracefully if `mdfind` is absent, e.g. CI/Linux). `hitsFromPaths` on two real temp files (one containing the query term) returns a rank-normalized hit for the matching file with a `file:line` anchor, skipping unextractable ones.
- **Unit — `spotlight-server.ts`:** MCP round-trip (InMemoryTransport) with an **injected fake `mdfind`** returning two known temp-file paths → `files_query({question})` returns a valid `{hits}` payload (string `claim_text`, satisfies `federated-client`'s contract). Unknown tool → `isError`+`{hits:[]}`; empty candidates → `{hits:[]}`.
- **VERIFY-AGAINST-REAL (owner machine):** register the Spotlight source in the real `~/.hearth/sources.json` (pointed at the real `~/Documents/hearth` server path, `--onlyin ~/Documents` to bound the smoke test), then `hearth query`/owner `vault_query{federate:true}` for a term known to exist in the user's files → returns real hits with real `file:line` anchors from actual on-disk documents, entirely federated (nothing copied into the vault).

## Non-goals

- **Non-macOS Spotlight** (Linux/Windows) — this variant is macOS-only; the walk-`--root` variant remains the cross-platform option. (A Windows "Everything"-backed variant is a future analog.)
- **Deep Spotlight query syntax** (`kMDItem*` predicates, date/kind filters) — v1 passes the question as a plain content query; structured predicates are a follow-on.
- **Re-ranking by Spotlight relevance** — mdfind's own order is ignored; we re-rank candidates by our token-overlap score (deterministic, anchored). 
- **Media transcription** — unchanged (media = filename/metadata only, inherited from `extract.ts`).
- **Caching extracted candidates across queries** — v1 extracts fresh per query (bounded by the candidate cap); a cache is a later optimization.

## Risks

- **Extraction cost per query:** extracting up to `limit` (40) Office/PDF candidates per query (officeparser spawns work per file) could be slow on heavy queries. Mitigation: the 40-candidate cap + returning only top 8; tune `--limit` down if needed; note it. mdfind itself is instant — the cost is our extraction, bounded and configurable.
- **mdfind absence / non-macOS:** the wrapper fail-opens to `[]` (empty hits), so the server degrades gracefully rather than crashing; the real smoke test skips when `mdfind` is absent.
- **Spotlight coverage gaps:** excluded/unindexed locations won't appear — this is intended (privacy boundary) but should be documented so users aren't surprised a Privacy-excluded folder is unsearchable.
