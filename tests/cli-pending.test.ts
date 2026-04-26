import { describe, expect, it } from 'vitest';
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
