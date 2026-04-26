import { describe, expect, it, afterEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareQuickTunnel } from '../src/tunnel.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(__dirname, 'fixtures', 'fake-cloudflared.sh');

let tunnel: CloudflareQuickTunnel | null = null;
afterEach(async () => { await tunnel?.stop(); tunnel = null; });

describe('CloudflareQuickTunnel', () => {
  it('spawns cloudflared, parses the URL, and exposes it', async () => {
    tunnel = new CloudflareQuickTunnel({ binary: FAKE, localPort: 12345 });
    const url = await tunnel.start({ timeoutMs: 2000 });
    expect(url).toBe('https://fake-tunnel-test.trycloudflare.com');
    expect(tunnel.url).toBe(url);
  });

  it('rejects start() if cloudflared exits early', async () => {
    tunnel = new CloudflareQuickTunnel({ binary: '/bin/false', localPort: 12345 });
    await expect(tunnel.start({ timeoutMs: 500 })).rejects.toThrow();
  });

  it('rejects start() on timeout if URL never appears', async () => {
    tunnel = new CloudflareQuickTunnel({ binary: '/bin/sh', localPort: 12345, args: ['-c', 'sleep 10'] });
    await expect(tunnel.start({ timeoutMs: 100 })).rejects.toThrow(/timeout/);
  });
});
