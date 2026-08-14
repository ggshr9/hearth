import { test, expect } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile, classify } from '../src/extract.ts';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'sf-extract-')); }

test('classify routes by extension', () => {
  expect(classify('/a/b.md')).toBe('text');
  expect(classify('/a/b.TXT')).toBe('text');
  expect(classify('/a/b.docx')).toBe('office');
  expect(classify('/a/b.pdf')).toBe('office');
  expect(classify('/a/b.mp4')).toBe('media');
  expect(classify('/a/b.png')).toBe('skip');
});

test('extractFile reads text files directly', async () => {
  const dir = tmp();
  const p = join(dir, 'note.md');
  writeFileSync(p, '# Title\nquarterly revenue forecast');
  const ex = await extractFile(p);
  expect(ex).not.toBeNull();
  expect(ex!.isMedia).toBe(false);
  expect(ex!.text).toContain('quarterly revenue');
});

test('extractFile marks media as metadata-only (empty text, isMedia)', async () => {
  const dir = tmp();
  const p = join(dir, 'clip.mp4');
  writeFileSync(p, Buffer.from([0x00, 0x01, 0x02])); // not real mp4; extractor must not read content
  const ex = await extractFile(p);
  expect(ex).toEqual({ text: '', isMedia: true });
});

test('extractFile returns null for unsupported types', async () => {
  const dir = tmp();
  const p = join(dir, 'image.png');
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  expect(await extractFile(p)).toBeNull();
});

test('extractFile is throw-proof: a corrupt office file → null, not a throw', async () => {
  const dir = tmp();
  const p = join(dir, 'broken.docx');
  writeFileSync(p, Buffer.from('this is not a real docx zip'));
  const ex = await extractFile(p); // officeparser will throw internally; extractFile must catch → null
  expect(ex).toBeNull();
});

// Office/PDF happy path — real fixture (see Step 6).
test('extractFile extracts text from a real .docx fixture', async () => {
  const ex = await extractFile(join(import.meta.dir, 'fixtures', 'sample.docx'));
  expect(ex).not.toBeNull();
  expect(ex!.isMedia).toBe(false);
  expect(ex!.text.toLowerCase()).toContain('hearth');
});
