# Why hearth

> This page is the *background* — pattern roots, what's missing in existing
> implementations, and the discipline hearth holds itself to. For the
> *current product doctrine* (positioning, principles, what hearth is and
> isn't, the four action types, View-before-Move), read
> [`PRODUCT.md`](./PRODUCT.md) first.

> "Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase." — Karpathy's [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## The pattern

Karpathy's LLM Wiki bypasses RAG. Instead of searching raw documents on the fly, the LLM **pre-compiles** them into a structured wiki:

- `raw/` — primary sources, append-only, never modified
- `<topic>/` — agent-maintained wiki pages (concepts, source-summaries, MOCs, walkthroughs)
- `SCHEMA.md` — human-written contract telling the agent what to produce

Every new source the LLM ingests makes the whole wiki smarter. The wiki stays maintained because the cost of maintenance is near zero for an LLM.

## What's missing in existing implementations

Most existing Karpathy-pattern projects assume you sit at your desk in front of Obsidian to interact with the agent. They miss two things:

1. **Capture friction is the bottleneck.** People don't write to their KB during the day; they write at the end. By then they've forgotten. We need always-on capture from chat / voice / link sharing — wherever you actually are.
2. **The agent is reactive only.** The wiki should be tended continuously, not just when you remember to invoke it. Periodic Lint, weekly digests, drift alerts.

`hearth` is the runtime that fills these gaps:

- **Channel adapters** push every chat message, voice memo, shared link, file, photo into the vault under SCHEMA.md's rules
- **Companion scheduler** runs Lint + digest cycles in the background
- **Cross-channel memory** so a conversation that started on WeChat can continue on Telegram tomorrow

## What hearth deliberately does NOT do

- Replace your editor. Obsidian / Logseq / Foam / Anytype / plain text — pick whatever; hearth doesn't care.
- Replace your sync. Use Obsidian Sync, Syncthing, git, Dropbox — hearth doesn't sync; it just reads/writes files where you tell it.
- Try to be smart about your taxonomy. SCHEMA.md is YOUR contract. hearth follows it strictly. No "AI knows best."
- Pre-organize your vault. Capture goes to designated landing zones per your SCHEMA.md. Reorganization happens only on explicit ask, never autonomous.

## Trust gradient

Every piece of content in the vault has a provenance. hearth marks LLM-generated content distinctly from human-written content. You always know who wrote what, and every claim in agent-written pages cites a source path.

## Discipline > eagerness

The failure mode of "AI second brain" tools is slop generation: the agent eagerly compiles, generates noise, the vault rots. hearth defaults to lazy compile (only on explicit trigger or accumulated threshold), proposes-not-commits for risky operations, and mandates citations in all generated content. Better to under-organize than to over-slop.
