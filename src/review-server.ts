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
  /** Hostname to bind. Default '127.0.0.1'. Set to '0.0.0.0' (or a specific
   *  interface IP, e.g. the tailnet IP) for tailnet-only deploys without
   *  cloudflared. Note: binding to 0.0.0.0 on a host with a public interface
   *  exposes the server publicly — use `tailscale serve` or a firewall to
   *  scope it to your tailnet. */
  bind?: string;
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

interface BulkRequestBody {
  text?: string;
}

const BULK_URL_RE = /https?:\/\/[^\s<>"'`]+/g;

function bulkPastePage(token: string): Response {
  const tEnc = encodeURIComponent(token);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hearth · bulk capture</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 720px; margin: 2.5rem auto; padding: 0 1.25rem; line-height: 1.55; color: #1c1c1e; background: #fcfcfc; }
  @media (prefers-color-scheme: dark) { body { color: #e5e5e7; background: #111; } textarea { background: #1c1c1e; color: #e5e5e7; border-color: #333; } }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { color: #666; margin: 0.5rem 0; font-size: 0.9375rem; }
  textarea { width: 100%; min-height: 320px; padding: 0.75rem; font: 0.875rem ui-monospace, "SF Mono", Menlo, monospace; border: 1px solid #d0d0d0; border-radius: 3px; box-sizing: border-box; }
  form.actions { margin: 1rem 0; }
  button { font: inherit; padding: 0.5rem 1rem; border: 1px solid #2c7a3a; background: transparent; color: #2c7a3a; cursor: pointer; border-radius: 3px; }
  @media (prefers-color-scheme: dark) { button { border-color: #6abc7a; color: #6abc7a; } }
  button:hover { background: rgba(0,0,0,0.04); }
</style>
</head>
<body>
  <h1>hearth · bulk capture</h1>
  <p>Paste any text — bookmark export, list of URLs, a chat dump, anything. hearth pulls out the http(s) URLs and queues one pending plan per URL.</p>
  <form method="post" action="/bulk?t=${tEnc}" enctype="application/x-www-form-urlencoded">
    <textarea name="text" placeholder="https://example.com/article&#10;https://www.youtube.com/watch?v=..."></textarea>
    <div class="actions">
      <button type="submit">queue all</button>
    </div>
  </form>
</body>
</html>`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function extractUrls(text: string): string[] {
  const matches = text.match(BULK_URL_RE) ?? [];
  // Trim trailing punctuation that's commonly adjacent to URLs in prose.
  const cleaned = matches.map(u => u.replace(/[.,;:!?\)\]\}>]+$/, ''));
  // De-duplicate, preserve order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of cleaned) {
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

async function handleBulk(
  opts: ReviewServerOptions,
  req: Request,
  token: string,
): Promise<Response> {
  let payload;
  try {
    payload = verifyCaptureToken(token);
  } catch (e) {
    return staleTokenPage(e instanceof CaptureTokenError ? e.reason : 'invalid');
  }

  // Accept JSON ({text}) OR form-encoded (text=...). The HTML paste page
  // submits form-encoded; programmatic callers (scripts, scripts) use JSON.
  let text: string | undefined;
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const body = await req.json() as BulkRequestBody;
      text = body.text;
    } catch {
      return jsonResponse({ ok: false, error: 'malformed JSON body' }, 400);
    }
  } else {
    const form = await req.formData().catch(() => null);
    if (form) text = form.get('text')?.toString();
  }

  if (!text) {
    return jsonResponse({ ok: false, error: 'text body required' }, 400);
  }

  const urls = extractUrls(text);
  if (urls.length === 0) {
    return jsonResponse({ ok: false, error: 'no URLs found in text' }, 400);
  }

  // Enqueue each URL serially. We don't enrich (yt-dlp / readability) here —
  // bulk paste is a "queue many fast" surface; let the agent's per-plan
  // ingest pipeline handle enrichment when it processes each plan, or let
  // the user re-ingest individuals via /ingest if they need transcript.
  const change_ids: string[] = [];
  const failed: { url: string; error: string }[] = [];
  for (const url of urls) {
    const messageId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg: InboundMsg = {
      channel: 'bulk',
      message_id: messageId,
      from: payload.name ?? payload.issued_by ?? 'bulk',
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
    if (result.ok && result.change_id) {
      change_ids.push(result.change_id);
    } else {
      failed.push({ url, error: result.error ?? result.summary });
    }
  }

  return jsonResponse({ ok: true, change_ids, failed });
}

export function startReviewServer(opts: ReviewServerOptions): ReviewServerHandle {
  const stateDir = opts.hearthStateDir;
  const store = new PendingStore(stateDir ? join(stateDir, 'pending') : undefined);

  const server = Bun.serve({
    hostname: opts.bind ?? '127.0.0.1',
    port: opts.port,
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url);
      const token = url.searchParams.get('t') ?? '';

      // /ingest is the capture endpoint — separate from /p/:id review URLs.
      if (req.method === 'POST' && url.pathname === '/ingest') {
        return handleIngest(opts, req, token);
      }

      // /bulk: paste-many surface. GET serves an HTML form; POST extracts
      // URLs from the text body and queues one plan per URL.
      if (url.pathname === '/bulk') {
        // Verify capture token for both GET (rendering UI) and POST.
        try {
          verifyCaptureToken(token);
        } catch (e) {
          return staleTokenPage(e instanceof CaptureTokenError ? e.reason : 'invalid');
        }
        if (req.method === 'GET') return bulkPastePage(token);
        if (req.method === 'POST') return handleBulk(opts, req, token);
        return new Response('method not allowed', { status: 405 });
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
