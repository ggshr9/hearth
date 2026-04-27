// Capture token — the long-lived credential carried by external capture
// surfaces (iOS Shortcut, Telegram bot, browser bookmarklet, …) when they
// POST to /ingest. Distinct from the SPEC §11 approval token in two ways:
//
//   1. Long-lived: default 30 days. The user issues one once, configures
//      it into their phone shortcut or bot, and forgets about it.
//   2. NOT single-use: one token authorizes many captures.
//
// Cross-type confusion is prevented by the `capability` discriminator —
// an approval token can never be used as a capture token, and vice versa,
// even though both share the per-installation HMAC secret.
//
// Security envelope:
//   - The token never grants apply authority; it only authorizes appending
//     a ChangePlan to the pending queue. Approval still requires the §11
//     approval-token flow.
//   - Worst case on leak: an adversary can flood pending/. Bounded blast
//     radius — vault is not mutated, only the queue grows.

import { randomBytes } from 'node:crypto';
import { signPayload, decodeAndVerify } from './token-crypto.ts';

export interface CaptureTokenPayload {
  jti: string;
  /** Distinguishes capture tokens from approval tokens at verify time. */
  capability: 'capture';
  /** ISO 8601 issuance time. */
  iat: string;
  /** ISO 8601 expiry. */
  exp: string;
  /** Human surface that issued this (audit only). */
  issued_by: string;
  /** Optional human-readable name (e.g. "iphone-shortcut", "telegram-bot"). */
  name?: string;
}

export interface IssuedCaptureToken {
  token: string;
  payload: CaptureTokenPayload;
}

const DEFAULT_TTL_DAYS = 30;

export function issueCaptureToken(args: {
  issued_by: string;
  ttl_days?: number;
  name?: string;
}): IssuedCaptureToken {
  const ttlDays = args.ttl_days ?? DEFAULT_TTL_DAYS;
  const payload: CaptureTokenPayload = {
    jti: randomBytes(8).toString('hex'),
    capability: 'capture',
    iat: new Date().toISOString(),
    exp: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
    issued_by: args.issued_by,
    ...(args.name ? { name: args.name } : {}),
  };
  return { token: signPayload(payload), payload };
}

export class CaptureTokenError extends Error {
  constructor(public readonly reason: 'malformed' | 'invalid_sig' | 'expired' | 'wrong_capability') {
    super(`capture token rejected: ${reason}`);
    this.name = 'CaptureTokenError';
  }
}

export function verifyCaptureToken(token: string): CaptureTokenPayload {
  let payload: CaptureTokenPayload;
  try {
    payload = decodeAndVerify(token) as CaptureTokenPayload;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('malformed')) throw new CaptureTokenError('malformed');
    throw new CaptureTokenError('invalid_sig');
  }
  if (payload.capability !== 'capture') {
    throw new CaptureTokenError('wrong_capability');
  }
  if (new Date(payload.exp).getTime() < Date.now()) {
    throw new CaptureTokenError('expired');
  }
  return payload;
}
