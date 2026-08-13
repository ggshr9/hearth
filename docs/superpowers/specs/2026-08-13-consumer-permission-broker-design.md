# Memory-infra Phase 3 — hearth as consumer permission broker — Design

**Date**: 2026-08-13
**Status**: Design draft (brainstorm 2026-08-13); user review next.
**Repo**: `ggshr9/hearth` only (no wechat-cc changes). North star + phasing: memory note `hearth-memory-infra`; supersedes the "Phase 3 = permission broker" non-goal in the Phase 1 (`2026-08-13-hearth-ingest-phase1-design`) and Phase 2a specs.

## The direction (context)

hearth is becoming the front door to the owner's knowledge: many apps (Claude Code, Cursor, codex, a future GPT/cloud agent) will query it, and it federates to registered provinces (`wechat-cc` today) that hold raw data in place. Phases 1 (Ingest) and 2a (Federate) are merged: hearth's `vault_query` can, opt-in, fan out to sources in `~/.hearth/sources.json` and merge federated hits (verified-by-source) with vault-verified hits — **but any local caller of `hearth mcp serve` reaches every registered source.** That is the Phase 2a "local-trust" limitation, stated explicitly in its spec. Phase 3 closes it.

**This is the keystone of "memory as infrastructure other apps query *with permission*":** without per-consumer authorization, hearth can only be trusted with sources the owner is willing to expose to *every* connected app at once. With it, the owner grants a specific app read of a specific set of sources — and can audit what each app actually asked.

## Goal

Make hearth a **permission broker**: each consuming app authenticates as a named **consumer** and receives a **per-consumer × per-source grant** (may it read the vault? which federated sources may it reach?). hearth enforces the grant in its query path and records every query in an audit log. Unauthenticated/invalid consumers **fail closed** (deny). The owner's own direct tools remain full-access (backward-compatible).

## Why enforcement must live in hearth

When consumer C queries hearth and hearth federates to `wechat-cc`, wechat-cc sees hearth's MCP client — **not** the ultimate consumer C. So wechat-cc cannot make the per-consumer decision; only hearth can. hearth is the single choke point that knows both "who is asking" (the authenticated consumer) and "what sources exist" (the registry). Therefore the entire broker lives in hearth; wechat-cc is unchanged (its `federated_query` stays admin-gated on its own side, which is the *owner-to-wechat* trust boundary — orthogonal to the *consumer-to-hearth* boundary Phase 3 adds).

## Why this exact shape (grounded in hearth's real contracts)

Read from hearth `95b3d86` (main, Phase 1+2a merged):
- **`hearth mcp serve` is stdio, spawned per client** (`cli/index.ts:365` → `startStdioServer(vault)`). MCP has no built-in caller identity — but because each consumer spawns *its own* server process, **consumer identity can be fixed at spawn time** (a launch arg/env), then held in `ServerContext` for the process's life. No per-request identity plumbing needed.
- **hearth already has a per-installation HMAC secret** at `~/.hearth/secret.key` (chmod 600, lazily generated — `core/token-crypto.ts:17,23`) and an HMAC token format (`token = b64url(payload) + "." + b64url(HMAC-SHA256(secret, payload))`). Phase 3 reuses this exact secret + primitive to make **consumer tokens verifiable** — no new crypto.
- **hearth already has an append-only audit log** (`core/audit.ts` — `auditSync(vaultRoot, entry)`, typed `AuditEvent`). Phase 3 adds a query-audit event; no new logging subsystem.
- **Phase 2a's `federatedQuery`** (`core/query.ts`) already has injectable seams (`queryFn`, `sourceQueryFn`) and already loads sources from `loadSources(stateDir)`. Phase 3 filters the source list *before* fan-out and gates the local-vault leg — a surgical change at one function, not a rewrite.

Decision recap (from brainstorm): identity mechanism **(b) id + per-consumer token** (verifiable, reuse HMAC), not id-only; **fail-closed** for invalid/unknown consumers; **owner-full when no `--consumer` is passed** (backward-compat); Phase 3 governs the **consume/query side only** (ingest stays owner-channel-trust, Phase 1).

## Scope (hearth only)

### A. Consumer registry + token (`core/consumer-registry.ts`, new)

State file `~/.hearth/consumers.json` (0600), shape:
```jsonc
{
  "version": 1,
  "consumers": [
    { "id": "codex", "token_hash": "sha256:<hex>", "vault": "r", "sources": ["wechat-cc"] },
    { "id": "some-app", "token_hash": "sha256:<hex>", "vault": "none", "sources": "*" }
  ]
}
```
- `id`: opaque consumer name (the label the owner grants against).
- `token_hash`: `"sha256:" + hex(sha256(token))` — hearth stores the **hash**, never the plaintext token. (Distinct from the HMAC *signature* secret; the token is a bearer secret the consumer presents, hearth compares its sha256 to the stored hash with a constant-time compare.)
- `vault`: `"r"` (may read the local vault) | `"none"` (federated sources only).
- `sources`: `"*"` (all registered) | `string[]` (allowlist of `FederatedSource.id`s). An id not in the registry's sources is simply never matched (no error).

