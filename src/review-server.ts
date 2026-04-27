// review-server — local HTTP surface for capability-URL plan review and
// external capture.
//
// localhost-only bind. Routes:
//   GET  /p/:id?t=…       → render PlanReview HTML        (approval token)
//   POST /p/:id/apply?t=… → kernel apply, consumes token  (approval token)
//   POST /p/:id/reject?t=…→ mark rejected, consumes token (approval token)
//   POST /ingest?t=…      → accept inbound material       (capture token)
//
// The tunnel is the only path to this server from outside; the server
// binds 127.0.0.1 and refuses requests that don't carry a token.

import { join } from 'node:path';
import { PendingStore } from './core/pending-store.ts';
import { renderPlanReview, escapeHtml } from './core/plan-review.ts';
import { verifyToken, verifyAndConsume, TokenError } from './core/approval-token.ts';
import { verifyCaptureToken, CaptureTokenError } from './core/capture-token.ts';
import { loadSchema, SchemaError } from './core/schema.ts';
import { createKernel } from './core/vault-kernel.ts';
import { audit } from './core/audit.ts';
import { classifyRisk } from './core/risk-classifier.ts';
import { ingestFromChannel, type InboundMsg } from './runtime.ts';
import { fetchYouTubeTranscript, isYouTubeUrl } from './ingest/url-fetchers/youtube.ts';
import type { Risk } from './core/types.ts';
import type { AgentAdapter } from './core/agent-adapter.ts';

