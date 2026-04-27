# hearth ROADMAP

Versions are sequenced for **trust closure first, format coverage last**. The order is deliberate: every version after v0.1 must be reachable on top of a vault that can be trusted not to rot.

---

## Near-term priority shift (2026-04-27)

The version sequence below was drafted before the substrate framing in [PRODUCT.md "Hearth in the multi-LLM era"](./PRODUCT.md#hearth-in-the-multi-llm-era). Two practical implications:

- **LLM-conversation capture is being elevated** ahead of v0.5/v0.6/v0.7 polish. The hero use case for the substrate framing is dumping a ChatGPT or Claude conversation into hearth and continuing it tomorrow with a different LLM via MCP. That requires a browser extension (or equivalent) that pulls a chat thread out of vendor UIs and POSTs it to `/ingest`. This is the highest-ROI next surface, ahead of auto-policy.
- **Cross-LLM context query via MCP** is the killer use of hearth's existing MCP server, not just "agent edits vault". A `vault_query_conversations` tool that returns prior threads on a topic regardless of which LLM produced them is a small addition with outsized value.

The version path below remains valid for trust-layer work; capture-surface work runs as a parallel track with its own short-cycle versions (v0.4.x).

---

## v0.4.x — Capture surface coverage (parallel to v0.5+)

- v0.4.1: capture-token + `POST /ingest` endpoint (shipped 2026-04-27)
- v0.4.2: YouTube transcript fetch via yt-dlp (shipped 2026-04-27)
- v0.4.3: browser extension that dumps ChatGPT / Claude / Gemini conversations to `/ingest` (next)
- v0.4.4: MCP `vault_query_conversations(topic, since?, agents?)` for cross-LLM continuity
- v0.4.5: voice-memo capture (Whisper-local transcribe → ingest)
- v0.4.6: article extraction (Readability) for non-YouTube URL captures

Each is small (1-3 days) and independently shippable. Sequence by user signal during dogfood, not by upfront planning.

---

## v0.1 — local CLI core loop (markdown only; URL is stretch)

The minimum that proves "raw → wiki → query → lint" is a real loop, not a demo.

```
hearth init <vault> --template default
hearth ingest <md>            # produces a ChangePlan in ~/.hearth/pending/
hearth pending list
hearth pending show <id>
hearth pending apply <id>     # commit (after review; precondition checked)
hearth query "<question>"     # answer w/ claim-level citations
hearth lint                   # read-only audit
hearth doctor                 # config + schema + perms diagnostic
```

**Core acceptance: `.md` and `.txt` only.** URL ingest is a v0.1 stretch goal,
not a release blocker. URL brings fetch errors, anti-bot, Readability quality,
HTML prompt-injection, canonical URLs, caching — all worth handling, but none
of them are what hearth's existence depends on. The thing to prove first is
the trust loop, not the network plumbing.

**Implementation order matters.** Build the deterministic kernel first
(schema parser, ChangePlan format, vault kernel with permission checks,
citation index, lint), with a mock "agent" that produces deterministic
ChangePlans from markdown. Only after that loop is green do we plug in
the real LLM. This way the architecture is validated before LLM
non-determinism enters.

**Done when these tests pass**:

1. No `SCHEMA.md` in vault → `hearth ingest` refuses with a clear error
2. `hearth ingest <md>` creates a `ChangePlan` in `~/.hearth/pending/`,
   writes nothing to the wiki
3. `hearth pending apply <id>` writes only to paths the SCHEMA.md
   permission table allows the agent to write to
4. `update` op fails if the target file's `base_hash` no longer matches
   (concurrency / staleness protection)
5. `hearth query` for a topic with no grounding returns "no answer found
   in vault" rather than a guess
6. `hearth lint` is read-only by default; produces a report, mutates
   nothing
7. Source files in `raw/` are append-only — `hearth` cannot modify or
   delete them, even with `--force`

---

## v0.2 — pending review + diff

Make the transaction model first-class.

```
hearth pending show <id>      # full diff preview
hearth pending diff <id>      # unified diff per file
hearth pending reject <id> --reason "..."
hearth pending policy         # configure auto-apply for low-risk ops
```

Risk classification (`low | medium | high`) drives default behaviour; user can configure per-class auto-apply.

**Done when**: a user can run `hearth ingest` for a week without ever finding a wiki page they didn't approve.

---

## v0.3 — WeChat channel adapter (3 substages)

The first non-CLI channel. The differentiator: capture happens where you are
(your phone), not where you wish you were (at your desk).

### v0.3.0 — channel adapter spike (inbound → pending)

The minimum that proves channel adapters are entry points, not bypasses.

- New runtime API: `ingestFromChannel(InboundMsg, opts) → ChannelIngestResult`
- Inbound text materializes to `~/.hearth/channel-inbox/<channel>/<msg-id>.md`
- Plan goes through the existing AgentAdapter → validator → pending pipeline
- Channel reply: `pending ChangePlan <id> · risk=<low|med|high> · N ops · review=...`

What this stage deliberately does NOT include:
- approve / apply via the channel (control-vs-content boundary needs its own design)
- URL fetch (deferred to v0.5)
- file / image / voice attachments
- multi-user authorization

**Done when**: simulated WeChat text via `hearth channel ingest` produces a
pending ChangePlan, vault is untouched, malformed agent output is still
rejected by the validator (channels are entry points, not new backdoors).

### v0.3.1 — owner-only command surface

- `/hearth list` / `/hearth show <id>` / `/hearth apply <id>` over WeChat
- Owner allowlist: only configured WeChat user_id may approve / apply
- Non-allowlisted senders may capture, may not commit

### v0.3.2 — mobile demo closure

- Send WeChat content → channel ingests → pending → user approves in WeChat
- Vault apply → hearth query in WeChat returns grounded claim
- This is when the channel-first differentiation is end-to-end demoable.

### Wiring on the wechat-cc side

`wechat-cc` (the existing daemon) gains a hearth import:

```
wechat onInbound (text/link)
  → ingestFromChannel({ channel: 'wechat', message_id, from, text }, { vaultRoot, agent: 'claude' })
  → reply with result.summary
```

Wechat-cc continues to live in its own repo; hearth exposes the runtime API
so wechat-cc imports rather than shells out.

---

## v0.4 — Agent Interface & Audit

The leap from "a runnable tool" to "the vault governance layer that any
agent must use". See [`docs/PRODUCT.md`](./PRODUCT.md) for the doctrine.

```
hearth mcp serve                       stdio transport
MCP tools (read):
  vault_search / read / pending_list / pending_show / lint / doctor / query
MCP tools (mutation):
  vault_plan_ingest                    returns ChangePlan, queues to pending
  vault_apply_change(id, token)        token-gated; without token returns
                                       REQUIRES_HUMAN_APPROVAL
MCP resources:
  hearth://schema (with version_hash + last_modified)
  hearth://vault-map
  hearth://pending
  hearth://lint-report
  hearth://agent-instructions          (markdown — auto-prepended to agent system prompt)
MCP prompts:
  ingest_workflow / query_with_citations / lint_fix_workflow / restructure_discussion
Approval-token protocol (HMAC, single-use, 5-min expiry, scoped to change_id)
Audit log:
  <vault>/.hearth/audit.jsonl          append-only, file-locked
  hearth log [--since N] [--vault X]   human-readable timeline
File locks on pending + audit writes
Error codes: STALE_CONTEXT / REQUIRES_HUMAN_APPROVAL / REBASE_REQUIRED / STALE_TOKEN
schema_hash_seen field on ChangePlan; validator checks
docs/INTEGRATIONS.md                   Claude Code / Cursor / Codex MCP config snippets
```

**Done when**:
- Claude Code with hearth MCP configured can run a multi-turn ingest +
  pending review + (token-gated) apply on the user's actual vault
- Audit log records every event; `hearth log` shows it human-readable
- Two MCP-aware harnesses (Claude Code + Cursor) verified end-to-end against
  the same vault without mutual interference

Explicit non-goals (deferred to v0.5+):
- No auto-rebase
- No proposal expiration impl
- No multi-vault impl
- No audit log rotation
- No full UI
- Never expose raw `vault_write` / `vault_delete` / `vault_patch_anywhere`

---

## v0.5 — Auto-policy & resource staleness

```
auto_apply policy + risk classifier (heuristic)
audit log rotation
undo / replay
fast mode / policy-bounded yolo
vault_changed_since(ts) for richer staleness queries
auto-rebase suggestion (still requires human confirmation)
```

**Done when**: a user can configure "auto-apply low-risk in Hearth Inbox,
require review for everything else" and run for a week without spending
attention on each capture.

---

## v0.6 — Views before Moves + research watch

```
07 Hearth Proposals/ staging dir
auto-generated MOC / cluster views
suggested merges
restructure proposals
proposal expiration (expires_at frontmatter)
proposal dependency drift detection

hearth watch subsystem (see docs/RESEARCH-AGENT.md):
  - watch.yaml config
  - hearth watch list / add / remove / run
  - cron-driven research agent execution
  - per-watch token budget + cap_per_run + relevance_threshold
  - vault-side dedupe via vault_search before propose
  - daily/weekly digest pushed to notify_channel
```

**Done when**: a vault that has accumulated 200 messy notes can be browsed
through agent-generated proposal views without any physical file moves; the
user can promote individual proposals into structural changes.

---

## v0.7 — Human trust surface

```
local console (web app or native, single-page)
batch review of pending plans
weekly digest
policy settings UI
lint / doctor visualization
multi-vault: per-vault policy + audit + cross-vault search w/ explicit perms
```

**Done when**: a non-programmer with an existing Obsidian vault can install
hearth via a one-click installer, point it at their vault, and use it
without ever touching the CLI.

---

## Beyond v0.7

Parked deliberately:

- Semantic search (embeddings) — only when ripgrep stops being enough; heuristic threshold ~500 wiki pages
- Public projection / static-site rendering (Quartz integration patterns)
- Cross-channel session bridging (continue a WeChat thread on Telegram tomorrow)
- Telegram, Discord, voice-app, email channel adapters
- ACP server (currently we consume MCP; ACP is the inverse where we'd be the agent surface for an editor)
- Voice memo capture pipeline (WeChat voice / Telegram voice / native voice app → ASR → vault_plan_ingest)
- Multi-format extractors (PDF / Word / Excel / PowerPoint / video / audio / image / B站 / YouTube / 公众号) — punted as long as text + URL covers the dominant case
- Hosted services: TTS, sync, managed install (these are not in the open-source core; they are services you optionally pay for)

Track and discuss in GitHub Discussions / issues. PRs welcome but read PRODUCT.md + SPEC.md first.

---

*Format coverage is easy and tempting. Trust closure is hard and the only reason to use hearth instead of the next thing.*
