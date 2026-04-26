import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = `---\ntype: meta\n---\n\n| dir | human | agent |\n|--|--|--|\n| raw/ | add | add |\n| 06 Hearth Inbox/ | rw | rw |\n`;
const FAKE_CF = resolve(__dirname, 'fixtures', 'fake-cloudflared.sh');
const HEARTH = resolve(__dirname, '..', 'src', 'cli', 'index.ts');

let proc: ChildProcess | null = null;
afterEach(() => { try { proc?.kill('SIGTERM'); } catch {} proc = null; });

describe('CLI: hearth review start', () => {
  it('prints the trycloudflare URL on stdout', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'hearth-cli-rev-'));
    mkdirSync(join(vault, 'raw'), { recursive: true });
    mkdirSync(join(vault, '06 Hearth Inbox'), { recursive: true });
    writeFileSync(join(vault, 'SCHEMA.md'), SCHEMA);

    proc = spawn('bun', [HEARTH, 'review', 'start', '--vault', vault], {
      env: { ...process.env, HEARTH_TUNNEL_BINARY: FAKE_CF },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = await new Promise<string>((resolveP, reject) => {
      const timer = setTimeout(() => reject(new Error('no URL printed within 3s')), 3000);
      proc!.stdout!.on('data', (b: Buffer) => {
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(b.toString());
        if (m) { clearTimeout(timer); resolveP(m[0]); }
      });
    });
    expect(url).toMatch(/trycloudflare\.com$/);
  });
});
