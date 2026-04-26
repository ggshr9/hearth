# Integrating hearth with your agent runtime

`hearth` exposes a [Model Context Protocol](https://modelcontextprotocol.io/)
server. Any MCP-aware harness can mount it to operate on your vault under the
trust mechanisms documented in [`PRODUCT.md`](./PRODUCT.md).

This document is copy-paste-ready snippets for the major harnesses.

---

## Prerequisites

1. Clone hearth somewhere on your machine:
   ```bash
   git clone https://github.com/ggshr9/hearth.git ~/Documents/hearth
   cd ~/Documents/hearth && bun install
   ```
2. Adopt your vault (one-time setup; SAFE — only appends to SCHEMA.md and creates a Hearth Inbox dir):
   ```bash
   bun src/cli/index.ts adopt /path/to/your/vault --dry-run   # preview first
   bun src/cli/index.ts adopt /path/to/your/vault --yes
   bun src/cli/index.ts doctor --vault /path/to/your/vault    # verify hearth-ready
   ```

The MCP server uses stdio transport. The `command` is `bun` (or `node` if you
build first) running `src/cli/index.ts mcp serve`. Vault path comes from the
`HEARTH_VAULT` env var.

---

## Claude Code

Add to `~/.config/claude-code/mcp.json` (Linux/macOS) or `%APPDATA%\\claude-code\\mcp.json` (Windows):

```jsonc
{
  "servers": {
    "hearth": {
      "command": "bun",
      "args": ["/home/<user>/Documents/hearth/src/cli/index.ts", "mcp", "serve"],
      "env": {
        "HEARTH_VAULT": "/path/to/your/vault"
      }
    }
  }
}
```

Or via `/mcp add` interactively in Claude Code. After restart, Claude Code
sees hearth's tools (`vault_search`, `vault_read`, `vault_query`,
`vault_plan_ingest`, ...) and the `hearth://agent-instructions` resource.

**First thing to do**: ask Claude Code to read `hearth://agent-instructions`.
That primes it with the rules of engagement (never write directly, claims
must be grounded, etc.). You can also paste the resource into a project
`CLAUDE.md` so every session starts with it loaded.

---

## Cursor

Cursor reads MCP config from `~/.cursor/mcp.json`:

```jsonc
{
  "mcpServers": {
    "hearth": {
      "command": "bun",
      "args": ["/home/<user>/Documents/hearth/src/cli/index.ts", "mcp", "serve"],
      "env": {
        "HEARTH_VAULT": "/path/to/your/vault"
      }
    }
  }
}
```

Restart Cursor. The hearth tools appear under the MCP indicator.

---

## Codex CLI

Codex's MCP config lives at `~/.codex/config.toml`:

```toml
[mcp_servers.hearth]
command = "bun"
args = ["/home/<user>/Documents/hearth/src/cli/index.ts", "mcp", "serve"]

[mcp_servers.hearth.env]
HEARTH_VAULT = "/path/to/your/vault"
```

---

## Continue.dev

In `~/.continue/config.json`:

```jsonc
{
  "experimental": {
    "modelContextProtocolServer": {
      "transport": {
        "type": "stdio",
        "command": "bun",
        "args": ["/home/<user>/Documents/hearth/src/cli/index.ts", "mcp", "serve"],
        "env": {
          "HEARTH_VAULT": "/path/to/your/vault"
        }
      }
    }
  }
}
```

---

## Custom client (any MCP-aware harness)

The transport is stdio. Run `bun src/cli/index.ts mcp serve` and pipe JSON-RPC
2.0 messages over stdin / stdout. See [MCP spec](https://modelcontextprotocol.io/spec)
for the wire protocol.

---

## How `vault_apply_change` works (read this once)

`vault_apply_change` is the only MCP tool that mutates the vault. It is
**token-gated**:

- Without a token, it returns `REQUIRES_HUMAN_APPROVAL` and includes a CLI
  hint the agent should surface to you.
- With a valid token (HMAC-signed, single-use, 5-min expiry, scoped to one
  `change_id`), it goes through the kernel.

To apply a pending plan, the user has two paths:

**A. Apply directly via CLI (no token dance)**
```bash
hearth pending apply <change_id> --vault /path/to/vault
```
Direct human action — no token needed, the shell session itself is the
authentication.

**B. Issue a token to your agent**
(Token-issuance CLI lands in v0.5; for v0.4, use option A.)

This is intentional: agents cannot silently apply, ever.

---

## Audit log

Every MCP tool call (and every CLI mutation) lands in
`<vault>/.hearth/audit.jsonl`. Inspect:

```bash
hearth log --vault /path/to/vault --since 24h --limit 50
```

If you don't see hearth's activity here, something is wrong — file an issue.

---

## Recommended first-session ritual

Once the MCP server is mounted, kick off a session like:

> Read `hearth://agent-instructions` first. Then read `hearth://schema` so
> you know my permission table. Don't write to my vault directly; use
> `vault_plan_ingest` for any new content, surface ChangePlans to me before
> I apply them. If you can't ground an answer in `vault_query` results, say
> "no answer found in vault".

This primes the agent with hearth's rules and avoids 30 minutes of confusion.

---

## Troubleshooting

| symptom | likely cause |
|---|---|
| "no SCHEMA.md" | Run `hearth adopt <vault>` first |
| `STALE_CONTEXT` keeps firing | Agent isn't refreshing `hearth://schema` after edits; re-prompt it to re-read |
| `REQUIRES_HUMAN_APPROVAL` loops | Agent is trying to apply via MCP; tell it to surface the CLI command instead |
| `REBASE_REQUIRED` on apply | Target file changed since plan was made; agent must regenerate the op |
| Empty `hearth log` | No mutations yet, or you're querying the wrong vault |

---

## What hearth is not

It's not a remote service — it runs entirely on your machine. It does not
phone home. It does not transmit your vault content to anyone. The Anthropic
SDK only fires if you explicitly use `--agent claude` for ingest; the MCP
server itself never calls out.
