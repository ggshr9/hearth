// review-server bind option — for tailnet-only / server deploys where
// cloudflared isn't desired and the server needs to listen on more than
// just 127.0.0.1.
//
// Important: binding to 0.0.0.0 on a host with a public interface makes
// the server publicly reachable. The wider-bind option exists for
// tailnet-fronted deploys, where a separate layer (Tailscale ACL,
// firewall, `tailscale serve`) constrains who can reach the port.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer, type ReviewServerHandle } from '../src/review-server.ts';

const SCHEMA = `---
type: meta
---

# T

| dir | human | agent |
|-----|-------|-------|
| raw/ | add | add |
| 06 Hearth Inbox/ | rw | rw |
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-bind-vault-'));
  for (const d of ['raw', '06 Hearth Inbox']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}
function makeStateDir(): string { return mkdtempSync(join(tmpdir(), 'hearth-bind-state-')); }

let handle: ReviewServerHandle | null = null;
afterEach(() => { handle?.stop(); handle = null; });

describe('startReviewServer bind option', () => {
  it('default binds to 127.0.0.1 (loopback only)', async () => {
    const vault = makeVault();
    handle = startReviewServer({ port: 0, vaultRoot: vault, hearthStateDir: makeStateDir() });
    // 127.0.0.1 reaches it
    const res = await fetch(`http://127.0.0.1:${handle.port}/p/nope`);
    expect(res.status).toBe(403);
  });

  it('bind option flows through (custom hostname is honored)', async () => {
    const vault = makeVault();
    handle = startReviewServer({
      port: 0,
      bind: 'localhost',
      vaultRoot: vault,
      hearthStateDir: makeStateDir(),
    });
    const res = await fetch(`http://localhost:${handle.port}/p/nope`);
    expect(res.status).toBe(403);
  });
});
