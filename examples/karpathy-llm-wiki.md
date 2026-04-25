# Karpathy LLM Wiki

> "Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."
> — Andrej Karpathy

## The pattern

The LLM Wiki bypasses RAG. Instead of searching raw documents on the fly,
the LLM pre-compiles them into a structured wiki:

- `raw/` — primary sources, append-only, never modified
- `<topic>/` — agent-maintained wiki pages: concepts, source-summaries, MOCs
- `SCHEMA.md` — human-written contract telling the agent what to produce

Every new source the LLM ingests makes the whole wiki smarter. The wiki stays
maintained because the cost of maintenance is near zero for an LLM.

## Why bypass RAG

RAG re-derives answers from raw documents on every query. The LLM Wiki pattern
amortizes that work: the LLM compiles raw → structured wiki once, and queries
hit the structured wiki directly. The wiki accumulates value over time;
RAG indexes do not.
