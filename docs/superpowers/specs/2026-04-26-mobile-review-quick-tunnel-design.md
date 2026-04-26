# Mobile Review via Quick Tunnel — Design Spec

**Date**: 2026-04-26
**Status**: Brainstormed; awaiting user sign-off before writing the implementation plan
**Targets**: hearth v0.2 (diff + rebase + risk classifier) + Phase 0 mobile review surface
**Supersedes**: nothing
**Related**: [PRODUCT.md](../../PRODUCT.md), [SPEC.md §11](../../SPEC.md), [ROADMAP.md v0.2 / v0.7](../../ROADMAP.md)

---

## 1. Why this exists

hearth has shipped through v0.4 (MCP server, audit log, token-gated apply). What it has not shipped:

- **A way to actually look at a plan diff before approving.** Today `pending show` lists ops; it does not render unified diffs. Real users will not approve what they cannot see.
- **A surface that earns "I would use this for a week."** CLI works for me-the-builder; it does not survive contact with a real user, and PRODUCT.md explicitly anticipates a v0.7 "human trust surface."
- **The other half of the channel-first differentiation.** Capture from WeChat exists. Review from WeChat does not — the user has to walk to a laptop. The `channel-first` claim is half-shipped until the loop closes on the phone.

This spec ships the smallest design that closes all three holes at once, while honoring two PRODUCT.md doctrines that must not bend:

> *Vault remains the source of truth.*
> *Optional hosted services may exist later.*

The design pulls v0.7's local trust surface forward, frames it as a transient capability surface (not a dashboard), and threads it through Cloudflare Quick Tunnel so that **no hearth-operated server is ever on the data path**.

## 2. What's in scope, what's out

### In scope (v1)

- **Runtime additions** that v0.2 was supposed to ship:
  - `renderPlanReview(id, opts)` — canonical PlanReview rendering layer; multi-format
  - `rebasePlan(id)` — 3-way merge when `precondition.base_hash` has drifted
  - `classifyRisk(plan)` — kernel-side, deterministic, ignores agent self-report
- **Local review HTTP server** (`src/review-server.ts`): bun.serve on `127.0.0.1:RAND`; three routes; server-side rendered HTML; no SPA build step
- **Tunnel manager** (`src/tunnel.ts`): spawns `cloudflared`, parses `*.trycloudflare.com` URL, one shared tunnel per hearth process
- **Capability URL flow**: reuses SPEC §11 approval token as URL credential — single-use, 5-min TTL, bound to `change_id`, HMAC-signed
- **Channel-side notification format**: `ingestFromChannel` returns `review_url` when tunnel active; channel adapter (wechat-cc) renders short text + URL
- **CLI surface**: `hearth review start` (manual on for testing), `hearth pending share <id>` (issue capability URL on demand), `hearth doctor` extension to detect missing `cloudflared`
- **tendhearth.com landing**: short onboarding section + one-line install command. Static. Not a product surface.

### Out of scope (deferred — Phase 1 / v0.5+)

- Persistent `alice.tendhearth.com` subdomains, NS delegation, Cloudflare for SaaS
- Login flow, account system, Cloudflare Access
- Multi-user dashboard, persistent review history UI
- Real-time cross-device session sync (websocket / SSE)
- Auto-policy / risk-class auto-apply (separate v0.5 work)
- Audit log rotation (separate v0.5 work)
- Format coverage (URL / PDF / voice — orthogonal, parked)

If the user comes back saying "we have a power user who needs persistent URL" → that is Phase 1, additive, no breaking changes.

## 3. Architecture

```
┌──────────────────── local hearth process ────────────────────┐
│                                                                │
│   pending-store ─→ runtime ─→ renderPlanReview(id, format)    │
│                              ─→ classifyRisk(plan)            │
│                              ─→ rebasePlan(id)                │
│                              ─→ issueApprovalToken(...)       │
│                                                                │
│   review-server  (bun.serve, 127.0.0.1:RAND)                  │
│     GET  /p/:id?t=…       → render HTML diff                  │
│     POST /p/:id/apply?t=… → verifyToken → kernel.apply        │
│     POST /p/:id/reject?t=…→ verifyToken → mark rejected       │
│                                                                │
│   tunnel-manager                                               │
│     spawn(cloudflared --url http://127.0.0.1:RAND)             │
│     parse stdout → *.trycloudflare.com URL                    │
│     one shared tunnel; alive while ANY plan pending            │
│     close after 10 min idle                                    │
└────────────────────────────┬───────────────────────────────────┘
                             │ HTTPS
                             ▼
                    Cloudflare edge
                             │
                             ▼
                    User's phone (anywhere)
```

