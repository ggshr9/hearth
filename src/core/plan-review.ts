// PlanReview — canonical view of a ChangePlan.
//
// Every user-facing surface (CLI text, HTTP HTML page, channel markdown,
// future Local Console) renders from this single representation. No surface
// computes its own diff or risk; they all read PlanReview.

import type { ChangePlan, ChangeOpKind, Risk } from './types.ts';

/** Default cap on body-preview lines per op for size-bounded surfaces. */
const DEFAULT_OP_BODY_LINES = 40;

export interface PlanReviewOp {
  kind: ChangeOpKind;
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

export type RenderResult =
  | { format: 'json';      json: PlanReview }
  | { format: 'markdown';  text: string }
  | { format: 'ansi';      text: string }
  | { format: 'html';      html: string };

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
      return { format: 'markdown', text: renderMarkdown(plan, review, opts) };
    case 'html':
      return { format: 'html', html: renderHtml(plan, review, opts) };
    case 'ansi':
      throw new Error(`format ${opts.format} not implemented yet (Task 4)`);
  }
}

function renderMarkdown(_plan: ChangePlan, review: PlanReview, opts: RenderOptions): string {
  const previewN = opts.maxOpBodyLines ?? DEFAULT_OP_BODY_LINES;
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
