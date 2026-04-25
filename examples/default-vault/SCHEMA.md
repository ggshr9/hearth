---
type: meta
tags: [schema, contract]
---

# Default Vault Contract

Minimal SCHEMA.md shipped with `hearth init --template default`. Borrows from
[Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
Replace with your own conventions as your vault grows.

## Permission table

| dir         | human | agent |
|-------------|-------|-------|
| raw/        | add   | add   |
| 00 Inbox/   | rw    | none  |
| 01 Topics/  | r     | rw    |
| 02 Maps/    | r     | rw    |
| 99 Assets/  | rw    | add   |

Permission tokens:
- `none` — no access at all
- `r` — read only
- `add` — may create new files; may not modify or delete existing
- `rw` — full read/write on existing; may also create

`SCHEMA.md`, `README.md`, `index.md` at the vault root are implicitly
human-only. Agents may read them; they cannot be modified by `hearth`.

## Frontmatter types

Wiki pages must declare `type:` in their frontmatter:

- `concept` — a single concept's encyclopedia entry
- `source-summary` — agent's reading notes on a single raw source
- `moc` — Map of Content; topic-level index page
- `walkthrough` — step-by-step explanation of a process
- `decision` — a design decision (why / alternatives / tradeoff)

## Status values

- `stub` — placeholder, almost no content
- `draft` — has content, not cross-validated
- `stable` — verified across multiple sources

`agent:wiki`-authored pages always start as `draft` with `review_required: true`.
Promotion to `stable` is a human action.
