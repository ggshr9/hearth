# hearth

> Tend your second brain. Karpathy LLM Wiki runtime — chat-first, vault-native, agent-agnostic.

**Status: pre-alpha, designing in public. SPEC.md coming.**

🔗 [tendhearth.com](https://tendhearth.com) — landing

`hearth` is a personal AI runtime that sits between your channels (chat, voice) and your plain-markdown vault. It implements [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): you drop sources into `raw/`, the agent compiles them into a structured wiki, you query and live in the result.

## What hearth does

Three verbs (borrowed from the schema you write yourself):

- **Ingest** — new source enters the vault → agent reads it, summarizes, extracts concepts, links them, updates the topic MOC
- **Query** — you ask a question → agent answers with citations from the wiki, writes new insights back so they don't get lost in chat
- **Lint** — periodic audit of contradictions, orphan pages, single-source claims, missing cross-references

## What hearth is

- A **runtime**, not a UI. Obsidian (or Logseq, or Foam, or any plain-md editor) stays your editor.
- A **glue layer** between channels (today: WeChat via [wechat-cc](https://github.com/ggshr9/wechat-cc); coming: telegram, voice, cli) and ACP-compatible agents (Claude Code, Codex, etc.)
- **Channel-agnostic, agent-agnostic, editor-agnostic** — the only thing it cares about is your `vault/` of plain markdown plus your `SCHEMA.md`

## What hearth is NOT

- Not another PKM tool (use Obsidian/Logseq for that)
- Not a chatbot framework (see OpenClaw)
- Not an OS or a database — files on disk, plain text, no lock-in
- Not a vendor-managed service (open source, self-hosted; optional hosted services may exist later)

## How it differs from neighbors

| neighbor | what they do | how hearth differs |
|---|---|---|
| [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) | in-vault AI assistant (Obsidian plugin) | runtime, not a plugin — works without Obsidian running |
| [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | MCP server exposing vault | hearth includes ingest/query/lint pipelines, not just CRUD tools |
| [SamurAIGPT/llm-wiki-agent](https://github.com/SamurAIGPT/llm-wiki-agent) | Karpathy LLM Wiki via Claude Code | hearth adds chat/voice channels + ACP-flexible runtime + cross-channel memory |
| [OpenClaw](https://github.com/SamurAIGPT/awesome-openclaw) | multi-channel bot framework | hearth focuses on vault-as-substrate; planning to reuse OpenClaw channel adapters where they fit |
| [memex-lab/memex](https://github.com/memex-lab/memex) | Flutter PKM with multi-agent capture | hearth is plain-md filesystem (no app), runtime not application |

## Architecture (sketch)

```
Channels (consumable, swappable)
  wechat | telegram | voice | cli | email | ...
                ↓ (InboundMsg)        ↑ (Delivery)
       ┌─────────── hearth ───────────┐
       │  - Ingest pipeline           │
       │  - Query (with citations)    │
       │  - Lint (periodic audit)     │
       │  - Cross-channel memory FS   │
       │  - Companion scheduler       │
       └────┬───────────────┬─────────┘
            │ ACP           │ filesystem (per SCHEMA.md)
            ↓               ↓
       Agent runtime   ~/vault/
       (Claude Code,    raw/  (sources, append-only)
        Codex, ...)     <topic dirs>/  (agent-maintained wiki)
                        SCHEMA.md  (human-governed)
```

## Status

- [x] Naming + initial repo
- [ ] SPEC.md — public contract (verbs + interfaces + scope discipline)
- [ ] First reference channel adapter (wechat-cc → hearth)
- [ ] Ingest pipeline v0 (markdown + URL)
- [ ] Query v0 (with citation enforcement)
- [ ] Lint v0
- [ ] Multi-format extractors (PDF / Word / Excel / video)

## License

MIT
