# @hearth/source-files

A reference federated province for [hearth](../../README.md): an MCP stdio
server that exposes one tool — `files_query({question}) -> {hits}` — backed
by a keyword search over local text and Office/PDF files.

It exists to demonstrate the shape a province must have to plug into
hearth's multi-source broker, and to be a real, useful one on its own
(search your notes, docs, and reports from any hearth consumer).

## Run it

```bash
bun src/server.ts --root /path/to/docs [--root /path/to/more-docs] [--name files_query]
```

- `--root` is repeatable — pass it once per directory you want indexed. Each
  root is walked once at startup (dotfiles/dotdirs, `node_modules`, `.git`,
  and other build/VCS directories are skipped; oversized files are skipped).
  Symlinked files and directories are not followed/indexed (keeps the walk
  loop-safe).
- `--name` overrides the exposed tool name (default `files_query`) — useful
  if you're registering more than one instance of this province under
  different labels.
- All diagnostic logging goes to `stderr`. `stdout` is the MCP JSON-RPC
  transport and must stay uncontaminated.

## Register it with hearth

`~/.hearth/sources.json` is a JSON array; add this element:

```json
[
  {
    "id": "files",
    "description": "Local files (txt/md + Office/PDF)",
    "transport": {
      "kind": "stdio",
      "command": "bun",
      "args": ["/abs/path/to/examples/source-files/src/server.ts", "--root", "/abs/path/to/your/docs"]
    },
    "query_tool": "files_query"
  }
]
```

Use absolute paths for both the server entrypoint and the `--root` directory
— hearth spawns the process from its own working directory, not this one.

## Spotlight mode (macOS)

This province ships two entrypoints:

- **Walk mode** (`src/server.ts`, above) — bounded folders you list with
  `--root`; each root is walked and indexed once at startup. Cross-platform.
- **Spotlight mode** (`src/spotlight-server.ts`) — whole-disk recall via
  macOS Spotlight (`mdfind`); no startup crawl, no fixed root required.
  **macOS only.**

```bash
bun src/spotlight-server.ts [--onlyin /path/to/docs] [--limit 40] [--name files_query] \
  [--ext pdf,md] [--all-types] [--exclude some-substr]
```

- `--onlyin` is repeatable and scopes `mdfind` to specific directories;
  omit it to search the whole disk (subject to Spotlight indexing and
  Privacy exclusions — anything under System Settings → Siri & Spotlight →
  Spotlight Privacy is invisible to `mdfind`, by design).
- `--limit` caps how many results are returned per query (default 40).
  Internally, a larger candidate pool (`max(limit * 6, 200)`) is pulled from
  `mdfind` and filtered *before* this limit is applied, so junk/code matches
  can't crowd real documents out of the budget.
- `--name` overrides the exposed tool name, same as walk mode.
- Same `stdout`/`stderr` discipline as walk mode: all diagnostics go to
  `stderr`.

### Filtering

Whole-disk Spotlight recall needs scoping, or `node_modules`, build output,
and source code drown out the documents you actually want. Two filters are
always applied, and one is on by default:

- **Junk directories — always excluded.** Any candidate whose path passes
  through a build/dependency/cache directory (`node_modules`, `.git`,
  `dist`, `build`, `target`, `.next`, `__pycache__`, `.venv`, anything
  containing "cache", etc. — see `JUNK_SEGMENTS` in
  [`src/spotlight.ts`](./src/spotlight.ts)) is dropped. This can't be
  turned off; `--exclude <substr>` (repeatable) adds more path segments to
  the junk set on top of it.
- **Document types — the default.** With no flags, only document/note
  extensions are returned — office docs (`.pdf`, `.doc`/`.docx`,
  `.ppt`/`.pptx`, `.xls`/`.xlsx`, `.pages`/`.key`/`.numbers`, `.odt`/`.ods`/`.odp`)
  and plain-text/note formats (`.txt`, `.md`/`.markdown`, `.rtf`/`.rtfd`,
  `.csv`, `.tex`) — see `DOC_EXTS` in [`src/spotlight.ts`](./src/spotlight.ts)
  for the exact list. Source code, configs, and other non-document types are
  filtered out automatically; **no flags are needed for this — it's the
  out-of-the-box behavior.**
  - `--ext <csv>` replaces the allowlist with your own extensions (e.g.
    `--ext pdf,md`).
  - `--all-types` disables the type allowlist entirely — every extension is
    returned (junk directories are still excluded).

- `--exclude` and `--ext`/`--all-types` are independent: junk-directory
  exclusion always runs first, then the type allowlist (if any).

Register Spotlight mode with hearth the same way, pointing at the other
entrypoint. The tuned defaults (doc-mode filtering, junk exclusion) apply
automatically — no flags required:

```json
[
  {
    "id": "files",
    "description": "Local files (txt/md + Office/PDF), whole-disk via Spotlight",
    "transport": {
      "kind": "stdio",
      "command": "bun",
      "args": ["/abs/path/to/examples/source-files/src/spotlight-server.ts", "--onlyin", "/abs/path/to/your/docs"]
    },
    "query_tool": "files_query"
  }
]
```

## Scope (v1)

- **In scope:** plain text (`.txt`, `.md`, `.markdown`, `.text`, `.log`,
  `.csv`) is read directly; Office documents and PDFs (`.docx`, `.pptx`,
  `.xlsx`, `.pdf`, `.odt`, `.odp`, `.ods`) are extracted via `officeparser`.
  Media files (audio/video) are indexed by filename only — no content.
- **Non-goals:** no ASR/transcription of media, no embeddings or semantic
  search (keyword/token-overlap only), no persistent or incremental index —
  every start re-walks all configured roots from scratch.

## Build your own province

Copy this directory as a starting point. The only contract you need to
satisfy is one MCP tool: `{question: string} -> {hits: Hit[]}`, where each
hit has a `claim_text: string` (required) and optionally `source`,
`anchor_summary`, `confidence`, and `match_score` — see
[`src/search.ts`](./src/search.ts) for the exact shape hearth's
`federated-client` expects.
