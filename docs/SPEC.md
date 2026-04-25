# hearth SPEC v0.1

**Status**: draft, designing in public. This document is the contract; code lands after.

---

## 0. Mission

`hearth` is a personal AI runtime that sits between input channels (chat, voice, file drop, web clipping) and a plain-markdown vault. It implements [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — sources go in, an agent compiles them into a structured wiki, queries return citation-grounded answers, periodic lint keeps the wiki clean.

It is a **runtime**, not a UI. Editors (Obsidian, Logseq, Foam, plain text) stay yours. Channels (WeChat, Telegram, voice, CLI) are interchangeable. Agent runtimes (Claude Code, Codex, ACP-compatible) are pluggable. The vault is the canonical store; everything else is consumable.

---

## 1. Vault contract

A vault is a directory of plain-markdown files plus a human-authored `SCHEMA.md`. `SCHEMA.md` defines:

- Folder structure (e.g. `raw/`, `<topic>/`, `Maps/`, `Assets/`)
- A **permission table**: who may add/modify/delete in each directory (human, agent, or both)
- The **frontmatter taxonomy**: required types (e.g. `concept`, `source-summary`, `moc`, `walkthrough`, `decision`), required status values, source quality tiers
- Writing conventions

`hearth` reads `SCHEMA.md` on startup. Every action it takes is constrained by it. **No SCHEMA.md, no compile.** This is the single most important rule and the primary defense against slop.

---

## 2. Three verbs

These are the only verbs `hearth` exposes. Everything else is plumbing.

### `Ingest(source) → IngestResult`

A new file lands in `raw/` (or arrives via a channel). `Ingest`:

1. Detects format, routes to the appropriate extractor
2. Preserves the original under `raw/` or `Assets/` per SCHEMA.md
3. Writes a `source-summary` page to the appropriate topic directory
4. Extracts concepts → creates or updates `concept` pages
5. If the source describes a process → writes a `walkthrough`
6. Updates the relevant Map of Content
7. Establishes bidirectional links between new and existing pages

A typical Ingest touches 5–15 wiki pages. `IngestResult` lists every file created, updated, or skipped, plus any concepts it couldn't resolve.

### `Query(question, context?) → Answer`

`Query`:

1. Searches the wiki (ripgrep + frontmatter index, optional embedding fallback later)
2. Assembles an answer grounded in retrieved pages
3. **Mandates citations.** Every claim points to a source path; pages without sufficient grounding are reported as "no answer found in vault"
4. If the answer surfaces a novel synthesis, optionally writes it back as a new wiki page (gated, see §5)

The "write back" rule prevents the failure mode where good thinking gets trapped in a chat transcript and lost.

### `Lint(scope?) → LintReport`

`Lint` is a pure auditor. Defaults to read-only — proposes, does not commit. Checks include:

- Contradictions between pages
- Orphan pages not linked from any MOC
- `status: stable` pages whose source has been updated
- `status: stable` pages supported by a single secondary source
- Missing cross-references between conceptually-linked pages
- Sources in `raw/` never ingested

Auto-fix is opt-in per check, never default.

---

## 3. Adapter interfaces

### `ChannelAdapter`

```
ChannelAdapter {
  // Receives a message from the channel; emits InboundMsg.
  onInbound(handler: (msg: InboundMsg) => Promise<void>): void

  // Delivers a response. Channel decides how to render.
  deliver(chatId: string, payload: Delivery): Promise<DeliveryAck>
}

InboundMsg {
  chatId, userId, userName?, text, msgType,
  createTimeMs, accountId, attachments?, quoteTo?
}

Delivery { text?, attachments?, sharePage?, voice? }
```

Each channel handles its own session continuity (mapping `chatId` → conversation thread). hearth's session manager treats every `chatId` as an independent conversation.

### `AgentRuntime`

```
AgentRuntime {
  runAgent(opts: {
    systemPrompt, conversation, tools, model
  }): AsyncIterable<AgentEvent>
}
```

`hearth` supplies vault-aware MCP tools to whichever agent runtime runs: `vault_search`, `vault_read`, `vault_ingest`, `vault_query`, `vault_lint`. The runtime is otherwise opaque — Claude Code, Codex, OpenCode, or anything else that speaks ACP works.

---

## 4. Frontmatter contract

Every wiki page must carry frontmatter. Inherited from the user's SCHEMA.md, with two additions hearth enforces:

```yaml
---
type: concept | source-summary | moc | walkthrough | decision
status: stub | draft | stable
sources: [ raw/file.md, https://... ]
created: YYYY-MM-DD
updated: YYYY-MM-DD
topic: <topic>
tags: [snake_case, max_5]
author: human | agent:extract | agent:wiki | agent:suggest
generated_by: hearth-vX.Y           # optional, for agent-written pages
---
```

The `author` field is hearth's **trust gradient**: human-written, agent-extracted (faithful to source), agent-wiki (synthesized, requires review), agent-suggest (proposal, not committed).

---

## 5. Scope discipline (what hearth does NOT do)

This list is load-bearing. It is the difference between a useful tool and a slop generator.

- Does **not** modify or delete files in human-write zones (per SCHEMA.md permission table)
- Does **not** auto-reorganize the vault — moves and renames require explicit user request
- Does **not** compile without a SCHEMA.md
- Does **not** output content without source citations
- Does **not** sync the vault (use Obsidian Sync / Syncthing / git)
- Does **not** maintain a separate database as source of truth — any sqlite/embedding store is derivable cache
- Does **not** manage tasks, calendar, email, or other domains outside personal knowledge
- Does **not** execute code from the vault
- Does **not** silently auto-commit risky operations — high-impact actions go to a `_pending/` review queue

---

## 6. Ingest pipeline

Files arrive via channel attachment, manual drop into `raw/`, or web clipping. Pipeline:

```
file → mime detect → extractor → preserve original + write companion .md
```

| Format | Extractor | Output |
|---|---|---|
| `.md` / `.txt` | direct | front-matter normalized |
| `.pdf` | pdftotext + vision-LLM fallback | text + page anchors |
| `.docx` | pandoc → markdown | near-lossless markdown |
| `.xlsx` / `.csv` | small: full table; large: schema + sample | MD table + summary |
| `.pptx` | python-pptx | per-slide text + image OCR |
| `.mp4` / `.mp3` | ffmpeg + ASR | transcript + optional keyframes |
| `.png` / `.jpg` | OCR + vision description | text + visual gloss |
| URL | fetch + Readability + site adapters (B站/YouTube/微信公众号) | full text + meta + transcript |

Originals are kept under `raw/` or `Assets/` per SCHEMA.md. Companion `.md` files in topic directories carry frontmatter linking back to the original. **No information is destroyed in extraction**; the original is always re-extractable.

---

## 7. Storage and retention

- **Vault**: user's filesystem; hearth never dictates sync mechanism
- **Originals**: indefinite retention, append-only
- **Derived indexes** (sqlite full-text, embeddings, wiki graph cache): expendable, hearth can rebuild from vault
- **Conversation logs**: stored under hearth's own state directory (default `~/.hearth/sessions/`), NOT in vault — only distilled summaries land in vault
- **Pending review queue**: `~/.hearth/pending/` — agent-proposed writes await user approval before landing in vault

---

## 8. Versioning + open questions

This is `v0.1`. Expected `v0.2` and beyond:

- Semantic search: when to introduce embeddings (heuristic: vault > 500 pages)
- Approval flow UX: prompt-in-chat vs dashboard-batch
- Multi-vault support: one user, multiple SCHEMAs
- Public projection: how hearth integrates with Quartz / static site generators that publish vault subsets
- Cross-channel session bridging: WeChat conversation continued from Telegram next day

Track and discuss in GitHub Discussions / issues.

---

*This SPEC is the contract. The code follows it, not the other way around.*
