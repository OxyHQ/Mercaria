/**
 * The referral state carrier (#143 web rules 2, 4, 7 and 10).
 *
 * Three properties are load-bearing and each has a test that would go red if it
 * were lost:
 *
 *  1. It authorizes NOTHING — the payload's key set is exact, so a field that
 *     could name a user, a session or an order fails the build.
 *  2. A client cannot forge the winning partner (web rule 10): the signature is
 *     checked, and the partner is not in the token to begin with.
 *  3. Presenting it does not move the attribution window (web rule 7).
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  mintReferralState,
  referralStateCookieProfile,
  readReferralStateCookie,
  verifyReferralState,
  REFERRAL_STATE_MAX_LIFETIME_SECONDS,
  REFERRAL_STATE_PREFIX,
} from '../referral-state.js';

// Hoisted above the imports, so `config/index.ts` reads it at load.
vi.hoisted(() => {
  process.env.REFERRAL_STATE_SECRET = 'test-referral-state-secret';
});

const CLICKED_AT = new Date('2026-05-01T10:00:00.000Z');
const WINDOW_SECONDS = 30 * 24 * 60 * 60;

function mint(clickedAt = CLICKED_AT, lifetimeSeconds = WINDOW_SECONDS) {
  return mintReferralState({
    linkId: 'link-1',
    codeId: 'code-1',
    clickedAt,
    lifetimeSeconds,
  });
}

describe('mintReferralState / verifyReferralState', () => {
  it('round-trips the click evidence', () => {
    const { token } = mint();
    const claims = verifyReferralState(token, new Date('2026-05-02T10:00:00.000Z'));
    expect(claims).not.toBeNull();
    expect(claims?.linkId).toBe('link-1');
    expect(claims?.codeId).toBe('code-1');
    expect(claims?.clickedAt.toISOString()).toBe(CLICKED_AT.toISOString());
  });

  it('is prefixed `mrf_` — not a guest, portal or exchange credential', () => {
    // ADR 0003 I5 scopes credentials by table, resolver AND prefix. This one
    // shares none of the three with `mgs_`, `mgp_` or `mgx_`, so a cart token
    // presented here fails its shape gate before any signature work.
    const { token } = mint();
    expect(token.startsWith(REFERRAL_STATE_PREFIX)).toBe(true);
    for (const foreign of ['mgs_', 'mgp_', 'mgx_']) {
      expect(token.startsWith(foreign)).toBe(false);
    }
    expect(verifyReferralState('mgs_someguestcarttoken', CLICKED_AT)).toBeNull();
  });

  it('carries EXACTLY the two ids, the click, the deadline and a nonce', () => {
    // Exact key set, not substring matching: a field added to the payload
    // fails here and forces the question of whether it belongs in a value a
    // browser holds. There is nothing here an authorization check could read —
    // no user id, no session id, no order id, no scope list, no partner.
    const { token } = mint();
    const [payloadB64] = token.slice(REFERRAL_STATE_PREFIX.length).split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['c', 'l', 'n', 't', 'x']);
  });

  it('refuses a tampered payload — a client cannot forge the winner', () => {
    // #143 web rule 10. Two layers: the partner is not in the token at all
    // (it is read from the row the ids name), and editing the ids invalidates
    // the signature.
    const { token } = mint();
    const [payloadB64, sig] = token.slice(REFERRAL_STATE_PREFIX.length).split('.');
    const payload = JSON.parse(Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8'));
    payload.l = 'link-belonging-to-another-partner';
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    expect(
      verifyReferralState(`${REFERRAL_STATE_PREFIX}${forged}.${sig ?? ''}`, CLICKED_AT),
    ).toBeNull();
  });

  it('refuses a token signed with a different key', () => {
    const payload = Buffer.from(
      JSON.stringify({ l: 'x', c: 'y', t: 1, x: 4_102_444_800, n: 'n' }),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', 'not-the-secret').update(payload).digest('base64url');
    expect(verifyReferralState(`${REFERRAL_STATE_PREFIX}${payload}.${sig}`, CLICKED_AT)).toBeNull();
  });

  it('refuses every malformed shape uniformly, as null', () => {
    for (const bad of [
      undefined,
      '',
      'mrf_',
      'mrf_no-dot',
      'mrf_a.b.c',
      `${REFERRAL_STATE_PREFIX}${'a'.repeat(2_000)}.sig`,
      'not-even-prefixed',
    ]) {
      expect(verifyReferralState(bad, CLICKED_AT), String(bad)).toBeNull();
    }
  });

  it('expires, and the deadline is the CLICK plus the window', () => {
    const { token, expiresAt } = mint();
    expect(expiresAt.getTime()).toBe(CLICKED_AT.getTime() + WINDOW_SECONDS * 1_000);
    expect(verifyReferralState(token, new Date(expiresAt.getTime() - 1_000))).not.toBeNull();
    expect(verifyReferralState(token, expiresAt)).toBeNull();
    expect(verifyReferralState(token, new Date(expiresAt.getTime() + 1_000))).toBeNull();
  });

  it('does NOT extend its window when it is presented again', () => {
    // #143 web rule 7, and the only place it could actually go wrong. The
    // anchor is inside the signature, so verifying a carrier a hundred times
    // yields the same click instant and the same deadline every time.
    const { token, expiresAt } = mint();
    const reads = [
      verifyReferralState(token, new Date(CLICKED_AT.getTime() + 1_000)),
      verifyReferralState(token, new Date(CLICKED_AT.getTime() + 10 * 24 * 3_600_000)),
      verifyReferralState(token, new Date(CLICKED_AT.getTime() + 29 * 24 * 3_600_000)),
    ];
    for (const claims of reads) {
      expect(claims?.clickedAt.toISOString()).toBe(CLICKED_AT.toISOString());
      expect(claims?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
    }
  });

  it('caps a program that asks for an absurd window', () => {
    const { expiresAt } = mint(CLICKED_AT, 10 * 365 * 24 * 60 * 60);
    expect(expiresAt.getTime()).toBe(
      CLICKED_AT.getTime() + REFERRAL_STATE_MAX_LIFETIME_SECONDS * 1_000,
    );
  });

  it('mints a distinct spelling every time for one link', () => {
    // So a carrier is never a stable per-link identifier a third party could
    // correlate two visitors by.
    expect(mint().token).not.toBe(mint().token);
  });
});

describe('referralStateCookieProfile', () => {
  it('is HttpOnly, SameSite=Lax and Path=/ in every environment', () => {
    const profile = referralStateCookieProfile(1_000);
    expect(profile.options.httpOnly).toBe(true);
    expect(profile.options.sameSite).toBe('lax');
    expect(profile.options.path).toBe('/');
  });

  it('uses a DIFFERENT NAME when it drops Secure', () => {
    // The #103 D9 rule: a dev downgrade is explicit, never a silently weaker
    // production cookie. `__Host-` additionally forbids a Domain, so a sibling
    // subdomain can never plant or shadow it.
    const profile = referralStateCookieProfile(1_000);
    expect(profile.options.secure ? profile.name : `${profile.name}!secure`).toBe(
      profile.options.secure ? '__Host-mercaria_referral' : 'mercaria_referral_dev!secure',
    );
    expect(profile.name.startsWith('__Host-')).toBe(profile.options.secure);
  });
});

describe('readReferralStateCookie', () => {
  it('finds the named cookie among others', () => {
    expect(readReferralStateCookie('a=1; mercaria_referral_dev=mrf_x; b=2', 'mercaria_referral_dev')).toBe(
      'mrf_x',
    );
  });

  it('answers undefined for absent, empty and oversized headers', () => {
    expect(readReferralStateCookie(undefined, 'n')).toBeUndefined();
    expect(readReferralStateCookie('', 'n')).toBeUndefined();
    expect(readReferralStateCookie('n=', 'n')).toBeUndefined();
    // Bounded before parsing: a cookie header is attacker-controlled bytes.
    expect(readReferralStateCookie(`n=v; ${'x'.repeat(9_000)}`, 'n')).toBeUndefined();
  });

  it('does not confuse a cookie whose name is a suffix of another', () => {
    expect(readReferralStateCookie('other_mercaria_referral_dev=nope', 'mercaria_referral_dev')).toBeUndefined();
  });
});
