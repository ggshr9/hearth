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
bun src/spotlight-server.ts [--onlyin /path/to/docs] [--limit 40] [--name files_query]
```

- `--onlyin` is repeatable and scopes `mdfind` to specific directories;
  omit it to search the whole disk (subject to Spotlight indexing and
  Privacy exclusions — anything under System Settings → Siri & Spotlight →
  Spotlight Privacy is invisible to `mdfind`, by design).
- `--limit` caps how many Spotlight-matched candidates get opened and
  extracted per query (default 40) — tune it down if queries feel slow.
- `--name` overrides the exposed tool name, same as walk mode.
- Same `stdout`/`stderr` discipline as walk mode: all diagnostics go to
  `stderr`.

Register Spotlight mode with hearth the same way, pointing at the other
entrypoint:

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