export interface ReviewServerOptions {
  /** 0 = OS-assigned ephemeral port. */
  port: number;
  vaultRoot: string;
  hearthStateDir?: string;
  /** Override the public base URL the page renders into form actions
   *  (when behind a tunnel, this is the *.trycloudflare.com URL). */
  publicBase?: string;
  /** Which agent adapter /ingest should drive. Defaults to 'mock' so the
   *  endpoint works without API keys; CLI sets 'claude' for real use. */
  agent?: 'mock' | 'claude';
  /** Optional adapter override (test seam — bypasses agent name). */
  adapterOverride?: AgentAdapter;
  /** When provided, /ingest forwards it so the resulting plan carries a
   *  review_url on the active tunnel host. */
  tunnelManager?: { ensureUrl(): Promise<string>; notePlanCount(n: number): void };
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
  <p>This link is no longer valid (<code>${escapeHtml(reason)}</code>).</p>
  <p>Wait for the next pending notification — it will include a fresh link.</p>
</body></html>`;
  return new Response(body, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function successPage(message: string): Response {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>hearth · ok</title>
<style>body{font-family:-apple-system,sans-serif;max-width:560px;margin:4rem auto;padding:0 1.25rem;color:#1c1c1e}h1{font-size:1.125rem;font-weight:600}p{color:#666}</style>
</head><body><h1>hearth</h1><p>${message}</p></body></html>`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function errorPage(status: number, title: string, detail: string): Response {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>hearth · ${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:560px;margin:4rem auto;padding:0 1.25rem;color:#1c1c1e}h1{font-size:1.125rem;font-weight:600}p{color:#666}code{font-family:ui-monospace,Menlo,monospace;font-size:.875em;background:#f0f0f0;padding:0 .2em;border-radius:2px}</style>
</head><body><h1>hearth · ${escapeHtml(title)}</h1><p>${detail}</p></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function rebaseRequiredPage(changeId: string): Response {
  const id = escapeHtml(changeId);
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>hearth · rebase required</title>
<style>body{font-family:-apple-system,sans-serif;max-width:560px;margin:4rem auto;padding:0 1.25rem;color:#1c1c1e;line-height:1.55}h1{font-size:1.125rem;font-weight:600}p{color:#666}code{font-family:ui-monospace,Menlo,monospace;font-size:.875em;background:#f0f0f0;padding:0 .2em;border-radius:2px}</style>
</head><body>
  <h1>hearth · rebase required</h1>
  <p>The target file changed since this plan was created. The plan needs to be regenerated against the new file state before it can be applied.</p>
  <p>From your terminal, run:</p>
  <p><code>hearth pending rebase ${id}</code></p>
  <p>You'll get a fresh notification with a new review link once the rebase completes.</p>
</body></html>`;
  return new Response(body, { status: 409, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function handleApply(
  opts: ReviewServerOptions,
  store: PendingStore,
  changeId: string,
  token: string,
): Promise<Response> {
  if (!token) {
    return staleTokenPage('missing token');
  }
  // Load plan to determine required scope
  let plan;
  try { plan = store.load(changeId); }
  catch { return errorPage(404, 'plan not found', `pending plan <code>${escapeHtml(changeId)}</code> not found`); }
  const requiredScope: Risk = classifyRisk(plan);
  // Verify and consume token with the required scope
  let payload;
  try {
    payload = verifyAndConsume({ token, change_id: changeId, required_scope: requiredScope });
  } catch (e) {
    void audit(opts.vaultRoot, {
      event: 'approval_token.rejected',
      initiated_by: 'review-server',
      data: { change_id: changeId, reason: (e as Error).message },
    });
    return staleTokenPage((e as Error).message);
  }
  void audit(opts.vaultRoot, {
    event: 'approval_token.consumed',
    initiated_by: 'review-server',
    data: { change_id: changeId, jti: payload.jti },
  });
  // Load schema and apply
  let schema;
  try { schema = loadSchema(opts.vaultRoot); }
  catch (e) {
    if (e instanceof SchemaError) return errorPage(500, 'no SCHEMA.md', escapeHtml(e.message));
    throw e;
  }
  const kernel = createKernel(opts.vaultRoot, schema);
  const result = kernel.apply(plan);
  if (result.ok) {
    store.remove(changeId);
    void audit(opts.vaultRoot, {
      event: 'changeplan.applied',
      initiated_by: 'review-server',
      data: { change_id: changeId, ops: result.ops.length },
    });
    return successPage(`applied <code>${escapeHtml(changeId)}</code> — ${result.ops.length} op${result.ops.length === 1 ? '' : 's'} written.`);
  }
  void audit(opts.vaultRoot, {
    event: 'changeplan.rejected',
    initiated_by: 'review-server',
    data: { change_id: changeId, error: result.error },
  });
  if (result.error?.includes('rebase')) {
    return rebaseRequiredPage(changeId);
  }
  return errorPage(409, 'apply failed', escapeHtml(result.error ?? 'kernel rejected'));
}

async function handleReject(
  opts: ReviewServerOptions,
  store: PendingStore,
  changeId: string,
  token: string,
): Promise<Response> {
  if (!token) {
    return staleTokenPage('missing token');
  }
  // Reject is always low-scope: declining a plan doesn't require apply-level
  // authority. Verify token first (before loading plan) so that token consumption
  // is detected before plan-not-found errors.
  let payload;
  try {
    payload = verifyAndConsume({ token, change_id: changeId, required_scope: 'low' });
  } catch (e) {
    void audit(opts.vaultRoot, {
      event: 'approval_token.rejected',
      initiated_by: 'review-server',
      data: { change_id: changeId, reason: (e as Error).message },
    });
    return staleTokenPage((e as Error).message);
  }
  void audit(opts.vaultRoot, {
    event: 'approval_token.consumed',
    initiated_by: 'review-server',
    data: { change_id: changeId, jti: payload.jti },
  });
  let plan;
  try { plan = store.load(changeId); }
  catch { return errorPage(404, 'plan not found', `pending plan <code>${escapeHtml(changeId)}</code> not found`); }
  store.remove(changeId);
  void audit(opts.vaultRoot, {
    event: 'changeplan.rejected',
    initiated_by: 'review-server',
    data: { change_id: changeId, ops: plan.ops.length, reason: 'user_rejected' },
  });
  return successPage(`rejected <code>${escapeHtml(changeId)}</code>.`);
}

interface IngestRequestBody {
  url?: string;
  title?: string;
  text?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleIngest(
  opts: ReviewServerOptions,
  req: Request,
  token: string,
): Promise<Response> {
  // Capture-token gated. Tokens are long-lived + reusable; verifyCaptureToken
  // does NOT consume.
  let payload;
  try {
    payload = verifyCaptureToken(token);
  } catch (e) {
    return staleTokenPage(e instanceof CaptureTokenError ? e.reason : 'invalid');
  }

  let body: IngestRequestBody;
  try {
    body = await req.json() as IngestRequestBody;
  } catch {
    return jsonResponse({ ok: false, error: 'malformed JSON body' }, 400);
  }

  const { url, title, text } = body;
  if (!url && !text) {
    return jsonResponse({ ok: false, error: 'url or text required' }, 400);
  }

  // Enrich URL captures with their content where we have a fetcher.
  // YouTube: pull auto-subs via yt-dlp into a markdown transcript so the
  // agent has actual material to summarize, not just the bare URL.
  // Non-fatal: if yt-dlp is missing or the fetch fails, fall back to URL.
  let enrichedText: string | undefined;
  if (url && isYouTubeUrl(url)) {
    const fetched = await fetchYouTubeTranscript(url, { binary: process.env.HEARTH_YTDL_BINARY });
    if (fetched) enrichedText = fetched.markdown;
  }

  // Synthesize an InboundMsg. The capture surface name (if the token had
  // one) becomes `from` for traceability in the audit log.
  const messageId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const composedText = [enrichedText, title, text].filter(Boolean).join('\n\n');
  const msg: InboundMsg = {
    channel: 'capture',
    message_id: messageId,
    from: payload.name ?? payload.issued_by ?? 'capture',
    text: composedText || undefined,
    url,
    received_at: new Date().toISOString(),
  };

  const result = await ingestFromChannel(msg, {
    vaultRoot: opts.vaultRoot,
    agent: opts.agent ?? 'mock',
    hearthStateDir: opts.hearthStateDir,
    adapterOverride: opts.adapterOverride,
    tunnelManager: opts.tunnelManager,
  });

  if (!result.ok) {
    return jsonResponse({ ok: false, error: result.error ?? result.summary }, 422);
  }
  return jsonResponse({
    ok: true,
    change_id: result.change_id,
    review_url: result.review_url,
    summary: result.summary,
  });
}

export function startReviewServer(opts: ReviewServerOptions): ReviewServerHandle {
  const stateDir = opts.hearthStateDir;
  const store = new PendingStore(stateDir ? join(stateDir, 'pending') : undefined);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url);
      const token = url.searchParams.get('t') ?? '';

      // /ingest is the capture endpoint — separate from /p/:id review URLs.
      if (req.method === 'POST' && url.pathname === '/ingest') {
        return handleIngest(opts, req, token);
      }

      const m = PATH_RE.exec(url.pathname);
      if (!m) return new Response('not found', { status: 404 });
      const [, changeId, action] = m;

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
      if (req.method === 'POST' && action === 'apply') {
        return handleApply(opts, store, changeId!, token);
      }
      if (req.method === 'POST' && action === 'reject') {
        return handleReject(opts, store, changeId!, token);
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    port: server.port!,
    stop() { server.stop(); },
  };
}
