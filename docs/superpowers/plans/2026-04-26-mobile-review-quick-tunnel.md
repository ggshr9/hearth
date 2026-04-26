# Mobile Review via Quick Tunnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 0 mobile review surface (per `docs/superpowers/specs/2026-04-26-mobile-review-quick-tunnel-design.md`): channel notification → ephemeral `*.trycloudflare.com` URL → server-rendered HTML diff → token-gated approve → kernel apply. Bundles v0.2 runtime work (PlanReview canonical render, rebase, kernel-side risk classifier).

**Architecture:** A canonical `PlanReview` rendering layer in `runtime.ts` is consumed by three surfaces (CLI text, HTTP HTML, channel markdown) with no surface-specific logic. A localhost-only `bun.serve` review server is reached from the public internet via a single shared `cloudflared` Quick Tunnel. Auth is a capability URL embedding the existing SPEC §11 HMAC approval token. No hearth-operated infrastructure is on the data path.

**Tech Stack:** TypeScript / Bun runtime / vitest. No new npm dependencies for v1 (uses node `crypto`, `child_process`, bun's `serve`). External binary: `cloudflared` (detected by doctor; not bundled).

**Test command:** `bun run test` (vitest run). Single file: `bun run test tests/<file>.test.ts`. Type check: `bun run typecheck`.

**Conventions observed in this codebase:**
- Relative TS imports include `.ts` extension
- File header comment explaining purpose
- Tests use `mkdtempSync(tmpdir(), 'hearth-<scope>-')` for isolated state and vault dirs
- SCHEMA snippet inlined as a const at top of each test file
- Async audit calls use `void audit(...)` to fire-and-forget
- `process.stdout.write` / `process.stderr.write` (no `console.log`) in CLI
- `parseArgs` from `node:util` for CLI

---

## Task 0: Branch and worktree (optional but recommended)

**Files:** none (git only)

- [ ] **Step 1: Create a worktree for this work**

```bash
cd /Users/homebot/hearth
git worktree add -b feat/mobile-review-quick-tunnel ../hearth-mobile-review main
cd ../hearth-mobile-review
bun install
```

- [ ] **Step 2: Confirm baseline tests pass before any change**

Run: `bun run test`
Expected: all existing tests pass (this is the green-baseline; subsequent tasks must keep it green).

If the executor opts to work directly on `main`, that's fine — the plan does not depend on a worktree. Skip this task in that case.

---

## Task 1: PlanReview canonical type + JSON output

**Files:**
- Create: `src/core/plan-review.ts`
- Test: `tests/plan-review.test.ts`

The PlanReview type is the canonical view all surfaces render from. v1 ships JSON + markdown + html + ansi formats. This task scaffolds the type and the JSON format (the "raw passthrough"); subsequent tasks add the other three formats.

- [ ] **Step 1: Write the failing test**

Create `tests/plan-review.test.ts`:

```typescript
// PlanReview canonical render layer — JSON format + structure tests.

import { describe, expect, it } from 'vitest';
import type { ChangePlan } from '../src/core/types.ts';
import { renderPlanReview } from '../src/core/plan-review.ts';

const PLAN: ChangePlan = {
  change_id: 'cp-001',
  source_id: 'sha256:abc',
  risk: 'medium',
  ops: [
    {
      op: 'create',
      path: '06 Hearth Inbox/note.md',
      reason: 'new capture',
      precondition: { exists: false },
      patch: { type: 'replace', value: '# Hello\n\nbody\n' },
      body_preview: '# Hello\n\nbody',
    },
  ],
  requires_review: true,
  created_at: '2026-04-26T10:00:00Z',
  note: 'first capture',
};

describe('renderPlanReview JSON', () => {
  it('returns the canonical PlanReview structure under format="json"', () => {
    const out = renderPlanReview(PLAN, { format: 'json' });
    expect(out.format).toBe('json');
    expect(out.json).toBeDefined();
    const review = out.json!;
    expect(review.change_id).toBe('cp-001');
    expect(review.risk).toBe('medium');
    expect(review.requires_review).toBe(true);
    expect(review.ops).toHaveLength(1);
    expect(review.ops[0]!.kind).toBe('create');
    expect(review.ops[0]!.path).toBe('06 Hearth Inbox/note.md');
    expect(review.ops[0]!.reason).toBe('new capture');
  });

  it('PlanReview ops carry diff hints (current/proposed bodies for create)', () => {
    const out = renderPlanReview(PLAN, { format: 'json' });
    const op0 = out.json!.ops[0]!;
    expect(op0.kind).toBe('create');
    expect(op0.before).toBeNull();
    expect(op0.after).toBe('# Hello\n\nbody\n');
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun run test tests/plan-review.test.ts`
Expected: FAIL — module `src/core/plan-review.ts` does not exist.

- [ ] **Step 3: Implement minimal `src/core/plan-review.ts`**

```typescript
// PlanReview — canonical view of a ChangePlan.
//
// Every user-facing surface (CLI text, HTTP HTML page, channel markdown,
// future Local Console) renders from this single representation. No surface
// computes its own diff or risk; they all read PlanReview.

import type { ChangePlan, ChangeOp, Risk } from './types.ts';

export interface PlanReviewOp {
  kind: ChangeOp['op'];
  path: string;
  reason: string;
  /** Current file content for `update`; null for `create` and `delete`. */
  before: string | null;
  /** Proposed content for `create`/`update`; null for `delete`. */
  after: string | null;
  /** Required existence at apply time. */
  must_exist: boolean;
  /** Expected file hash at apply time, if any. */
  base_hash?: string;
}

export interface PlanReview {
  change_id: string;
  risk: Risk;
  requires_review: boolean;
  created_at: string;
  note?: string;
  ops: PlanReviewOp[];
}

export type RenderFormat = 'json' | 'markdown' | 'html' | 'ansi';

export interface RenderOptions {
  format: RenderFormat;
  /** Cap diff body lines per op for surfaces with size limits (markdown/html). */
  maxOpBodyLines?: number;
  /** For html only: include the per-plan capability URL token in form actions. */
  capabilityToken?: string;
  /** For html only: capability URL base (e.g. https://abc.trycloudflare.com). */
  capabilityBase?: string;
}

export interface RenderResult {
  format: RenderFormat;
  /** Plain-text rendering: ANSI is text with escape codes; markdown is text. */
  text?: string;
  /** Server-renderable HTML document (full page) for `format: 'html'`. */
  html?: string;
  /** Structural JSON for programmatic consumers. */
  json?: PlanReview;
}

function toPlanReview(plan: ChangePlan): PlanReview {
  return {
    change_id: plan.change_id,
    risk: plan.risk,
    requires_review: plan.requires_review,
    created_at: plan.created_at,
    note: plan.note,
    ops: plan.ops.map<PlanReviewOp>(op => ({
      kind: op.op,
      path: op.path,
      reason: op.reason,
      // For create: there is no "before"; after = the proposed body.
      // For update: before is the current file, computed by the renderer
      //   when needed (see renderHtml). v1 only stores the proposed content
      //   inline; before-fetching happens lazily because not every renderer
      //   needs it.
      before: null,
      after: op.patch && op.patch.type === 'replace' ? op.patch.value : null,
      must_exist: op.precondition.exists,
      base_hash: op.precondition.base_hash,
    })),
  };
}

export function renderPlanReview(plan: ChangePlan, opts: RenderOptions): RenderResult {
  const review = toPlanReview(plan);
  switch (opts.format) {
    case 'json':
      return { format: 'json', json: review };
    case 'markdown':
    case 'html':
    case 'ansi':
      throw new Error(`format ${opts.format} not implemented yet (Tasks 2-4)`);
  }
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `bun run test tests/plan-review.test.ts`
Expected: PASS, both `it` cases.

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/plan-review.ts tests/plan-review.test.ts
git commit -m "feat(core): PlanReview canonical type + JSON renderer

Single representation that all surfaces (CLI / HTTP / channel) render
from. v1 establishes the type and the JSON passthrough; markdown / HTML /
ANSI formats land in subsequent tasks."
```

---

## Task 2: PlanReview markdown renderer (folds in `renderPlanMarkdown`)

**Files:**
- Modify: `src/core/plan-review.ts`
- Modify: `src/runtime.ts:341-422` (delete `renderPlanMarkdown`)
- Modify: `tests/channel-review.test.ts` (update imports / call sites if needed)
- Modify: `tests/plan-review.test.ts`

The recent `renderPlanMarkdown` in `runtime.ts` (lines 341-422) is the channel-publishable review document. We fold it into `renderPlanReview(plan, { format: 'markdown' })` and delete the old entry point.

- [ ] **Step 1: Add a failing test for markdown format**

Append to `tests/plan-review.test.ts`:

```typescript
describe('renderPlanReview markdown', () => {
  it('produces a self-contained markdown document', () => {
    const out = renderPlanReview(PLAN, { format: 'markdown' });
    expect(out.format).toBe('markdown');
    const md = out.text!;
    expect(md).toContain('cp-001');
    expect(md).toContain('medium');
    expect(md).toContain('06 Hearth Inbox/note.md');
    expect(md).toContain('new capture');
    // Body preview is rendered in a fenced code block
    expect(md).toMatch(/```/);
    expect(md).toContain('# Hello');
  });

  it('omits the celebratory footer (aesthetic restraint — no v0.3.1 advert)', () => {
    const out = renderPlanReview(PLAN, { format: 'markdown' });
    const md = out.text!;
    expect(md).not.toMatch(/v0\.3\.1/);
    expect(md).not.toMatch(/🔥|📋|✅|❌/); // no emoji decoration
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/plan-review.test.ts -t "markdown"`
Expected: FAIL — `format markdown not implemented yet`.

- [ ] **Step 3: Implement markdown rendering in `src/core/plan-review.ts`**

Replace the `case 'markdown':` arm in `renderPlanReview` (delete the throw):

```typescript
    case 'markdown':
      return { format: 'markdown', text: renderMarkdown(plan, review, opts) };
```

Add at bottom of file:

```typescript
function renderMarkdown(_plan: ChangePlan, review: PlanReview, opts: RenderOptions): string {
  const previewN = opts.maxOpBodyLines ?? 40;
  const lines: string[] = [];

  lines.push('# Hearth ChangePlan', '');
  lines.push(`\`${review.change_id}\``, '');
  lines.push('| risk | review | ops | created |');
  lines.push('| ---- | ------ | --- | ------- |');
  lines.push(`| ${review.risk} | ${review.requires_review ? 'yes' : 'no'} | ${review.ops.length} | ${review.created_at.replace('T', ' ').slice(0, 16)} |`);
  lines.push('');
  if (review.note) lines.push(`> ${review.note}`, '');

  lines.push('## Operations', '');
  for (let i = 0; i < review.ops.length; i++) {
    const op = review.ops[i]!;
    lines.push(`### ${i + 1}. \`${op.kind}\` → \`${op.path}\``, '');
    lines.push(`reason: ${op.reason}`, '');
    if (op.must_exist) {
      lines.push(`precondition: file must exist; base hash \`${op.base_hash?.slice(0, 16) ?? '–'}…\``, '');
    } else {
      lines.push('precondition: file must NOT already exist (create-only)', '');
    }
    if (op.after !== null) {
      const bodyLines = op.after.split('\n');
      const shown = bodyLines.slice(0, previewN);
      const more = Math.max(0, bodyLines.length - previewN);
      lines.push('```markdown');
      lines.push(...shown);
      if (more > 0) lines.push(`… (+${more} more lines)`);
      lines.push('```', '');
    }
  }
  return lines.join('\n').trimEnd();
}
```

- [ ] **Step 4: Run new test, confirm pass**

Run: `bun run test tests/plan-review.test.ts`
Expected: PASS, all `it` cases (json + markdown).

- [ ] **Step 5: Wire `runtime.renderPlanMarkdown` callers to the new entry, then delete the old function**

In `src/runtime.ts`:
- Delete the old `renderPlanMarkdown` block (lines 341-422 inclusive).
- Delete the `RenderPlanOptions` and `RenderPlanResult` interfaces above it.
- Add a thin wrapper that the channel surface still imports:

```typescript
import { renderPlanReview as renderPlan } from './core/plan-review.ts';

export interface RenderPlanOptions {
  hearthStateDir?: string;
  maxOpBodyLines?: number;
  /** Suffix line at the bottom (e.g. "/hearth apply <id> to commit"). */
  applyHint?: string;
}

export interface RenderPlanResult {
  ok: boolean;
  change_id?: string;
  title?: string;
  markdown: string;
  error?: string;
}

export function renderPlanMarkdown(changeId: string, opts: RenderPlanOptions = {}): RenderPlanResult {
  const stateDir = opts.hearthStateDir ?? defaultStateDir();
  const store = new PendingStore(join(stateDir, 'pending'));
  let plan: ChangePlan;
  try { plan = store.load(changeId); }
  catch (e) {
    return { ok: false, markdown: `# Plan not found\n\n\`${changeId}\` is no longer pending.`, error: (e as Error).message };
  }
  const out = renderPlan(plan, { format: 'markdown', maxOpBodyLines: opts.maxOpBodyLines });
  let markdown = out.text!;
  if (opts.applyHint) markdown += `\n\n---\n\n${opts.applyHint}`;
  return {
    ok: true,
    change_id: plan.change_id,
    title: `Hearth · ${plan.ops.length}-op ChangePlan (${plan.risk})`,
    markdown,
  };
}
```

(This keeps existing channel-review.test.ts passing without changing call sites — the public name `renderPlanMarkdown` stays, the implementation is now the new layer.)

- [ ] **Step 6: Run the full suite to make sure channel-review tests still pass**

Run: `bun run test`
Expected: PASS, all existing + new tests.

- [ ] **Step 7: Type check**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/core/plan-review.ts src/runtime.ts tests/plan-review.test.ts
git commit -m "feat(core): PlanReview markdown renderer; fold renderPlanMarkdown

renderPlanMarkdown stays as a thin wrapper for channel surfaces, but its
guts now route through renderPlanReview(plan, {format: 'markdown'}).
Aesthetic restraint: drop emoji decoration and the v0.3.1 advert footer
that the original carried."
```

---

## Task 3: PlanReview HTML renderer (server-rendered review page)

**Files:**
- Modify: `src/core/plan-review.ts`
- Modify: `tests/plan-review.test.ts`

The HTML output is what the phone browser sees. **Aesthetic constraints from spec §7 are spec-level, not optional**: single column, ~720px max, system font stack, monospace muted-color diff, no shadows/gradients/emoji/spinners/toasts.

- [ ] **Step 1: Write failing tests**

Append to `tests/plan-review.test.ts`:

```typescript
describe('renderPlanReview html', () => {
  it('returns a complete HTML document', () => {
    const out = renderPlanReview(PLAN, {
      format: 'html',
      capabilityBase: 'https://abc-1.trycloudflare.com',
      capabilityToken: 'tok-xyz',
    });
    expect(out.format).toBe('html');
    const html = out.html!;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>');
    expect(html).toContain('cp-001');
    expect(html).toContain('06 Hearth Inbox/note.md');
  });

  it('honors aesthetic restraint (no shadows / gradients / emoji / external assets)', () => {
    const out = renderPlanReview(PLAN, {
      format: 'html',
      capabilityBase: 'https://abc-1.trycloudflare.com',
      capabilityToken: 'tok-xyz',
    });
    const html = out.html!;
    expect(html).not.toMatch(/box-shadow|drop-shadow/);
    expect(html).not.toMatch(/linear-gradient|radial-gradient/);
    expect(html).not.toMatch(/🎉|✅|❌|🔥|📋/);
    // No external script or stylesheet refs
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('renders approve and reject form actions bound to the capability URL', () => {
    const out = renderPlanReview(PLAN, {
      format: 'html',
      capabilityBase: 'https://abc-1.trycloudflare.com',
      capabilityToken: 'tok-xyz',
    });
    const html = out.html!;
    expect(html).toContain('action="/p/cp-001/apply?t=tok-xyz"');
    expect(html).toContain('action="/p/cp-001/reject?t=tok-xyz"');
    expect(html).toContain('method="post"');
  });

  it('renders the proposed body inside <pre> for create ops', () => {
    const out = renderPlanReview(PLAN, {
      format: 'html',
      capabilityBase: 'https://abc-1.trycloudflare.com',
      capabilityToken: 'tok-xyz',
    });
    const html = out.html!;
    expect(html).toMatch(/<pre[^>]*>[\s\S]*# Hello[\s\S]*<\/pre>/);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/plan-review.test.ts -t "html"`
Expected: FAIL.

- [ ] **Step 3: Implement HTML rendering**

In `src/core/plan-review.ts`, replace `case 'html':` arm:

```typescript
    case 'html':
      return { format: 'html', html: renderHtml(plan, review, opts) };
```

Add at bottom of file:

```typescript
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml(_plan: ChangePlan, review: PlanReview, opts: RenderOptions): string {
  const t = opts.capabilityToken ?? '';
  const id = encodeURIComponent(review.change_id);
  const tEnc = encodeURIComponent(t);
  const applyAction = `/p/${id}/apply?t=${tEnc}`;
  const rejectAction = `/p/${id}/reject?t=${tEnc}`;

  const opsHtml = review.ops.map((op, i) => {
    const body = op.after ?? '';
    return `
    <section class="op">
      <h2>${i + 1}. <code>${escapeHtml(op.kind)}</code> → <code>${escapeHtml(op.path)}</code></h2>
      <p class="reason">${escapeHtml(op.reason)}</p>
      <p class="meta">${op.must_exist ? `must exist · base hash <code>${escapeHtml(op.base_hash?.slice(0, 16) ?? '')}…</code>` : 'must NOT already exist (create-only)'}</p>
      ${op.after !== null ? `<pre>${escapeHtml(body)}</pre>` : ''}
    </section>`;
  }).join('');

  const noteHtml = review.note ? `<blockquote>${escapeHtml(review.note)}</blockquote>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hearth · ${escapeHtml(review.change_id)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    max-width: 720px;
    margin: 2.5rem auto;
    padding: 0 1.25rem;
    line-height: 1.55;
    color: #1c1c1e;
    background: #fcfcfc;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e5e7; background: #111; }
    code, pre { background: #1c1c1e; }
    blockquote { color: #999; }
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
  h2 { font-size: 1rem;    font-weight: 600; margin: 1.5rem 0 0.5rem; letter-spacing: -0.005em; }
  .meta-row { color: #666; font-size: 0.875rem; margin-bottom: 1.5rem; }
  .meta-row > span + span::before { content: " · "; color: #ccc; }
  .reason { margin: 0.25rem 0 0.5rem; }
  .meta   { font-size: 0.8125rem; color: #888; margin: 0.25rem 0 0.75rem; }
  blockquote { color: #555; margin: 0.75rem 0 1.5rem; padding-left: 0.85rem; border-left: 2px solid #d0d0d0; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.875em;
    background: #f0f0f0;
    padding: 0 0.2em;
    border-radius: 2px;
  }
  pre {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.8125rem;
    background: #f5f5f5;
    padding: 0.75rem 0.85rem;
    overflow-x: auto;
    line-height: 1.5;
    border-radius: 3px;
    margin: 0.5rem 0 0;
  }
  section.op { margin-bottom: 1.5rem; }
  form.actions { margin: 2rem 0 4rem; display: flex; gap: 0.75rem; }
  button {
    font: inherit;
    padding: 0.5rem 1rem;
    border: 1px solid #999;
    background: transparent;
    color: inherit;
    cursor: pointer;
    border-radius: 3px;
  }
  button.approve { border-color: #2c7a3a; color: #2c7a3a; }
  button.reject  { border-color: #999; color: #666; }
  button:hover { background: rgba(0,0,0,0.04); }
  @media (prefers-color-scheme: dark) {
    button:hover { background: rgba(255,255,255,0.06); }
    button.approve { border-color: #6abc7a; color: #6abc7a; }
  }
</style>
</head>
<body>
  <h1>hearth · <code>${escapeHtml(review.change_id)}</code></h1>
  <div class="meta-row">
    <span>risk: ${escapeHtml(review.risk)}</span>
    <span>${review.ops.length} op${review.ops.length === 1 ? '' : 's'}</span>
    <span>${escapeHtml(review.created_at.replace('T', ' ').slice(0, 16))}</span>
  </div>
  ${noteHtml}
  ${opsHtml}
  <form class="actions" method="post" action="${applyAction}">
    <button type="submit" class="approve">approve</button>
  </form>
  <form class="actions" method="post" action="${rejectAction}" style="margin-top: -3.5rem;">
    <button type="submit" class="reject">reject</button>
  </form>
</body>
</html>`;
}
```

- [ ] **Step 4: Run all PlanReview tests, confirm pass**

Run: `bun run test tests/plan-review.test.ts`
Expected: PASS, all `it` cases.

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/plan-review.ts tests/plan-review.test.ts
git commit -m "feat(core): PlanReview HTML renderer with aesthetic constraints

Single-column ~720px, system font stack, no shadows/gradients/external
assets. Approve/reject as POST forms bound to the capability URL. Dark
mode via prefers-color-scheme. Tests assert the aesthetic constraints
verbatim so a future drift fails the build."
```

---

## Task 4: PlanReview ANSI/text renderer (CLI surface)

**Files:**
- Modify: `src/core/plan-review.ts`
- Modify: `tests/plan-review.test.ts`

ANSI is for terminal output. Per spec §7: color only when meaningful (errors red, metadata dim, content default). v1 keeps it minimal — no colors at all in this slice; just structured text.

- [ ] **Step 1: Write failing test**

Append to `tests/plan-review.test.ts`:

```typescript
describe('renderPlanReview ansi (CLI text)', () => {
  it('produces a structured terminal-friendly text block', () => {
    const out = renderPlanReview(PLAN, { format: 'ansi' });
    expect(out.format).toBe('ansi');
    const text = out.text!;
    expect(text).toContain('cp-001');
    expect(text).toContain('medium');
    expect(text).toContain('06 Hearth Inbox/note.md');
    // No emoji, no ANSI escape sequences in v1 (plain text)
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(text).not.toMatch(/\x1b\[/);
    // Body preview is indented under the op header
    expect(text).toContain('# Hello');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/plan-review.test.ts -t "ansi"`
Expected: FAIL.

- [ ] **Step 3: Implement ANSI/text renderer**

In `src/core/plan-review.ts` replace `case 'ansi':` arm:

```typescript
    case 'ansi':
      return { format: 'ansi', text: renderAnsi(plan, review, opts) };
```

Add at bottom of file:

```typescript
function renderAnsi(_plan: ChangePlan, review: PlanReview, opts: RenderOptions): string {
  const previewN = opts.maxOpBodyLines ?? 12;
  const lines: string[] = [];
  lines.push(`change_id: ${review.change_id}`);
  lines.push(`risk:      ${review.risk}    review: ${review.requires_review}    ops: ${review.ops.length}`);
  lines.push(`created:   ${review.created_at}`);
  if (review.note) lines.push(`note:      ${review.note}`);
  lines.push('');
  for (let i = 0; i < review.ops.length; i++) {
    const op = review.ops[i]!;
    lines.push(`[${op.kind}] ${op.path}`);
    lines.push(`  reason: ${op.reason}`);
    if (op.must_exist) lines.push(`  precondition: exists; base ${op.base_hash?.slice(0, 16) ?? '–'}`);
    else lines.push(`  precondition: must not exist`);
    if (op.after !== null) {
      const body = op.after.split('\n').slice(0, previewN);
      lines.push(`  body:`);
      for (const ln of body) lines.push(`    ${ln}`);
      const more = op.after.split('\n').length - previewN;
      if (more > 0) lines.push(`    … (+${more} more lines)`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/plan-review.test.ts`
Expected: PASS, all 4 format groups.

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/plan-review.ts tests/plan-review.test.ts
git commit -m "feat(core): PlanReview ANSI/text renderer for CLI surface

Plain text, no color codes, no emoji. CLI 'pending show' will route
through this in a later task to drop the parallel rendering path."
```

---

## Task 5: Risk classifier (kernel-side, deterministic)

**Files:**
- Create: `src/core/risk-classifier.ts`
- Test: `tests/risk-classifier.test.ts`

Per spec §6: agent's self-reported `risk` is not trusted at the kernel layer. Classifier rules: any `update` to a stable / canonical / SCHEMA path → high; any `delete` → high; multiple ops touching > 3 paths → medium; else low. Pure function of the plan; no side effects.

- [ ] **Step 1: Write failing tests**

Create `tests/risk-classifier.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { ChangePlan } from '../src/core/types.ts';
import { classifyRisk } from '../src/core/risk-classifier.ts';

function plan(ops: ChangePlan['ops']): ChangePlan {
  return {
    change_id: 'cp', source_id: 'sha256:x', risk: 'low',
    ops, requires_review: false, created_at: '2026-04-26T00:00:00Z',
  };
}

describe('classifyRisk (kernel-side)', () => {
  it('low for a single create in 06 Hearth Inbox/', () => {
    const r = classifyRisk(plan([
      { op: 'create', path: '06 Hearth Inbox/note.md', reason: 'x',
        precondition: { exists: false }, patch: { type: 'replace', value: '' } },
    ]));
    expect(r).toBe('low');
  });

  it('high for any update touching SCHEMA.md', () => {
    const r = classifyRisk(plan([
      { op: 'update', path: 'SCHEMA.md', reason: 'x',
        precondition: { exists: true, base_hash: 'sha256:abc' },
        patch: { type: 'replace', value: '' } },
    ]));
    expect(r).toBe('high');
  });

  it('high for any delete', () => {
    const r = classifyRisk(plan([
      { op: 'delete', path: '02 Maps/Old.md', reason: 'x',
        precondition: { exists: true, base_hash: 'sha256:abc' } },
    ]));
    expect(r).toBe('high');
  });

  it('high for update on a path matching **/stable*.md', () => {
    const r = classifyRisk(plan([
      { op: 'update', path: '02 Topics/stable-rag.md', reason: 'x',
        precondition: { exists: true, base_hash: 'sha256:abc' },
        patch: { type: 'replace', value: '' } },
    ]));
    expect(r).toBe('high');
  });

  it('medium when more than 3 ops are bundled', () => {
    const r = classifyRisk(plan([
      { op: 'create', path: '06 Hearth Inbox/a.md', reason: 'x',
        precondition: { exists: false }, patch: { type: 'replace', value: '' } },
      { op: 'create', path: '06 Hearth Inbox/b.md', reason: 'x',
        precondition: { exists: false }, patch: { type: 'replace', value: '' } },
      { op: 'create', path: '06 Hearth Inbox/c.md', reason: 'x',
        precondition: { exists: false }, patch: { type: 'replace', value: '' } },
      { op: 'create', path: '06 Hearth Inbox/d.md', reason: 'x',
        precondition: { exists: false }, patch: { type: 'replace', value: '' } },
    ]));
    expect(r).toBe('medium');
  });

  it('ignores agent-reported risk', () => {
    const p = plan([
      { op: 'create', path: '06 Hearth Inbox/n.md', reason: 'x',
        precondition: { exists: false }, patch: { type: 'replace', value: '' } },
    ]);
    p.risk = 'high'; // agent claim is high but path is low-risk
    expect(classifyRisk(p)).toBe('low');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/risk-classifier.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/core/risk-classifier.ts`**

```typescript
// Risk classifier — kernel-side, deterministic, ignores the agent's
// self-reported risk. The agent may put `risk: low` in a plan that
// rewrites SCHEMA.md; this module says high and the surfaces enforce.
//
// v1 rules:
//   high   — any delete; any update on SCHEMA.md or **/stable*.md
//   medium — > 3 ops in a single plan
//   low    — everything else

import type { ChangePlan, Risk } from './types.ts';

const HIGH_PATH_PATTERNS: RegExp[] = [
  /^SCHEMA\.md$/,
  /\bstable[^/]*\.md$/,
];

function isHighPath(p: string): boolean {
  return HIGH_PATH_PATTERNS.some(rx => rx.test(p));
}

export function classifyRisk(plan: ChangePlan): Risk {
  for (const op of plan.ops) {
    if (op.op === 'delete') return 'high';
    if (op.op === 'update' && isHighPath(op.path)) return 'high';
  }
  if (plan.ops.length > 3) return 'medium';
  return 'low';
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/risk-classifier.test.ts`
Expected: PASS, all 6 cases.

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/risk-classifier.ts tests/risk-classifier.test.ts
git commit -m "feat(core): kernel-side risk classifier

Deterministic; ignores agent-reported risk. v1 rules: delete or
SCHEMA/stable update is high; > 3 ops is medium; else low. Surfaces
that gate by risk class will read from this, not from plan.risk."
```

---

## Task 6: Add `source_path` to ChangePlan; populate in ingestFromChannel

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/runtime.ts:121-200` (ingestFromChannel)
- Modify: `tests/runtime.test.ts` or add to existing test

`rebasePlan` (next task) needs to find the source the plan was generated from. Today the plan stores `source_id` (a hash) but no path. We add `source_path` as an optional field and populate it in `ingestFromChannel`. Other code paths (e.g. `cmdIngest` in CLI) can populate it later; v1 only uses it for channel-ingested plans.

- [ ] **Step 1: Write failing test**

Append to `tests/runtime.test.ts` (find the channel-ingest section):

```typescript
import { existsSync as _existsSync } from 'node:fs';

describe('ingestFromChannel records source_path on the plan', () => {
  it('plan.source_path points at the materialized channel-inbox file', async () => {
    const vault = makeVault();          // existing helper in this file
    const stateDir = makeStateDir();    // existing helper
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'm1', from: 'me',
        text: 'first thought', received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    const store = new PendingStore(`${stateDir}/pending`);
    const plan = store.load(r.change_id!);
    expect(plan.source_path).toBeDefined();
    expect(_existsSync(plan.source_path!)).toBe(true);
    expect(plan.source_path).toContain('m1');
  });
});
```

(If `tests/runtime.test.ts` lacks `makeVault` / `makeStateDir`, copy them from `tests/channel-review.test.ts` — they're shared idiom in this repo.)

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/runtime.test.ts -t "source_path"`
Expected: FAIL — `plan.source_path` is undefined.

- [ ] **Step 3: Add field to ChangePlan**

In `src/core/types.ts`, modify the `ChangePlan` interface:

```typescript
export interface ChangePlan {
  change_id: string;
  source_id: string;
  /** Absolute path to the materialized source file (set by ingest pipelines
   *  that have a stable source location, e.g. ingestFromChannel). Used by
   *  rebasePlan to re-run ingest against current vault state. */
  source_path?: string;
  risk: Risk;
  ops: ChangeOp[];
  requires_review: boolean;
  created_at: string;
  note?: string;
}
```

- [ ] **Step 4: Populate in ingestFromChannel**

In `src/runtime.ts`, after the line `plan.source_id = sourceId;` (currently around line 183), add:

```typescript
  plan.source_path = sourcePath;
```

- [ ] **Step 5: Run, confirm pass**

Run: `bun run test tests/runtime.test.ts -t "source_path"`
Expected: PASS.

- [ ] **Step 6: Run full suite (no regressions)**

Run: `bun run test && bun run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/runtime.ts tests/runtime.test.ts
git commit -m "feat(core): ChangePlan.source_path; populate from channel ingest

Allows rebasePlan to re-run ingest against the same source when the
plan's base_hash drifts. Optional field — non-channel pipelines can
omit it (rebase will return UNSUPPORTED in that case)."
```

---

## Task 7: `rebasePlan` — re-ingest from source_path

**Files:**
- Modify: `src/runtime.ts` (add export `rebasePlan`)
- Test: `tests/rebase.test.ts`

Honest scope: rebase = "re-run ingest from `plan.source_path` against current vault state, replace the old plan in pending, audit". For plans without `source_path`, return error. This is simpler and more correct than 3-way merging an `update` op whose `patch.value` was computed against an outdated base.

- [ ] **Step 1: Write failing tests**

Create `tests/rebase.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFromChannel, rebasePlan } from '../src/runtime.ts';
import { PendingStore } from '../src/core/pending-store.ts';

const SCHEMA = `---
type: meta
---

# T

| dir         | human | agent |
|-------------|-------|-------|
| raw/        | add   | add   |
| 06 Hearth Inbox/ | rw | rw |
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-rebase-vault-'));
  for (const d of ['raw', '06 Hearth Inbox']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}
function makeStateDir(): string { return mkdtempSync(join(tmpdir(), 'hearth-rebase-state-')); }

describe('rebasePlan', () => {
  it('produces a fresh plan with the same source content; old plan is removed', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'm1', from: 'me', text: 'hello',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    const oldId = r.change_id!;
    const result = await rebasePlan(oldId, { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir });
    expect(result.ok).toBe(true);
    expect(result.change_id).toBeDefined();
    const store = new PendingStore(join(stateDir, 'pending'));
    expect(() => store.load(oldId)).toThrow();          // old gone
    const fresh = store.load(result.change_id!);        // new present
    expect(fresh.source_id).toBeDefined();
  });

  it('returns ok=false when the plan has no source_path', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const store = new PendingStore(join(stateDir, 'pending'));
    store.save({
      change_id: 'manual', source_id: 'sha256:x',
      // no source_path
      risk: 'low', ops: [], requires_review: false,
      created_at: new Date().toISOString(),
    });
    const r = await rebasePlan('manual', { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('source_path');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/rebase.test.ts`
Expected: FAIL — `rebasePlan` not exported.

- [ ] **Step 3: Implement `rebasePlan` in `src/runtime.ts`**

Add at end of file:

```typescript
// ── rebase ────────────────────────────────────────────────────────────────
//
// rebasePlan re-runs the ingest pipeline against the source the original
// plan was generated from, picking up current vault state. It deletes the
// old plan from pending and saves a fresh one. Honest-scope alternative to
// 3-way merge: for ops with patch.type='replace' (the only supported type
// in v0.1), surgically merging the agent's body against a drifted base is
// more error-prone than letting the agent (or mock) recompute against the
// new base. Source must have a stable on-disk location (set by
// ingestFromChannel as plan.source_path).

export interface RebaseOptions {
  vaultRoot: string;
  agent?: 'mock' | 'claude';
  hearthStateDir?: string;
  adapterOverride?: AgentAdapter;
}

export interface RebaseResult {
  ok: boolean;
  change_id?: string;
  /** Same prose summary shape as ChannelIngestResult for surface reuse. */
  summary: string;
  error?: string;
}

export async function rebasePlan(oldChangeId: string, opts: RebaseOptions): Promise<RebaseResult> {
  const stateDir = opts.hearthStateDir ?? defaultStateDir();
  const store = new PendingStore(join(stateDir, 'pending'));
  let oldPlan: ChangePlan;
  try { oldPlan = store.load(oldChangeId); }
  catch (e) {
    return { ok: false, summary: `pending plan not found: ${oldChangeId}`, error: (e as Error).message };
  }
  if (!oldPlan.source_path) {
    return { ok: false, summary: `plan ${oldChangeId} has no source_path; cannot rebase`,
             error: `source_path missing on plan ${oldChangeId}` };
  }
  if (!existsSync(oldPlan.source_path)) {
    return { ok: false, summary: `source file gone: ${oldPlan.source_path}`,
             error: `source file no longer at ${oldPlan.source_path}` };
  }

  // Re-derive an InboundMsg-shaped record from the materialized source.
  // The source file's frontmatter holds channel / message_id / from /
  // received_at — but for rebase we only need the body and the source_path.
  // We use a synthetic message_id so the pipeline doesn't collide with the
  // original; the source file is reused.
  const content = readFileSync(oldPlan.source_path, 'utf8');
  // Strip frontmatter to recover original text (pipeline re-frontmatters).
  let text = content;
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---\n', 4);
    if (end > 0) text = content.slice(end + 5).trim();
  }

  const r = await ingestFromChannel(
    { channel: 'rebase', message_id: `${oldChangeId}-r${Date.now()}`,
      from: 'rebase', text, received_at: new Date().toISOString() },
    { vaultRoot: opts.vaultRoot, agent: opts.agent ?? 'mock',
      hearthStateDir: stateDir, adapterOverride: opts.adapterOverride },
  );
  if (!r.ok) {
    return { ok: false, summary: `rebase ingest failed: ${r.summary}`, error: r.error };
  }
  store.remove(oldChangeId);
  void audit(opts.vaultRoot, {
    event: 'changeplan.created',
    initiated_by: 'rebase',
    data: { from_change_id: oldChangeId, change_id: r.change_id },
  });
  return { ok: true, change_id: r.change_id, summary: `rebased ${oldChangeId} → ${r.change_id}` };
}
```

Add `readFileSync` to the existing `node:fs` import at the top of `runtime.ts`.

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/rebase.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts tests/rebase.test.ts
git commit -m "feat(runtime): rebasePlan — re-ingest from plan.source_path

Honest scope for v1: rebase = re-run the agent against current vault
state using the original source. Refuses on plans without source_path.
True 3-way merging deferred until we have unified-diff patches in
the kernel."
```

---

## Task 8: Token verify-without-consume helper

**Files:**
- Modify: `src/core/approval-token.ts`
- Test: `tests/v04.test.ts` (extend existing token tests)

Today `verifyAndConsume` always marks the token consumed. The review server's GET handler needs to verify validity (signature / expiry / change_id binding) WITHOUT consuming — the user might just be looking. Consumption should only happen on POST apply/reject. We add a sibling `verifyToken` that returns the payload but doesn't touch the consumed-tokens log.

- [ ] **Step 1: Write failing tests**

Append to `tests/v04.test.ts` inside the existing `describe('approval token: ...')` block (or add a new describe):

```typescript
describe('approval token: verify without consume', () => {
  it('verifyToken returns payload without marking consumed', async () => {
    const { verifyToken, verifyAndConsume } = await import('../src/core/approval-token.ts');
    const { token } = issueToken({ change_id: 'cp-vw', issued_by: 'test' });
    // verify, twice — should not be consumed by either
    const p1 = verifyToken({ token, change_id: 'cp-vw', required_scope: 'low' });
    expect(p1.change_id).toBe('cp-vw');
    const p2 = verifyToken({ token, change_id: 'cp-vw', required_scope: 'low' });
    expect(p2.jti).toBe(p1.jti);
    // Now consume — first time succeeds
    verifyAndConsume({ token, change_id: 'cp-vw', required_scope: 'low' });
    // After consume, both verifyToken AND verifyAndConsume reject
    expect(() => verifyToken({ token, change_id: 'cp-vw', required_scope: 'low' })).toThrow();
    expect(() => verifyAndConsume({ token, change_id: 'cp-vw', required_scope: 'low' })).toThrow();
  });

  it('verifyToken still rejects expired / wrong change_id / bad sig', () => {
    const { verifyToken } = require('../src/core/approval-token.ts');
    const { token } = issueToken({ change_id: 'cp-vw2', issued_by: 'test', expires_in_ms: -1 });
    expect(() => verifyToken({ token, change_id: 'cp-vw2', required_scope: 'low' })).toThrow(); // expired
    const { token: t2 } = issueToken({ change_id: 'cp-other', issued_by: 'test' });
    expect(() => verifyToken({ token: t2, change_id: 'cp-vw2', required_scope: 'low' })).toThrow(); // wrong change_id
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/v04.test.ts -t "verify without consume"`
Expected: FAIL — `verifyToken` not exported.

- [ ] **Step 3: Refactor `approval-token.ts` to expose `verifyToken`**

In `src/core/approval-token.ts`, refactor `verifyAndConsume` so the validity-checking lives in a private helper, and `verifyToken` calls only that helper while `verifyAndConsume` calls helper + `markConsumed`. Replace the existing `verifyAndConsume` with:

```typescript
/** Verify validity without consuming. Throws TokenError on any failure
 *  EXCEPT 'consumed' is also reported (we look up the consumed-log). */
export function verifyToken(args: {
  token: string;
  change_id: string;
  required_scope: Risk;
}): TokenPayload {
  return verifyCore(args);
}

/** Verify and mark single-use consumed. Existing public surface. */
export function verifyAndConsume(args: {
  token: string;
  change_id: string;
  required_scope: Risk;
}): TokenPayload {
  const payload = verifyCore(args);
  markConsumed(payload.jti);
  return payload;
}

function verifyCore(args: {
  token: string;
  change_id: string;
  required_scope: Risk;
}): TokenPayload {
  const parts = args.token.split('.');
  if (parts.length !== 2) throw new TokenError('malformed');
  const [payloadB64, sigB64] = parts;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64!).toString('utf8')) as TokenPayload;
  } catch {
    throw new TokenError('malformed');
  }
  const payloadJson = JSON.stringify(payload);
  const expectedSig = createHmac('sha256', loadOrCreateSecret()).update(payloadJson).digest();
  const givenSig = b64urlDecode(sigB64!);
  if (expectedSig.length !== givenSig.length || !timingSafeEqual(expectedSig, givenSig)) {
    throw new TokenError('invalid_sig');
  }
  if (new Date(payload.exp).getTime() < Date.now()) throw new TokenError('expired');
  if (payload.change_id !== args.change_id) throw new TokenError('wrong_change_id');
  const order: Risk[] = ['low', 'medium', 'high'];
  if (order.indexOf(args.required_scope) > order.indexOf(payload.scope)) {
    throw new TokenError('insufficient_scope');
  }
  if (isConsumed(payload.jti)) throw new TokenError('consumed');
  return payload;
}
```

(Delete the inline body of the old `verifyAndConsume`; the helper takes its place.)

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/v04.test.ts`
Expected: PASS — including the existing token tests AND the new ones.

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/approval-token.ts tests/v04.test.ts
git commit -m "feat(core): verifyToken — validity check without consuming

Review server GET handlers need to render diffs from a token without
burning its single-use credit. POST handlers (apply/reject) keep using
verifyAndConsume. Same TokenError reasons; consumption is the only
difference."
```

---

## Task 9: Review server scaffold (bun.serve) + token-gated GET /p/:id

**Files:**
- Create: `src/review-server.ts`
- Test: `tests/review-server.test.ts`

bun.serve scaffold; GET route only in this task. localhost-only bind via `hostname: '127.0.0.1'`. Port 0 = OS-assigned ephemeral port. Tests fetch via the `Bun.serve` instance's `port` property.

- [ ] **Step 1: Write failing test**

Create `tests/review-server.test.ts`:

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFromChannel } from '../src/runtime.ts';
import { issueToken } from '../src/core/approval-token.ts';
import { startReviewServer, type ReviewServerHandle } from '../src/review-server.ts';

const SCHEMA = `---
type: meta
---

# T

| dir         | human | agent |
|-------------|-------|-------|
| raw/        | add   | add   |
| 06 Hearth Inbox/ | rw | rw |
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-rs-vault-'));
  for (const d of ['raw', '06 Hearth Inbox']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}
function makeStateDir(): string { return mkdtempSync(join(tmpdir(), 'hearth-rs-state-')); }

let handle: ReviewServerHandle | null = null;
afterEach(() => { handle?.stop(); handle = null; });

describe('review-server: GET /p/:id', () => {
  it('renders the HTML diff page with a valid token', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'm1', from: 'me', text: 'hello body',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const url = `http://127.0.0.1:${handle.port}/p/${r.change_id}?t=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(r.change_id!);
    expect(html).toContain('hello body'); // body preview is rendered
  });

  it('returns 403 STALE_TOKEN page when token is missing', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/anything`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('STALE_TOKEN');
  });

  it('returns 403 STALE_TOKEN page when token is invalid', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/anything?t=bogus`);
    expect(res.status).toBe(403);
  });

  it('GET does NOT consume the token (subsequent verifyAndConsume still works)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'm2', from: 'me', text: 'two',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    // GET twice — both should succeed (no consumption)
    const u = `http://127.0.0.1:${handle.port}/p/${r.change_id}?t=${encodeURIComponent(token)}`;
    expect((await fetch(u)).status).toBe(200);
    expect((await fetch(u)).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/review-server.test.ts`
Expected: FAIL — `src/review-server.ts` does not exist.

- [ ] **Step 3: Implement `src/review-server.ts`**

```typescript
// review-server — local HTTP surface for capability-URL plan review.
//
// localhost-only bind. Three routes (GET/POST/POST) all token-gated:
//   GET  /p/:id?t=…       → render PlanReview HTML
//   POST /p/:id/apply?t=… → kernel apply (consumes token)
//   POST /p/:id/reject?t=…→ mark rejected (consumes token)
//
// The tunnel is the only path to this server from outside; the server
// binds 127.0.0.1 and refuses cross-origin POSTs that don't carry a token.
//
// v1 implements GET + STALE_TOKEN handling. POST routes land in subsequent
// tasks.

import { join } from 'node:path';
import { PendingStore } from './core/pending-store.ts';
import { renderPlanReview } from './core/plan-review.ts';
import { verifyToken, TokenError } from './core/approval-token.ts';

export interface ReviewServerOptions {
  /** 0 = OS-assigned ephemeral port. */
  port: number;
  vaultRoot: string;
  hearthStateDir?: string;
  /** Override the public base URL the page renders into form actions
   *  (when behind a tunnel, this is the *.trycloudflare.com URL). */
  publicBase?: string;
}

export interface ReviewServerHandle {
  port: number;
  stop(): void;
}

const PATH_RE = /^\/p\/([^/?#]+)(?:\/(apply|reject))?$/;

function staleTokenPage(reason: string): Response {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>hearth · STALE_TOKEN</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 560px; margin: 4rem auto; padding: 0 1.25rem; color: #1c1c1e; }
  h1 { font-size: 1.125rem; font-weight: 600; }
  p { color: #666; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.875em; background: #f0f0f0; padding: 0 0.2em; border-radius: 2px; }
</style></head>
<body>
  <h1>hearth · STALE_TOKEN</h1>
  <p>This link is no longer valid (<code>${reason}</code>).</p>
  <p>Wait for the next pending notification — it will include a fresh link.</p>
</body></html>`;
  return new Response(body, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function startReviewServer(opts: ReviewServerOptions): ReviewServerHandle {
  const stateDir = opts.hearthStateDir;
  const store = new PendingStore(stateDir ? join(stateDir, 'pending') : undefined);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    fetch(req): Response | Promise<Response> {
      const url = new URL(req.url);
      const m = PATH_RE.exec(url.pathname);
      if (!m) return new Response('not found', { status: 404 });
      const [, changeId, action] = m;
      const token = url.searchParams.get('t') ?? '';

      if (req.method === 'GET' && !action) {
        try {
          verifyToken({ token, change_id: changeId!, required_scope: 'low' });
        } catch (e) {
          return staleTokenPage(e instanceof TokenError ? e.reason : 'invalid');
        }
        let plan;
        try { plan = store.load(changeId!); }
        catch { return new Response('plan not found', { status: 404 }); }
        const out = renderPlanReview(plan, {
          format: 'html',
          capabilityToken: token,
          capabilityBase: opts.publicBase,
        });
        return new Response(out.html!, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      // POST routes land in later tasks
      return new Response('not implemented yet', { status: 501 });
    },
  });

  return {
    port: server.port,
    stop() { server.stop(); },
  };
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/review-server.test.ts`
Expected: PASS, all 4 cases.

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: 0 errors. (Note: `Bun.serve` types are provided by `@types/bun`, already in devDeps.)

- [ ] **Step 6: Commit**

```bash
git add src/review-server.ts tests/review-server.test.ts
git commit -m "feat: review-server scaffold + GET /p/:id

bun.serve, 127.0.0.1 bind, capability-URL gated. GET renders the HTML
PlanReview without consuming the token (verifyToken not verifyAndConsume).
STALE_TOKEN returns a calm error page, not a stack trace. POST routes
land in the next tasks."
```

---

## Task 10: Review server POST /p/:id/apply

**Files:**
- Modify: `src/review-server.ts`
- Modify: `tests/review-server.test.ts`

POST consumes the token and applies the plan via the existing kernel pipeline. Audit log entries are written exactly as the existing channel-apply path. High-risk plans require a `confirm=true` form field — without it, the response is a confirmation prompt page rather than an apply.

- [ ] **Step 1: Write failing tests**

Append to `tests/review-server.test.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { auditLogPath } from '../src/core/audit.ts';

describe('review-server: POST /p/:id/apply', () => {
  it('applies the plan and writes vault file', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'apply-1', from: 'me', text: 'apply me',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/p/${r.change_id}/apply?t=${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    // Audit log should have changeplan.applied
    const auditEntries = readFileSync(auditLogPath(vault), 'utf8').split('\n').filter(Boolean);
    expect(auditEntries.some(l => l.includes('changeplan.applied'))).toBe(true);
    expect(auditEntries.some(l => l.includes('approval_token.consumed'))).toBe(true);
  });

  it('rejects POST apply without token', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/whatever/apply`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('consumes the token (second apply with same token returns STALE_TOKEN)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'apply-2', from: 'me', text: 'apply twice',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const u = `http://127.0.0.1:${handle.port}/p/${r.change_id}/apply?t=${encodeURIComponent(token)}`;
    expect((await fetch(u, { method: 'POST' })).status).toBe(200);
    expect((await fetch(u, { method: 'POST' })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/review-server.test.ts -t "POST /p/:id/apply"`
Expected: FAIL — current handler returns 501.

- [ ] **Step 3: Wire POST apply into the handler**

In `src/review-server.ts`, replace the placeholder POST branch with:

```typescript
      if (req.method === 'POST' && action === 'apply') {
        return handleApply(opts, store, changeId!, token);
      }
      if (req.method === 'POST' && action === 'reject') {
        return handleReject(opts, store, changeId!, token);
      }
      return new Response('not found', { status: 404 });
```

Add at top of file:

```typescript
import { verifyAndConsume } from './core/approval-token.ts';
import { loadSchema, SchemaError } from './core/schema.ts';
import { createKernel } from './core/vault-kernel.ts';
import { audit } from './core/audit.ts';
import { classifyRisk } from './core/risk-classifier.ts';
import type { Risk } from './core/types.ts';
```

Add helpers below `staleTokenPage`:

```typescript
function successPage(message: string): Response {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>hearth · ok</title>
<style>body{font-family:-apple-system,sans-serif;max-width:560px;margin:4rem auto;padding:0 1.25rem;color:#1c1c1e}h1{font-size:1.125rem;font-weight:600}p{color:#666}</style>
</head><body><h1>hearth</h1><p>${message}</p></body></html>`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function errorPage(status: number, title: string, detail: string): Response {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>hearth · ${title}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:560px;margin:4rem auto;padding:0 1.25rem;color:#1c1c1e}h1{font-size:1.125rem;font-weight:600}p{color:#666}code{font-family:ui-monospace,Menlo,monospace;font-size:.875em;background:#f0f0f0;padding:0 .2em;border-radius:2px}</style>
</head><body><h1>hearth · ${title}</h1><p>${detail}</p></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function handleApply(
  opts: ReviewServerOptions,
  store: PendingStore,
  changeId: string,
  token: string,
): Promise<Response> {
  let plan;
  try { plan = store.load(changeId); }
  catch { return errorPage(404, 'plan not found', `pending plan <code>${changeId}</code> not found`); }
  const requiredScope: Risk = classifyRisk(plan);
  let payload;
  try {
    payload = verifyAndConsume({ token, change_id: changeId, required_scope: requiredScope });
  } catch (e) {
    void audit(opts.vaultRoot, {
      event: 'approval_token.rejected',
      initiated_by: 'review-server',
      data: { change_id: changeId, reason: (e as Error).message },
    });
    return staleTokenPage((e as Error).message);
  }
  void audit(opts.vaultRoot, {
    event: 'approval_token.consumed',
    initiated_by: 'review-server',
    data: { change_id: changeId, jti: payload.jti },
  });
  let schema;
  try { schema = loadSchema(opts.vaultRoot); }
  catch (e) {
    if (e instanceof SchemaError) return errorPage(500, 'no SCHEMA.md', e.message);
    throw e;
  }
  const kernel = createKernel(opts.vaultRoot, schema);
  const result = kernel.apply(plan);
  if (result.ok) {
    store.remove(changeId);
    void audit(opts.vaultRoot, {
      event: 'changeplan.applied',
      initiated_by: 'review-server',
      data: { change_id: changeId, ops: result.ops.length },
    });
    return successPage(`applied <code>${changeId}</code> — ${result.ops.length} op${result.ops.length === 1 ? '' : 's'} written.`);
  }
  void audit(opts.vaultRoot, {
    event: 'changeplan.rejected',
    initiated_by: 'review-server',
    data: { change_id: changeId, error: result.error },
  });
  return errorPage(409, 'apply failed', result.error ?? 'kernel rejected');
}

async function handleReject(
  _opts: ReviewServerOptions,
  _store: PendingStore,
  _changeId: string,
  _token: string,
): Promise<Response> {
  return new Response('not implemented yet', { status: 501 });
}
```

(Note `handleReject` lands in the next task.)

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/review-server.test.ts -t "POST /p/:id/apply"`
Expected: PASS, all 3 new cases. Existing GET cases must also still pass — run the full file:

Run: `bun run test tests/review-server.test.ts`

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/review-server.ts tests/review-server.test.ts
git commit -m "feat: review-server POST /p/:id/apply with token consumption

verifyAndConsume → kernel.apply → audit. Token-gated; classifies risk
kernel-side and demands matching scope. Audits changeplan.applied,
approval_token.consumed, and approval_token.rejected paths."
```

---

## Task 11: Review server POST /p/:id/reject

**Files:**
- Modify: `src/review-server.ts`
- Modify: `tests/review-server.test.ts`

Reject removes the plan from pending and audits. Token still consumed (single-use even on reject — it was a credential for *this decision moment*).

- [ ] **Step 1: Write failing test**

Append to `tests/review-server.test.ts`:

```typescript
describe('review-server: POST /p/:id/reject', () => {
  it('removes the plan from pending and audits changeplan.rejected', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'rej-1', from: 'me', text: 'reject me',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/p/${r.change_id}/reject?t=${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    // plan gone from pending
    const store2 = new (await import('../src/core/pending-store.ts')).PendingStore(join(stateDir, 'pending'));
    expect(() => store2.load(r.change_id!)).toThrow();
    // audit recorded changeplan.rejected
    const lines = readFileSync(auditLogPath(vault), 'utf8').split('\n').filter(Boolean);
    expect(lines.some(l => l.includes('changeplan.rejected'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/review-server.test.ts -t "POST /p/:id/reject"`
Expected: FAIL — handler returns 501.

- [ ] **Step 3: Implement `handleReject`**

Replace the stub `handleReject` in `src/review-server.ts` with:

```typescript
async function handleReject(
  opts: ReviewServerOptions,
  store: PendingStore,
  changeId: string,
  token: string,
): Promise<Response> {
  let plan;
  try { plan = store.load(changeId); }
  catch { return errorPage(404, 'plan not found', `pending plan <code>${changeId}</code> not found`); }
  // Reject classified at low scope: the human is declining; we don't need
  // high-scope authority to drop a plan.
  let payload;
  try { payload = verifyAndConsume({ token, change_id: changeId, required_scope: 'low' }); }
  catch (e) {
    void audit(opts.vaultRoot, {
      event: 'approval_token.rejected',
      initiated_by: 'review-server',
      data: { change_id: changeId, reason: (e as Error).message },
    });
    return staleTokenPage((e as Error).message);
  }
  void audit(opts.vaultRoot, {
    event: 'approval_token.consumed',
    initiated_by: 'review-server',
    data: { change_id: changeId, jti: payload.jti },
  });
  store.remove(changeId);
  void audit(opts.vaultRoot, {
    event: 'changeplan.rejected',
    initiated_by: 'review-server',
    data: { change_id: changeId, ops: plan.ops.length, reason: 'user_rejected' },
  });
  return successPage(`rejected <code>${changeId}</code>.`);
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/review-server.test.ts`
Expected: PASS, all cases (GET, POST apply, POST reject).

- [ ] **Step 5: Type check + commit**

```bash
bun run typecheck
git add src/review-server.ts tests/review-server.test.ts
git commit -m "feat: review-server POST /p/:id/reject

Removes plan from pending, audits changeplan.rejected, consumes token.
Reject is always low-scope — we don't need apply-level authority to
drop a plan."
```

---

## Task 12: TunnelBackend interface + `CloudflareQuickTunnel` implementation

**Files:**
- Create: `src/tunnel.ts`
- Test: `tests/tunnel.test.ts`

`TunnelBackend` is a simple interface; `CloudflareQuickTunnel` is the only v1 impl. Spawns `cloudflared tunnel --url http://127.0.0.1:<port>`, parses `https://*.trycloudflare.com` from stdout/stderr, exposes `start()` / `stop()`. Tests use a fake script that prints a URL and waits for SIGTERM.

- [ ] **Step 1: Create the fake cloudflared script**

Create `tests/fixtures/fake-cloudflared.sh`:

```bash
#!/usr/bin/env bash
# Fake cloudflared for tests. Prints a sentinel URL line within 100ms,
# then sits until killed.
set -e
echo "INF Requesting new quick Tunnel on trycloudflare.com..."
sleep 0.05
echo "Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):"
echo "https://fake-tunnel-test.trycloudflare.com"
# Stay alive
sleep 30 &
wait
```

```bash
chmod +x tests/fixtures/fake-cloudflared.sh
```

- [ ] **Step 2: Write failing test**

Create `tests/tunnel.test.ts`:

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareQuickTunnel } from '../src/tunnel.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(__dirname, 'fixtures', 'fake-cloudflared.sh');

let tunnel: CloudflareQuickTunnel | null = null;
afterEach(async () => { await tunnel?.stop(); tunnel = null; });

describe('CloudflareQuickTunnel', () => {
  it('spawns cloudflared, parses the URL, and exposes it', async () => {
    tunnel = new CloudflareQuickTunnel({ binary: FAKE, localPort: 12345 });
    const url = await tunnel.start({ timeoutMs: 2000 });
    expect(url).toBe('https://fake-tunnel-test.trycloudflare.com');
    expect(tunnel.url).toBe(url);
  });

  it('rejects start() if cloudflared exits early', async () => {
    tunnel = new CloudflareQuickTunnel({ binary: '/bin/false', localPort: 12345 });
    await expect(tunnel.start({ timeoutMs: 500 })).rejects.toThrow();
  });

  it('rejects start() on timeout if URL never appears', async () => {
    tunnel = new CloudflareQuickTunnel({ binary: '/bin/sh', localPort: 12345, args: ['-c', 'sleep 10'] });
    await expect(tunnel.start({ timeoutMs: 100 })).rejects.toThrow(/timeout/);
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `bun run test tests/tunnel.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `src/tunnel.ts`**

```typescript
// Tunnel manager — exposes the local review-server to the public internet
// via Cloudflare Quick Tunnel (`cloudflared tunnel --url http://127.0.0.1:N`).
//
// v1 ships exactly one backend (`CloudflareQuickTunnel`); the interface is
// preserved so future ngrok / Tailscale / bore backends are additive, not
// rewrites. Per spec §10: do not pre-build a plugin system — interface +
// one impl, more later only on real demand.
//
// The cloudflared process is spawned by the tunnel manager; its stdout is
// scraped for the *.trycloudflare.com URL. cloudflared exits → tunnel.url
// becomes null and the manager surfaces the failure.

import { spawn, type ChildProcess } from 'node:child_process';

export interface TunnelStartOptions {
  /** Reject if URL has not appeared by this many ms after spawn. */
  timeoutMs?: number;
}

export interface TunnelBackend {
  url: string | null;
  start(opts?: TunnelStartOptions): Promise<string>;
  stop(): Promise<void>;
}

export interface CloudflareQuickTunnelOptions {
  /** Path to cloudflared binary; default `cloudflared` (looked up on PATH). */
  binary?: string;
  /** Override args for testing. Default: ['tunnel','--url','http://127.0.0.1:<port>']. */
  args?: string[];
  /** localhost port the tunnel forwards to. */
  localPort: number;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class CloudflareQuickTunnel implements TunnelBackend {
  url: string | null = null;
  private proc: ChildProcess | null = null;

  constructor(private readonly opts: CloudflareQuickTunnelOptions) {}

  start(startOpts: TunnelStartOptions = {}): Promise<string> {
    const timeoutMs = startOpts.timeoutMs ?? 10_000;
    const binary = this.opts.binary ?? 'cloudflared';
    const args = this.opts.args ?? ['tunnel', '--url', `http://127.0.0.1:${this.opts.localPort}`];

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        reject(new Error(`tunnel start timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const onChunk = (buf: Buffer) => {
        const m = URL_RE.exec(buf.toString());
        if (m) {
          this.url = m[0];
          clearTimeout(timer);
          resolve(this.url);
        }
      };
      proc.stdout?.on('data', onChunk);
      proc.stderr?.on('data', onChunk);
      proc.on('exit', code => {
        if (this.url === null) {
          clearTimeout(timer);
          reject(new Error(`cloudflared exited (code=${code}) before URL appeared`));
        } else {
          // Mid-flight exit: surface for the manager to handle.
          this.url = null;
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      await new Promise<void>(r => {
        if (!this.proc) return r();
        this.proc.on('exit', () => r());
        // Hard fallback in case SIGTERM is ignored
        setTimeout(() => { try { this.proc?.kill('SIGKILL'); } catch {} r(); }, 1500);
      });
    }
    this.proc = null;
    this.url = null;
  }
}
```

- [ ] **Step 5: Run, confirm pass**

Run: `bun run test tests/tunnel.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 6: Type check + commit**

```bash
bun run typecheck
git add src/tunnel.ts tests/tunnel.test.ts tests/fixtures/fake-cloudflared.sh
git commit -m "feat: TunnelBackend interface + CloudflareQuickTunnel impl

Spawns cloudflared, scrapes the *.trycloudflare.com URL from stdout/stderr,
exposes start/stop. Test rig uses a fake cloudflared script; CI does not
require the real binary. Future ngrok/Tailscale backends slot into the
same interface — but no plugin system yet (one impl, real demand only)."
```

---

## Task 13: `hearth doctor` detects missing `cloudflared`

**Files:**
- Modify: `src/cli/doctor.ts`
- Modify: `tests/setup.test.ts` or add new test (whichever covers doctor)

Doctor is read-only; it adds a check for `cloudflared` presence and prints a brief install hint when missing. Detection via `which cloudflared` (cross-platform: `which` exists on macOS/Linux; on Windows we can fall back to `where`, but hearth currently doesn't claim Windows support — keep simple).

- [ ] **Step 1: Find / write the test**

Look for the existing doctor test file:

Run: `grep -rln "runDoctor\|describe.*doctor" tests/`

If a `doctor` test already exists, append to it. If not, append to `tests/setup.test.ts`. Add test:

```typescript
import { runDoctor } from '../src/cli/doctor.ts';
// (... reuse existing makeVault helper or paste)

describe('doctor: cloudflared check', () => {
  it('reports cloudflared present when on PATH (or absent with install hint)', () => {
    const vault = makeVault();
    const report = runDoctor(vault);
    const cf = report.checks.find(c => c.name.toLowerCase().includes('cloudflared'));
    expect(cf).toBeDefined();
    if (!cf!.ok) {
      expect(cf!.detail).toMatch(/install/i);
    }
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test -t "cloudflared check"`
Expected: FAIL — no such check produced.

- [ ] **Step 3: Add the check to `src/cli/doctor.ts`**

After the existing checks (e.g. after the claim-index check), append:

```typescript
  // 6. cloudflared on PATH (mobile review surface dependency)
  try {
    const { execSync } = await import('node:child_process');
    execSync('which cloudflared', { stdio: 'ignore' });
    checks.push({ name: 'cloudflared on PATH', ok: true });
  } catch {
    checks.push({
      name: 'cloudflared on PATH',
      ok: false,
      detail: 'cloudflared is required for hearth review (mobile diff URL). Install: `brew install cloudflared` (macOS) or `npm i -g cloudflared`. Without it, channel ingest still works; only the review surface is unreachable.',
    });
  }
```

If `runDoctor` is currently synchronous, switch the failing-cloudflared check to a synchronous form using `execSync` already imported synchronously (move `import { execSync } from 'node:child_process'` to the top of the file as a static import). Verify the existing `runDoctor` signature doesn't break — if it returns synchronously, keep it synchronous.

Final import to add to top of `src/cli/doctor.ts`:

```typescript
import { execSync } from 'node:child_process';
```

…and change the snippet to:

```typescript
  // 6. cloudflared on PATH (mobile review surface dependency)
  try {
    execSync('which cloudflared', { stdio: 'ignore' });
    checks.push({ name: 'cloudflared on PATH', ok: true });
  } catch {
    checks.push({
      name: 'cloudflared on PATH',
      ok: false,
      detail: 'cloudflared is required for hearth review (mobile diff URL). Install: `brew install cloudflared` (macOS) or `npm i -g cloudflared`. Without it, channel ingest still works; only the review surface is unreachable.',
    });
  }
```

A failing cloudflared check should NOT mark the whole report `ok: false` (channel ingest still works without it). If `runDoctor` aggregates `ok` as `every check ok`, change it to allow the cloudflared check to be advisory:

```typescript
  return { ok: checks.filter(c => c.name !== 'cloudflared on PATH').every(c => c.ok), checks };
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test -t "cloudflared check"`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/doctor.ts tests/*.test.ts
git commit -m "feat(doctor): cloudflared on PATH check + install hint

Advisory: missing cloudflared does NOT fail the report (ingest still
works). Just nudges the user when the mobile review surface dependency
is missing."
```

---

## Task 14: Tunnel manager — shared tunnel, refcounted, idle close

**Files:**
- Create: `src/tunnel-manager.ts`
- Test: `tests/tunnel-manager.test.ts`

Per spec §10: one shared tunnel per hearth process, alive while any plan pending, closes after 10-min idle. The manager owns the tunnel lifecycle and exposes `ensureUrl(localPort)` for callers. Multiple concurrent callers share the same tunnel.

- [ ] **Step 1: Write failing test**

Create `tests/tunnel-manager.test.ts`:

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TunnelManager } from '../src/tunnel-manager.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(__dirname, 'fixtures', 'fake-cloudflared.sh');

let mgr: TunnelManager | null = null;
afterEach(async () => { await mgr?.close(); mgr = null; });

describe('TunnelManager: shared tunnel + refcount', () => {
  it('ensureUrl returns the same URL on repeated calls', async () => {
    mgr = new TunnelManager({ binary: FAKE, localPort: 12345, idleCloseMs: 60_000 });
    const u1 = await mgr.ensureUrl();
    const u2 = await mgr.ensureUrl();
    expect(u1).toBe(u2);
    expect(u1).toMatch(/trycloudflare\.com/);
  });

  it('idle close: tunnel stops after idleCloseMs of zero pending plans', async () => {
    mgr = new TunnelManager({ binary: FAKE, localPort: 12345, idleCloseMs: 50 });
    await mgr.ensureUrl();
    mgr.notePlanCount(0);
    await new Promise(r => setTimeout(r, 120));
    expect(mgr.isLive()).toBe(false);
  });

  it('does NOT close while plans remain pending', async () => {
    mgr = new TunnelManager({ binary: FAKE, localPort: 12345, idleCloseMs: 50 });
    await mgr.ensureUrl();
    mgr.notePlanCount(2);
    await new Promise(r => setTimeout(r, 120));
    expect(mgr.isLive()).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/tunnel-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/tunnel-manager.ts`**

```typescript
// TunnelManager — single shared tunnel per hearth process.
//
// Spawns a CloudflareQuickTunnel on first ensureUrl(); reuses it for
// subsequent calls. Closes the tunnel after `idleCloseMs` elapse with
// notePlanCount(0) — the surface (channel ingest, CLI) reports the current
// pending count after each operation; tunnel sleeps when there's nothing
// to review.

import { CloudflareQuickTunnel } from './tunnel.ts';

export interface TunnelManagerOptions {
  binary?: string;
  localPort: number;
  /** Close tunnel after this many ms of zero pending plans. Default 10 min. */
  idleCloseMs?: number;
  /** Test seam: override args. */
  args?: string[];
}

export class TunnelManager {
  private tunnel: CloudflareQuickTunnel | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPending = Number.POSITIVE_INFINITY; // until first notePlanCount

  constructor(private readonly opts: TunnelManagerOptions) {}

  async ensureUrl(): Promise<string> {
    if (this.tunnel?.url) return this.tunnel.url;
    this.tunnel = new CloudflareQuickTunnel({
      binary: this.opts.binary,
      localPort: this.opts.localPort,
      args: this.opts.args,
    });
    const url = await this.tunnel.start({ timeoutMs: 15_000 });
    this.scheduleIdleCheck();
    return url;
  }

  notePlanCount(n: number): void {
    this.currentPending = n;
    this.scheduleIdleCheck();
  }

  isLive(): boolean { return this.tunnel?.url != null; }

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    await this.tunnel?.stop();
    this.tunnel = null;
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.isLive()) return;
    if (this.currentPending > 0) return;
    const ms = this.opts.idleCloseMs ?? 10 * 60_000;
    this.idleTimer = setTimeout(() => { void this.close(); }, ms);
  }
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/tunnel-manager.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Type check + commit**

```bash
bun run typecheck
git add src/tunnel-manager.ts tests/tunnel-manager.test.ts
git commit -m "feat: TunnelManager — shared cloudflared tunnel with idle close

One tunnel per hearth process. ensureUrl returns the same URL on
repeated calls; notePlanCount(0) starts an idle timer that closes
the tunnel after 10 min of inactivity."
```

---

## Task 15: `ChannelIngestResult.review_url` — runtime API

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/channel-review.test.ts`

`ingestFromChannel` accepts an optional `tunnelManager` and, when present, includes the capability URL in the result. Channel adapter (wechat-cc) calls `ingestFromChannel` with a manager wired to a running review server.

- [ ] **Step 1: Write failing test**

Append to `tests/channel-review.test.ts`:

```typescript
import { startReviewServer } from '../src/review-server.ts';
import { TunnelManager } from '../src/tunnel-manager.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CF = resolve(__dirname, 'fixtures', 'fake-cloudflared.sh');

describe('ingestFromChannel emits review_url when a tunnel manager is provided', () => {
  it('result.review_url is a /p/:change_id?t=<token> URL on the tunnel host', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const server = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const mgr = new TunnelManager({ binary: FAKE_CF, localPort: server.port, idleCloseMs: 60_000 });
    try {
      const r = await ingestFromChannel(
        { channel: 'cli', message_id: 'rurl-1', from: 'me', text: 'hello world',
          received_at: new Date().toISOString() },
        { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir, tunnelManager: mgr },
      );
      expect(r.ok).toBe(true);
      expect(r.review_url).toBeDefined();
      expect(r.review_url).toMatch(/trycloudflare\.com\/p\/[^?]+\?t=/);
      expect(r.review_url).toContain(r.change_id!);
    } finally {
      await mgr.close();
      server.stop();
    }
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/channel-review.test.ts -t "review_url"`
Expected: FAIL.

- [ ] **Step 3: Wire in runtime**

In `src/runtime.ts`:

Add to the existing `ChannelIngestOptions` interface:

```typescript
  /** Optional tunnel manager — when present, the result includes a
   *  capability URL (review_url) the channel adapter can deliver. */
  tunnelManager?: { ensureUrl(): Promise<string>; notePlanCount(n: number): void };
```

Add to `ChannelIngestResult`:

```typescript
  /** Capability URL for human review of this plan (token-bound, single-use,
   *  ttl ~5 min). Set only when caller provided a tunnelManager. */
  review_url?: string;
```

Add import at top of `src/runtime.ts`:

```typescript
import { issueToken } from './core/approval-token.ts';
```

In `ingestFromChannel`, after `const savedPath = store.save(plan);` and before constructing the summary, add:

```typescript
  // Optional capability URL for the review surface.
  let reviewUrl: string | undefined;
  if (opts.tunnelManager) {
    try {
      const tunnelUrl = await opts.tunnelManager.ensureUrl();
      const { token } = issueToken({ change_id: plan.change_id, issued_by: `channel:${msg.channel}` });
      reviewUrl = `${tunnelUrl}/p/${encodeURIComponent(plan.change_id)}?t=${encodeURIComponent(token)}`;
      // Update pending count so the manager keeps the tunnel alive.
      opts.tunnelManager.notePlanCount(store.list().length);
    } catch (e) {
      // Tunnel failure is non-fatal — plan is still pending; user can
      // approve via CLI or wait for the next push.
      reviewUrl = undefined;
    }
  }
```

Then in the return:

```typescript
  return {
    ok: true,
    change_id: plan.change_id,
    pending_path: savedPath,
    risk: plan.risk,
    op_count: plan.ops.length,
    requires_review: plan.requires_review,
    source_path: sourcePath,
    summary,
    review_url: reviewUrl,
  };
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/channel-review.test.ts -t "review_url"`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts tests/channel-review.test.ts
git commit -m "feat(runtime): ingestFromChannel emits review_url via tunnel manager

When the caller passes a TunnelManager, the result carries a capability
URL (host = trycloudflare.com tunnel; token = SPEC §11 HMAC). Channel
adapter (wechat-cc) renders that URL in its outbound message. Tunnel
failure is non-fatal — plan is still pending."
```

---

## Task 16: New minimal channel summary format (drop emoji)

**Files:**
- Modify: `src/runtime.ts` (line ~189 — the `summary` string)
- Modify: `tests/channel-review.test.ts` (existing assertion checks may need updating)

Replace the verbose summary line with the spec §7 format:

```
hearth pending <change_id>
<N> ops · risk=<class> · expires <HH:MM>
<review_url>
```

- [ ] **Step 1: Write failing test**

Append to `tests/channel-review.test.ts`:

```typescript
describe('ingestFromChannel summary format (spec §7)', () => {
  it('summary is plain text, no emoji, includes change_id and op count', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'fmt-1', from: 'me', text: 'plain',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji
    expect(r.summary).toContain(r.change_id!);
    expect(r.summary).toMatch(/\d+ ops?/);
    expect(r.summary).toContain(`risk=${r.risk}`);
  });

  it('summary includes review_url on its own line when tunnel present', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const server = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const mgr = new TunnelManager({ binary: FAKE_CF, localPort: server.port, idleCloseMs: 60_000 });
    try {
      const r = await ingestFromChannel(
        { channel: 'cli', message_id: 'fmt-2', from: 'me', text: 'with url',
          received_at: new Date().toISOString() },
        { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir, tunnelManager: mgr },
      );
      expect(r.review_url).toBeDefined();
      expect(r.summary).toContain(r.review_url!);
    } finally {
      await mgr.close();
      server.stop();
    }
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/channel-review.test.ts -t "summary format"`
Expected: FAIL — current summary uses emoji `📋` and text doesn't match.

- [ ] **Step 3: Update the summary-construction block**

Replace the current `const summary = ...` line in `ingestFromChannel`:

```typescript
  const lines = [
    `hearth pending ${plan.change_id}`,
    `${plan.ops.length} op${plan.ops.length === 1 ? '' : 's'} · risk=${plan.risk}${plan.requires_review ? ' · review' : ''}`,
  ];
  if (reviewUrl) lines.push(reviewUrl);
  const summary = lines.join('\n');
```

(Keep the rest of the return shape unchanged.)

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/channel-review.test.ts`
Expected: PASS, all cases. (Older assertions that grep for `📋` or `apply via:` may need a small update — the test output will tell you.)

If older `it` cases assert the legacy summary substring, update them to match the new format. Don't keep both formats.

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun run test && bun run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts tests/channel-review.test.ts
git commit -m "refactor(runtime): plain-text channel summary format

No emoji, no 'apply via' prose. Three lines max: id / counts / URL.
Spec §7 aesthetic restraint applied at the channel surface."
```

---

## Task 17: CLI — `hearth review start`

**Files:**
- Modify: `src/cli/index.ts`
- Test: manual + `tests/cli-review.test.ts` (smoke)

`hearth review start` boots a review-server and a TunnelManager (with a sentinel print of the URL), then keeps the process alive until SIGINT. Useful for "open a session, hand the URL out, watch the audit log scroll".

- [ ] **Step 1: Write smoke test**

Create `tests/cli-review.test.ts`:

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = `---\ntype: meta\n---\n\n| dir | human | agent |\n|--|--|--|\n| raw/ | add | add |\n| 06 Hearth Inbox/ | rw | rw |\n`;
const FAKE_CF = resolve(__dirname, 'fixtures', 'fake-cloudflared.sh');
const HEARTH = resolve(__dirname, '..', 'src', 'cli', 'index.ts');

let proc: ChildProcess | null = null;
afterEach(() => { try { proc?.kill('SIGTERM'); } catch {} proc = null; });

describe('CLI: hearth review start', () => {
  it('prints the trycloudflare URL on stdout', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'hearth-cli-rev-'));
    mkdirSync(join(vault, 'raw'), { recursive: true });
    mkdirSync(join(vault, '06 Hearth Inbox'), { recursive: true });
    writeFileSync(join(vault, 'SCHEMA.md'), SCHEMA);

    proc = spawn('bun', [HEARTH, 'review', 'start', '--vault', vault], {
      env: { ...process.env, HEARTH_TUNNEL_BINARY: FAKE_CF },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = await new Promise<string>((resolveP, reject) => {
      const timer = setTimeout(() => reject(new Error('no URL printed within 3s')), 3000);
      proc!.stdout!.on('data', (b: Buffer) => {
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(b.toString());
        if (m) { clearTimeout(timer); resolveP(m[0]); }
      });
    });
    expect(url).toMatch(/trycloudflare\.com$/);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/cli-review.test.ts`
Expected: FAIL — `review` is an unknown command.

- [ ] **Step 3: Add the command in `src/cli/index.ts`**

Add helper at top (with imports):

```typescript
import { startReviewServer } from '../review-server.ts';
import { TunnelManager } from '../tunnel-manager.ts';
```

Add a new function near the other `cmd*` functions:

```typescript
async function cmdReview(positionals: string[], values: Record<string, string | boolean | undefined>): Promise<void> {
  const sub = positionals[0];
  if (sub !== 'start') fail(`review: unknown subcommand "${sub}". expected: start`);
  const vault = resolve((values.vault as string) ?? process.cwd());
  const stateDir = (values.stateDir as string) ?? undefined;

  const server = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
  const mgr = new TunnelManager({
    binary: process.env.HEARTH_TUNNEL_BINARY,    // test seam
    localPort: server.port,
    idleCloseMs: 10 * 60_000,
  });
  try {
    const url = await mgr.ensureUrl();
    process.stdout.write(`${url}\n`);
    process.stdout.write(`local server: http://127.0.0.1:${server.port}\n`);
    process.stdout.write(`vault: ${vault}\n`);
    process.stdout.write(`stop with Ctrl-C\n`);
    // Keep alive until SIGINT
    await new Promise<void>(r => {
      process.on('SIGINT', () => r());
      process.on('SIGTERM', () => r());
    });
  } finally {
    await mgr.close();
    server.stop();
  }
}
```

Add to the dispatch switch:

```typescript
    case 'review': void cmdReview(positionals, values); return;
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/cli-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Type check + commit**

```bash
bun run typecheck
git add src/cli/index.ts tests/cli-review.test.ts
git commit -m "feat(cli): hearth review start — boot review-server + tunnel

Prints the *.trycloudflare.com URL and waits on SIGINT. Test seam via
HEARTH_TUNNEL_BINARY env var lets CI use the fake cloudflared script."
```

---

## Task 18: CLI — `hearth pending share <id>`

**Files:**
- Modify: `src/cli/index.ts`
- Test: append to `tests/cli-review.test.ts`

`hearth pending share <id>` issues a capability URL on demand for an existing pending plan. Useful for "I'm at my desk and want to push this plan to my phone right now."

- [ ] **Step 1: Write failing test**

Append to `tests/cli-review.test.ts`:

```typescript
import { ingestFromChannel } from '../src/runtime.ts';

describe('CLI: hearth pending share <id>', () => {
  it('prints a capability URL bound to the pending plan', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'hearth-cli-share-'));
    mkdirSync(join(vault, 'raw'), { recursive: true });
    mkdirSync(join(vault, '06 Hearth Inbox'), { recursive: true });
    writeFileSync(join(vault, 'SCHEMA.md'), SCHEMA);
    const stateDir = mkdtempSync(join(tmpdir(), 'hearth-cli-share-state-'));

    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'share-1', from: 'me', text: 'share me',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );

    // We cannot easily run the server in a child process for this test;
    // instead require the CLI to emit a URL via env-injected tunnel + state dir.
    proc = spawn('bun', [HEARTH, 'pending', 'share', r.change_id!,
                          '--vault', vault, '--state-dir', stateDir],
      { env: { ...process.env, HEARTH_TUNNEL_BINARY: FAKE_CF }, stdio: ['ignore', 'pipe', 'pipe'] });
    const url = await new Promise<string>((resolveP, reject) => {
      const timer = setTimeout(() => reject(new Error('no URL printed within 3s')), 3000);
      proc!.stdout!.on('data', (b: Buffer) => {
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\/p\/[^\s]+/.exec(b.toString());
        if (m) { clearTimeout(timer); resolveP(m[0]); }
      });
    });
    expect(url).toContain(r.change_id!);
    expect(url).toContain('?t=');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/cli-review.test.ts -t "pending share"`
Expected: FAIL.

- [ ] **Step 3: Implement the subcommand**

In `src/cli/index.ts`, extend `cmdPending`:

```typescript
  if (sub === 'share') {
    const id = positionals[1];
    if (!id) fail('pending share: missing <change_id>. usage: hearth pending share <id> [--vault <dir>] [--state-dir <dir>]');
    const vault = resolve((values.vault as string) ?? process.cwd());
    const stateDir = (values.stateDir as string) ?? undefined;
    void (async () => {
      try {
        const server = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
        const mgr = new TunnelManager({
          binary: process.env.HEARTH_TUNNEL_BINARY,
          localPort: server.port, idleCloseMs: 10 * 60_000,
        });
        const tunnelUrl = await mgr.ensureUrl();
        const { token } = issueToken({ change_id: id, issued_by: 'cli:share' });
        const url = `${tunnelUrl}/p/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
        process.stdout.write(`${url}\n`);
        process.stdout.write(`local server: http://127.0.0.1:${server.port}\n`);
        process.stdout.write(`stop with Ctrl-C\n`);
        await new Promise<void>(r => {
          process.on('SIGINT', () => r());
          process.on('SIGTERM', () => r());
        });
        await mgr.close();
        server.stop();
      } catch (e) {
        fail(`pending share: ${(e as Error).message}`);
      }
    })();
    return;
  }
```

Note `parseArgs` needs `--state-dir` support if it doesn't already — extend the option spec at the top of `main()`:

```typescript
    'state-dir': { type: 'string' },
```

In the `cmdPending` body, read it as `values['state-dir']` (kebab-case; accessing `values.stateDir` won't pick it up — adjust the read accordingly).

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/cli-review.test.ts`
Expected: PASS, all CLI tests.

- [ ] **Step 5: Type check + commit**

```bash
bun run typecheck
git add src/cli/index.ts tests/cli-review.test.ts
git commit -m "feat(cli): hearth pending share <id> — issue capability URL

For 'I'm at my desk, push this plan to my phone'. Spawns the same
review-server + tunnel as 'review start' but exits when SIGINT'd.
Useful for one-off shares."
```

---

## Task 19: CLI `pending show` reuses `renderPlanReview`

**Files:**
- Modify: `src/cli/index.ts:160-180` (the existing `pending show` body)
- Test: extend `tests/runtime.test.ts` (or a new `tests/cli-pending.test.ts`)

The existing `pending show` body builds its own diff text inline. Replace with `renderPlanReview(plan, { format: 'ansi' })` to honor the multi-end unification principle: every surface renders from the same canonical source.

- [ ] **Step 1: Write failing test**

Create `tests/cli-pending.test.ts`:

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ingestFromChannel } from '../src/runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = `---\ntype: meta\n---\n\n| dir | human | agent |\n|--|--|--|\n| raw/ | add | add |\n| 06 Hearth Inbox/ | rw | rw |\n`;
const HEARTH = resolve(__dirname, '..', 'src', 'cli', 'index.ts');

describe('CLI: pending show uses renderPlanReview', () => {
  it('output is the ANSI/text render — plain text, no emoji', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'hearth-show-'));
    mkdirSync(join(vault, 'raw'), { recursive: true });
    mkdirSync(join(vault, '06 Hearth Inbox'), { recursive: true });
    writeFileSync(join(vault, 'SCHEMA.md'), SCHEMA);
    const stateDir = mkdtempSync(join(tmpdir(), 'hearth-show-state-'));

    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'show-1', from: 'me', text: 'show me',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );

    const result = spawnSync('bun', [HEARTH, 'pending', 'show', r.change_id!,
                                     '--state-dir', stateDir],
      { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(r.change_id!);
    expect(result.stdout).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(result.stdout).toContain('06 Hearth Inbox/');
    expect(result.stdout).toContain('reason:');
  });
});
```

- [ ] **Step 2: Run, confirm failure or success-by-coincidence**

Run: `bun run test tests/cli-pending.test.ts`
Expected: FAIL or partial — current code might happen to pass, but the goal is to route through `renderPlanReview`. Change the impl regardless.

- [ ] **Step 3: Update `cmdPending` 'show' branch**

Replace the body of the `if (sub === 'show')` block in `src/cli/index.ts` with:

```typescript
  if (sub === 'show') {
    const id = positionals[1];
    if (!id) fail('pending show: missing <change_id>');
    const stateDir = (values['state-dir'] as string) ?? undefined;
    const store = stateDir ? new PendingStore(join(stateDir, 'pending')) : new PendingStore();
    let plan;
    try { plan = store.load(id); }
    catch (e) { fail((e as Error).message); }
    const out = renderPlanReview(plan, { format: 'ansi' });
    process.stdout.write(out.text! + '\n');
    return;
  }
```

Add import to top of `src/cli/index.ts`:

```typescript
import { renderPlanReview } from '../core/plan-review.ts';
```

If `--state-dir` was added in Task 18, this picks it up; if not, add the option spec there now.

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/cli-pending.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts tests/cli-pending.test.ts
git commit -m "refactor(cli): pending show routes through renderPlanReview

Drops the inline ANSI rendering loop in cmdPending. Multi-end unification
applied at the CLI surface — same code path as the HTTP and channel
renderings."
```

---

## Task 20: Drop emoji from `listPending` / `showPending` channel renderers

**Files:**
- Modify: `src/runtime.ts:268-339` (listPending + showPending render strings)
- Modify: `tests/channel-review.test.ts` (any existing emoji assertions)

`listPending` (`📋 pending …`) and `showPending` (`🔥 …`) carry emoji that conflict with spec §7 "no emoji". Strip the decoration; keep the structure.

- [ ] **Step 1: Write failing test**

Append to `tests/channel-review.test.ts`:

```typescript
describe('channel renderers honor aesthetic restraint (no emoji)', () => {
  it('listPending output has no emoji', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    await ingestOne(vault, stateDir, 'm1', 'a');
    await ingestOne(vault, stateDir, 'm2', 'b');
    const out = listPending({ hearthStateDir: stateDir });
    expect(out.rendered).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('showPending output has no emoji', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const id = await ingestOne(vault, stateDir, 'm3', 'c');
    const out = showPending(id, { hearthStateDir: stateDir });
    expect(out.rendered).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun run test tests/channel-review.test.ts -t "aesthetic restraint"`
Expected: FAIL — emojis present in current output.

- [ ] **Step 3: Strip the emojis**

In `src/runtime.ts`:

`listPending` — replace the header line `📋 pending (...)` with `pending (...)`. Remove the `👁` markers; keep `review` as a text marker:

```typescript
  const lines = [`pending (${plans.length}${plans.length > limit ? `, latest ${limit}` : ''})`, ''];
  for (const it of items) {
    const review = it.requires_review ? 'review' : '     ';
    lines.push(`${review}  ${it.change_id}  ${it.risk}  ${it.op_count}op  ${it.created_at.slice(11, 16)}`);
    lines.push(`        → ${it.primary_path}`);
    lines.push(`        ${it.preview}`);
    lines.push('');
  }
```

`showPending` — replace the leading `🔥 ${plan.change_id}` with the same plain header used in the ANSI renderer. Even better: refactor `showPending` to call `renderPlanReview(plan, { format: 'ansi' })` and wrap the result.

```typescript
export function showPending(changeId: string, opts: PendingShowOptions = {}): PendingShowResult {
  const stateDir = opts.hearthStateDir ?? defaultStateDir();
  const store = new PendingStore(join(stateDir, 'pending'));
  let plan: ChangePlan;
  try { plan = store.load(changeId); }
  catch (e) {
    return { ok: false, rendered: `pending plan not found: ${changeId}`, error: (e as Error).message };
  }
  const out = renderPlan(plan, { format: 'ansi', maxOpBodyLines: opts.previewLines ?? 6 });
  return { ok: true, change_id: plan.change_id, rendered: out.text! };
}
```

(If existing channel-review tests assert for the old `🔥` substring, update those assertions to match the plain text.)

In `applyForOwner`, replace `✅ applied` / `❌ apply failed` decorations with plain `applied` / `apply failed:` lines, and `✓` / `✗` op markers with `ok` / `fail`:

```typescript
  if (result.ok) {
    // ...
    const lines = [
      `applied ${changeId}`,
      `${result.ops.length} op${result.ops.length === 1 ? '' : 's'} written`,
    ];
    for (const r of result.ops) lines.push(`  ${r.ok ? 'ok ' : 'err'} ${r.op} ${r.path}`);
    return { ok: true, change_id: changeId, ops_applied: result.ops.length, rendered: lines.join('\n') };
  }
  // ...
  const lines = [`apply failed: ${changeId}`, result.error ?? '(unknown error)'];
  for (const r of result.ops) {
    if (!r.ok) lines.push(`  err ${r.op} ${r.path} — ${r.error ?? ''}`);
  }
  return { ok: false, change_id: changeId, rendered: lines.join('\n'), error: result.error };
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun run test tests/channel-review.test.ts`
Expected: PASS, all cases (existing tests should also pass; only the strings changed).

If older assertions hard-coded `📋` / `🔥` / `✅` / `✗`, update them to the new plain-text equivalents in this commit.

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: PASS / 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts tests/channel-review.test.ts
git commit -m "refactor(runtime): strip emoji from channel renderers

Spec §7 'aesthetic restraint' applied to listPending / showPending /
applyForOwner. showPending now reuses renderPlanReview(ansi). All
channel surfaces output plain text."
```

---

## Task 21: tendhearth.com landing — onboarding section

**Files:**
- Modify: existing landing source under `web/` (locate via `ls web`)
- No test (visual)

Add a short "Try it" / "Setup in 60 seconds" block with the install line. Keep the existing landing structure; do not redesign.

- [ ] **Step 1: Find the landing entry point**

Run: `ls web && find web -name '*.html' -maxdepth 3`

The relevant file is most likely `web/index.html` or `web/<dir>/index.html`. Read it fully before editing to match its existing tone, structure, and CSS conventions.

- [ ] **Step 2: Add an onboarding section**

In the landing HTML, after the existing hero/intro, add a section like:

```html
<section class="onboarding">
  <h2>Try it locally</h2>
  <pre><code>git clone https://github.com/ggshr9/hearth.git ~/Documents/hearth
cd ~/Documents/hearth &amp;&amp; bun install
bun src/cli/index.ts setup</code></pre>
  <p>Mobile review (optional): install <code>cloudflared</code> (<code>brew install cloudflared</code> or <code>npm i -g cloudflared</code>), then <code>hearth review start</code> prints a public URL you can open from your phone.</p>
</section>
```

Match the surrounding CSS (no shadows, no gradients, no emoji — same restraint as the HTML review page).

- [ ] **Step 3: Visual smoke**

If `web/` has a dev server (e.g. `bun dev` or similar; check `package.json` of `web/`), run it and look at the page. Otherwise open the HTML directly in a browser.

- [ ] **Step 4: Commit**

```bash
git add web/
git commit -m "docs(web): tendhearth.com onboarding section

Two paragraphs + one code block: install + mobile review hint. Visually
matches the existing landing — no new components, no shadows or emoji."
```

---

## Task 22: Acceptance — end-to-end manual run

**Files:** none (manual)

The automated tests cover token / render / server / tunnel / channel surfaces. The acceptance test is real cloudflared + a real phone.

- [ ] **Step 1: Confirm cloudflared on PATH**

```bash
which cloudflared
hearth doctor --vault /path/to/your/test-vault
```

Expected: `cloudflared on PATH` check is `ok: true` in doctor output.

- [ ] **Step 2: Bring up review surface**

```bash
bun src/cli/index.ts review start --vault /path/to/your/test-vault
```

Expected: a `https://*.trycloudflare.com` URL appears on stdout within ~5 seconds.

- [ ] **Step 3: Trigger a channel ingest**

In a separate shell:

```bash
bun src/cli/index.ts channel ingest \
  --channel cli --message-id m-test-1 --from you \
  --text "first thought from acceptance" \
  --vault /path/to/your/test-vault
```

Expected: a `pending` summary printed; `change_id` returned.

- [ ] **Step 4: Open the URL on a real phone**

(In the current implementation, the channel ingest above does not push the URL anywhere on its own — `wechat-cc` is what does that in production. For acceptance, copy the URL from `hearth pending share <change_id>` into a different shell:)

```bash
bun src/cli/index.ts pending share <change_id> --vault /path/to/your/test-vault
```

Open the printed URL on your phone. Verify:
- Page loads
- Diff is visible
- "approve" button is present and unobtrusive

- [ ] **Step 5: Approve**

Tap "approve". Verify on the laptop:

```bash
ls /path/to/your/test-vault/06\ Hearth\ Inbox/   # new file present
hearth log --vault /path/to/your/test-vault --since 5m
```

Expected: audit log shows `approval_token.consumed` + `changeplan.applied`.

- [ ] **Step 6: Replay attack**

Re-tap the same URL. Expected: STALE_TOKEN page (token already consumed).

- [ ] **Step 7: Document the run**

Create `docs/superpowers/specs/2026-04-26-mobile-review-quick-tunnel-design.md` ↑ already has a "Definition of Done" — confirm each item now passes; record any deviations as a follow-up issue.

If any item fails, do not commit closure. Open an issue and fix it before declaring done.

- [ ] **Step 8: Final cleanup commit**

If acceptance produced any minor doc fixes:

```bash
git add docs/
git commit -m "docs: acceptance run notes for mobile review v1"
```

---

## Self-review

After writing the plan, executor should re-read the spec and verify:

1. **Spec coverage**: every section/requirement maps to one or more tasks above.
   - §2 in scope: covered by Tasks 1-21 ✓
   - §3 architecture: §3 layers map to Task 15 (channel), Task 17 (CLI), Tasks 9-11 (HTTP), all backed by Tasks 1-4 (PlanReview) ✓
   - §4 file plan: each row → at least one task above ✓
   - §5 data flow: end-to-end traced through Tasks 9-15, 22 ✓
   - §6 security: Token tests in Task 8; high-risk gate in Task 10 (`required_scope = classifyRisk(plan)`); replay-rejection in Task 10 + acceptance step 6 ✓
   - §7 aesthetic: Task 3 + Task 16 + Task 20 + Task 21 ✓
   - §8 errors: STALE_TOKEN in Task 9; REBASE_REQUIRED handled by Task 7 + future channel push (acceptance) ✓
   - §9 testing: every task has a TDD test step ✓
   - §10 open questions: all locked ✓
   - §13 DoD: revisit in acceptance Task 22 ✓

2. **Placeholders**: search the plan for "TBD" / "TODO" / "implement later" — none should appear.

3. **Type consistency**:
   - `renderPlanReview(plan, opts)` signature stable across Tasks 1-4 ✓
   - `ChangePlan.source_path?: string` in Task 6 used by Task 7 ✓
   - `verifyToken` (no consume) defined in Task 8 used by Task 9 ✓
   - `verifyAndConsume` used by Tasks 10-11 ✓
   - `TunnelManager.ensureUrl()` / `notePlanCount(n)` from Task 14 used by Task 15 ✓
   - `startReviewServer({ port, vaultRoot, hearthStateDir, publicBase? })` ↦ Task 9; reused in Tasks 17, 18 (via `cmdReview`, `cmdPending share`) ✓
   - `--state-dir` option threaded through Tasks 17-19 ✓

4. **Ambiguity**: pure-JS diff vs git binary deferred (Task 7 decision: re-ingest, no diff merge).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-mobile-review-quick-tunnel.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints

Pick one to proceed.
