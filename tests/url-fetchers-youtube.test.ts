// fetchYouTubeTranscript pulls the auto-subs + metadata for a YouTube URL
// via yt-dlp and converts to a hearth-friendly markdown body. Tests use a
// fake yt-dlp script (tests/fixtures/yt-fake.sh) that writes canned SRT +
// metadata JSON — CI does not require the real binary.

import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchYouTubeTranscript,
  isYouTubeUrl,
  parseSrt,
} from '../src/ingest/url-fetchers/youtube.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_YTDL = resolve(__dirname, 'fixtures', 'yt-fake.sh');

describe('isYouTubeUrl', () => {
  it('matches youtube.com/watch?v=...', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://youtube.com/watch?v=abc')).toBe(true);
  });
  it('matches youtu.be/...', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });
  it('matches youtube.com/shorts/...', () => {
    expect(isYouTubeUrl('https://www.youtube.com/shorts/abcdef')).toBe(true);
  });
  it('rejects non-YouTube URLs', () => {
    expect(isYouTubeUrl('https://example.com')).toBe(false);
    expect(isYouTubeUrl('https://vimeo.com/123')).toBe(false);
    expect(isYouTubeUrl('not a url')).toBe(false);
  });
});

describe('parseSrt', () => {
  it('converts SRT blocks into [HH:MM:SS] markdown lines', () => {
    const srt = `1
00:00:00,000 --> 00:00:03,500
First line

2
00:00:03,500 --> 00:00:07,000
Second line
spans two physical lines

3
00:01:23,400 --> 00:01:27,000
Third
`;
    const md = parseSrt(srt);
    expect(md).toContain('[00:00:00] First line');
    expect(md).toContain('[00:00:03] Second line spans two physical lines');
    expect(md).toContain('[00:01:23] Third');
  });

  it('returns empty string for empty SRT', () => {
    expect(parseSrt('')).toBe('');
  });
});

describe('fetchYouTubeTranscript', () => {
  it('returns a markdown body containing the title + transcript', async () => {
    const result = await fetchYouTubeTranscript(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      { binary: FAKE_YTDL },
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Never Gonna Give You Up');
    expect(result!.uploader).toBe('Rick Astley');
    expect(result!.markdown).toContain('# Never Gonna Give You Up');
    expect(result!.markdown).toContain('[00:00:00] We');
    expect(result!.markdown).toContain('Rick Astley');
  });

  it('returns null for non-YouTube URLs', async () => {
    const result = await fetchYouTubeTranscript(
      'https://example.com/article',
      { binary: FAKE_YTDL },
    );
    expect(result).toBeNull();
  });

  it('returns null when yt-dlp binary is missing', async () => {
    const result = await fetchYouTubeTranscript(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      { binary: '/nonexistent/yt-dlp-not-here' },
    );
    expect(result).toBeNull();
  });
});
