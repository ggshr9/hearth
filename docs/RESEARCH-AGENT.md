# Hearth + Research Agent — Design Note

How a user gets "have an LLM continuously search and organize content about
topic X into my vault" without breaking hearth's governance properties.

This is a design note, **not** an implementation plan. The actual `hearth watch`
subsystem (Path 2 below) is a v0.6 / v0.7 candidate; until then, users
self-assemble via Path 1.

---

## What hearth is and is not in this picture

Hearth is a **vault governance layer**. It does not crawl the web, schedule
jobs, dedupe articles, or rate relevance. Those are **agent** concerns.

The temptation to fold "research agent" into hearth's core is the same
temptation as folding "agent harness" into hearth's core (see
[PRODUCT.md](./PRODUCT.md)) — and the answer is the same:

> Hearth provides the governed surface. Agents (Claude Code, Cursor,
> custom scripts, future products) provide the intelligence.

Hearth's only role here is: when a research agent has found something it
considers worth keeping, it goes through `vault_plan_ingest` like any other
ingest. Same pending queue, same kernel, same audit trail.

---

## Four orthogonal layers

```
[scheduler]            cron / launchd / systemd timer / wechat-cc companion
       ↓ (periodic trigger)
[research agent]       Claude Code / Cursor / custom script + web search tool
       ↓ (zero or more findings)
[hearth governance]    vault_plan_ingest → pending queue
       ↓ (batched human review)
[notification]         wechat push / email digest / Local Console badge
       ↓
       user approves the ones worth keeping
```

Each layer is independent. Swap any one without changing the others. This is
the same composability hearth has at runtime — extended to long-running work.

---

## Critical principle: research agents NEVER auto-apply

This is non-negotiable.

A research agent that finds 5 articles a day, multiplied by 10 topics,
multiplied by 30 days = 1,500 wiki pages a month. If they auto-apply, the
vault becomes noise within weeks. Karpathy's compounding-wiki promise turns
into compounding slop.

The defense:
- Agent **proposes** via `vault_plan_ingest`
- Findings go to **pending queue**
- User **batch-reviews** (daily / weekly digest)
- Only approved findings land in the vault

This is exactly hearth's existing governance — applied to a higher-volume
workload. No new mechanism needed.

---

## Two paths to implementation

### Path 1 — Ad-hoc, zero new hearth code (start here)

Use existing infrastructure. Recommended for the first weeks of any new
research workflow, because you'll learn what the prompt should be only by
running it.

**Step 1**: Create a watch list as a vault file.

```markdown
<!-- 05 Recipes/watch-list.md -->
# Things to watch

## karpathy-llm-wiki
substantive new content about Karpathy's LLM Wiki pattern, personal AI
knowledge bases, agent-native vault tools. skip generic "AI second brain"
hype. relevance threshold: high.

## anthropic-releases
new model releases, Claude Code updates, MCP spec changes. relevance:
high. cadence: weekly.
```

**Step 2**: Write a research-agent prompt at `~/.hearth/research-prompt.md`:

```markdown
You are a research agent for hearth. Your job is to find new content matching
the topics in <vault>/05 Recipes/watch-list.md and propose ingest plans.

For each topic in the watch list:
1. Use vault_search to dedupe — skip topics already covered.
2. Search the web (use your built-in web tool) for content published since
   the last run. Cap at 5 findings per topic.
3. For each finding, rate relevance 1-5. Discard anything below 4.
4. For each kept finding, call vault_plan_ingest with:
   - source_text: a markdown summary including title, URL, source type,
     publication date, your 50-word relevance reason, and a verbatim quote
     from the source.
   - origin: "watch:<topic>"
5. After all topics processed, output a one-line digest:
   "today: N findings on [topic1: X, topic2: Y, ...]"

DO NOT call vault_apply_change. The user reviews pending and applies.

Hard rules:
- Every finding MUST include a verbatim quote from the source. If you can't
  produce one, drop the finding.
- Never propose ingest into a dir other than 06 Hearth Inbox/research/<topic>/.
- Stop after 25 total findings across all topics, regardless of cadence.
```

**Step 3**: Schedule it via cron (or launchd / systemd timer):

```cron
0 9 * * * cd /home/<user>/Documents/hearth && claude -p "$(cat ~/.hearth/research-prompt.md)" --mcp-config ~/.config/claude-code/mcp.json
```

**Step 4**: Each morning, review pending:

```bash
hearth pending list
hearth pending show <id>
hearth pending apply <id> --vault /path/to/vault
```

This works **today** with hearth v0.4. Zero new code. The price is per-user
manual setup.

### Path 2 — `hearth watch` subsystem (v0.6 / v0.7 candidate)

Once Path 1 has run for weeks and the right defaults are clear, productize:

```yaml
# <vault>/.hearth/watch.yaml
topics:
  - name: karpathy-llm-wiki
    query_template: |
      Find up to 5 substantive new items about Karpathy's LLM Wiki, personal
      AI knowledge bases, or agent-native vault tools, published since
      {since}. Skip generic AI hype. For each: title, URL, source type,
      50-word relevance reason, verbatim quote. Then call vault_plan_ingest
      for each.
    cadence: "daily 09:00"
    cap_per_run: 5
    relevance_threshold: 4   # 1-5
    inbox_dir: "06 Hearth Inbox/research/karpathy-llm-wiki"
    notify_channel: "wechat:o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat"

  - name: anthropic-releases
    query_template: ...
    cadence: "weekly Mon 10:00"
```

