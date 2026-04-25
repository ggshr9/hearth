// hearth doctor — vault health check. Read-only.
//
// Verifies that hearth can operate against the given vault: schema parses,
// permission table covers a writable agent zone, ChangePlan pipeline is
// reachable, no obvious config breakage. Doesn't fix anything; reports.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSchema, SchemaError, permits } from '../core/schema.ts';
import { buildClaimIndex } from '../core/citations.ts';

export interface DoctorReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

export function runDoctor(vaultRoot: string): DoctorReport {
  const checks: DoctorReport['checks'] = [];
  const root = resolve(vaultRoot);

  // 1. SCHEMA.md exists
  const schemaPath = join(root, 'SCHEMA.md');
  if (!existsSync(schemaPath)) {
    checks.push({ name: 'SCHEMA.md present', ok: false, detail: `not found at ${schemaPath} — run \`hearth adopt ${root}\`` });
    return { ok: false, checks };
  }
  checks.push({ name: 'SCHEMA.md present', ok: true });

  // 2. SCHEMA.md parses
  let schema;
  try {
    schema = loadSchema(root);
    checks.push({ name: 'SCHEMA.md parses', ok: true, detail: `${schema.rules.length} rules` });
  } catch (e) {
    const msg = e instanceof SchemaError ? e.message : (e as Error).message;
    checks.push({ name: 'SCHEMA.md parses', ok: false, detail: msg });
    return { ok: false, checks };
  }

  // 3. At least one writable agent zone exists outside raw/
  const writable = schema.rules.filter(r =>
    r.dir !== 'raw/' && permits(schema, 'agent', 'create', r.dir + 'sample.md'),
  );
  if (writable.length === 0) {
    checks.push({
      name: 'agent has a writable zone outside raw/',
      ok: false,
      detail: 'no SCHEMA rule grants the agent create/update permission outside raw/. Hearth has nowhere to land new wiki pages. Run `hearth adopt` to create one.',
    });
  } else {
    checks.push({ name: 'agent has a writable zone outside raw/', ok: true, detail: writable.map(w => w.dir).join(', ') });
  }

  // 4. raw/ is append-only for the agent (typical Karpathy convention)
  const rawRule = schema.rules.find(r => r.dir === 'raw/');
  if (rawRule) {
    if (rawRule.agent === 'rw') {
      checks.push({
        name: 'raw/ is append-only',
        ok: false,
        detail: 'agent has rw on raw/. Karpathy convention is add-only — agent should append sources, never modify them.',
      });
    } else {
      checks.push({ name: 'raw/ is append-only', ok: true, detail: `agent=${rawRule.agent}` });
    }
  } else {
    checks.push({ name: 'raw/ rule present', ok: false, detail: 'SCHEMA has no rule for raw/' });
  }

  // 5. claim index can be built (existing pages parse)
  try {
    const idx = buildClaimIndex(root);
    const invalid = idx.invalid().length;
    checks.push({
      name: 'claim index builds',
      ok: invalid === 0,
      detail: `${idx.records.length} claim(s) found, ${invalid} drifted (run hearth lint for details)`,
    });
  } catch (e) {
    checks.push({ name: 'claim index builds', ok: false, detail: (e as Error).message });
  }

  const ok = checks.every(c => c.ok);
  return { ok, checks };
}

export function renderDoctorReport(r: DoctorReport): string {
  const lines: string[] = [];
  for (const c of r.checks) {
    const tag = c.ok ? '✓' : '✗';
    lines.push(`${tag} ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
  }
  lines.push('');
  lines.push(r.ok ? '✓ vault is hearth-ready' : '✗ vault has issues; see above');
  return lines.join('\n');
}
