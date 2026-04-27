// /bulk endpoint — paste any text blob, hearth extracts URLs and queues
// a separate plan for each. Solves the "I have 50 saved Xiaohongshu links"
// pain — sending them one at a time over Telegram or Shortcut is brutal.
//
// Auth: same capture token as /ingest (capability='capture').
// Body: { text: "..." } where text is freeform; URLs extracted via regex.
// Returns: { ok, change_ids: [], failed: [] }.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueCaptureToken } from '../src/core/capture-token.ts';
import { issueToken as issueApprovalToken } from '../src/core/approval-token.ts';
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
  const root = mkdtempSync(join(tmpdir(), 'hearth-bulk-vault-'));
  for (const d of ['raw', '06 Hearth Inbox']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}
function makeStateDir(): string { return mkdtempSync(join(tmpdir(), 'hearth-bulk-state-')); }

let handle: ReviewServerHandle | null = null;
afterEach(() => { handle?.stop(); handle = null; });

describe('review-server: POST /bulk', () => {
  it('extracts URLs from a free-form text blob and queues one plan per URL', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test', name: 'desktop' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const blob = `here are some saved recipes:
- https://www.xiaohongshu.com/explore/abc111
- https://www.xiaohongshu.com/explore/def222
plus a youtube one https://www.youtube.com/watch?v=zzz333
and some random prose nobody cares about
`;
    const res = await fetch(`http://127.0.0.1:${handle.port}/bulk?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: blob }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; change_ids: string[]; failed: string[] };
    expect(body.ok).toBe(true);
    expect(body.change_ids).toHaveLength(3);
    expect(body.failed).toHaveLength(0);
  });

  it('deduplicates URLs in the input', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const blob = `https://example.com/a
https://example.com/a
https://example.com/b
https://example.com/a`;
    const res = await fetch(`http://127.0.0.1:${handle.port}/bulk?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: blob }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; change_ids: string[] };
    expect(body.change_ids).toHaveLength(2);
  });

  it('returns 400 when no URLs found in the blob', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/bulk?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'just prose, no links here at all' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects approval tokens (cross-type confusion guard)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueApprovalToken({ change_id: 'cp-x', issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/bulk?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'https://example.com/a' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects without a token (403)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'https://example.com/a' }),
    });
    expect(res.status).toBe(403);
  });

  it('ignores non-http URLs (mailto, javascript, etc.)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const blob = `https://example.com/real
mailto:fake@example.com
javascript:alert(1)
file:///etc/passwd
https://example.com/another`;
    const res = await fetch(`http://127.0.0.1:${handle.port}/bulk?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: blob }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { change_ids: string[] };
    expect(body.change_ids).toHaveLength(2);
  });
});

describe('review-server: GET /bulk (paste page)', () => {
  it('returns an HTML paste form with the token preserved in the action', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test', name: 'paste-ui' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/bulk?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<textarea');
    expect(html).toContain('<form');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/bulk?t=');
  });

  it('GET /bulk without a token returns 403', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/bulk`);
    expect(res.status).toBe(403);
  });
});
