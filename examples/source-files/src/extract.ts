// Extract searchable text from a file. Text types are read directly; Office/PDF
// go through officeparser; media is metadata-only (no content — transcription
// is a non-goal); everything else is skipped. Throw-proof: any failure → null.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseOffice } from 'officeparser';

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.text', '.log', '.csv']);
const OFFICE_EXTS = new Set(['.docx', '.pptx', '.xlsx', '.pdf', '.odt', '.odp', '.ods']);
const MEDIA_EXTS = new Set(['.mp3', '.mp4', '.m4a', '.wav', '.mov', '.avi', '.mkv', '.flac', '.aac', '.webm', '.ogg']);

export interface Extracted { text: string; isMedia: boolean }

export function classify(path: string): 'text' | 'office' | 'media' | 'skip' {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXTS.has(ext)) return 'text';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (MEDIA_EXTS.has(ext)) return 'media';
  return 'skip';
}

export async function extractFile(path: string): Promise<Extracted | null> {
  const kind = classify(path);
  try {
    if (kind === 'text') return { text: await readFile(path, 'utf8'), isMedia: false };
    if (kind === 'office') {
      const ast = await parseOffice(path);
      return { text: String(ast?.toText() ?? ''), isMedia: false };
    }
    if (kind === 'media') return { text: '', isMedia: true };
    // Unrecognized extension (e.g. source code/config surfaced by --all-types):
    // best-effort UTF-8 read. Binary files decode with U+FFFD replacement
    // characters for their invalid byte sequences -> treat as unsupported.
    const text = await readFile(path, 'utf8');
    if (text.includes('�')) return null;
    return { text, isMedia: false };
  } catch (err) {
    process.stderr.write(`[source-files] extract failed for ${path}: ${(err as Error).message}\n`);
    return null;
  }
}
