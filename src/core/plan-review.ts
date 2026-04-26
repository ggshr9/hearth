// PlanReview — canonical view of a ChangePlan.
//
// Every user-facing surface (CLI text, HTTP HTML page, channel markdown,
// future Local Console) renders from this single representation. No surface
// computes its own diff or risk; they all read PlanReview.

import type { ChangePlan, ChangeOpKind, Risk } from './types.ts';

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
    case 'html':
    case 'ansi':
      throw new Error(`format ${opts.format} not implemented yet (Tasks 2-4)`);
  }
}
