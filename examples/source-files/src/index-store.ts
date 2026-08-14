// Build an in-memory index by walking each root once at startup. Skips
// node_modules/.git/dotdirs, oversized files, and unsupported types. Rebuilt
// on restart (persistent/incremental indexing is a non-goal).
import { readdir, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { extractFile } from './extract.ts';

export interface IndexRecord {
  relPath: string;
  rootLabel: string;
  absPath: string;
  text: string;
  isMedia: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', 'target']);
const MAX_BYTES = 10 * 1024 * 1024;

export async function buildIndex(roots: string[]): Promise<IndexRecord[]> {
  const records: IndexRecord[] = [];
  for (const root of roots) {
    await walk(root, root, records);
  }
  return records;
}

async function walk(root: string, dir: string, out: IndexRecord[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable/missing dir → contribute nothing
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // dotfiles + dotdirs
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(root, abs, out);
      continue;
    }
    if (!e.isFile()) continue;
    let size = 0;
    try { size = (await stat(abs)).size; } catch { continue; }
    if (size > MAX_BYTES) continue;
    const ex = await extractFile(abs);
    if (ex === null) continue;
    out.push({ relPath: relative(root, abs), rootLabel: basename(root), absPath: abs, text: ex.text, isMedia: ex.isMedia });
  }
}