Functions (all throw-proof / typed results, matching hearth's style):
- `loadConsumers(stateDir?): ConsumerRegistry` — reads/parses; missing file → `{ version:1, consumers:[] }`; malformed → same empty (fail-closed: no grants).
- `resolveConsumer(reg, id, token): ResolvedConsumer | { denied: reason }` — finds by `id`, constant-time-compares `sha256(token)` to `token_hash`; returns the grant or a `denied` reason (`unknown_id` | `bad_token`).
- `addConsumer(stateDir, { id, sources, vault }): { token: string }` — generates a random token (`randomBytes(24)` → base64url), writes `{ id, token_hash: sha256(token), vault, sources }` (upsert by id), returns the **plaintext token once** (caller prints it; hearth never stores/reprints it).
- `listConsumers(stateDir): Array<{ id, vault, sources }>` — never returns hashes/tokens.

### B. Consumer identity at spawn (`mcp-server.ts` + `cli/index.ts`)

- `ServerContext` gains `consumer?: ResolvedConsumer | null` (null = owner-full; a `denied` marker = fail-closed).
- `hearth mcp serve` gains `--consumer <id>` and `--consumer-token <token>` (also honored via env `HEARTH_CONSUMER_ID` / `HEARTH_CONSUMER_TOKEN` so MCP client configs can pass them without exposing the token in `ps`/argv — **env is the recommended path; document it**).
- At startup: if neither id nor token is present → `consumer = null` (owner-full, backward-compatible; existing setups and the owner's own Claude Code keep working unchanged). If an id is present → `resolveConsumer(...)`; on success store the grant; on `denied` store the denied marker (do **not** exit — the server runs but every gated tool returns a permission-denied result, so the failure is observable to the consumer, and no silent full-access fallback can occur). If an id is present but no token (or vice-versa) → treated as `denied: bad_token` (both required together).

### C. Enforcement in the query path (`core/query.ts` `federatedQuery` + `mcp-server.ts` `vault_query`)

`federatedQuery` gains an optional `consumer?: ResolvedConsumer | null` param (default `null` = owner-full — pure-local callers and existing tests are byte-identical):
- **Denied consumer** (marker passed through from `vault_query`): return a permission-denied result — `{ answer: "permission denied: <reason>", hits: [], denied: true }` — **without touching the vault or any source** (fail-closed; a denied consumer learns nothing, not even vault contents).
- **`vault: "none"`**: skip the local-vault `queryFn` leg entirely; only federated (granted) sources contribute. (The consumer was granted federation but not raw vault read.)
- **Source filtering**: before fan-out, filter `loadSources(...)` to those whose `id` is in the consumer's `sources` (`"*"` = all). Un-granted sources are **never queried** — hearth never even opens a connection to them for this consumer, so an un-granted province learns nothing about the consumer's questions either.
- Owner-full (`consumer == null`): unchanged Phase 2a behavior (vault + all sources when `federate` on).

`vault_query` in `mcp-server.ts` reads `ctx.consumer` and passes it into `federatedQuery`. The `federate` flag still gates whether fan-out happens *at all* (default off = pure-local); Phase 3 additionally scopes *which* sources when it is on, and gates the vault leg per `vault` grant. **A denied consumer is refused even for a pure-local (`federate:false`) `vault_query`** — deny is absolute, not just a federation filter.

### D. Audit (`core/audit.ts` + call site in `federatedQuery`/`vault_query`)

Add an `AuditEvent` variant for query, written on every `vault_query` call (owner or consumer):
```
{ event: "query", consumer: <id|"owner">, question_sha256: "sha256:<hex>",
  vault_included: boolean, sources_consulted: string[], denied: boolean }
```
- The question is stored **hashed** (`question_sha256`), not in plaintext — the audit proves *which* query happened (matchable if you have the question) without turning the audit log into a plaintext record of everything every app ever asked. (Consistent with hearth's privacy posture; the owner can still correlate by hashing a suspected question.)
- Written via the existing `auditSync(vaultRoot, ...)`; append-only; no new storage.

### E. Management CLI (`cli/index.ts` — `hearth consumer …`)

- `hearth consumer add <id> --sources <csv|*> [--vault r|none] [--vault-path <p>]` → calls `addConsumer`, prints the generated token **once** with a copy-paste MCP-config snippet (env form) and a "this token is shown only now" warning.
- `hearth consumer list [--vault-path <p>]` → table of `id / vault / sources` (never hashes).
- `hearth consumer rm <id>` → removes the grant (revocation).
(These write/read `~/.hearth/consumers.json`; `--vault-path` only matters if a non-default state dir is ever wired — default is `~/.hearth`, consistent with `secret.key`/`sources.json`.)

## Architecture

```
consumer app (codex)                     hearth (broker)                    province (wechat-cc)
  spawns: hearth mcp serve                 ServerContext.consumer =            federated_query
    --consumer codex                         resolveConsumer(codex, tok)         (admin-gated on
    (token via env)  ───────────────►        │                                   ITS OWN side)
  vault_query{q, federate:true} ─────►  federatedQuery(q, consumer=codex)
                                             ├─ denied?  → refuse, audit(denied)
                                             ├─ vault:'r'? → local queryFn leg
                                             └─ sources ∩ grant → fan out ──────►  (only granted)
                                             merge → audit(query, sources) ◄──── hits (verified-by-source)
```

Three trust boundaries, cleanly separated: **owner→hearth** (owns the vault + secret.key; runs `hearth consumer add`), **consumer→hearth** (Phase 3: token + grant), **owner→province** (wechat-cc's own admin gate on `federated_query`). Phase 3 adds exactly the middle one; the other two are untouched.

**Independence preserved:** wechat-cc has zero knowledge of consumers; a province just answers hearth. The broker is hearth's alone.

## Verification

- **Unit — consumer registry:** `addConsumer` writes a 0600 file with a hashed (not plaintext) token and returns the plaintext once; `resolveConsumer` accepts the right token (constant-time), rejects a wrong token (`bad_token`) and an unknown id (`unknown_id`); `loadConsumers` on a missing/malformed file returns empty grants (fail-closed).
- **Unit — enforcement (`federatedQuery` with injected `queryFn`/`sourceQueryFn`):**
  - `consumer == null` (owner) → byte-identical to Phase 2a (vault + all sources).
  - denied consumer → `{ hits: [], denied: true }`, and neither `queryFn` nor any `sourceQueryFn` is called (assert the spies are untouched — proves no leak).
  - `vault: "none"` → `queryFn` not called; only granted sources' hits returned.
  - `sources: ["wechat-cc"]` with a second registered source `X` → `X`'s `sourceQueryFn` never called; only `wechat-cc` fans out.
- **Unit — audit:** a `vault_query` writes exactly one `query` event with `question_sha256` (not plaintext), correct `consumer`, `sources_consulted`, `denied`.
- **VERIFY-AGAINST-REAL (owner machine):** register two consumers against the real cloned hearth — `codex` granted `sources:["wechat-cc"]`, `guest` granted `sources:[]` vault-only. Spawn `hearth mcp serve --consumer codex` (token via env) and query → gets vault + wechat federated hits. Spawn as `guest` → gets vault hits, **zero** wechat hits. Spawn with a **wrong token** → permission-denied, zero hits. Spawn with **no --consumer** (owner) → unchanged full federate. Confirm `~/.hearth/consumers.json` is 0600 and holds only hashes, and the audit log shows one hashed `query` entry per call with the right `sources_consulted`.

## Non-goals (later)

- **Per-consumer scoping of the *ingest* side** (`vault_plan_submit`/`vault_apply_for_owner`) — Phase 1 owner-channel-trust stands; consumers are read-side. A "who may write" broker is a separate slice if a third-party ever needs write.
- **Path-/topic-level scope within a source** (consumer may read source X but only its `wechat/work/*` claims) — grant is per-source, not intra-source; finer scope is future.
- **Token rotation/expiry/TTL** — Phase 3 tokens are long-lived bearer secrets, revoked by `hearth consumer rm`. TTL/rotation (reusing the token payload's expiry field) is a follow-on.
- **A shared multi-tenant hearth server** (one process serving many consumers with per-request identity) — Phase 3's per-spawn identity fits hearth's per-client stdio model; a shared server is a different deployment shape, not needed now.
- **RRF / multi-source rank fusion, freshness/scope labels, connection caching** — deferred Phase 2b/2c; independent of Phase 3.
- **strict mode** (deny even no-`--consumer` connections) — an optional config flag can be added later; Phase 3 keeps owner-full as the no-consumer default for backward-compat.

## Risks

- **Backdoor via no-consumer:** the owner-full default means any locally-spawned `hearth mcp serve` *without* `--consumer` has full access. This is intentional (the owner controls what they wire) but must be documented clearly so an integrator doesn't wire a third-party app without `--consumer` and silently grant it everything. Mitigation: the `hearth consumer add` output and README make "third-party apps MUST launch with `--consumer`+token" explicit; a future strict flag (non-goal) can enforce it.
- **Token in argv:** `--consumer-token` on the command line is visible in `ps`. Mitigation: env (`HEARTH_CONSUMER_TOKEN`) is the documented/recommended path; the CLI snippet emitted by `consumer add` uses env, not the flag.
- **Fail-closed correctness:** the highest-risk bug class is a denied/limited consumer leaking data (vault contents to a denied consumer, or an un-granted source's hits). The unit tests assert the query/source spies are **never called** for denied/un-granted paths — leak-by-omission is caught structurally, not just by output shape.
- **Constant-time compare:** token check must use a constant-time comparison (`timingSafeEqual` on equal-length sha256 hex) to avoid a timing oracle on the token. Called out as a task requirement.
