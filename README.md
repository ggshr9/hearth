# hearth

> The agent-native vault governance layer.
> Any AI can participate in maintaining your markdown vault — but must respect permission, citation, review, and audit rules.

**Status**: v0.4 complete (alpha). [PRODUCT.md](./docs/PRODUCT.md) is the doctrine; [SPEC v0.4](./docs/SPEC.md) is the contract. v0.1 deterministic kernel + v0.3 channel runtime + adopt + v0.4 MCP server (agent instruction pack, token-gated apply, audit log) all shipped. See [INTEGRATIONS.md](./docs/INTEGRATIONS.md) to mount hearth in Claude Code / Cursor / Codex / Continue.dev. Next: v0.2 pending diff + v0.5 auto-policy.

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

## Two-minute setup

```bash
git clone https://github.com/ggshr9/hearth.git ~/Documents/hearth
cd ~/Documents/hearth && bun install

# One command. Detects your Obsidian vault, runs adopt with preview,
# verifies with doctor, optionally writes a Claude Code MCP config.
bun src/cli/index.ts setup
```

After setup, capture from anywhere:

```bash
hearth channel ingest --channel cli --message-id m1 --from you \
  --text "your first thought" --vault /path/to/vault
hearth pending list
hearth pending apply <change_id> --vault /path/to/vault
hearth query "first thought" --vault /path/to/vault
hearth log --vault /path/to/vault --since 1d
```

Or, with Claude Code mounted via MCP (setup wizard offers to wire this for you):

> "Read hearth://agent-instructions then hearth://schema, then propose a
> ChangePlan for this content: ..."

Claude Code uses the hearth tools directly; every mutation still goes through
ChangePlan + token gate + audit log.

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

- [`docs/PRODUCT.md`](./docs/PRODUCT.md) — **product compass** (positioning, principles, what hearth is and isn't)
- [`docs/SPEC.md`](./docs/SPEC.md) — public contract: verbs, interfaces, scope discipline
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — version path (trust closure first, format coverage last)
- [`docs/SECURITY.md`](./docs/SECURITY.md) — threat model + the three trust pillars
- [`docs/why.md`](./docs/why.md) — pattern background + design discipline
- [`docs/INTEGRATIONS.md`](./docs/INTEGRATIONS.md) — copy-paste MCP config for Claude Code / Cursor / Codex / Continue.dev
- [`docs/RESEARCH-AGENT.md`](./docs/RESEARCH-AGENT.md) — design note for proactive long-running research agents (Path 1 today, `hearth watch` later)

## Status

- [x] Naming + initial repo
- [x] Landing ([tendhearth.com](https://tendhearth.com))
- [x] **Foundations** — naming, landing ([tendhearth.com](https://tendhearth.com)), [PRODUCT](./docs/PRODUCT.md) / [SPEC](./docs/SPEC.md) / [ROADMAP](./docs/ROADMAP.md) / [SECURITY](./docs/SECURITY.md)
- [x] **v0.1 — deterministic kernel** (init, ChangePlan transactions, claim-grounded query, lint, AgentAdapter w/ mock + Claude)
- [x] **v0.3.0 — channel adapter spike** + adopt + doctor (`hearth setup` wizard one-command onboarding)
- [x] **v0.4 — Agent Interface & Audit** (MCP server, agent instruction pack, token-gated apply, audit log, `hearth log`, [INTEGRATIONS](./docs/INTEGRATIONS.md) guide)
- [ ] **v0.2 — pending review + diff + rebase**
- [ ] **v0.3.1 / v0.3.2 — owner-only `/hearth` over WeChat + end-to-end mobile demo**
- [ ] **v0.5 — auto-policy + risk classifier + audit rotation**
- [ ] **v0.6 — Views before Moves + `hearth watch`** (see [RESEARCH-AGENT.md](./docs/RESEARCH-AGENT.md))
- [ ] **v0.7 — human trust surface** (local console + multi-vault)
- [ ] **Beyond v0.7** — voice capture, multi-format extractors, semantic search (see [ROADMAP](./docs/ROADMAP.md#beyond-v07))

## License

MIT
