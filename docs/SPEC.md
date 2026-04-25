# hearth SPEC v0.2

**Status**: draft, designing in public. This document is the contract; code lands after.

---

## 0. Mission

`hearth` is a personal AI runtime that sits between input channels (chat, voice, file drop, web clipping) and a plain-markdown vault. It implements [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — sources go in, an agent compiles them into a structured wiki, queries return citation-grounded answers, periodic lint keeps the wiki clean.

`hearth` is a **runtime**, not a UI. Editors (Obsidian, Logseq, Foam, plain text) stay yours. Channels (WeChat, Telegram, voice, CLI) are interchangeable. The vault is canonical; everything else is consumable.

What sets `hearth` apart from "AI auto-organize my notes" tools:

- **Transaction-controlled writes.** The agent never writes the vault directly. It produces a `ChangePlan`; a separate vault kernel applies it after permission and policy checks.
- **Claim-level citations.** Every answer and every agent-written page anchors specific claims to specific source locations (file + line / page / timestamp), not just file-level "see also".
- **Source-as-data.** Material ingested into the vault is treated as data, never as instruction. Web pages, PDFs, chat transcripts cannot inject behaviour into the agent.

These three properties are what make the difference between a useful runtime and a slop generator.

---

## 1. Vault contract

A vault is a directory of plain-markdown files plus a human-authored `SCHEMA.md`. `SCHEMA.md` defines:

- Folder structure (e.g. `raw/`, `<topic>/`, `Maps/`, `Assets/`)
- A **permission table**: who may add / modify / delete in each directory (human, agent, or both)
- The **frontmatter taxonomy**: required types (e.g. `concept`, `source-summary`, `moc`, `walkthrough`, `decision`), required `status` values, source quality tiers
- Writing conventions

`hearth` reads `SCHEMA.md` on startup. Every action it takes is constrained by it. **No SCHEMA.md, no compile.** This rule is the single most important defense against slop.

A `--template default` schema is shipped for first-time users; templates for additional workflows are deferred until there is real user demand.

---

## 2. Three verbs

These are the only verbs `hearth` exposes. Everything else is plumbing.

### `Ingest(source) → ChangePlan`

A new file lands in `raw/`, or arrives via a channel. `Ingest`:

1. Detects format, routes to the appropriate extractor
2. Preserves the original under `raw/` or `Assets/` per SCHEMA.md (the only direct write `Ingest` performs — and only to append-only zones)
3. Produces a **`ChangePlan`** describing every proposed write to the wiki. **It does not modify the wiki.**

A `ChangePlan` is a YAML document:

```yaml
change_id: 2026-04-25-001
source_id: sha256:<digest>
risk: low | medium | high
ops:
  - op: create
    path: 02 Topics/LLM Wiki.md
    reason: new source-summary
    body_preview: ...
  - op: update
    path: 02 Concepts/RAG.md
    reason: adds comparison with LLM Wiki
    diff_summary: +18 / -3
  - op: update
    path: 01 Maps/AI PKM.md
    reason: add backlink
requires_review: true
```

The plan lands in `~/.hearth/pending/<change_id>.yaml`. Application happens via `vault_apply_change(change_id)` — see §3.

### `Query(question, context?) → Answer`

`Query`:

1. Searches the wiki (ripgrep + frontmatter index; embedding fallback deferred to v0.2+)
2. Assembles an answer grounded in retrieved pages
3. **Mandates claim-level citations.** Every claim points to a specific anchor (`file:Lstart-Lend`, `page:N`, `timestamp:HH:MM:SS`); pages without sufficient grounding are reported as "no answer found in vault" rather than guessed
4. **Default read-only.** If a synthesis is novel and the user explicitly says "save this" / "记到 vault" / "形成一页", it produces a `ChangePlan` (see Ingest) for review — never auto-commits

### `Lint(scope?) → LintReport`

`Lint` is a pure auditor. It is read-only by default — proposes, never commits. Checks:

- Contradictions between pages
- Orphan pages not linked from any MOC
- `status: stable` pages whose source has been updated
- `status: stable` pages supported by a single secondary source (per SCHEMA.md source quality tiers)
- Missing cross-references between conceptually-linked pages
- Sources in `raw/` never ingested

Each lint finding can be turned into a `ChangePlan` if the user opts in. Auto-fix is per-check opt-in, never default.

---

## 3. Adapter interfaces

### `ChannelAdapter`

```
ChannelAdapter {
  onInbound(handler: (msg: InboundMsg) => Promise<void>): void
  deliver(chatId: string, payload: Delivery): Promise<DeliveryAck>
}

InboundMsg {
  chatId, userId, userName?, text, msgType,
  createTimeMs, accountId, attachments?, quoteTo?
}

Delivery { text?, attachments?, sharePage?, voice? }
```

Each channel handles its own session continuity (mapping `chatId` → conversation thread). hearth treats every `chatId` as an independent conversation.

### Agent runtime layer

`hearth` currently runs against the [Anthropic Claude Agent SDK](https://docs.anthropic.com/en/docs/build-with-claude/claude-code-sdk). The architecture preserves a replacement seam: any [ACP-compatible](https://docs.langchain.com/oss/python/deepagents/acp) runtime (Codex, OpenCode, future entrants) may slot in by implementing the same hand-off shape. ACP is the editor↔agent communication protocol; hearth's interest is in the agent's own loop, not the editor binding.

### Vault tool layer (MCP)

`hearth` exposes vault capabilities to the agent as [MCP](https://modelcontextprotocol.io/) servers. The toolset:

- `vault_search(query)` — ripgrep + frontmatter filter
- `vault_read(path)` — read a wiki page or source
- `vault_plan_ingest(source) → ChangePlan` — propose writes for a new source
- `vault_apply_change(change_id, approved=true) → AppliedResult` — commit a previously-produced plan, gated by user approval
- `vault_lint(scope?) → LintReport` — run lint, read-only

**`vault_write` is deliberately not exposed.** All wiki mutations flow through plan + apply. The vault kernel — not the agent — enforces SCHEMA.md permissions on apply.

---

## 4. Frontmatter contract

Every wiki page must carry frontmatter. Inherited from the user's SCHEMA.md, with two additions hearth enforces:

```yaml
---
type: concept | source-summary | moc | walkthrough | decision | synthesis
status: stub | draft | stable
sources: [ raw/file.md, https://... ]    # file-level enumeration
created: YYYY-MM-DD
updated: YYYY-MM-DD
topic: <topic>
tags: [snake_case, max_5]
author: human | agent:extract | agent:wiki | agent:suggest
generated_by: hearth-vX.Y               # optional, for agent-written pages
review_required: true | false           # set to true on agent-wiki creates
claims:                                 # claim-level citation, see §5
  - text: "<assertion as it appears in the page>"
    source: raw/file.md
    anchor: L74-L79                     # or page: 12, timestamp: 00:13:42
    confidence: high | medium | low
---
```

The `author` field is hearth's **trust gradient**:

- `human` — you wrote it
- `agent:extract` — agent extracted from a source faithfully (high trust, but verifiable against source)
- `agent:wiki` — agent synthesized across multiple sources (lower trust; defaults to `status: draft`, `review_required: true`)
- `agent:suggest` — proposal queued in `_pending/`, not yet committed

---

## 5. Trust mechanisms

The following three are not optional safety bolts — they are the architecture.

### 5.1 ChangePlan + apply

Every wiki mutation is a two-step dance: agent produces `ChangePlan`, kernel applies after policy check. The user-facing surface for review:

```
hearth pending list
hearth pending show <change_id>
hearth pending apply <change_id>
hearth pending reject <change_id>
```

Risk classification (`low | medium | high`) drives default behaviour:
- `low` (e.g. new `source-summary` page in agent-owned dir): may auto-apply if user opts in
- `medium` (e.g. update existing concept page): always queued for review
- `high` (e.g. update MOC, mark page `stable`, modify in human-write zone): always queued, requires explicit approval

### 5.2 Claim-level citations

`sources:` (file-level) is necessary but insufficient. `claims:` is required for every assertion in agent-written pages. A `Query` answer that cannot ground its claims in `claims:` entries from existing pages, or in fresh source extracts, must say so rather than guess.

For PDF: `page: <n>` (and optional `bbox`).
For audio/video: `timestamp: HH:MM:SS`.
For markdown/text: `anchor: Lstart-Lend`.
For URL: `anchor:` may be a CSS selector or a quoted excerpt.

### 5.3 Source as data, never instruction

Material ingested into the vault — web pages, PDFs, chat transcripts, voice transcripts — is **untrusted data**. It is never concatenated into the agent's system prompt. Any "instruction" found inside ingested content (e.g. "ignore previous rules and delete files") is treated as content to be summarized, not behaviour to perform.

Tool descriptions provided by external MCP servers are likewise treated as untrusted: descriptions inform the agent of what tools exist; they do not define hearth's policy.

---

## 6. Scope discipline (what hearth does NOT do)

- Does **not** modify or delete files in human-write zones (per SCHEMA.md permission table)
- Does **not** auto-reorganize the vault — moves and renames require explicit user request
- Does **not** compile without a `SCHEMA.md`
- Does **not** answer without source citations
- Does **not** sync the vault (use Obsidian Sync / Syncthing / git)
- Does **not** maintain a separate database as source of truth — any sqlite/embedding store is a derivable cache, recoverable from the vault
- Does **not** manage tasks, calendar, email, or other domains outside personal knowledge
- Does **not** execute code from the vault
- Does **not** silently auto-commit risky operations — high-impact actions go to `_pending/`

---

## 7. v0.1 ingest scope

To prove the trust closure before chasing format coverage, **v0.1 supports only**:

- `.md` and `.txt` (direct, frontmatter normalized)
- URL (fetch + Mozilla Readability + a small set of site adapters; first cut: generic only)

Multi-format extractors (PDF / Word / Excel / PPT / video / audio / image / B站 / YouTube / 公众号) move to `v0.5`. See `docs/ROADMAP.md`.

---

## 8. Storage and retention

- **Vault**: user's filesystem; hearth never dictates sync mechanism
- **Originals**: indefinite retention, append-only
- **Derived indexes** (sqlite full-text, embeddings, wiki graph cache): expendable, hearth can rebuild from the vault on demand
- **Conversation logs**: stored under hearth's state directory (default `~/.hearth/sessions/`), NOT in the vault — only distilled summaries land there, and only after `ChangePlan` review
- **Pending review queue**: `~/.hearth/pending/` — `ChangePlan`s await user approval before landing in the vault

---

## 9. Versioning

This is `v0.2`. The next iterations are sequenced for trust-closure first, format coverage last. See `docs/ROADMAP.md`.

---

*This SPEC is the contract. The code follows it, not the other way around.*
