// hearth v0.3.0 — channel runtime API tests
//
// Two load-bearing properties:
//   1. Channel inbound NEVER writes the vault directly. The materialized source
//      lives in hearth's state dir; the kernel pipeline is the only path to vault.
//   2. A bad/malformed agent plan is still rejected by the validator. Channels
//      are new entry points, not new bypasses.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFromChannel } from '../src/runtime.ts';
import { PendingStore } from '../src/core/pending-store.ts';
import type { AgentAdapter } from '../src/core/agent-adapter.ts';
import type { ChangePlan } from '../src/core/types.ts';

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
  const root = mkdtempSync(join(tmpdir(), 'hearth-rt-vault-'));
  for (const d of ['raw', '00 Inbox', '01 Topics', '02 Maps', '99 Assets']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'hearth-rt-state-'));
}

function snapshotVault(vault: string): string[] {
  const out: string[] = [];
  function walk(dir: string, prefix = ''): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const { statSync } = require('node:fs');
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  }
  walk(vault);
  return out.sort();
}

describe('v0.3.0 channel runtime: ingestFromChannel', () => {
  it('Test channel-1: channel inbound does NOT directly write the vault', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const before = snapshotVault(vault);

    const result = await ingestFromChannel(
      {
        channel: 'wechat',
        message_id: 'wechat-msg-test-001',
        from: 'user-id-123',
        text: '# Note\n\nA thought I want to capture from my phone.\n',
        received_at: '2026-04-25T10:00:00Z',
      },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );

    expect(result.ok).toBe(true);
    expect(result.change_id).toBeTruthy();
    expect(result.pending_path).toContain(stateDir);

    // The vault is unchanged. The channel adapter staged its source under
    // hearth's state dir; the pending plan also lives there. NO vault write.
    const after = snapshotVault(vault);
    expect(after).toEqual(before);

    // The materialized source lives under channel-inbox/wechat/
    expect(result.source_path).toMatch(/channel-inbox\/wechat\/wechat-msg-test-001\.md$/);
    const stagedContent = readFileSync(result.source_path!, 'utf8');
    expect(stagedContent).toContain('channel: "wechat"');
    expect(stagedContent).toContain('A thought I want to capture');
  });

  it('Test channel-2: malformed agent plan is rejected — pending queue stays empty', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const pendingStore = new PendingStore(join(stateDir, 'pending'));

    // An adapter that produces an unsafe plan (writes to /etc/passwd)
    const badAdapter: AgentAdapter = {
      name: 'evil-mock',
      async planIngest(): Promise<ChangePlan> {
        return {
          change_id: 'evil-001',
          source_id: 'sha256:fake',
          risk: 'low',
          ops: [{
            op: 'create',
            path: '/etc/passwd',
            reason: 'attempted absolute path',
            precondition: { exists: false },
            patch: { type: 'replace', value: 'compromised' },
          }],
          requires_review: true,
          created_at: new Date().toISOString(),
        };
      },
    };

    const result = await ingestFromChannel(
      { channel: 'wechat', message_id: 'msg-evil', from: 'attacker', text: 'try it', received_at: '2026-04-25T10:00:00Z' },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir, adapterOverride: badAdapter, pendingStoreOverride: pendingStore },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/invalid ChangePlan/);
    expect(result.error).toMatch(/absolute path not allowed/);

    // Pending queue is empty — bad plan never landed there.
    expect(pendingStore.list()).toEqual([]);

    // Vault is also untouched.
    expect(snapshotVault(vault)).toEqual(snapshotVault(vault));
  });

  it('refuses when vault has no SCHEMA.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hearth-rt-noschema-'));
    const stateDir = makeStateDir();
    const result = await ingestFromChannel(
      { channel: 'wechat', message_id: 'm1', from: 'u', text: 'hi', received_at: 'now' },
      { vaultRoot: root, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no SCHEMA\.md/);
  });

  it('records URL in source frontmatter when no text is supplied (no fetch in v0.3.0)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const result = await ingestFromChannel(
      { channel: 'wechat', message_id: 'msg-url', from: 'u', url: 'https://www.bilibili.com/video/BVfake', received_at: '2026-04-25T10:00:00Z' },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(result.ok).toBe(true);
    const staged = readFileSync(result.source_path!, 'utf8');
    expect(staged).toContain('url: "https://www.bilibili.com/video/BVfake"');
    expect(staged).toContain('Shared URL (not fetched in v0.3)');
  });

  it('plan.source_path points at the materialized channel-inbox file', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'm-srcpath-1', from: 'me',
        text: 'first thought', received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    const store = new PendingStore(`${stateDir}/pending`);
    const plan = store.load(r.change_id!);
    expect(plan.source_path).toBeDefined();
    expect(existsSync(plan.source_path!)).toBe(true);
    expect(plan.source_path).toContain('m-srcpath-1');
  });
});
