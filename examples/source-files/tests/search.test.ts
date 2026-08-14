import { test, expect } from 'bun:test';
import { search, tokenize } from '../src/search.ts';
import type { IndexRecord } from '../src/index-store.ts';

function rec(relPath: string, text: string, isMedia = false): IndexRecord {
  return { relPath, rootLabel: 'root', absPath: '/x/' + relPath, text, isMedia };
}

test('tokenize lowercases, splits on non-alphanumeric, keeps CJK chars, drops 1-char latin', () => {
  expect(tokenize('Hello, World! a')).toEqual(['hello', 'world']);
  expect(tokenize('营收 forecast')).toContain('营');
  expect(tokenize('营收 forecast')).toContain('forecast');
});

test('search returns the best-matching file top-ranked with a file:line anchor', () => {
  const idx = [
    rec('notes/q3.md', 'line one\nquarterly revenue forecast is up\nline three'),
    rec('other.md', 'unrelated content about cats'),
  ];
  const hits = search(idx, 'quarterly revenue');
  expect(hits.length).toBe(1);
  expect(hits[0]!.source).toBe('notes/q3.md');
  expect(hits[0]!.anchor_summary).toBe('notes/q3.md:2');
  expect(hits[0]!.claim_text).toContain('quarterly revenue forecast');
  expect(hits[0]!.match_score).toBe(1); // 1/(1+0)
  expect(hits[0]!.confidence).toBe('high');
});

test('multi-file matches are rank-normalized (strictly descending, first=1.0)', () => {
  const idx = [
    rec('a.md', 'revenue revenue revenue forecast'),   // higher coverage+occurrence
    rec('b.md', 'forecast only here'),
    rec('c.md', 'nothing relevant'),
  ];
  const hits = search(idx, 'revenue forecast');
  expect(hits.map(h => h.source)).toEqual(['a.md', 'b.md']); // c excluded (0 matches)
  expect(hits[0]!.match_score).toBe(1);
  expect(hits[1]!.match_score).toBeCloseTo(0.5, 5);
  expect(hits[0]!.match_score).toBeGreaterThan(hits[1]!.match_score);
});

test('media files match on filename and report a media anchor', () => {
  const hits = search([rec('talks/keynote-revenue.mp4', '', true)], 'revenue');
  expect(hits.length).toBe(1);
  expect(hits[0]!.anchor_summary).toContain('(media)');
  expect(hits[0]!.claim_text.toLowerCase()).toContain('keynote-revenue');
});

test('no-match question returns []', () => {
  expect(search([rec('a.md', 'cats and dogs')], 'quarterly revenue')).toEqual([]);
});

test('empty question returns []', () => {
  expect(search([rec('a.md', 'anything')], '   ')).toEqual([]);
});

test('coverage dominates unconditionally over occurrence count (no overflow into next tier)', () => {
  const idx = [
    rec('A.md', Array(1003).fill('forecast').join(' ')), // coverage 1, occ 1003
    rec('B.md', 'revenue forecast'),                     // coverage 2, occ 2
  ];
  const hits = search(idx, 'revenue forecast');
  expect(hits[0]!.source).toBe('B.md');
});

test('filename-only match cites the filename, not an unrelated body line', () => {
  const hits = search([rec('revenue-report.md', 'unrelated content about kittens')], 'revenue');
  expect(hits.length).toBe(1);
  expect(hits[0]!.anchor_summary).toBe('revenue-report.md');
  expect(hits[0]!.claim_text).toContain('revenue-report.md');
  expect(hits[0]!.claim_text).not.toContain('kittens');
});
