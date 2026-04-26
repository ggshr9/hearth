// TunnelManager — single shared tunnel per hearth process.
//
// Spawns a CloudflareQuickTunnel on first ensureUrl(); reuses it for
// subsequent calls. Closes the tunnel after `idleCloseMs` elapse with
// notePlanCount(0) — the surface (channel ingest, CLI) reports the current
// pending count after each operation; tunnel sleeps when there's nothing
// to review.

import { CloudflareQuickTunnel } from './tunnel.ts';

export interface TunnelManagerOptions {
  binary?: string;
  localPort: number;
  /** Close tunnel after this many ms of zero pending plans. Default 10 min. */
  idleCloseMs?: number;
  /** Test seam: override args. */
  args?: string[];
}

export class TunnelManager {
  private tunnel: CloudflareQuickTunnel | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPending = Number.POSITIVE_INFINITY; // until first notePlanCount

  constructor(private readonly opts: TunnelManagerOptions) {}

  async ensureUrl(): Promise<string> {
    if (this.tunnel?.url) return this.tunnel.url;
    this.tunnel = new CloudflareQuickTunnel({
      binary: this.opts.binary,
      localPort: this.opts.localPort,
      args: this.opts.args,
    });
    const url = await this.tunnel.start({ timeoutMs: 15_000 });
    this.scheduleIdleCheck();
    return url;
  }

  notePlanCount(n: number): void {
    this.currentPending = n;
    this.scheduleIdleCheck();
  }

  isLive(): boolean { return this.tunnel?.url != null; }

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    await this.tunnel?.stop();
    this.tunnel = null;
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.isLive()) return;
    if (this.currentPending > 0) return;
    const ms = this.opts.idleCloseMs ?? 10 * 60_000;
    this.idleTimer = setTimeout(() => { void this.close(); }, ms);
  }
}