CLI:

```
hearth watch list                    # current watches + last-run / next-run / pending count
hearth watch add                     # interactive
hearth watch remove <name>
hearth watch run [--name X]          # one-shot; called by cron / launchd
hearth watch run --all
```

Each `watch run`:
1. Loads `watch.yaml`, picks topics due (or all if `--all`).
2. Renders `query_template`, substituting `{since}` = `last_run_at`.
3. Spawns a Claude subprocess (or any configured agent runtime) with
   web-search tool + hearth MCP mounted.
4. Captures resulting pending ChangePlan IDs.
5. Updates `last_run_at` in `watch.yaml`.
6. Writes `watch.ran` event to audit log with: topic, findings, tokens used.
7. Sends digest to `notify_channel`:
   > "today's research finds: 3 new on karpathy-llm-wiki, 1 on
   > anthropic-releases. /hearth pending list to review."

Implementation cost: ~300 lines (config parser, cron-spec parser, Claude
subprocess driver, digest dispatcher). Tests for: dedup against vault, cap
enforcement, malformed config rejection, audit completeness.

---

## Failure modes to design against

These will bite if not designed for. Mitigations are required, not optional.

| Failure | What happens | Mitigation |
|---|---|---|
| **Slop accumulation** | Agent finds 100 mediocre articles a week, vault becomes noise | `cap_per_run` (hard limit), `relevance_threshold` ≥ 4, vault-side dedupe via `vault_search` before proposing |
| **Topic drift** | "Agent harnesses" search returns generic AI content over time | Periodic prompt review; user thumbs-down on accepted-then-regretted findings; weekly metric: approve-rate per topic |
| **Echo chamber** | Same source keeps surfacing | Track domain frequency; agent caps any one domain at e.g. 30% of findings per week |
| **Cost runaway** | Web search + LLM tokens add up to surprise bill | Per-watch token budget (default 50K tokens/run); hard cap on tool calls per run; daily cost tally in audit log |
| **Hallucinated finds** | Agent invents content when real search yields nothing | Mandatory verbatim quote + URL per finding; lint check that the quote is fetchable from the URL |
| **Stale topic** | User added a watch 6 months ago, no longer cares | `hearth watch list` shows last 5 approve-rate; topics with <20% approve-rate flagged for review |
| **Missed cadence** | Cron didn't fire (laptop sleeping, daemon crashed) | Compare `last_run_at` to `now`; if missed, run once on next opportunity rather than skipping; surface in `hearth doctor` |

---

## How `vault_search` dedupe works in practice

The agent's first action for any topic should be a `vault_search` for the
topic name + keywords. If existing claims already cover the candidate
content, drop it.

Example flow inside the agent:

```
Topic: "karpathy-llm-wiki"
1. vault_search("karpathy LLM wiki")
   → 12 existing verified claims about Karpathy LLM Wiki pattern
2. Web search returns 5 candidates.
3. For each candidate, agent compares title + summary against existing
   claims. If the candidate is "yet another article restating Karpathy's
   gist", skip — already covered.
4. Only genuinely new angles propose ingest.
```

This is the most important step. Without it, the wiki accumulates 20 source-
summaries all saying the same thing.

---

## Why hearth doesn't ship a built-in web search

`vault_plan_ingest` already accepts `source_text`. The agent fetches and
summarizes; hearth just receives. This keeps hearth small and lets the
agent use whatever search backend it prefers (Claude's built-in tool, Brave
Search MCP, Tavily, custom scraper).

If hearth shipped its own web fetcher, we'd inherit anti-bot maintenance,
HTML extraction quality issues, prompt-injection risk from page contents,
canonical URL handling, caching — none of it core to governance.

---

## Recommended starting workflow (concrete)

Pick ONE topic. Run Path 1 for two weeks. Write down what you noticed:
- What was the approve rate?
- What kinds of findings were noise?
- What the cron schedule actually felt like (too often / too rare)?
- Where did the prompt get edited?

After two weeks of real signal, decide whether Path 2 (`hearth watch`)
is worth building, and what its defaults should be.

Pre-emptively building `hearth watch` without two weeks of Path 1 = building
the wrong thing confidently.

---

## What this design **does NOT** do

- It does not auto-apply findings (vault stays clean)
- It does not crawl the web (agent's job)
- It does not maintain a separate index of "things I've seen" (vault IS the index — `vault_search` is the dedupe primitive)
- It does not push to user without their consent (notify_channel is opt-in)
- It does not run agents indefinitely (per-run caps + budgets)
- It does not bypass any of hearth's existing trust mechanisms

It does **one** thing: gives a research agent a place to put its findings
under the same governance as everything else.

---

## Status

Path 1: doable today against hearth v0.4. Examples in this doc are
copy-pasteable.

Path 2: roadmap candidate (v0.6 or v0.7). Will not ship until at least
one Path 1 deployment has produced ≥ 3 weeks of real signal informing the
defaults.
