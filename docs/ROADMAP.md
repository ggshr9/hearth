# hearth ROADMAP

Versions are sequenced for **trust closure first, format coverage last**. The order is deliberate: every version after v0.1 must be reachable on top of a vault that can be trusted not to rot.

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

## v0.4 — voice memo capture

The highest-leverage mobile capture path. Most knowledge that gets lost is the kind that starts as "I had this thought walking home".

- Voice in (WeChat voice / Telegram voice / native voice app)
- ASR pipeline (Whisper / Qwen ASR / VoxCPM2 — provider-pluggable)
- Transcript becomes a `vault_plan_ingest` source
- Optional: agent proposes which existing concept page this thought relates to

**Done when**: dictating a 30-second thought on the way home produces a reviewable wiki addition by the time you sit down.

---

## v0.5 — multi-format extractors

Now we earn the right to ingest the messy real world.

- PDF: pdftotext + vision-LLM fallback, with `claims:` carrying `page:N`
- Word: pandoc → markdown
- Excel/CSV: small full / large schema+sample
- PowerPoint: per-slide text + image OCR
- Video: ffmpeg + ASR, `claims:` with `timestamp:`
- Image: OCR + vision description
- Site adapters: B站, YouTube, 公众号 (and others as community contributes)

**Done when**: the eight formats above all flow through the same `vault_plan_ingest` → `ChangePlan` → review → apply pipeline as text and URL.

---

## Beyond v0.5

Parked deliberately:

- Semantic search (embeddings) — only when ripgrep stops being enough; heuristic threshold ~500 wiki pages
- Multi-vault support
- Public projection / static-site rendering (Quartz integration patterns)
- Cross-channel session bridging (continue a WeChat thread on Telegram tomorrow)
- Telegram, Discord, voice-app, CLI, email channel adapters
- Hosted services: TTS, ACP runtime, sync, managed install (these are not in the open-source core; they are services you optionally pay for)

Track and discuss in GitHub Discussions / issues. PRs welcome but read SPEC.md first.

---

*Format coverage is easy and tempting. Trust closure is hard and the only reason to use hearth instead of the next thing.*
