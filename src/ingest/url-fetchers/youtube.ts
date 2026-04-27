// YouTube transcript fetcher — calls yt-dlp to pull auto-generated subtitles
// + metadata, then converts the SRT into a hearth-friendly markdown body.
//
// Why yt-dlp: it handles both youtube.com and youtu.be, fetches the auto-sub
// when no manual sub exists, and works without a Google API key. yt-dlp must
// be on PATH (or the binary path passed via opts); doctor warns if missing.
//
// Failure modes are non-fatal: if yt-dlp isn't installed, or the URL doesn't
// have an English auto-sub, or the network is down, we return null. Caller
// (handleIngest) falls back to capturing just the URL as a "to-watch" stub.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const YOUTUBE_HOST_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\b/i;

export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_HOST_RE.test(url);
}

/** Convert SRT subtitle text into a hearth markdown transcript.
 *  Each cue becomes one line: `[HH:MM:SS] <text>`. Multi-line cues are
 *  joined with spaces. Index numbers and end-timestamps are dropped. */
export function parseSrt(srt: string): string {
  if (!srt.trim()) return '';
  const blocks = srt.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const lines: string[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const blockLines = block.split('\n');
    // Block shape: [index]? <timestamp line> <text...>
    let i = 0;
    if (/^\d+$/.test(blockLines[i] ?? '')) i++;
    const ts = blockLines[i] ?? '';
    const m = /^(\d\d):(\d\d):(\d\d)[,.]\d{1,3}\s*-->/.exec(ts);
    if (!m) continue;
    i++;
    const text = blockLines.slice(i).join(' ').trim();
    if (!text) continue;
    lines.push(`[${m[1]}:${m[2]}:${m[3]}] ${text}`);
  }
  return lines.join('\n');
}

export interface YouTubeFetched {
  title: string;
  uploader?: string;
  /** Title heading + uploader line + timestamped transcript. */
  markdown: string;
}

export interface FetchOptions {
  /** Path to yt-dlp binary; default 'yt-dlp' (looked up on PATH). */
  binary?: string;
  /** Soft kill after this many ms. Default 30000. */
  timeoutMs?: number;
}

export async function fetchYouTubeTranscript(
  url: string,
  opts: FetchOptions = {},
): Promise<YouTubeFetched | null> {
  if (!isYouTubeUrl(url)) return null;

  const binary = opts.binary ?? 'yt-dlp';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const tempDir = mkdtempSync(join(tmpdir(), 'hearth-yt-'));
  const outTemplate = join(tempDir, '%(id)s');

  try {
    const result = await runYtDlp(binary, [
      '--skip-download',
      '--write-auto-sub',
      '--sub-lang', 'en',
      '--convert-subs', 'srt',
      '--print-json',
      '-o', outTemplate,
      url,
    ], timeoutMs);
    if (!result) return null;

    let metadata: { title?: string; uploader?: string };
    try { metadata = JSON.parse(result.stdout) as typeof metadata; }
    catch { return null; }
    if (!metadata.title) return null;

    const srtFile = readdirSync(tempDir).find(f => f.endsWith('.en.srt'));
    if (!srtFile) return null;
    const srt = readFileSync(join(tempDir, srtFile), 'utf8');
    const transcript = parseSrt(srt);
    if (!transcript) return null;

    const lines: string[] = [];
    lines.push(`# ${metadata.title}`, '');
    if (metadata.uploader) lines.push(`Uploader: ${metadata.uploader}`, '');
    lines.push(`Source: ${url}`, '');
    lines.push('## Transcript', '');
    lines.push(transcript);

    return {
      title: metadata.title,
      uploader: metadata.uploader,
      markdown: lines.join('\n'),
    };
  } finally {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  }
}

interface YtDlpResult { stdout: string; }

function runYtDlp(binary: string, args: string[], timeoutMs: number): Promise<YtDlpResult | null> {
  return new Promise(resolve => {
    let proc;
    try {
      proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      resolve(null);
    }, timeoutMs);
    proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString(); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('exit', code => {
      clearTimeout(timer);
      resolve(code === 0 ? { stdout } : null);
    });
  });
}
