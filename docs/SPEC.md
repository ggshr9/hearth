# hearth SPEC v0.4

**Status**: shipped through v0.4 (Agent Interface & Audit). Read [`PRODUCT.md`](./PRODUCT.md) first for the doctrine; this document is the technical contract.

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
    precondition:
      exists: false                 # this path must not already exist
    body_preview: ...
  - op: update
    path: 02 Concepts/RAG.md
    reason: adds comparison with LLM Wiki
    precondition:
      exists: true
      base_hash: sha256:<file-content-at-plan-time>
    patch:
      type: unified_diff
      value: |
        ...
  - op: update
    path: 01 Maps/AI PKM.md
    reason: add backlink
    precondition:
      exists: true
      base_hash: sha256:<...>
requires_review: true
```

The `precondition` block is non-optional. `vault_apply_change` re-checks
every op's precondition immediately before writing. If a target file's
hash has changed since the plan was produced (you edited it in Obsidian
in the meantime, an earlier plan applied first, etc.), the apply rejects
with:

```
Apply failed: target file changed since ChangePlan was created.
Run `hearth pending rebase <change_id>`.
```

This is what makes the agent-doesn't-pollute-vault guarantee actually
hold under concurrency — without preconditions, a stale plan would
clobber human edits.

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
For markdown/text: structured anchor — see Anchor stability below.
For URL: `anchor:` may be a CSS selector + quoted excerpt + hash.

#### Anchor stability

Line numbers drift when a source is edited. To keep `claims:` resilient,
hearth-managed citations use a structured anchor:

```yaml
claims:
  - text: "<assertion as it appears in the page>"
    source: raw/file.md
    anchor:
      type: line                  # | page | timestamp | css
      line_start: 74
      line_end: 79
      quote: "<short exact excerpt>"
      quote_hash: sha256:<digest of quote>
    confidence: high
```

`quote_hash` is the source of truth: `Lint` recomputes it from the source
and reports drift if it no longer matches. `line_start` / `line_end` are
fast hints — used first, then validated against `quote_hash`.

For this to work in practice, hearth-managed markdown follows a writing
convention: **one sentence per line, one bullet per line, one claim per
line for agent-written content.** The convention is enforced for agent
writes; human writes are best-effort (`Lint` warns, doesn't fail).

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

To prove the trust closure before chasing format coverage:

**v0.1 release blocker** (must work, must have tests):
- `.md` (direct, frontmatter normalized)
- `.txt`

**Stretch (nice-to-have for v0.1, not a release blocker)**:
- URL (fetch + Mozilla Readability)

**Deferred to v0.5**:
- PDF, Word (.docx), Excel (.xlsx, .csv), PowerPoint (.pptx), video, audio, image
- Site adapters: B站, YouTube, 微信公众号

URL is held back from blocker status because it drags in fetch errors,
anti-bot, Readability quality, HTML prompt-injection, canonical URLs, and
caching — all worth handling, but none of them are what hearth's existence
depends on. The thing to prove first is the trust loop. See `docs/ROADMAP.md`.

---

## 8. Storage and retention

- **Vault**: user's filesystem; hearth never dictates sync mechanism
- **Originals**: indefinite retention, append-only
- **Derived indexes** (sqlite full-text, embeddings, wiki graph cache): expendable, hearth can rebuild from the vault on demand
- **Conversation logs**: stored under hearth's state directory (default `~/.hearth/sessions/`), NOT in the vault — only distilled summaries land there, and only after `ChangePlan` review
- **Pending review queue**: `~/.hearth/pending/` — `ChangePlan`s await user approval before landing in the vault

---

## 9. v0.3 — Channel runtime

`runtime.ts` exposes `ingestFromChannel(InboundMsg, opts) → ChannelIngestResult` so any channel adapter (wechat-cc, telegram-cc, future) routes inbound material into the same kernel pipeline as CLI ingest. Channel-side materialization lands in `~/.hearth/channel-inbox/<channel>/<msg-id>.md`; vault is never written by inbound directly.

```
InboundMsg { channel, message_id, from, text?, url?, received_at }
       ↓
materialize → ~/.hearth/channel-inbox/<channel>/<msg-id>.md
       ↓
AgentAdapter (mock | claude) → ChangePlan
       ↓
plan-validator (rejects path-escape / permission / patch-type drift)
       ↓
PendingStore  (vault still untouched)
       ↓
[user reviews via CLI / channel commands]
       ↓
