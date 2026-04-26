// hearth v0.3.x — adopt + doctor + safety-priority target dir tests

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProposal, applyProposal, scanVault } from '../src/cli/adopt.ts';
import { runDoctor } from '../src/cli/doctor.ts';
import { mockIngest } from '../src/ingest/mock.ts';

function makeVaultWithDirs(dirs: string[], schemaContent?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-adopt-'));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  if (schemaContent !== undefined) writeFileSync(join(root, 'SCHEMA.md'), schemaContent);
  return root;
}

describe('adopt: scan', () => {
  it('detects missing SCHEMA + missing canonical block + missing hearth inbox', () => {
    const vault = makeVaultWithDirs(['raw', '01 Maps', '02 Notes']);
    const scan = scanVault(vault);
    expect(scan.schemaExists).toBe(false);
    expect(scan.hasCanonicalBlock).toBe(false);
    expect(scan.hasHearthInbox).toBe(false);
    expect(scan.topDirs).toEqual(['01 Maps', '02 Notes', 'raw']);
  });

  it('detects existing canonical block', () => {
    const schema = '---\ntype: meta\n---\n\n## hearth permissions\n\n| dir | human | agent |\n|-----|-------|-------|\n| raw/ | add | add |\n';
    const vault = makeVaultWithDirs(['raw'], schema);
    expect(scanVault(vault).hasCanonicalBlock).toBe(true);
  });

  it('detects existing hearth inbox dir', () => {
    const vault = makeVaultWithDirs(['raw', '06 Hearth Inbox', '01 Maps']);
    const scan = scanVault(vault);
    expect(scan.hasHearthInbox).toBe(true);
    expect(scan.hearthInboxDir).toBe('06 Hearth Inbox');
  });
});

describe('adopt: proposed block (conservative defaults)', () => {
  it('agent gets read-only on existing topic dirs; rw only on Hearth Inbox', () => {
    const vault = makeVaultWithDirs(['raw', '01 Maps', '02 Claude Code', '03 OpenClaw', '99 Assets']);
    const proposal = buildProposal(vault);
    const block = proposal.blockToAppend;
    expect(block).toContain('| raw/             | add   | add   |');
    expect(block).toContain('| 01 Maps/         | rw    | r     |');
    expect(block).toContain('| 02 Claude Code/  | rw    | r     |');
    expect(block).toContain('| 03 OpenClaw/     | rw    | r     |');
    expect(block).toContain('| 99 Assets/       | rw    | add   |');
    expect(block).toContain('| 06 Hearth Inbox/ | rw    | rw    |');
  });

  it('does not propose anything if canonical block already present', () => {
    const schema = '---\ntype: meta\n---\n## hearth permissions\n\n| dir | human | agent |\n|-----|-------|-------|\n| raw/ | add | add |\n';
    const vault = makeVaultWithDirs(['raw'], schema);
    expect(buildProposal(vault).blockToAppend).toBe('');
  });
});

describe('adopt: apply (writes only what was proposed; idempotent)', () => {
  it('appends block and creates Hearth Inbox; running twice does NOT duplicate', () => {
    const vault = makeVaultWithDirs(['raw', '01 Maps']);
    const before = buildProposal(vault);
    const result1 = applyProposal(before);
    expect(result1.appendedToSchema).toBe(true);
    expect(result1.createdInbox).toBe(true);
    expect(existsSync(join(vault, '06 Hearth Inbox'))).toBe(true);

    // Running adopt again must be a no-op (canonical block already present)
    const after = buildProposal(vault);
    expect(after.scan.hasCanonicalBlock).toBe(true);
    expect(after.blockToAppend).toBe('');
    const result2 = applyProposal(after);
    expect(result2.appendedToSchema).toBe(false);
    expect(result2.createdInbox).toBe(false);
  });

  it('does NOT touch files outside SCHEMA.md and the new inbox dir', () => {
    const vault = makeVaultWithDirs(['raw', '01 Maps']);
    writeFileSync(join(vault, '01 Maps', 'pre-existing.md'), '# Pre-existing\nhuman content\n');
    const original = readFileSync(join(vault, '01 Maps', 'pre-existing.md'), 'utf8');
    applyProposal(buildProposal(vault));
    expect(readFileSync(join(vault, '01 Maps', 'pre-existing.md'), 'utf8')).toBe(original);
  });
});

