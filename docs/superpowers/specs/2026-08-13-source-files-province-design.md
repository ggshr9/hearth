# Second federated source — the `source-files` province + multi-source broker validation — Design

**Date**: 2026-08-13
**Status**: Design draft (brainstorm 2026-08-13); execution approved by user ("写 spec，然后执行").
**Repo**: `ggshr9/hearth` (the province ships as `examples/source-files/`; a conditional ranking fix touches `src/core/query.ts`). North star + phasing: memory note `hearth-memory-infra`.

## The direction (context)

hearth's permission broker (Phase 3, merged) is only exercised by ONE federated source today — `wechat-cc`. Its whole value proposition — *per-consumer × per-source* authorization, and *cross-source* merge/ranking — cannot be proven or tuned with a single source. This work stands up a **second, genuinely different** federated source (a local **files** province: the user's scattered documents on disk) and uses it to **validate the broker's multi-source behavior** end-to-end, and to finally decide the deferred Phase-2b ranking question on real 2-source data.

A "province" (federated source) is any local data source that answers *"given a question, here are matching snippets with citations"* over MCP, holding its raw data in place (Federate mode — nothing is copied into hearth's vault). The files province is the natural second one: high-volume, raw, already-on-disk, and **plausibly granted separately** from wechat ("grant codex my notes but not my chat") — exactly the authorization contrast the broker exists for.

## Goal

1. Ship `examples/source-files/` — a standalone MCP stdio server that federates keyword search over one or more local directories (txt/md + Office/PDF text content), emitting hearth-compatible hits. It doubles as **hearth's reference province** (proof the federation contract is not wechat-specific).
2. Stand up a real hearth vault at `~/Documents/tendhearth/vault`, register **both** wechat-cc and the files province, and **validate the broker's three multi-source guarantees** on real data: per-source authorization (grant one, not the other), cross-source merge (a query hitting both), and fair ranking.
3. Using that real 2-source merge, **decide Phase 2b**: keep the current flat-merge, or apply a minimal cross-source normalization — driven by observed behavior, not speculation.

## The province contract (grounded in hearth's real code)

Read from hearth `34faa6d` (main, Phase 3 merged) — a federated source must satisfy exactly this, and no more:
- **`src/core/source-registry.ts` `FederatedSource`**: `{ id, description?, transport: { kind:'stdio', command, args?, env? }, query_tool }`. Registered as a JSON entry in `~/.hearth/sources.json`.
- **`src/core/federated-client.ts`**: hearth spawns the source's `command`, connects as an MCP client, and calls `query_tool` with `{ question }`. It expects the tool result's text content to be `JSON.stringify({ hits: RawFederatedHit[] })`, where **`RawFederatedHit` = `{ claim_text: string (required), source?, anchor_summary?, confidence?, match_score? }`**. hearth stamps `origin:'federated'` + `verified_by:<source id>` itself; a federated hit is **never** run through hearth's `verifyClaim` (the source vouches for it — Phase 2a decision A). `match_score` defaults to 0 if absent.
- **Privacy**: hearth sends the source *only the question string* — no vault content, no other source's data. The province returns *only* snippets it chooses to expose. Raw files never enter hearth's vault.

So the province is simply: an MCP stdio server exposing one `{question} → {hits}` tool. Nothing hearth-internal is imported.

## Scope

### A. The `source-files` province (`examples/source-files/`, new — its own package)

hearth is a single package (no workspaces), so the province is a **self-contained sub-package** with its OWN `package.json` (isolating its `officeparser` dependency from hearth core). Files:
- `examples/source-files/package.json` — name `@hearth/source-files` (private), `type: module`, deps: `@modelcontextprotocol/sdk`, `officeparser`. Its own `bun.lock`. (These ARE committed — it's a new package; hearth's ROOT `package.json`/`bun.lock` are NOT touched.)
- `examples/source-files/src/extract.ts` — text extraction per file type:
  - `.txt`/`.md`/`.markdown` → read UTF-8 directly.
  - `.docx`/`.pptx`/`.xlsx`/`.pdf` → `officeparser.parseOfficeAsync(path)` → text.
  - `.mp3`/`.mp4`/`.m4a`/`.wav`/`.mov` (and other media) → **no content**; represented by filename + metadata (size, mtime) only. (Content transcription is a non-goal.)
  - Unknown/binary extensions → skipped.
  - Extraction is throw-proof per file (a corrupt/locked file logs a warning and is skipped, never crashes the walk).
- `examples/source-files/src/index-store.ts` — an **in-memory index built at startup**: walk each `--root` recursively (skipping `node_modules`, `.git`, dotdirs, and files over a size cap e.g. 10 MB), extract text, and store `{ path (relative to its root), rootId, text, mtime, isMedia }`. Tokenize lazily at query time. (Persistent/incremental indexing is a non-goal — restart re-walks.)
- `examples/source-files/src/search.ts` — `search(index, question, limit): Hit[]`:
  - Tokenize the question (lowercase, split on non-alphanumeric, drop tokens < 2 chars; keep CJK char-blocks like hearth's own tokenizer).
  - Score each file by **distinct question-token coverage** within its text (count of distinct query tokens present), tie-broken by total occurrences. Files with zero matched tokens are excluded. Media files match on filename tokens only.
  - For each matching file, pick the best **snippet**: the smallest line-window containing the most query tokens (± 1 line of context), capped at ~300 chars. `anchor_summary = "<relPath>:<lineStart>"` (or `"<relPath> (media)"` for filename-only media hits).
  - Rank files by score descending, take top `limit` (default 8), and assign **rank-normalized `match_score = 1/(1+index)`** (so the province plays fair in hearth's cross-source merge, mirroring wechat-cc's fix). `confidence` = `index===0 ? 'high' : index<=2 ? 'medium' : 'low'`.
  - `claim_text` = the snippet; `source` = the relative file path.
- `examples/source-files/src/server.ts` — the MCP stdio server: parse `--root <dir>` (repeatable) + optional `--name <toolName>` (default `files_query`); build the index at startup (log progress to stderr, NEVER stdout — stdout is MCP protocol); register ONE tool `files_query({ question }) → { content:[{ type:'text', text: JSON.stringify({ hits }) }] }`. Fail-safe: an empty/no-root config yields an empty index and `{hits:[]}`, never a crash.
- `examples/source-files/README.md` — how to run it, the sources.json entry to register it, and a one-paragraph "this is the reference province: copy it to build your own."
- `examples/source-files/tests/` — `bun test`:
  - `extract`: txt/md read; a fixture `.docx` (or `.pdf`) extracts expected text; a media file returns metadata-only (no content); a corrupt file is skipped not thrown.
  - `search`: a fixture dir with 3 known files → a question matching one returns it top-ranked with a correct `file:line` anchor; a question matching two returns both, rank-normalized (`match_score` strictly descending, first = 1.0/0.5…); a no-match question returns `[]`.
  - `server` (in-memory MCP Client/Server/InMemoryTransport, hearth's harness pattern): `files_query({question})` returns a well-formed `{hits}` payload whose every hit has a string `claim_text` — i.e. it satisfies `federated-client`'s `RawFederatedHit` validator. Assert the JSON shape hearth actually parses.

### B. Real vault + dual-source registration + broker validation (a manual verify gate — mostly not committed code)

1. `hearth init ~/Documents/tendhearth/vault` (or `hearth adopt` if it exists) — the user's real durable vault. Add a couple of small seed pages so the local-vault leg has content to return.
2. `~/.hearth/sources.json` registers **two** sources:
   - `wechat-cc` — its Phase-2a `federated_query` MCP server (command that spawns wechat-cc's MCP surface). *(Reality dependency — see Risks; the fallback is a second files root.)*
   - `files` — `{ id:'files', transport:{ kind:'stdio', command:'bun', args:['examples/source-files/src/server.ts','--root','<a real dir with docs>'] }, query_tool:'files_query' }`.
3. `hearth consumer add` three consumers with different grants and drive `vault_query{federate:true}` (token via env) through a spawned `hearth mcp serve --consumer <id>`:
   - `notes-only` — `--sources files`: a query matching both domains returns ONLY files hits (no wechat).
   - `chat-only` — `--sources wechat-cc`: returns ONLY wechat hits (no files).
   - `both` — `--sources files,wechat-cc`: returns MERGED hits from both, each labeled `verified_by` its source, raw content never in the vault.
   Confirm the audit log shows the correct `sources_consulted` per consumer.

### C. Cross-source ranking decision (conditional — Phase 2b-lite)

During the `both` merge, inspect the ranked hit order. hearth currently does `federatedQuery`: flat-merge `[...local, ...federated]`, clamp `match_score` to [0,1], sort desc. With both sources rank-normalizing to `1/(1+index)`, the top hit of EACH source is 1.0 — so ties are common and one source can still dominate on ties.
- **If** the merge demonstrably buries one source (e.g. all of source A before any of source B despite B having a better match), implement a minimal **interleave/normalization** in `src/core/query.ts` — reciprocal-rank fusion (`score = Σ 1/(k+rank_within_source)`, k=60) across sources, or a stable interleave on tie — with a unit test proving a mixed query alternates fairly. Touch ONLY the merge/sort tail; the fail-open/consumer-filter logic is unchanged.
- **If** the existing flat-merge already interleaves acceptably, record that finding (no code change) and keep Phase 2b closed.
This is decided by observation in step B, not assumed up front.

## Architecture

```
                     ~/.hearth/sources.json  (2 entries)
                              │
consumer app ── hearth mcp serve --consumer <id> ──► federatedQuery
  (grant: files | wechat | both)                       │  (consumer-filtered: only granted sources)
                                                        ├── local vault leg (if vault:'r')
                                                        ├──► [files] province  (bun server.ts --root DIR)  ── keyword search on disk, snippets+anchors
                                                        └──► [wechat-cc] province (federated_query)          ── semantic search over messages
                                                        merge (rank-normalized) → audit(sources_consulted)
```

The files province imports nothing from hearth — it only implements the wire contract (`{question}→{hits}` over MCP stdio). hearth stays vendor-neutral; the province is a pure downstream. Independence holds: either runs alone.

## Verification

- **Province unit tests (in `examples/source-files/`)**: extraction (text + one Office/PDF fixture + media-metadata + corrupt-skip), search (top-rank + anchor correctness + rank-normalized multi-hit + no-match empty), and the MCP server round-trip producing a `federated-client`-valid `{hits}` payload.
- **VERIFY-AGAINST-REAL (owner machine, the point of this work)**: with the real `~/Documents/tendhearth/vault` + both sources registered + the three consumers: prove per-source authorization (notes-only sees no wechat; chat-only sees no files), cross-source merge (both sees both, each `verified_by` its source, raw never in vault), and audit `sources_consulted` correctness. Record the observed ranking and the Phase-2b decision.
- **Backward-compat**: hearth's existing suites stay green; the province is additive (a new example package + at most a merge-tail change in query.ts). `federate:false` and owner paths unchanged.

## Non-goals (deferred)

- **Media content search** (mp3/mp4 → ASR/Whisper transcription) — v1 is filename/metadata only for media.
- **Semantic/embedding retrieval** in the files province — v1 is honest keyword/token-overlap, matching hearth's own conservative query.
- **Persistent/incremental index** — v1 re-walks roots at startup; no on-disk index, no file-watching.
- **Additional provinces** (email, calendar) — this validates the pattern with one new source; others follow if the pattern holds.
- **Ingest-mode for files** — the files province is Federate-only (raw stays on disk); distilling file summaries into the vault is a separate future slice.
- **A `hearth-provinces` monorepo** — the first province lives in `examples/`; it graduates to its own repo only if the ecosystem grows.

## Risks

- **wechat-cc live dependency (validation B):** the broker validation ideally uses wechat-cc as source #1, which requires its `federated_query` MCP server to stand up on this machine (validated in Phase 2a, but env-dependent). **Mitigation:** the broker's multi-source behavior is domain-agnostic — if wechat-cc won't start, register a **second files root** as source #2 and validate authorization/merge/ranking with two files provinces (identical broker mechanics), then wire wechat separately. The validation must not be blocked on wechat-cc's runtime.
- **`officeparser` in Bun:** it's a Node lib; confirm `parseOfficeAsync` works under Bun during Task 1 and swap to per-format libs (`mammoth`/`pdf-parse` + a pptx unzip) only if it doesn't. Keep extraction behind the `extract.ts` seam so the choice is swappable.
- **Startup index cost on a large root:** walking a huge directory at startup could be slow. **Mitigation:** a file-count/size cap + skip-list (node_modules/.git/dotdirs/>10MB), and point the demo `--root` at a bounded real directory, not `$HOME`. Persistent indexing is the real fix (non-goal here).
- **stdout discipline:** the province is an MCP stdio server — ANY stray stdout write (an extractor's console.log, a progress bar) corrupts the protocol. All logging goes to stderr; this is a task requirement and a test-worthy invariant.
