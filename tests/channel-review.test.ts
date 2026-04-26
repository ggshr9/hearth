// hearth v0.3.1 — channel-side review surface tests.
//
// listPending / showPending / applyForOwner are the runtime hooks
// wechat-cc (and future channel adapters) call to drive ingest → list →
// show → apply from inside the chat. Owner authentication lives in the
// channel adapter; hearth here trusts its caller. SPEC §11 calls this the
// "human-direct" path — channel ownership is the authentication, no token
// needed.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ingestFromChannel,
  listPending,
  showPending,
  applyForOwner,
} from '../src/runtime.ts';
import { auditLogPath } from '../src/core/audit.ts';

const SCHEMA = `---
type: meta
---

# T

| dir         | human | agent |
|-------------|-------|-------|
| raw/        | add   | add   |
| 00 Inbox/   | rw    | none  |
| 01 Topics/  | r     | rw    |
| 02 Maps/    | r     | rw    |
| 99 Assets/  | rw    | add   |
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-cr-vault-'));
  for (const d of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'hearth-cr-state-'));
}

async function ingestOne(vault: string, stateDir: string, msgId: string, text: string): Promise<string> {
  const r = await ingestFromChannel(
    { channel: 'wechat', message_id: msgId, from: 'owner', text, received_at: new Date().toISOString() },
    { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
  );
  expect(r.ok).toBe(true);
  return r.change_id!;
}

describe('v0.3.1 channel review: list / show / apply', () => {
  it('listPending: empty queue renders an explicit "no pending plans" string', () => {
    const stateDir = makeStateDir();
    const r = listPending({ hearthStateDir: stateDir });
    expect(r.items).toEqual([]);
    expect(r.rendered).toBe('(no pending plans)');
  });

  it('listPending: returns the latest plans newest-first, capped by limit', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const id1 = await ingestOne(vault, stateDir, 'msg-1', '# Note one\n\nfirst body');
    await new Promise(r => setTimeout(r, 5)); // distinct timestamps
    const id2 = await ingestOne(vault, stateDir, 'msg-2', '# Note two\n\nsecond body');
    await new Promise(r => setTimeout(r, 5));
    const id3 = await ingestOne(vault, stateDir, 'msg-3', '# Note three\n\nthird body');

    const r = listPending({ hearthStateDir: stateDir, limit: 2 });
    expect(r.items.length).toBe(2);
    // newest first
    expect(r.items[0]!.change_id).toBe(id3);
    expect(r.items[1]!.change_id).toBe(id2);
    expect(r.rendered).toContain('pending (3, latest 2)');
    expect(r.rendered).toContain(id3);
    expect(r.rendered).not.toContain(id1);
    expect(r.rendered).toContain('…1 older not shown');
  });

  it('showPending: renders ops + reasons + body preview for one plan', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const id = await ingestOne(vault, stateDir, 'msg-show', '# Test heading\n\nsome body line that the mock surfaces as a claim');

    const r = showPending(id, { hearthStateDir: stateDir });
    expect(r.ok).toBe(true);
    expect(r.change_id).toBe(id);
    expect(r.rendered).toContain('🔥 ' + id);
    expect(r.rendered).toMatch(/risk: (low|medium|high)/);
    expect(r.rendered).toMatch(/\[create\] /);
  });

  it('showPending: missing change_id returns ok=false with friendly message', () => {
    const stateDir = makeStateDir();
    const r = showPending('does-not-exist', { hearthStateDir: stateDir });
    expect(r.ok).toBe(false);
    expect(r.rendered).toContain('❌ pending plan not found: does-not-exist');
  });

  it('applyForOwner: writes vault files, removes from pending, audits with channel initiator', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const id = await ingestOne(vault, stateDir, 'msg-apply', '# Apply me\n\na claim worth keeping');

    const r = await applyForOwner(id, {
      vaultRoot: vault,
      hearthStateDir: stateDir,
      ownerId: 'wechat-user-abc',
      channel: 'wechat',
    });
    expect(r.ok).toBe(true);
    expect(r.ops_applied).toBeGreaterThan(0);
    expect(r.rendered).toContain('✅ applied ' + id);

    // pending queue purged
    const after = listPending({ hearthStateDir: stateDir });
    expect(after.items.find(i => i.change_id === id)).toBeUndefined();

    // audit log records channel:wechat as initiator + owner_id
    // (give the async audit a microtask to flush)
    await new Promise(r => setTimeout(r, 50));
    const auditPath = auditLogPath(vault);
    expect(existsSync(auditPath)).toBe(true);
    const log = readFileSync(auditPath, 'utf8');
    expect(log).toContain('"event":"changeplan.applied"');
    expect(log).toContain('"initiated_by":"channel:wechat"');
    expect(log).toContain('"owner_id":"wechat-user-abc"');
  });

  it('applyForOwner: vault without SCHEMA.md fails cleanly, no throw', async () => {
    const stateDir = makeStateDir();
    const noSchema = mkdtempSync(join(tmpdir(), 'hearth-cr-noschema-'));
    const r = await applyForOwner('whatever', {
      vaultRoot: noSchema,
      hearthStateDir: stateDir,
      ownerId: 'owner',
      channel: 'wechat',
    });
    expect(r.ok).toBe(false);
    expect(r.rendered).toContain('❌ vault has no SCHEMA.md');
  });

  it('applyForOwner: missing change_id fails cleanly, no throw', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await applyForOwner('does-not-exist', {
      vaultRoot: vault,
      hearthStateDir: stateDir,
      ownerId: 'owner',
      channel: 'wechat',
    });
    expect(r.ok).toBe(false);
    expect(r.rendered).toContain('❌ pending plan not found: does-not-exist');
  });
});
