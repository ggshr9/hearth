import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

export function sha256(content: string | Buffer): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

/** sha256 of a file's current contents. Returns null if the file is absent. */
export function fileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path));
}
