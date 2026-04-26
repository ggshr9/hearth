// Approval token protocol — the kernel-side gate for vault_apply_change via MCP.
//
// Invariant: an agent talking to hearth via MCP cannot apply a ChangePlan
// without a token issued by a human-direct surface (CLI / wechat-cc /
// future Local Console). This makes apply NOT a silent agent capability.
//
// Token format: HMAC-SHA256(secret, "<change_id>|<expires_at>|<scope>") +
// the same payload, base64url-encoded as "payload.sig".
//
// Properties:
//   - Single-use: kernel records consumed token IDs in a deque file
//   - Expires: default 5 min; configurable per issuance
//   - Scoped: bound to one specific change_id
//   - Risk-class aware: high-risk ops require explicit `high` scope
//   - Not network-transmitted: tokens stay on the user's machine

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type Risk = 'low' | 'medium' | 'high';

export interface TokenPayload {
  /** Random per-token ID; used to enforce single-use. */
  jti: string;
  /** ChangePlan this token authorizes. */
  change_id: string;
  /** Highest risk class the kernel should accept under this token. */
  scope: Risk;
  /** ISO 8601 issuance time. */
  iat: string;
  /** ISO 8601 expiry. */
  exp: string;
  /** Human surface that issued this (audit only). */
  issued_by: string;
}

export interface IssuedToken {
  /** Opaque token string for the agent to pass to vault_apply_change. */
  token: string;
  /** Unwrapped payload (for the issuing surface to log / display). */
  payload: TokenPayload;
}

const SECRET_PATH = join(homedir(), '.hearth', 'secret.key');
const CONSUMED_PATH = join(homedir(), '.hearth', 'consumed-tokens.log');
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;

/** Lazily generate a per-installation HMAC secret. chmod 600. */
function loadOrCreateSecret(): Buffer {
  mkdirSync(join(homedir(), '.hearth'), { recursive: true, mode: 0o700 });
  if (!existsSync(SECRET_PATH)) {
    const secret = randomBytes(32);
    writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  }
  return readFileSync(SECRET_PATH);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Issue a token. Called by human-surface code (CLI / channel adapter). */
export function issueToken(args: {
  change_id: string;
  scope?: Risk;
  expires_in_ms?: number;
  issued_by: string;
}): IssuedToken {
  const payload: TokenPayload = {
    jti: randomBytes(8).toString('hex'),
    change_id: args.change_id,
    scope: args.scope ?? 'low',
    iat: new Date().toISOString(),
    exp: new Date(Date.now() + (args.expires_in_ms ?? DEFAULT_EXPIRY_MS)).toISOString(),
    issued_by: args.issued_by,
  };
  const payloadJson = JSON.stringify(payload);
  const sig = createHmac('sha256', loadOrCreateSecret()).update(payloadJson).digest();
  const token = `${b64url(Buffer.from(payloadJson))}.${b64url(sig)}`;
  return { token, payload };
}

export class TokenError extends Error {
  constructor(public readonly reason: 'malformed' | 'invalid_sig' | 'expired' | 'consumed' | 'wrong_change_id' | 'insufficient_scope') {
    super(`token rejected: ${reason}`);
    this.name = 'TokenError';
  }
}

function isConsumed(jti: string): boolean {
  if (!existsSync(CONSUMED_PATH)) return false;
  // Naive scan; v0.5 may switch to a sqlite-backed index if N grows
  const text = readFileSync(CONSUMED_PATH, 'utf8');
  return text.split('\n').some(line => line.startsWith(jti + ' '));
}

function markConsumed(jti: string): void {
  mkdirSync(join(homedir(), '.hearth'), { recursive: true, mode: 0o700 });
  appendFileSync(CONSUMED_PATH, `${jti} ${new Date().toISOString()}\n`, { mode: 0o600 });
}

/**
 * Verify a token for a given change_id and required risk. Throws TokenError
 * with a precise reason. On success, marks the token consumed (single-use).
 */
export function verifyAndConsume(args: {
  token: string;
  change_id: string;
  required_scope: Risk;
}): TokenPayload {
  const parts = args.token.split('.');
  if (parts.length !== 2) throw new TokenError('malformed');
  const [payloadB64, sigB64] = parts;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64!).toString('utf8')) as TokenPayload;
  } catch {
    throw new TokenError('malformed');
  }

  // Verify HMAC
  const payloadJson = JSON.stringify(payload);
  const expectedSig = createHmac('sha256', loadOrCreateSecret()).update(payloadJson).digest();
  const givenSig = b64urlDecode(sigB64!);
  if (expectedSig.length !== givenSig.length || !timingSafeEqual(expectedSig, givenSig)) {
    throw new TokenError('invalid_sig');
  }

  // Expiry
  if (new Date(payload.exp).getTime() < Date.now()) throw new TokenError('expired');

  // Bind to change_id
  if (payload.change_id !== args.change_id) throw new TokenError('wrong_change_id');

  // Scope: token's `scope` is a ceiling. Required ≤ token.
  const order: Risk[] = ['low', 'medium', 'high'];
  if (order.indexOf(args.required_scope) > order.indexOf(payload.scope)) {
    throw new TokenError('insufficient_scope');
  }

  // Single-use
  if (isConsumed(payload.jti)) throw new TokenError('consumed');
  markConsumed(payload.jti);

  return payload;
}

/** Constant-time equality to prevent HMAC timing attacks. */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i]! ^ b[i]!);
  return diff === 0;
}
