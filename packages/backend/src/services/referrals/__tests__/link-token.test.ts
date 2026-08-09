/**
 * The signed referral link token: what it authenticates, and what it must
 * never carry.
 *
 * The "no secret data" assertion is EXACT-key-set, not substring matching — a
 * new field added to the payload fails the test and forces the question of
 * whether it belongs in a value that travels the open web.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { mintReferralLinkToken, verifyReferralLinkToken } from '../link-token.js';

// Hoisted above the imports, so `config/index.ts` reads it at load.
vi.hoisted(() => {
  process.env.REFERRAL_LINK_TOKEN_SECRET = 'test-referral-link-secret';
});

describe('mintReferralLinkToken / verifyReferralLinkToken', () => {
  it('round-trips the link and code ids', () => {
    const token = mintReferralLinkToken({ linkId: 'link-1', codeId: 'code-1' });
    expect(verifyReferralLinkToken(token)).toEqual({ linkId: 'link-1', codeId: 'code-1' });
  });

  it('carries EXACTLY the link id, the code id and a nonce — nothing else', () => {
    const token = mintReferralLinkToken({ linkId: 'link-2', codeId: 'code-2' });
    const [payloadB64] = token.split('.');
    const payload: unknown = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      'codeId',
      'linkId',
      'nonce',
    ]);
  });

  it('two mints for one link differ — the nonce makes tokens non-colliding', () => {
    const a = mintReferralLinkToken({ linkId: 'link-3', codeId: 'code-3' });
    const b = mintReferralLinkToken({ linkId: 'link-3', codeId: 'code-3' });
    expect(a).not.toBe(b);
  });

  it('refuses a tampered payload', () => {
    const token = mintReferralLinkToken({ linkId: 'link-4', codeId: 'code-4' });
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ linkId: 'someone-elses-link', codeId: 'code-4', nonce: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(() => verifyReferralLinkToken(`${forged}.${sig}`)).toThrow(/signature mismatch/i);
  });

  it('refuses a tampered signature', () => {
    const token = mintReferralLinkToken({ linkId: 'link-5', codeId: 'code-5' });
    const [payloadB64, sig] = token.split('.');
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(() => verifyReferralLinkToken(`${payloadB64}.${flipped}`)).toThrow(
      /signature mismatch/i,
    );
  });

  it('refuses a malformed token outright', () => {
    expect(() => verifyReferralLinkToken('no-dot-here')).toThrow(/malformed/i);
    expect(() => verifyReferralLinkToken('a.b.c')).toThrow(/malformed/i);
  });

  it('refuses a signed payload whose SHAPE is wrong', () => {
    // Signed correctly, but the claims are not link claims — a token minted by
    // other code sharing the secret must not verify as a link token.
    const payloadB64 = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    const sig = createHmac('sha256', 'test-referral-link-secret')
      .update(payloadB64)
      .digest('base64url');
    expect(() => verifyReferralLinkToken(`${payloadB64}.${sig}`)).toThrow(/invalid/i);
  });
});
