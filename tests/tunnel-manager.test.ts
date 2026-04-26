import { describe, expect, it, afterEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TunnelManager } from '../src/tunnel-manager.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(__dirname, 'fixtures', 'fake-cloudflared.sh');

let mgr: TunnelManager | null = null;
afterEach(async () => { await mgr?.close(); mgr = null; });

describe('TunnelManager: shared tunnel + refcount', () => {
  it('ensureUrl returns the same URL on repeated calls', async () => {
    mgr = new TunnelManager({ binary: FAKE, localPort: 12345, idleCloseMs: 60_000 });
    const u1 = await mgr.ensureUrl();
    const u2 = await mgr.ensureUrl();
    expect(u1).toBe(u2);
    expect(u1).toMatch(/trycloudflare\.com/);
  });

  it('idle close: tunnel stops after idleCloseMs of zero pending plans', async () => {
    mgr = new TunnelManager({ binary: FAKE, localPort: 12345, idleCloseMs: 50 });
    await mgr.ensureUrl();
    mgr.notePlanCount(0);
    await new Promise(r => setTimeout(r, 120));
    expect(mgr.isLive()).toBe(false);
  });

  it('does NOT close while plans remain pending', async () => {
    mgr = new TunnelManager({ binary: FAKE, localPort: 12345, idleCloseMs: 50 });
    await mgr.ensureUrl();
    mgr.notePlanCount(2);
    await new Promise(r => setTimeout(r, 120));
    expect(mgr.isLive()).toBe(true);
  });
});
