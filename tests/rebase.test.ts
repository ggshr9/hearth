import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFromChannel, rebasePlan } from '../src/runtime.ts';
import { PendingStore } from '../src/core/pending-store.ts';

const SCHEMA = `---
type: meta
---

# T

| dir         | human | agent |
|-------------|-------|-------|
| raw/        | add   | add   |
| 06 Hearth Inbox/ | rw | rw |
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-rebase-vault-'));
  for (const d of ['raw', '06 Hearth Inbox']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}
function makeStateDir(): string { return mkdtempSync(join(tmpdir(), 'hearth-rebase-state-')); }

describe('rebasePlan', () => {
  it('produces a fresh plan with the same source content; old plan is removed', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'm1', from: 'me', text: 'hello',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    const oldId = r.change_id!;
    const result = await rebasePlan(oldId, { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir });
    expect(result.ok).toBe(true);
    expect(result.change_id).toBeDefined();
    const store = new PendingStore(join(stateDir, 'pending'));
    expect(() => store.load(oldId)).toThrow();          // old gone
    const fresh = store.load(result.change_id!);        // new present
    expect(fresh.source_id).toBeDefined();
  });

  it('returns ok=false when the plan has no source_path', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const store = new PendingStore(join(stateDir, 'pending'));
    store.save({
      change_id: 'manual', source_id: 'sha256:x',
      // no source_path
      risk: 'low', ops: [], requires_review: false,
      created_at: new Date().toISOString(),
    });
    const r = await rebasePlan('manual', { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('source_path');
  });
});
