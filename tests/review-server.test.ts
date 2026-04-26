import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFromChannel } from '../src/runtime.ts';
import { issueToken } from '../src/core/approval-token.ts';
import { startReviewServer, type ReviewServerHandle } from '../src/review-server.ts';

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
  const root = mkdtempSync(join(tmpdir(), 'hearth-rs-vault-'));
  for (const d of ['raw', '06 Hearth Inbox']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}
function makeStateDir(): string { return mkdtempSync(join(tmpdir(), 'hearth-rs-state-')); }

let handle: ReviewServerHandle | null = null;
afterEach(() => { handle?.stop(); handle = null; });

describe('review-server: GET /p/:id', () => {
  it('renders the HTML diff page with a valid token', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'm1', from: 'me', text: 'hello body',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const url = `http://127.0.0.1:${handle.port}/p/${r.change_id}?t=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(r.change_id!);
    expect(html).toContain('hello body'); // body preview is rendered
  });

  it('returns 403 STALE_TOKEN page when token is missing', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/anything`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('STALE_TOKEN');
  });

  it('returns 403 STALE_TOKEN page when token is invalid', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/anything?t=bogus`);
    expect(res.status).toBe(403);
  });

  it('GET does NOT consume the token (subsequent verifyAndConsume still works)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'm2', from: 'me', text: 'two',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    // GET twice — both should succeed (no consumption)
    const u = `http://127.0.0.1:${handle.port}/p/${r.change_id}?t=${encodeURIComponent(token)}`;
    expect((await fetch(u)).status).toBe(200);
    expect((await fetch(u)).status).toBe(200);
  });
});
