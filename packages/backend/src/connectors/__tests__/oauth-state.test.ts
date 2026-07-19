/**
 * Unit tests for the signed OAuth `state` token (CSRF protection for the connect
 * flow). No DB / no network. Asserts the round-trip carries the claims, a
 * tampered payload or signature is rejected (constant-time), a malformed token is
 * rejected, and an expired token is rejected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createOAuthState, verifyOAuthState } from '../oauth-state.js';

const ENV_VAR = 'CONNECTOR_OAUTH_STATE_SECRET';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_VAR];
  process.env[ENV_VAR] = 'a'.repeat(64);
});

afterEach(() => {
  vi.useRealTimers();
  if (saved === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = saved;
  }
});

const params = {
  storeId: 'store-1',
  provider: 'shopify' as const,
  userId: 'user-1',
  shopDomain: 'acme.myshopify.com',
};

describe('OAuth state round-trip', () => {
  it('verifies a freshly minted token and returns its claims', () => {
    const claims = verifyOAuthState(createOAuthState(params));
    expect(claims).toEqual(params);
  });

  it('rejects a tampered signature', () => {
    const token = createOAuthState(params);
    const [payload, sig] = token.split('.');
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(() => verifyOAuthState(`${payload}.${flipped}`)).toThrow(/signature/);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = createOAuthState(params);
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...params, nonce: 'x', exp: Date.now() + 10000, storeId: 'attacker-store' }),
      'utf8',
    ).toString('base64url');
    expect(() => verifyOAuthState(`${forged}.${sig}`)).toThrow(/signature/);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyOAuthState('not-a-token')).toThrow(/Malformed/);
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    const token = createOAuthState(params);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(() => verifyOAuthState(token)).toThrow(/expired/);
  });
});
