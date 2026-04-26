import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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

  it('STALE_TOKEN page HTML-escapes the reason string', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    // We can't directly inject an evil reason, but we can verify the
    // escaping pipeline by submitting a malformed token and checking that
    // the page never contains a raw '<' from any source. Belt-and-braces
    // protection against future code paths that might pipe user input
    // into the reason.
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/anything?t=invalid.<script>`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain('<script>');
  });
});

describe('review-server: POST /p/:id/apply', () => {
  it('applies the plan and writes vault file', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'apply-1', from: 'me', text: 'apply me',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/p/${r.change_id}/apply?t=${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    // Allow fire-and-forget audit calls to complete
    await new Promise(r => setTimeout(r, 100));
    // Audit log should have changeplan.applied
    const { existsSync } = await import('node:fs');
    const { auditLogPath } = await import('../src/core/audit.ts');
    expect(existsSync(auditLogPath(vault))).toBe(true);
    const auditEntries = readFileSync(auditLogPath(vault), 'utf8').split('\n').filter(Boolean);
    expect(auditEntries.some(l => l.includes('changeplan.applied'))).toBe(true);
    expect(auditEntries.some(l => l.includes('approval_token.consumed'))).toBe(true);
  });

  it('rejects POST apply without token', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/whatever/apply`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('consumes the token (plan removed after apply; second POST returns 404)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'apply-2', from: 'me', text: 'apply twice',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const u = `http://127.0.0.1:${handle.port}/p/${r.change_id}/apply?t=${encodeURIComponent(token)}`;
    expect((await fetch(u, { method: 'POST' })).status).toBe(200);
    // Token is consumed and plan is removed after successful apply.
    // Second request fails to load plan (it was removed), returns 404.
    expect((await fetch(u, { method: 'POST' })).status).toBe(404);
  });

  it('returns 409 apply failed when kernel rejects (precondition violation)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'apply-rej', from: 'me', text: 'will be rejected',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    expect(r.ok).toBe(true);

    // Sabotage the apply: write a file at the target path so precondition.exists=false fails
    const { PendingStore } = await import('../src/core/pending-store.ts');
    const store = new PendingStore(join(stateDir, 'pending'));
    const plan = store.load(r.change_id!);
    const targetPath = plan.ops[0]!.path;
    const fullPath = join(vault, targetPath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, 'pre-existing content');

    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/p/${r.change_id}/apply?t=${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain('apply failed');
    // Allow fire-and-forget audit calls to complete
    await new Promise(r => setTimeout(r, 100));
    // Audit log should record changeplan.rejected (and approval_token.consumed)
    const { auditLogPath } = await import('../src/core/audit.ts');
    const lines = readFileSync(auditLogPath(vault), 'utf8').split('\n').filter(Boolean);
    expect(lines.some(l => l.includes('changeplan.rejected'))).toBe(true);
    expect(lines.some(l => l.includes('approval_token.consumed'))).toBe(true);
  });
});

describe('review-server: POST /p/:id/reject', () => {
  it('removes the plan from pending and audits changeplan.rejected', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'rej-1', from: 'me', text: 'reject me',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/p/${r.change_id}/reject?t=${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    // small delay so fire-and-forget audit lands
    await new Promise(r => setTimeout(r, 100));
    // plan gone from pending
    const { PendingStore } = await import('../src/core/pending-store.ts');
    const store2 = new PendingStore(join(stateDir, 'pending'));
    expect(() => store2.load(r.change_id!)).toThrow();
    // audit recorded changeplan.rejected
    const { auditLogPath } = await import('../src/core/audit.ts');
    const lines = readFileSync(auditLogPath(vault), 'utf8').split('\n').filter(Boolean);
    expect(lines.some(l => l.includes('changeplan.rejected'))).toBe(true);
  });

  it('rejects POST reject without a token (403 STALE_TOKEN)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/whatever/reject`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('consumes the token (cannot reject + apply with the same token)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const r = await ingestFromChannel(
      { channel: 'cli', message_id: 'rej-2', from: 'me', text: 'reject then apply',
        received_at: new Date().toISOString() },
      { vaultRoot: vault, agent: 'mock', hearthStateDir: stateDir },
    );
    const { token } = issueToken({ change_id: r.change_id!, issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    // Reject first
    expect((await fetch(
      `http://127.0.0.1:${handle.port}/p/${r.change_id}/reject?t=${encodeURIComponent(token)}`,
      { method: 'POST' },
    )).status).toBe(200);
    // Plan is removed after successful reject. Second action fails to load plan.
    expect((await fetch(
      `http://127.0.0.1:${handle.port}/p/${r.change_id}/apply?t=${encodeURIComponent(token)}`,
      { method: 'POST' },
    )).status).toBe(404);
  });
});
