// Spotlight-backed recall: query macOS Spotlight (mdfind) for whole-disk
// candidates, then reuse extract.ts/search.ts to turn the top candidates into
// precise, anchored hits. Fail-open: mdfind absent/failed/empty -> []. macOS-only.
import { homedir } from 'node:os';
import { extractFile } from './extract.ts';
import { search, type Hit } from './search.ts';
import type { IndexRecord } from './index-store.ts';

export type ExecFn = (argv: string[]) => Promise<string>;

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
  const q = question.trim();
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

function displayPath(abs: string): string {
  const home = homedir();
  return abs.startsWith(home) ? '~' + abs.slice(home.length) : abs;
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
