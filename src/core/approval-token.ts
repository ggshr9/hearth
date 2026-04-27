// Approval token protocol — the kernel-side gate for vault_apply_change via MCP.
//
// Invariant: an agent talking to hearth via MCP cannot apply a ChangePlan
// without a token issued by a human-direct surface (CLI / wechat-cc /
// future Local Console). This makes apply NOT a silent agent capability.
//
// Token envelope is shared with capture-token.ts — see token-crypto.ts.
// What's specific to approval tokens:
//   - Single-use: kernel records consumed token IDs in a deque file
//   - Expires: default 5 min; configurable per issuance
//   - Scoped: bound to one specific change_id
//   - Risk-class aware: high-risk ops require explicit `high` scope
//   - capability discriminator: 'approval' (rejects cross-type tokens)

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { signPayload, decodeAndVerify } from './token-crypto.ts';

export type Risk = 'low' | 'medium' | 'high';

export interface TokenPayload {
  /** Random per-token ID; used to enforce single-use. */
  jti: string;
  /** Discriminator that prevents cross-type confusion with capture tokens. */
  capability?: 'approval';
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

const CONSUMED_PATH = join(homedir(), '.hearth', 'consumed-tokens.log');
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;

/** Issue a token. Called by human-surface code (CLI / channel adapter). */
export function issueToken(args: {
  change_id: string;
  scope?: Risk;
  expires_in_ms?: number;
  issued_by: string;
}): IssuedToken {
  const payload: TokenPayload = {
    jti: randomBytes(8).toString('hex'),
    capability: 'approval',
    change_id: args.change_id,
    scope: args.scope ?? 'low',
    iat: new Date().toISOString(),
    exp: new Date(Date.now() + (args.expires_in_ms ?? DEFAULT_EXPIRY_MS)).toISOString(),
    issued_by: args.issued_by,
  };
  return { token: signPayload(payload), payload };
}

export class TokenError extends Error {
  constructor(public readonly reason: 'malformed' | 'invalid_sig' | 'expired' | 'consumed' | 'wrong_change_id' | 'insufficient_scope' | 'wrong_capability') {
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

/** Verify validity without consuming. Throws TokenError on any failure. */
export function verifyToken(args: {
  token: string;
  change_id: string;
  required_scope: Risk;
}): TokenPayload {
  return verifyCore(args);
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
  const payload = verifyCore(args);
  markConsumed(payload.jti);
  return payload;
}

function verifyCore(args: {
  token: string;
  change_id: string;
  required_scope: Risk;
}): TokenPayload {
  let payload: TokenPayload;
  try {
    payload = decodeAndVerify(args.token) as TokenPayload;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('malformed')) throw new TokenError('malformed');
    throw new TokenError('invalid_sig');
  }

  // Capability discriminator — reject capture/other tokens. Older approval
  // tokens issued before the discriminator existed lack this field; treat
  // missing as approval-grade for backward compatibility within the same
  // installation.
  if (payload.capability !== undefined && payload.capability !== 'approval') {
    throw new TokenError('wrong_capability');
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

  return payload;
}
