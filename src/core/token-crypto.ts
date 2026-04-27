// Shared HMAC primitives for token-based authorization (approval, capture).
//
// All token types use the same per-installation secret in
// ~/.hearth/secret.key (lazily generated, chmod 600). Each type defines its
// own payload shape on top; the cryptographic envelope is uniform:
//
//   token = b64url(JSON(payload)) + "." + b64url(HMAC-SHA256(secret, JSON(payload)))
//
// Cross-type confusion is prevented at the payload level (each verifier
// asserts on a `capability` discriminator), not at the crypto level.

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SECRET_PATH = join(homedir(), '.hearth', 'secret.key');

/** Lazily generate the per-installation HMAC secret. chmod 600. */
export function loadOrCreateSecret(): Buffer {
  mkdirSync(join(homedir(), '.hearth'), { recursive: true, mode: 0o700 });
  if (!existsSync(SECRET_PATH)) {
    const secret = randomBytes(32);
    writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  }
  return readFileSync(SECRET_PATH);
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Constant-time equality to prevent HMAC timing attacks. */
export function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i]! ^ b[i]!);
  return diff === 0;
}

/** Sign an arbitrary JSON-serializable payload. Returns `payload.sig`. */
export function signPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  const sig = createHmac('sha256', loadOrCreateSecret()).update(json).digest();
  return `${b64url(Buffer.from(json))}.${b64url(sig)}`;
}

/** Decode + HMAC-verify a token. Throws on malformed/sig-mismatch. The
 *  caller is responsible for further structural validation (capability
 *  discriminator, expiry, etc.). */
export function decodeAndVerify(token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('malformed: not a 2-part token');
  const [payloadB64, sigB64] = parts;
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64!).toString('utf8'));
  } catch {
    throw new Error('malformed: payload not JSON');
  }
  const json = JSON.stringify(payload);
  const expected = createHmac('sha256', loadOrCreateSecret()).update(json).digest();
  const given = b64urlDecode(sigB64!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error('invalid signature');
  }
  return payload;
}
