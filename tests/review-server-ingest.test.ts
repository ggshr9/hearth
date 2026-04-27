// /ingest endpoint — capture-token-gated POST that lets external surfaces
// (iOS Shortcut, Telegram bot, browser bookmarklet) push inbound material
// straight to the pending queue without going through the CLI.
//
// These tests pin the security envelope (capture token required, approval
// tokens rejected, malformed bodies rejected) and the success contract
// (returns change_id so the caller can deep-link the user to review).

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
  const root = mkdtempSync(join(tmpdir(), 'hearth-ingest-vault-'));
  for (const d of ['raw', '06 Hearth Inbox']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}
function makeStateDir(): string { return mkdtempSync(join(tmpdir(), 'hearth-ingest-state-')); }

let handle: ReviewServerHandle | null = null;
afterEach(() => { handle?.stop(); handle = null; });

describe('review-server: POST /ingest', () => {
  it('accepts a URL capture and produces a pending plan', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test', name: 'iphone' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/ingest?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/article', title: 'Example Article' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; change_id?: string; summary?: string };
    expect(body.ok).toBe(true);
    expect(body.change_id).toBeDefined();
    expect(body.summary).toContain(body.change_id!);
  });

  it('accepts a text-only capture (no URL)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/ingest?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A thought to capture later.' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; change_id?: string };
    expect(body.ok).toBe(true);
    expect(body.change_id).toBeDefined();
  });

  it('returns 403 when no token is supplied', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects approval tokens (cross-type confusion)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    // Issue an approval token (not a capture token); /ingest must refuse it.
    const { token } = issueApprovalToken({ change_id: 'cp-x', issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/ingest?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects expired capture tokens', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test', ttl_days: -1 });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/ingest?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 when neither url nor text is provided', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/ingest?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'just a title, no content' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on malformed JSON body', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/ingest?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('a capture token works for many ingests (NOT single-use)', async () => {
    const vault = makeVault();
    const stateDir = makeStateDir();
    const { token } = issueCaptureToken({ issued_by: 'test' });
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: stateDir });
    const url = `http://127.0.0.1:${handle.port}/ingest?t=${encodeURIComponent(token)}`;
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `capture #${i}` }),
      });
      expect(res.status).toBe(200);
    }
  });
});
