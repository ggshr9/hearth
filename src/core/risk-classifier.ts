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