**Multi-end unification is structural, not aspirational.**

| Layer                     | Sole responsibility                  | Consumed by              |
|---------------------------|--------------------------------------|--------------------------|
| `ChangePlan`              | data                                 | already exists           |
| `runtime.renderPlanReview`| canonical render entry point         | CLI, HTTP, channel       |
| `runtime.classifyRisk` / `rebasePlan` / `issueApprovalToken` | adjudication entry points | CLI, HTTP, channel |
| Surface renderers         | format conversion only — no logic    | CLI / HTTP / WeChat etc. |

No surface may bypass `runtime` to compute its own diff, risk, or token — the unification is enforced by the API shape, not by discipline.

## 4. Components & file plan

| File                          | Type    | Content                                                                                       |
|-------------------------------|---------|-----------------------------------------------------------------------------------------------|
| `src/runtime.ts`              | extend  | export `renderPlanReview`, `rebasePlan`, `classifyRisk`; channel-result includes `review_url` |
| `src/core/plan-review.ts`     | new     | `PlanReview` data structure + multi-format render (`html` / `markdown` / `ansi` / `json`)     |
| `src/core/risk-classifier.ts` | new     | path-glob + op-kind heuristics; deterministic; not agent-driven                                |
| `src/core/rebase.ts`          | new     | 3-way merge (`git merge-file` shell-out OR pure-JS diff3); conflict path goes to PendingStore |
| `src/review-server.ts`        | new     | bun.serve; 3 routes; verifyToken on every request; server-rendered HTML; localhost-only bind  |
| `src/tunnel.ts`               | new     | `TunnelBackend` interface + single impl `CloudflareQuickTunnel`; spawn / parse / lifecycle    |
| `src/cli/index.ts`            | extend  | `hearth review start`, `hearth pending share <id>`                                            |
| `src/cli/doctor.ts`           | extend  | detect `cloudflared` presence; print install hint if missing                                  |
| `web/`                        | extend  | tendhearth.com adds onboarding section + install command                                      |
| `tests/`                      | new     | token replay, rebase 3-way (clean / conflict), render 3 formats, tunnel mock, route handlers   |

### Refactor consolidations (in-scope housekeeping)

The user has explicitly licensed refactoring during this work. The following are folded as part of v1:

- `renderPlanMarkdown` (recent commit, channel-publishable review document) → folds into `renderPlanReview(id, "markdown")`. Old entry point deleted, no shim.
- v0.3.1 channel review surface (`listPending` / `showPending` / `applyForOwner`) → backend re-routed to share `renderPlanReview` + token verification logic. If their existing public shape stays compatible, keep it; if not, change call sites cleanly. No deprecation comments — pre-1.0.
- Any ad-hoc YAML/diff rendering encountered along the way is replaced with `renderPlanReview` calls.

If a consolidation turns out to be non-trivial during implementation, surface it as a discrete plan step rather than smuggling it into an unrelated commit.

## 5. Data flow — full mobile review journey

```
1. inbound capture from channel
   → runtime.ingestFromChannel(InboundMsg)
   → AgentAdapter → ChangePlan → pending-store
2. runtime.ensureTunnel():
     if cloudflared not installed → return TUNNEL_BACKEND_MISSING with install hint
     if no live tunnel             → spawn cloudflared, parse URL
     if tunnel already live        → reuse
3. runtime.issueApprovalToken({ change_id, ttl: 5min, scope })
4. capability URL = `<tunnel_url>/p/<change_id>?t=<token>`
5. ChannelIngestResult.review_url = capability URL
   → channel adapter sends:
       hearth pending <change_id>
       <N> ops · risk=<class> · expires <HH:MM>
       <capability URL>
6. user taps URL on phone
   → CF edge → tunnel → review-server
   → GET /p/:id?t=…
       verifyToken (signature / expiry / change_id binding / jti not consumed)
       on fail → STALE_TOKEN error page (calm copy, "wait for next notification")
       on pass → renderPlanReview(id, "html") response
7. user clicks Approve
   → POST /p/:id/apply?t=…
       verifyToken AND mark jti consumed atomically
       kernel.apply(plan):
         re-check precondition.exists / base_hash on every op
         hash matches → write vault → 200 success page (text only, no celebration UI)
         hash drift  → REBASE_REQUIRED page with "rebase and re-issue" link
                       runtime.rebasePlan(id) → new ChangePlan
                       channel push: new URL + new token (old jti dead)
   → audit log: approval_token.consumed + changeplan.applied
8. all pending plans resolved + 10 min idle → tunnel closes
```

