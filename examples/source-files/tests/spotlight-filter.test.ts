import { test, expect } from 'bun:test';
import { filterCandidates, JUNK_SEGMENTS, DOC_EXTS } from '../src/spotlight.ts';

const mixed = [
  '/U/me/Documents/notes/q3.pdf',
  '/U/me/Documents/report.docx',
  '/U/me/Documents/notes/plan.md',
  '/U/me/Documents/notes/build-plan.md',            // FILE named build-* — must NOT be dropped
  '/U/me/Documents/app/src/index.ts',               // source code
  '/U/me/Documents/svc/main.go',                    // source code
  '/U/me/Documents/app/node_modules/pkg/readme.md', // junk dir
  '/U/me/Documents/app/dist/out.md',                // junk dir
  '/U/me/Documents/app/target/debug/x.md',          // junk dir
  '/U/me/Documents/data/hf-embedding-cache/vocab.txt', // cache substring
  '/U/me/Documents/app/.git/COMMIT_EDITMSG',        // junk dir
];

test('default (DOC_EXTS) keeps documents, drops junk dirs AND source code', () => {
  const out = filterCandidates(mixed, { allowExts: DOC_EXTS as string[] });
  expect(out).toEqual([
    '/U/me/Documents/notes/q3.pdf',
    '/U/me/Documents/report.docx',
    '/U/me/Documents/notes/plan.md',
    '/U/me/Documents/notes/build-plan.md',
  ]);
});

test('allowExts null keeps source code but STILL drops junk dirs', () => {
  const out = filterCandidates(mixed, { allowExts: null });
  expect(out).toContain('/U/me/Documents/app/src/index.ts');
  expect(out).toContain('/U/me/Documents/svc/main.go');
  expect(out).not.toContain('/U/me/Documents/app/node_modules/pkg/readme.md');
  expect(out).not.toContain('/U/me/Documents/data/hf-embedding-cache/vocab.txt');
  expect(out).not.toContain('/U/me/Documents/app/.git/COMMIT_EDITMSG');
});

test('exclude adds a junk segment (case-insensitive)', () => {
  const out = filterCandidates(['/U/me/Documents/Secret/a.pdf', '/U/me/Documents/ok/b.pdf'], { allowExts: DOC_EXTS as string[], exclude: ['secret'] });
  expect(out).toEqual(['/U/me/Documents/ok/b.pdf']);
});

test('DOC_EXTS excludes source-code extensions; JUNK_SEGMENTS covers node_modules', () => {
  expect(DOC_EXTS).toContain('pdf'); expect(DOC_EXTS).toContain('md');
  expect(DOC_EXTS).not.toContain('ts'); expect(DOC_EXTS).not.toContain('go');
  expect(JUNK_SEGMENTS.has('node_modules')).toBe(true);
});

test('terminal filenames containing "cache" are kept — only cache DIRECTORIES are junk', () => {
  const out = filterCandidates(
    ['/U/me/Documents/cache-strategy.pdf', '/U/me/Documents/Cache Invalidation Notes.docx'],
    { allowExts: DOC_EXTS as string[] },
  );
  expect(out).toEqual([
    '/U/me/Documents/cache-strategy.pdf',
    '/U/me/Documents/Cache Invalidation Notes.docx',
  ]);
});

test('a cache DIRECTORY segment still drops its contents', () => {
  const out = filterCandidates(
    ['/U/me/Documents/data/hf-embedding-cache/vocab.txt'],
    { allowExts: null },
  );
  expect(out).toEqual([]);
});

test('.cache directory segment is dropped', () => {
  const out = filterCandidates(
    ['/U/me/Documents/proj/.cache/x.md'],
    { allowExts: DOC_EXTS as string[] },
  );
  expect(out).toEqual([]);
});
