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

describe('renderPlanReview html', () => {
  it('returns a complete HTML document', () => {
    const out = renderPlanReview(PLAN, {
      format: 'html',
      capabilityBase: 'https://abc-1.trycloudflare.com',
      capabilityToken: 'tok-xyz',
    });
    expect(out.format).toBe('html');
    if (out.format !== 'html') throw new Error('narrow');
    const html = out.html;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>');
    expect(html).toContain('cp-001');
    expect(html).toContain('06 Hearth Inbox/note.md');
  });

  it('honors aesthetic restraint (no shadows / gradients / animations / emoji / external assets / inline JS)', () => {
    const out = renderPlanReview(PLAN, {
      format: 'html',
      capabilityBase: 'https://abc-1.trycloudflare.com',
      capabilityToken: 'tok-xyz',
    });
    if (out.format !== 'html') throw new Error('narrow');
    const html = out.html;
    expect(html).not.toMatch(/box-shadow|drop-shadow|text-shadow/);
    expect(html).not.toMatch(/linear-gradient|radial-gradient/);
    expect(html).not.toMatch(/transition\s*:|animation\s*:/);
    expect(html).not.toMatch(/🎉|✅|❌|🔥|📋/);
    // No external script or stylesheet refs
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    // No inline event handlers
    expect(html).not.toMatch(/\bon\w+=/);
  });

  it('renders approve and reject form actions bound to the capability URL', () => {
    const out = renderPlanReview(PLAN, {
      format: 'html',
      capabilityBase: 'https://abc-1.trycloudflare.com',
      capabilityToken: 'tok-xyz',
    });
    if (out.format !== 'html') throw new Error('narrow');
    const html = out.html;
    expect(html).toContain('formaction="/p/cp-001/apply?t=tok-xyz"');
    expect(html).toContain('formaction="/p/cp-001/reject?t=tok-xyz"');
    expect(html).toContain('method="post"');
  });

  it('HTML-escapes user-controlled strings in op fields', () => {
    const evilPlan: ChangePlan = {
      ...PLAN,
      ops: [{
        ...PLAN.ops[0]!,
        reason: '<script>alert(1)</script>',
        path: '" onsubmit="evil',
      }],
    };
    const out = renderPlanReview(evilPlan, { format: 'html', capabilityToken: 'tok' });
    if (out.format !== 'html') throw new Error('narrow');
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).not.toContain('" onsubmit="evil');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('capability token appears only in form action attributes', () => {
    const out = renderPlanReview(PLAN, { format: 'html', capabilityToken: 'tok-secret-123' });
    if (out.format !== 'html') throw new Error('narrow');
    // Strip the form elements, then assert token is absent from the rest.
    const withoutForms = out.html.replace(/<form[\s\S]*?<\/form>/g, '');
    expect(withoutForms).not.toContain('tok-secret-123');
  });

  it('renders the proposed body inside <pre> for create ops', () => {
    const out = renderPlanReview(PLAN, {
      format: 'html',
      capabilityBase: 'https://abc-1.trycloudflare.com',
      capabilityToken: 'tok-xyz',
    });
    if (out.format !== 'html') throw new Error('narrow');
    const html = out.html;
    expect(html).toMatch(/<pre[^>]*>[\s\S]*# Hello[\s\S]*<\/pre>/);
  });
});

describe('renderPlanReview ansi (CLI text)', () => {
  it('produces a structured terminal-friendly text block', () => {
    const out = renderPlanReview(PLAN, { format: 'ansi' });
    expect(out.format).toBe('ansi');
    if (out.format !== 'ansi') throw new Error('narrow');
    const text = out.text;
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
