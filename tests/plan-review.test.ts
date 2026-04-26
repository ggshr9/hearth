// PlanReview canonical render layer — all-formats unification test
//
// Load-bearing property: every user-facing surface (CLI, HTTP, channel,
// future Local Console) renders from one place. If you delete these tests
// you lose the contract that all render layers are unified at the source.
// Tasks 2-4 each add a format arm; this test ensures only JSON works until
// then, and asserts the unimplemented formats throw.

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
    if (out.format !== 'json') throw new Error('expected json format');
    const review = out.json;
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
    if (out.format !== 'json') throw new Error('expected json format');
    const op0 = out.json.ops[0]!;
    expect(op0.kind).toBe('create');
    expect(op0.before).toBeNull();
    expect(op0.after).toBe('# Hello\n\nbody\n');
  });
});

describe('renderPlanReview markdown', () => {
  it('produces a self-contained markdown document', () => {
    const out = renderPlanReview(PLAN, { format: 'markdown' });
    expect(out.format).toBe('markdown');
    if (out.format !== 'markdown') throw new Error('narrow');
    const md = out.text;
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
    if (out.format !== 'markdown') throw new Error('narrow');
    const md = out.text;
    expect(md).not.toMatch(/v0\.3\.1/);
    expect(md).not.toMatch(/🔥|📋|✅|❌/); // no emoji decoration
  });
});

describe('renderPlanReview unimplemented formats', () => {
  it('throws for html / ansi (Tasks 3-4 land each format)', () => {
    expect(() => renderPlanReview(PLAN, { format: 'html' })).toThrow(/not implemented/);
    expect(() => renderPlanReview(PLAN, { format: 'ansi' })).toThrow(/not implemented/);
  });
});