## 6. Security model

- **Capability URL is the credential.** No login, no session. URL embeds HMAC token (SPEC §11) — single-use, 5-min TTL, bound to `change_id`, scope-bounded.
- **Review server binds 127.0.0.1.** The tunnel is the only path from outside; if the tunnel closes, the review server is unreachable from the internet.
- **Tunnel is shared safely.** One shared tunnel per hearth process. Each capability URL has its own token; tunnel itself is not a trust boundary.
- **Token leak blast radius**: one plan, ≤ 5 minutes, single use. Used = dead.
- **Risk is kernel-determined.** `classifyRisk(plan)` runs path globs + op-kind rules; agent's self-reported `risk` field is ignored at the kernel layer (still surfaced in PlanReview as "agent claimed: …" for transparency).
- **High-risk plans require explicit confirmation.** Even with a valid token, `risk == "high"` plans render with a second confirmation step — not a single-click approve. Cleared via a `confirm=true` form field.
- **Audit trail preserved.** Every token issuance / consumption / rejection logs to `<vault>/.hearth/audit.jsonl` exactly as v0.4.
- **No data crosses our infrastructure.** Cloudflare's edge sits on the data path; we do not. tendhearth.com remains static landing only.

## 7. Aesthetic / interaction principles

These are not optional polish — they are spec-level constraints, because the surfaces are part of what the user pays attention to.

### HTML review page
- Single column, max-width ~720px, generous whitespace
- System font stack (`-apple-system, BlinkMacSystemFont, …`)
- Diff rendered in `<pre>` with monospace; subtle muted red/green (not vivid SaaS palette)
- No shadows, no gradients, no emoji decoration, no hero illustrations
- Approve / Reject are plain text-styled buttons with low visual weight
- No toast notifications, no loading spinners (requests are sub-second), no "🎉 success" celebration
- Reference aesthetic: Linear's commit page, Stripe's docs — NOT a product dashboard

### CLI output
- Color used only when it carries meaning: errors red, metadata dim, content default
- No ASCII art, no emoji
- Information density over visual flourish

### Channel notification
- Pure information, no emoji header:
  ```
  hearth pending abc123
  2 ops · risk=med · expires 14:30
  https://abc-xyz-42.trycloudflare.com/p/abc123?t=…
  ```
- The URL stands on its own — no surrounding "click here to" prose

### Code-level discipline
- Single-responsibility modules
- `TunnelBackend` is an interface with one implementation; do not pre-build a plugin system
- Don't add error handling for impossible states; trust internal invariants
- No comments explaining WHAT — only WHY when surprising

When in doubt, cut. Less is more.

## 8. Error handling & user-facing recovery

| Code                       | Source                       | UX                                                                                          |
|----------------------------|------------------------------|----------------------------------------------------------------------------------------------|
| `TUNNEL_BACKEND_MISSING`   | tunnel-manager startup       | hearth doctor + setup wizard print install hint (`brew install cloudflared` / `npm i -g cloudflared`); CLI returns non-zero |
| `STALE_TOKEN`              | review-server token verify   | calm error page; copy: "this link is no longer valid; check your messages for a fresh one"  |
| `REQUIRES_HUMAN_APPROVAL`  | apply without token          | should not occur via review-server (server only accepts tokened requests); MCP path unchanged |
| `REBASE_REQUIRED`          | apply step / kernel preflight| review-server renders rebase page; "rebase and re-issue" → runtime.rebasePlan + channel push new URL |
| `PERMISSION_DENIED`        | kernel preflight             | error page; do not retry; advise schema review                                              |
| `PLAN_VALIDATION_FAILED`   | validator                    | error page with per-issue list                                                               |
| `cloudflared` process dies | tunnel-manager heartbeat     | restart cloudflared; new URL; outstanding tokens still valid (token is independent of URL); push fresh notification |

## 9. Testing strategy

### Unit tests
- **Token**: sign / verify / replay-rejection / wrong-change-id / expired / consumed-jti
- **Risk classifier**: each op kind, each path glob class, agent-claimed-but-classifier-disagrees
- **Rebase**: clean 3-way merge, conflict case, malformed base_hash
- **PlanReview render**: same plan input → expected HTML / markdown / ANSI / JSON outputs

