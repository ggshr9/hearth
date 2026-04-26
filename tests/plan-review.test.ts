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
