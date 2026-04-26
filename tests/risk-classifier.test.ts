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