### Integration tests
- Mock cloudflared (in-process loopback); run full pipeline: channel ingest → tunnel start → token URL → GET diff → POST approve → audit assertion

### Manual / acceptance
- Real cloudflared binary on dev machine
- Real WeChat round-trip via wechat-cc
- Acceptance: send capture from phone → receive URL on phone within 5s → tap → see diff → approve → query result reflected in vault

### Security regressions
- Replay a consumed token → 403
- Expired token → 403 + STALE_TOKEN page
- Token with mismatched change_id → 403 + audit
- URL guessing (random change_ids) → 404 (no information leak)

## 10. Open questions resolved by this spec

These were live during brainstorming; locking them here so implementation does not relitigate.

1. **Tunnel sharing strategy**: ONE shared tunnel per hearth process, lives while any plan pending, closes after 10-min idle. (Not per-plan tunnels — too heavy.)
2. **`cloudflared` distribution**: NOT bundled. Detected by doctor; install hint printed. v1 ships docs; future versions may opt to bundle.
3. **Tunnel backend abstraction**: `TunnelBackend` interface, one implementation (`CloudflareQuickTunnel`). Future backends added when CF Quick Tunnel ToS or reliability becomes a problem — not preemptively.
4. **Render technology**: server-side HTML, no SPA, no build step. Rendering function returns a string of HTML.
5. **Multi-plan pending**: each plan has its own URL + token; review page may include a footer link "N other plans pending" but does not aggregate.
6. **HTML styling**: inline `<style>` block, no external CSS. Single file, no asset pipeline.
7. **Persistent subdomain (alice.tendhearth.com)**: parked as Phase 1; revisit only when there is a concrete user request.
8. **Login**: explicitly not in v1. Capability URL is the credential.

## 11. Risks & mitigations

| Risk                                                                | Mitigation                                                                                  |
|---------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Cloudflare changes Quick Tunnel ToS or starts throttling            | `TunnelBackend` interface preserved; ngrok / bore.pub / Tailscale Funnel can be added       |
| `cloudflared` install friction blocks first-run                     | doctor detects + prints exact install line; tendhearth.com onboarding shows it upfront      |
| Capability URL leaked via WeChat screenshot / forwarded message     | single-use + 5-min expiry + change_id binding limits blast radius to one plan, one window   |
| User-installed cloudflared version drift                            | tunnel-manager parses output defensively; falls back to error with version hint             |
| HTML review page rendered for huge plans is slow / unwieldy         | render with truncation past N ops; "expand" link → fuller render; never block on giant diffs |
| User has no internet                                                 | Quick Tunnel requires outbound HTTPS; offline → doctor hints at LAN-only fallback (later)  |

## 12. Effort estimate

| Component                                              | Days |
|--------------------------------------------------------|------|
| Runtime three (renderPlanReview / rebase / classifyRisk) | 2.0  |
| review-server + tunnel-manager                         | 2.0  |
| Channel integration (runtime side + wechat-cc side)    | 1.0  |
| Tests + end-to-end manual                              | 1.5  |
| tendhearth.com onboarding + docs                       | 0.5  |
| **Total focused work**                                 | **~7 days** |

## 13. Definition of done

- [ ] Channel ingest produces a ChangePlan AND emits a capability URL on `*.trycloudflare.com`
- [ ] Phone tap on URL renders a server-rendered HTML diff page
- [ ] Approve button hits review-server, kernel applies, vault is mutated, audit log records
- [ ] Reject button marks plan rejected, audit log records, tunnel closes when no plans pending
- [ ] Token replay attempt returns 403 + audit entry
- [ ] base_hash drift triggers rebase flow with a fresh URL pushed to channel
- [ ] `hearth doctor` detects missing `cloudflared` and prints install hint
- [ ] CLI / HTTP / channel surfaces all render via `renderPlanReview` (no parallel rendering paths)
- [ ] HTML review page passes the aesthetic principles: single column, system font, no decoration, no toasts, no emoji
- [ ] tendhearth.com landing has a visible install line
- [ ] No code path causes hearth-operated infrastructure to handle vault content

---

*This spec is the technical contract for v1 of mobile review. PRODUCT.md remains the doctrine; SPEC.md remains the public surface. The implementation plan is generated from this spec via `superpowers:writing-plans`.*
