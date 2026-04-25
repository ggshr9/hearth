# hearth ROADMAP

Versions are sequenced for **trust closure first, format coverage last**. The order is deliberate: every version after v0.1 must be reachable on top of a vault that can be trusted not to rot.

---

## v0.1 — local CLI core loop (text + URL)

The minimum that proves "raw → wiki → query → lint" is a real loop, not a demo.

```
hearth init <vault>           # init / scan / write _hearth.json
hearth ingest <md|txt|url>    # produces a ChangePlan in ~/.hearth/pending/
hearth pending list           # see queued plans
hearth pending apply <id>     # commit (after review)
hearth query "<question>"     # answer w/ claim-level citations
hearth lint                   # read-only audit
hearth doctor                 # config + schema + perms diagnostic
```

Ingest format support: `.md`, `.txt`, URL (generic Readability extraction). That's it.

**Done when**: a fresh vault + a real source can be ingested, queried, and linted — with zero `agent:wiki` writes landing without explicit `pending apply`.

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

## v0.3 — WeChat channel adapter

The first non-CLI channel. The differentiator: capture happens where you are (your phone), not where you wish you were (at your desk).

- WeChat ilink-bot integration (rewires `wechat-cc` to depend on `hearth`)
- Inbound text / link / image / file routes through `hearth ingest`
- All wiki writes still gated by `_pending/`
- WeChat receives back `hearth query` answers

**Done when**: you can forward a B站 link in WeChat, get a `ChangePlan` summary back, approve, and the wiki has a new source-summary page.

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
