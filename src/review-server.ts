// review-server — local HTTP surface for capability-URL plan review.
//
// localhost-only bind. Three routes (GET/POST/POST) all token-gated:
//   GET  /p/:id?t=…       → render PlanReview HTML
//   POST /p/:id/apply?t=… → kernel apply (consumes token)        [Task 10]
//   POST /p/:id/reject?t=…→ mark rejected (consumes token)       [Task 11]
//
// The tunnel is the only path to this server from outside; the server
// binds 127.0.0.1 and refuses cross-origin POSTs that don't carry a token.
//
// v1 implements GET + STALE_TOKEN handling. POST routes land in subsequent
// tasks.

import { join } from 'node:path';
import { PendingStore } from './core/pending-store.ts';
import { renderPlanReview } from './core/plan-review.ts';
import { verifyToken, TokenError } from './core/approval-token.ts';

export interface ReviewServerOptions {
  /** 0 = OS-assigned ephemeral port. */
  port: number;
  vaultRoot: string;
  hearthStateDir?: string;
  /** Override the public base URL the page renders into form actions
   *  (when behind a tunnel, this is the *.trycloudflare.com URL). */
  publicBase?: string;
}

export interface ReviewServerHandle {
  port: number;
  stop(): void;
}

const PATH_RE = /^\/p\/([^/?#]+)(?:\/(apply|reject))?$/;

function staleTokenPage(reason: string): Response {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>hearth · STALE_TOKEN</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 560px; margin: 4rem auto; padding: 0 1.25rem; color: #1c1c1e; }
  h1 { font-size: 1.125rem; font-weight: 600; }
  p { color: #666; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.875em; background: #f0f0f0; padding: 0 0.2em; border-radius: 2px; }
</style></head>
<body>
  <h1>hearth · STALE_TOKEN</h1>
  <p>This link is no longer valid (<code>${reason}</code>).</p>
  <p>Wait for the next pending notification — it will include a fresh link.</p>
</body></html>`;
  return new Response(body, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function startReviewServer(opts: ReviewServerOptions): ReviewServerHandle {
  const stateDir = opts.hearthStateDir;
  const store = new PendingStore(stateDir ? join(stateDir, 'pending') : undefined);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    fetch(req): Response | Promise<Response> {
      const url = new URL(req.url);
      const m = PATH_RE.exec(url.pathname);
      if (!m) return new Response('not found', { status: 404 });
      const [, changeId, action] = m;
      const token = url.searchParams.get('t') ?? '';

      if (req.method === 'GET' && !action) {
        try {
          verifyToken({ token, change_id: changeId!, required_scope: 'low' });
        } catch (e) {
          return staleTokenPage(e instanceof TokenError ? e.reason : 'invalid');
        }
        let plan;
        try { plan = store.load(changeId!); }
        catch { return new Response('plan not found', { status: 404 }); }
        const out = renderPlanReview(plan, {
          format: 'html',
          capabilityToken: token,
          capabilityBase: opts.publicBase,
        });
        if (out.format !== 'html') throw new Error('renderPlanReview did not return html');
        return new Response(out.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      // POST routes land in later tasks (Tasks 10 + 11)
      return new Response('not implemented yet', { status: 501 });
    },
  });

  return {
    port: server.port!,
    stop() { server.stop(); },
  };
}
