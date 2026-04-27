// Capture token — the primitive that lets external surfaces (iOS Shortcut,
// Telegram bot, etc.) POST inbound material to /ingest. Distinct from the
// SPEC §11 approval token in two ways: capture tokens are long-lived (default
// 30 days), and they are NOT single-use — one token authorizes many captures.
//
// These tests pin the security envelope: HMAC verification, expiry, distinct
// capability marker (so an approval token can never be passed off as a
// capture token or vice versa).

import { describe, expect, it } from 'vitest';
import {
  issueCaptureToken,
  verifyCaptureToken,
  CaptureTokenError,
} from '../src/core/capture-token.ts';
import { issueToken as issueApprovalToken } from '../src/core/approval-token.ts';

describe('capture token: issue + verify', () => {
  it('issues a token and verifies it back', () => {
    const { token, payload } = issueCaptureToken({ issued_by: 'test' });
    expect(payload.capability).toBe('capture');
    expect(payload.jti).toBeDefined();
    const verified = verifyCaptureToken(token);
    expect(verified.jti).toBe(payload.jti);
    expect(verified.capability).toBe('capture');
  });

  it('default TTL is 30 days', () => {
    const { payload } = issueCaptureToken({ issued_by: 'test' });
    const lifeMs = new Date(payload.exp).getTime() - new Date(payload.iat).getTime();
    const days = lifeMs / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(29.9);
    expect(days).toBeLessThanOrEqual(30.1);
  });

  it('honors a custom TTL', () => {
    const { payload } = issueCaptureToken({ issued_by: 'test', ttl_days: 7 });
    const lifeMs = new Date(payload.exp).getTime() - new Date(payload.iat).getTime();
    expect(lifeMs / 86_400_000).toBeCloseTo(7, 1);
  });

  it('records the optional name field', () => {
    const { payload } = issueCaptureToken({ issued_by: 'test', name: 'iphone-shortcut' });
    expect(payload.name).toBe('iphone-shortcut');
  });

  it('is reusable — verifies many times in a row', () => {
    const { token } = issueCaptureToken({ issued_by: 'test' });
    for (let i = 0; i < 5; i++) {
      const p = verifyCaptureToken(token);
      expect(p.capability).toBe('capture');
    }
  });
});

describe('capture token: rejection paths', () => {
  it('rejects expired tokens', () => {
    const { token } = issueCaptureToken({ issued_by: 'test', ttl_days: -1 });
    expect(() => verifyCaptureToken(token)).toThrow(CaptureTokenError);
  });

  it('rejects malformed tokens', () => {
    expect(() => verifyCaptureToken('garbage')).toThrow(CaptureTokenError);
    expect(() => verifyCaptureToken('a.b.c')).toThrow(CaptureTokenError);
    expect(() => verifyCaptureToken('')).toThrow(CaptureTokenError);
  });

  it('rejects approval tokens (cross-type confusion)', () => {
    // A SPEC §11 approval token must not be accepted as a capture token, even
    // though both are HMAC'd with the same per-installation secret.
    const { token } = issueApprovalToken({ change_id: 'cp-1', issued_by: 'test' });
    expect(() => verifyCaptureToken(token)).toThrow(CaptureTokenError);
  });
});
