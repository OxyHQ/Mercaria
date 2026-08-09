/**
 * The guest token's shape and hashing — the pure half of
 * `guest-session.service.ts` (ADR 0003 D3). Everything touching Postgres is
 * in `guest-session.realdb.test.ts`; nothing here opens a connection.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GUEST_TOKEN_PREFIX,
  hashGuestToken,
  isWellFormedGuestToken,
  mintGuestToken,
} from '../guest-session.service.js';

describe('mintGuestToken', () => {
  it('mints mgs_-prefixed, 47-character base64url tokens whose hash is their SHA-256', () => {
    const { token, tokenHash } = mintGuestToken();

    expect(token.startsWith(GUEST_TOKEN_PREFIX)).toBe(true);
    expect(token).toHaveLength(47); // 'mgs_' + 43 chars of base64url(32 bytes)
    expect(token).toMatch(/^mgs_[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats across a batch — the CSPRNG is actually in the path', () => {
    // Not an entropy proof (no test can be); what this pins is that the token
    // body comes from the random source rather than a timestamp or counter,
    // where a batch of 1000 would collide or sort.
    const tokens = Array.from({ length: 1_000 }, () => mintGuestToken().token);
    expect(new Set(tokens).size).toBe(1_000);
  });

  it('mints tokens its own well-formedness check accepts', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isWellFormedGuestToken(mintGuestToken().token)).toBe(true);
    }
  });
});

describe('isWellFormedGuestToken — the before-any-work gate', () => {
  it('rejects every malformed shape without touching a hash or the database', () => {
    const body43 = 'A'.repeat(43);
    expect(isWellFormedGuestToken('')).toBe(false);
    expect(isWellFormedGuestToken('mgs_')).toBe(false);
    expect(isWellFormedGuestToken(body43)).toBe(false); // missing prefix
    expect(isWellFormedGuestToken(`mgs_${'A'.repeat(42)}`)).toBe(false); // short
    expect(isWellFormedGuestToken(`mgs_${'A'.repeat(44)}`)).toBe(false); // long
    expect(isWellFormedGuestToken(`mgs_${'A'.repeat(20)}!${'A'.repeat(22)}`)).toBe(false); // charset
    expect(isWellFormedGuestToken(`mgs_${'A'.repeat(20)}=${'A'.repeat(22)}`)).toBe(false); // padding
    // Oversized adversarial input: refused on length alone.
    expect(isWellFormedGuestToken(`mgs_${'A'.repeat(1_000_000)}`)).toBe(false);
  });

  it('rejects the OTHER token families — scope is structural (D3)', () => {
    // A portal (`mgp_`) or exchange (`mgx_`) token presented to the commerce
    // resolver must die at the shape check: the families share an alphabet
    // and a length, so the prefix is the entire discriminator.
    const body = 'A'.repeat(43);
    expect(isWellFormedGuestToken(`mgp_${body}`)).toBe(false);
    expect(isWellFormedGuestToken(`mgx_${body}`)).toBe(false);
  });
});

describe('hashGuestToken', () => {
  it('is deterministic and never the identity', () => {
    const { token } = mintGuestToken();
    expect(hashGuestToken(token)).toBe(hashGuestToken(token));
    expect(hashGuestToken(token)).not.toContain(token);
  });
});
