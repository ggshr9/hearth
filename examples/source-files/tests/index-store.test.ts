// examples/source-files/tests/index-store.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../src/index-store.ts';

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sf-index-'));
  writeFileSync(join(root, 'a.md'), 'alpha content one');
  writeFileSync(join(root, 'b.txt'), 'bravo content two');
  writeFileSync(join(root, 'clip.mp4'), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, 'pic.png'), Buffer.from([0x89])); // unsupported → skipped
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'junk.md'), 'should be skipped');
  mkdirSync(join(root, '.hidden'), { recursive: true });
  writeFileSync(join(root, '.hidden', 'secret.md'), 'should be skipped');
  return root;
}

test('buildIndex walks a root, extracts text, skips node_modules/dotdirs/unsupported', async () => {
  const root = seedRoot();
  const idx = await buildIndex([root]);
  const rels = idx.map(r => r.relPath).sort();
  expect(rels).toEqual(['a.md', 'b.txt', 'clip.mp4']); // png/node_modules/.hidden excluded
  const a = idx.find(r => r.relPath === 'a.md')!;
  expect(a.text).toContain('alpha content');
  expect(a.isMedia).toBe(false);
  const clip = idx.find(r => r.relPath === 'clip.mp4')!;
  expect(clip.isMedia).toBe(true);
  expect(clip.text).toBe('');
});

test('buildIndex handles multiple roots and a missing root gracefully', async () => {
  const root = seedRoot();
  const idx = await buildIndex([root, '/no/such/dir/xyz']);
  expect(idx.length).toBe(3); // missing root contributes nothing, no throw
});

test('buildIndex returns [] for no roots', async () => {
  expect(await buildIndex([])).toEqual([]);
});
