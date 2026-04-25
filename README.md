# hearth

> Capture anywhere. Compile into your markdown vault. Ask with citations.

**Status**: v0.1 complete (alpha). [SPEC v0.2.1](./docs/SPEC.md) is the contract; deterministic kernel + claim-grounded query + read-only lint + Claude / mock agent adapters work end-to-end. Next: wechat-cc as the first channel adapter (v0.3).

🔗 [tendhearth.com](https://tendhearth.com) — landing

`hearth` is a personal AI runtime for your plain-markdown vault. It implements [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — sources go in, an agent compiles them into a structured wiki, queries return citation-grounded answers, periodic lint keeps the wiki clean.

## What makes hearth different

There are already a handful of "Karpathy LLM Wiki implementations". `hearth` is one — but its differentiation is in **how it makes the wiki trustworthy**:

- **Transaction-controlled writes.** The agent never writes the vault directly. It produces a `ChangePlan`; a vault kernel applies it after permission and policy checks. You can run hearth for a week and never find a wiki page you didn't approve.
- **Claim-level citations.** Every assertion in an agent-written page anchors to a specific source location — file + line, page number for PDFs, timestamp for video. "Cite the file" isn't enough; you cite the line.
- **Source-as-data.** Web pages, PDFs, chat transcripts ingested into the vault are treated as untrusted data, never as instruction. A malicious blog post cannot hijack the agent.
- **Channel-first capture.** The other half of the differentiation: capture happens where you are (your phone, in WeChat, mid-conversation, by voice) — not where you wish you were (sitting at your desk, opening Obsidian).

## Three verbs

```
Ingest   →  new source enters → agent produces a ChangePlan; pending review queue
Query    →  ask in chat / voice → answer with claim-level citations
Lint     →  periodic audit → contradictions, orphans, drift, single-source claims
```

## Five-minute demo (target shape; v0.1 is being built)

```bash
bun src/cli/index.ts init ~/demo-vault
# default agent is mock (deterministic, no API key needed)
bun src/cli/index.ts ingest examples/karpathy-llm-wiki.md --vault ~/demo-vault
# or use Claude:
ANTHROPIC_API_KEY=sk-ant-... bun src/cli/index.ts ingest examples/karpathy-llm-wiki.md --vault ~/demo-vault --agent claude

bun src/cli/index.ts pending list
bun src/cli/index.ts pending apply <change_id> --vault ~/demo-vault
bun src/cli/index.ts query "How is LLM Wiki different from RAG?" --vault ~/demo-vault
bun src/cli/index.ts lint --vault ~/demo-vault
```

Expected output:

- 1 `source-summary` page
- ~6 `concept` pages
- 1 MOC update
- 1 citation-grounded answer (every claim anchored to a source line)
- 1 lint report (likely "no issues" on a single-source vault)

## What hearth is

A runtime, not a UI. Obsidian — or Logseq, Foam, plain text — stays your editor. `hearth` is the agent that lives between your channels and your vault, always-on but never in the way.

- **Channel-agnostic** — WeChat first via [`wechat-cc`](https://github.com/ggshr9/wechat-cc); telegram and voice next
- **Agent-runtime-flexible** — currently runs on the Anthropic Claude Agent SDK; architecturally pluggable for ACP-compatible runtimes (Codex, OpenCode, future entrants)
- **Editor-agnostic** — your vault is plain markdown, no lock-in

## What hearth is NOT

- Not another note-taking app (use Obsidian / Logseq / Foam)
- Not a chatbot framework (see [OpenClaw](https://github.com/SamurAIGPT/awesome-openclaw))
- Not an OS or a database — files on disk, plain text, no lock-in
- Not a vendor-managed service (open source, self-hosted; optional hosted services may exist later)

## How it differs from neighbors

| neighbor | what they do | how hearth differs |
|---|---|---|
| [SamurAIGPT/llm-wiki-agent](https://github.com/SamurAIGPT/llm-wiki-agent) | Karpathy LLM Wiki via Claude Code | hearth adds chat/voice channels + transaction-controlled writes + claim-level citations |
| [NicholasSpisak/second-brain](https://github.com/NicholasSpisak/second-brain) | Karpathy LLM Wiki for Obsidian | same pattern, but desktop-only; hearth is multi-channel runtime |
| [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | MCP server exposing vault CRUD | hearth includes Ingest/Query/Lint pipelines + the trust mechanisms — not just CRUD tools |
| [obsidian-copilot](https://github.com/logancyang/obsidian-copilot) | in-vault AI assistant (Obsidian plugin) | hearth is a runtime, not a plugin — works without Obsidian running |
| [OpenClaw](https://github.com/SamurAIGPT/awesome-openclaw) | multi-channel bot framework | complementary; hearth focuses on vault as substrate; planning to reuse OpenClaw channel adapters |
| [memex-lab/memex](https://github.com/memex-lab/memex) | Flutter PKM with multi-agent capture | hearth is plain-md filesystem (no app), runtime not application |

## Architecture (sketch)

```
Channels (consumable, swappable)
  wechat-cc | telegram-cc | voice-app | cli | email | ...
                ↓ (InboundMsg)        ↑ (Delivery)
       ┌─────────── hearth ───────────┐
       │  Ingest  →  ChangePlan       │
       │  Query   →  Answer + claims  │
       │  Lint    →  Report           │
       │  Pending review queue        │
       │  Cross-channel memory FS     │
       │  Companion scheduler         │
       └────┬───────────────┬─────────┘
            │ Agent SDK     │ vault kernel (filesystem + SCHEMA.md perms)
            ↓               ↓
       Claude Agent     ~/vault/
       SDK (or          raw/         (sources, append-only)
       ACP-compat)      <topic>/     (agent-maintained wiki)
                        SCHEMA.md    (human-governed)
```

## Documentation

- [`docs/SPEC.md`](./docs/SPEC.md) — public contract: verbs, interfaces, scope discipline
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — version path (trust closure first, format coverage last)
- [`docs/SECURITY.md`](./docs/SECURITY.md) — threat model + the three trust pillars
- [`docs/why.md`](./docs/why.md) — pattern background + design discipline

## Status

- [x] Naming + initial repo
- [x] Landing ([tendhearth.com](https://tendhearth.com))
- [x] [SPEC v0.2.1](./docs/SPEC.md) — public contract
- [x] [ROADMAP](./docs/ROADMAP.md) — trust-closure-first sequencing
- [x] [SECURITY](./docs/SECURITY.md) — threat model + three trust pillars
- [x] v0.1 deterministic kernel: init / ingest / pending list/show/apply (mock ingest, no LLM)
- [x] v0.1.1 transaction hardening: preflight-then-write (ChangePlan applies all-or-nothing)
- [x] v0.1.2 claim verification + query (no-grounding → literal "no answer found in vault") + lint (citation-drift / single-source-stable / orphan / raw append-only)
- [x] v0.1.3 AgentAdapter + Claude integration (mock + claude both selectable via --agent; malformed plans rejected before pending)
- [ ] v0.2 pending review + diff + rebase
- [ ] v0.3 wechat-cc → hearth channel adapter
- [ ] v0.4 voice memo capture
- [ ] v0.5 multi-format extractors

## License

MIT
