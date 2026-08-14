// Spotlight-backed recall: query macOS Spotlight (mdfind) for whole-disk
// candidates, then reuse extract.ts/search.ts to turn the top candidates into
// precise, anchored hits. Fail-open: mdfind absent/failed/empty -> []. macOS-only.
import { homedir } from 'node:os';
import { extractFile } from './extract.ts';
import { search, type Hit } from './search.ts';
import type { IndexRecord } from './index-store.ts';

export type ExecFn = (argv: string[]) => Promise<string>;

/** Build / dependency / cache directory names — a candidate is dropped if any
 *  of its path segments matches one of these (case-insensitive), or contains
 *  "cache" (e.g. hf-embedding-cache). Matched per-SEGMENT, so a file named
 *  "build-plan.md" is kept while a "build/" directory is excluded. */
export const JUNK_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.turbo', 'coverage', '__pycache__', '.venv', 'venv',
  'site-packages', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.cargo',
  'deriveddata',
]);

/** Document + note extensions kept by default (source code excluded). */
export const DOC_EXTS: readonly string[] = [
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
  'pages', 'key', 'numbers',
  'txt', 'md', 'markdown', 'rtf', 'rtfd', 'odt', 'ods', 'odp', 'csv', 'tex',
];

export interface CandidateFilter {
  exclude?: string[];
  /** Note: an empty array `[]` behaves the same as `null`/absent (no type filter) — the guard is `allowExts.length > 0`. */
  allowExts?: string[] | null;
}

function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Drop build/dep/cache junk (by path segment) and, when allowExts is a
 *  non-empty list, keep only those extensions. mdfind order is preserved. */
export function filterCandidates(paths: string[], opts?: CandidateFilter): string[] {
  const junk = new Set([...JUNK_SEGMENTS, ...(opts?.exclude ?? [])].map(s => s.toLowerCase()));
  const allow = opts?.allowExts && opts.allowExts.length > 0
    ? new Set(opts.allowExts.map(e => e.toLowerCase().replace(/^\./, '')))
    : null;
  const out: string[] = [];
  for (const p of paths) {
    const segs = p.split('/');
    let isJunk = false;
    for (let i = 0; i < segs.length; i++) {
      const sl = segs[i]!.toLowerCase();
      const isDir = i < segs.length - 1; // the terminal segment is the filename, not a dir
      if (junk.has(sl) || (isDir && sl.includes('cache'))) { isJunk = true; break; }
    }
    if (isJunk) continue;
    if (allow && !allow.has(extOf(p))) continue;
    out.push(p);
  }
  return out;
}

const defaultExec: ExecFn = async (argv) => {
  const proc = Bun.spawn(['/usr/bin/mdfind', ...argv], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`mdfind exited ${code}`);
  return out;
};

export async function mdfind(
  question: string,
  opts?: { onlyIn?: string[]; limit?: number },
  exec: ExecFn = defaultExec,
): Promise<string[]> {
  // mdfind treats an argv element starting with '-' as a flag (no '--' support),
  // so a leading-dash query would error out and silently return nothing. Strip them.
  const q = question.trim().replace(/^[-\s]+/, '');
  if (!q) return [];
  const argv: string[] = [];
  for (const dir of opts?.onlyIn ?? []) argv.push('-onlyin', dir);
  argv.push(q);
  let out: string;
  try {
    out = await exec(argv);
  } catch (err) {
    process.stderr.write(`[source-files] mdfind failed: ${(err as Error).message}\n`);
    return [];
  }
  const paths = out.split('\n').map(s => s.trim()).filter(Boolean);
  return paths.slice(0, opts?.limit ?? 40);
}

export function displayPath(abs: string): string {
  const home = homedir();
  return (abs === home || abs.startsWith(home + '/')) ? '~' + abs.slice(home.length) : abs;
}

export async function hitsFromPaths(paths: string[], question: string): Promise<Hit[]> {
  const index: IndexRecord[] = [];
  for (const abs of paths) {
    const ex = await extractFile(abs);
    if (ex === null) continue;
    index.push({ relPath: displayPath(abs), rootLabel: 'spotlight', absPath: abs, text: ex.text, isMedia: ex.isMedia });
  }
  return search(index, question);
}
