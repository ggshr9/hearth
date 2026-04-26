// hearth v0.4 — audit log, approval token, MCP server tests

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, readAudit, parseSince } from '../src/core/audit.ts';
import { issueToken, verifyAndConsume, verifyToken, TokenError } from '../src/core/approval-token.ts';
import { schemaVersionHash, schemaLastModified } from '../src/core/schema.ts';

const SCHEMA = `---
type: meta
---

## hearth permissions

| dir | human | agent |
|-----|-------|-------|
| raw/ | add | add |
| 06 Hearth Inbox/ | rw | rw |
`;

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'hearth-v04-'));
  for (const d of ['raw', '06 Hearth Inbox']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), SCHEMA);
  return root;
}

describe('audit log: append + read', () => {
  it('writes entries to <vault>/.hearth/audit.jsonl and reads them back', async () => {
    const vault = makeVault();
    await audit(vault, { event: 'lint.run', initiated_by: 'test', data: { findings: 0 } });
    await audit(vault, { event: 'changeplan.created', initiated_by: 'test', data: { change_id: 'abc' } });

    const path = join(vault, '.hearth', 'audit.jsonl');
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const entries = readAudit(vault);
    // most-recent first
    expect(entries[0]?.event).toBe('changeplan.created');
    expect(entries[1]?.event).toBe('lint.run');
  });

  it('filters by since', async () => {
    const vault = makeVault();
    await audit(vault, { event: 'lint.run', initiated_by: 'test' });
    await new Promise(r => setTimeout(r, 25));
    const beforeSecond = new Date();
    await new Promise(r => setTimeout(r, 25));
    await audit(vault, { event: 'doctor.run', initiated_by: 'test' });

    const recent = readAudit(vault, { since: beforeSecond });
    expect(recent.map(e => e.event)).toEqual(['doctor.run']);
  });

  it('parseSince handles 7d / 24h / 30m', () => {
    const now = Date.now();
    expect(Math.abs(parseSince('30m')!.getTime() - (now - 30 * 60_000))).toBeLessThan(1000);
    expect(Math.abs(parseSince('24h')!.getTime() - (now - 24 * 3_600_000))).toBeLessThan(1000);
    expect(Math.abs(parseSince('7d')!.getTime() - (now - 7 * 86_400_000))).toBeLessThan(1000);
    expect(parseSince('garbage')).toBeNull();
  });
});

describe('approval token: issue + verify + single-use + expiry', () => {
  it('issues a token and verifyAndConsume succeeds once', () => {
    const { token, payload } = issueToken({ change_id: 'cp-1', issued_by: 'test' });
    expect(payload.scope).toBe('low');
    const verified = verifyAndConsume({ token, change_id: 'cp-1', required_scope: 'low' });
    expect(verified.jti).toBe(payload.jti);
  });

  it('rejects reuse (single-use enforcement)', () => {
    const { token } = issueToken({ change_id: 'cp-2', issued_by: 'test' });
    verifyAndConsume({ token, change_id: 'cp-2', required_scope: 'low' });
    expect(() => verifyAndConsume({ token, change_id: 'cp-2', required_scope: 'low' })).toThrow(TokenError);
  });

  it('rejects token bound to a different change_id', () => {
    const { token } = issueToken({ change_id: 'cp-3', issued_by: 'test' });
    expect(() => verifyAndConsume({ token, change_id: 'cp-OTHER', required_scope: 'low' })).toThrow(/wrong_change_id/);
  });

  it('rejects when required_scope exceeds token scope', () => {
    const { token } = issueToken({ change_id: 'cp-4', scope: 'low', issued_by: 'test' });
    expect(() => verifyAndConsume({ token, change_id: 'cp-4', required_scope: 'high' })).toThrow(/insufficient_scope/);
  });

  it('rejects expired tokens', () => {
    const { token } = issueToken({ change_id: 'cp-5', expires_in_ms: -1000, issued_by: 'test' });
    expect(() => verifyAndConsume({ token, change_id: 'cp-5', required_scope: 'low' })).toThrow(/expired/);
  });

  it('rejects malformed tokens', () => {
    expect(() => verifyAndConsume({ token: 'garbage', change_id: 'x', required_scope: 'low' })).toThrow(/malformed/);
    expect(() => verifyAndConsume({ token: 'a.b.c', change_id: 'x', required_scope: 'low' })).toThrow(/malformed/);
  });

  it('rejects tampered signature', () => {
    const { token } = issueToken({ change_id: 'cp-6', issued_by: 'test' });
    const [payload, sig] = token.split('.');
    // Flip a byte in the sig
    const badSig = sig!.slice(0, -1) + (sig!.slice(-1) === 'A' ? 'B' : 'A');
    expect(() => verifyAndConsume({ token: `${payload}.${badSig}`, change_id: 'cp-6', required_scope: 'low' })).toThrow(/invalid_sig/);
  });
});

describe('approval token: verify without consume', () => {
  it('verifyToken returns payload without marking consumed', async () => {
    const { verifyToken } = await import('../src/core/approval-token.ts');
    const { token } = issueToken({ change_id: 'cp-vw', issued_by: 'test' });
    // verify, twice — should not be consumed by either
    const p1 = verifyToken({ token, change_id: 'cp-vw', required_scope: 'low' });
    expect(p1.change_id).toBe('cp-vw');
    const p2 = verifyToken({ token, change_id: 'cp-vw', required_scope: 'low' });
    expect(p2.jti).toBe(p1.jti);
    // Now consume — first time succeeds
    verifyAndConsume({ token, change_id: 'cp-vw', required_scope: 'low' });
    // After consume, both verifyToken AND verifyAndConsume reject
    expect(() => verifyToken({ token, change_id: 'cp-vw', required_scope: 'low' })).toThrow();
    expect(() => verifyAndConsume({ token, change_id: 'cp-vw', required_scope: 'low' })).toThrow();
  });

  it('verifyToken still rejects expired / wrong change_id', async () => {
    const { verifyToken } = await import('../src/core/approval-token.ts');
    const { token } = issueToken({ change_id: 'cp-vw2', issued_by: 'test', expires_in_ms: -1 });
    expect(() => verifyToken({ token, change_id: 'cp-vw2', required_scope: 'low' })).toThrow(); // expired
    const { token: t2 } = issueToken({ change_id: 'cp-other', issued_by: 'test' });
    expect(() => verifyToken({ token: t2, change_id: 'cp-vw2', required_scope: 'low' })).toThrow(); // wrong change_id
  });
});

describe('schema version_hash + last_modified', () => {
  it('schemaVersionHash is stable across reads, changes on edit', () => {
    const vault = makeVault();
    const h1 = schemaVersionHash(vault);
    const h2 = schemaVersionHash(vault);
    expect(h1).toBe(h2);
    writeFileSync(join(vault, 'SCHEMA.md'), readFileSync(join(vault, 'SCHEMA.md'), 'utf8') + '\n# extra\n');
    const h3 = schemaVersionHash(vault);
    expect(h3).not.toBe(h1);
  });

  it('returns null when SCHEMA.md is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'hearth-noschema-'));
    expect(schemaVersionHash(root)).toBeNull();
    expect(schemaLastModified(root)).toBeNull();
  });
});
