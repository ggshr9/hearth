// Tunnel manager — exposes the local review-server to the public internet
// via Cloudflare Quick Tunnel (`cloudflared tunnel --url http://127.0.0.1:N`).
//
// v1 ships exactly one backend (`CloudflareQuickTunnel`); the interface is
// preserved so future ngrok / Tailscale / bore backends are additive, not
// rewrites. Per spec §10: do not pre-build a plugin system — interface +
// one impl, more later only on real demand.
//
// The cloudflared process is spawned by the tunnel manager; its stdout is
// scraped for the *.trycloudflare.com URL. cloudflared exits → tunnel.url
// becomes null and the manager surfaces the failure.

import { spawn, type ChildProcess } from 'node:child_process';

export interface TunnelStartOptions {
  /** Reject if URL has not appeared by this many ms after spawn. */
  timeoutMs?: number;
}

export interface TunnelBackend {
  url: string | null;
  start(opts?: TunnelStartOptions): Promise<string>;
  stop(): Promise<void>;
}

export interface CloudflareQuickTunnelOptions {
  /** Path to cloudflared binary; default `cloudflared` (looked up on PATH). */
  binary?: string;
  /** Override args for testing. Default: ['tunnel','--url','http://127.0.0.1:<port>']. */
  args?: string[];
  /** localhost port the tunnel forwards to. */
  localPort: number;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class CloudflareQuickTunnel implements TunnelBackend {
  url: string | null = null;
  private proc: ChildProcess | null = null;

  constructor(private readonly opts: CloudflareQuickTunnelOptions) {}

  start(startOpts: TunnelStartOptions = {}): Promise<string> {
    const timeoutMs = startOpts.timeoutMs ?? 10_000;
    const binary = this.opts.binary ?? 'cloudflared';
    const args = this.opts.args ?? ['tunnel', '--url', `http://127.0.0.1:${this.opts.localPort}`];

    return new Promise<string>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        reject(e);
        return;
      }
      this.proc = proc;
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        reject(new Error(`tunnel start timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const onChunk = (buf: Buffer) => {
        const m = URL_RE.exec(buf.toString());
        if (m) {
          this.url = m[0];
          clearTimeout(timer);
          resolve(this.url);
        }
      };
      proc.stdout?.on('data', onChunk);
      proc.stderr?.on('data', onChunk);
      proc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', code => {
        if (this.url === null) {
          clearTimeout(timer);
          reject(new Error(`cloudflared exited (code=${code}) before URL appeared`));
        } else {
          // Mid-flight exit: surface for the manager to handle.
          this.url = null;
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      await new Promise<void>(r => {
        if (!this.proc) return r();
        this.proc.on('exit', () => r());
        // Hard fallback in case SIGTERM is ignored
        setTimeout(() => { try { this.proc?.kill('SIGKILL'); } catch {} r(); }, 1500);
      });
    }
    this.proc = null;
    this.url = null;
  }
}