describe('doctor: read-only health check', () => {
  it('passes on a freshly-adopted vault', () => {
    const vault = makeVaultWithDirs(['raw', '01 Maps']);
    applyProposal(buildProposal(vault));
    const r = runDoctor(vault);
    expect(r.ok).toBe(true);
  });

  it('fails when SCHEMA.md is absent', () => {
    const vault = makeVaultWithDirs(['raw']);
    const r = runDoctor(vault);
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.detail).toMatch(/not found/);
  });

  it('reports when raw/ would let agent rw (Karpathy violation)', () => {
    const schema = '---\ntype: meta\n---\n\n## hearth permissions\n\n| dir | human | agent |\n|-----|-------|-------|\n| raw/ | rw | rw |\n| 06 Hearth Inbox/ | rw | rw |\n';
    const vault = makeVaultWithDirs(['raw', '06 Hearth Inbox'], schema);
    const r = runDoctor(vault);
    const rawCheck = r.checks.find(c => /raw\/ is append-only/.test(c.name));
    expect(rawCheck?.ok).toBe(false);
  });
});

describe('doctor: cloudflared check (advisory)', () => {
  it('reports cloudflared status with an install hint when absent', () => {
    const schema = '---\ntype: meta\n---\n\n## hearth permissions\n\n| dir | human | agent |\n|-----|-------|-------|\n| raw/ | add | add |\n| 06 Hearth Inbox/ | rw | rw |\n';
    const vault = makeVaultWithDirs(['raw', '06 Hearth Inbox'], schema);
    const report = runDoctor(vault);
    const cf = report.checks.find(c => c.name.toLowerCase().includes('cloudflared'));
    expect(cf).toBeDefined();
    if (!cf!.ok) {
      expect(cf!.detail?.toLowerCase()).toMatch(/install|brew|npm/);
    }
  });

  it('a missing cloudflared does NOT fail the overall report', () => {
    const schema = '---\ntype: meta\n---\n\n## hearth permissions\n\n| dir | human | agent |\n|-----|-------|-------|\n| raw/ | add | add |\n| 06 Hearth Inbox/ | rw | rw |\n';
    const vault = makeVaultWithDirs(['raw', '06 Hearth Inbox'], schema);
    const report = runDoctor(vault);
    const cf = report.checks.find(c => c.name.toLowerCase().includes('cloudflared'));
    expect(cf).toBeDefined();
    if (!cf!.ok) {
      // Other checks pass → overall report should still be ok=true
      const otherChecksAllPass = report.checks.filter(c => c !== cf).every(c => c.ok);
      if (otherChecksAllPass) expect(report.ok).toBe(true);
    }
  });
});

describe('mock-adapter target: safety-ordered', () => {
  function fixtureSchema(extraRows: string): string {
    return [
      '---',
      'type: meta',
      '---',
      '',
      '## hearth permissions',
      '',
      '| dir | human | agent |',
      '|-----|-------|-------|',
      '| raw/ | add | add |',
      extraRows,
    ].join('\n');
  }

  it('prefers "Hearth Inbox/" over a writable "Maps/"', () => {
    const schema = fixtureSchema(
      '| 01 Maps/ | r | rw |\n' +
      '| 06 Hearth Inbox/ | rw | rw |\n'
    );
    const vault = makeVaultWithDirs(['raw', '01 Maps', '06 Hearth Inbox'], schema);
    const src = mkdtempSync(join(tmpdir(), 'src-'));
    const srcFile = join(src, 'sample.md');
    writeFileSync(srcFile, '# Sample\n');
    const { plan } = mockIngest(srcFile, { vaultRoot: vault });
    expect(plan.ops[1]?.path).toMatch(/^06 Hearth Inbox\//);
  });

  it('refuses when only structural dirs (Maps/) are writable', () => {
    const schema = fixtureSchema('| 01 Maps/ | r | rw |\n');
    const vault = makeVaultWithDirs(['raw', '01 Maps'], schema);
    const src = mkdtempSync(join(tmpdir(), 'src-'));
    const srcFile = join(src, 'sample.md');
    writeFileSync(srcFile, '# Sample\n');
    expect(() => mockIngest(srcFile, { vaultRoot: vault })).toThrow(/structural|Hearth Inbox|hearth adopt/i);
  });

  it('falls back to /Inbox/ + agent=rw when no /hearth/ dir exists', () => {
    const schema = fixtureSchema(
      '| 02 General Inbox/ | rw | rw |\n'
    );
    const vault = makeVaultWithDirs(['raw', '02 General Inbox'], schema);
    const src = mkdtempSync(join(tmpdir(), 'src-'));
    const srcFile = join(src, 'sample.md');
    writeFileSync(srcFile, '# Sample\n');
    const { plan } = mockIngest(srcFile, { vaultRoot: vault });
    expect(plan.ops[1]?.path).toMatch(/^02 General Inbox\//);
  });
});