kernel.apply  (only the human-direct path actually writes vault)
```

Companion: `hearth adopt <vault>` and `hearth doctor` for installing hearth into an existing vault without migrating files. See [PRODUCT.md §"Don't migrate, adopt"](./PRODUCT.md).

## 10. v0.4 — MCP server surface

Hearth exposes a stdio MCP server (`hearth mcp serve`) so any MCP-aware agent runtime (Claude Code, Cursor, Codex, Continue.dev) can operate on the vault under the trust mechanisms above. Surface:

**Tools (read)**: `vault_search`, `vault_read`, `vault_query`, `vault_lint`, `vault_doctor`, `vault_pending_list`, `vault_pending_show`.

**Tools (mutation)**:
- `vault_plan_ingest(source_text, origin?, schema_hash_seen?)` — returns ChangePlan; never writes vault. `STALE_CONTEXT` returned if `schema_hash_seen` mismatches current.
- `vault_apply_change(change_id, approval_token?)` — token-gated. Without token returns `REQUIRES_HUMAN_APPROVAL` with a CLI hint. With a valid token, kernel preflight + apply.

**Resources** (each carries a `version_hash` / `last_modified` so agents can detect drift):
- `hearth://schema` — SCHEMA.md content
- `hearth://vault-map` — directory tree summary
- `hearth://pending` — current pending queue
- `hearth://lint-report` — latest lint output
- `hearth://agent-instructions` — markdown rules pack the consuming agent should prepend to its system prompt

**Prompts** (workflow templates):
- `ingest_workflow`, `query_with_citations`, `lint_fix_workflow`, `restructure_discussion`

Tools not exposed (deliberately, ever): `vault_write`, `vault_delete`, `vault_patch_anywhere`. All mutations route through plan + apply.

## 11. v0.4 — Approval token protocol

`vault_apply_change` via MCP is gated by an HMAC-signed token issued only by a human-direct surface (CLI, channel adapter, future Local Console). This makes apply NOT a silent agent capability.

```
agent (via MCP) →  vault_apply_change(change_id)
                    no token → REQUIRES_HUMAN_APPROVAL + hint:
                                "hearth pending apply <id>" (CLI)
                                "/hearth apply <id>" (channel)

human surface →  issueToken({ change_id, scope, expires_in_ms?, issued_by })
                  HMAC-SHA256(secret, json(payload)); secret in
                  ~/.hearth/secret.key (chmod 600, lazily generated)

agent →  vault_apply_change(change_id, approval_token)
          verifyAndConsume:
            - signature OK (constant-time HMAC compare)
            - exp not in past
            - bound to this change_id
            - required_scope ≤ token.scope (low / medium / high)
            - jti not in consumed-tokens.log (single-use)
          → kernel preflight + apply
```

CLI `hearth pending apply <id> --vault <vault>` does not need a token — direct shell session is the human authentication. Token issuance for IDE/web flows lands in v0.5.

## 12. v0.4 — Audit log

`<vault>/.hearth/audit.jsonl`, append-only, file-locked writes. Every mutation event is logged with timestamp, event type, initiator, optional structured data:

```
adopt.proposed | adopt.applied
channel.ingested
changeplan.created | changeplan.applied | changeplan.rejected
lint.run | doctor.run
mcp.tool_called
approval_token.issued | approval_token.consumed | approval_token.rejected
```

CLI: `hearth log [--vault <dir>] [--since 7d|24h|30m] [--limit N]` for human-readable timeline. v0.4 ships no rotation — `audit.jsonl` grows linearly. Rotation lands in v0.5+.

## 13. v0.4 — Error code contract

Stable strings agents react to per [`hearth://agent-instructions`](../src/core/agent-instructions.ts):

- `STALE_CONTEXT` — a resource the agent saw earlier has changed; re-read and retry
- `REQUIRES_HUMAN_APPROVAL` — apply needs a token; surface to user, do not loop
- `REBASE_REQUIRED` — plan op's base_hash drifted; regenerate the op
- `STALE_TOKEN` — token expired / consumed / wrong; request fresh approval
- `PERMISSION_DENIED` — SCHEMA does not allow this op; report, do NOT retry with different paths
- `PLAN_VALIDATION_FAILED` — generic plan validator failure with per-issue list

## 14. Versioning

This is `v0.4`. The roadmap (auto-policy / Views before Moves / WebUI) lives in [`docs/ROADMAP.md`](./ROADMAP.md). High-level positioning lives in [`docs/PRODUCT.md`](./PRODUCT.md) — read PRODUCT first if you've never seen hearth before.

---

*This SPEC is the technical contract. PRODUCT.md is the doctrine. The code follows both.*
