/**
 * The visibility derivation (#92) — every outcome the issue names, as a case.
 *
 * These are the four states a public seller surface has to get right, and each
 * is a different SOURCE of truth: Oxy's privacy flags, Oxy Trust's tier,
 * Mercaria's own listing count. Keeping the derivation pure is what makes them
 * testable without a network fixture, and what stops the decision drifting into
 * three places.
 */

import { describe, expect, it } from 'vitest';
import type { User } from '@oxyhq/core';
import {
  SELLER_FORBIDDEN_FOLLOW_KINDS,
  SELLER_FOLLOW_KIND,
  SELLER_PROFILE_VISIBILITIES,
  SELLER_TRUST_RESTRICTED_TIERS,
  oxyUserFollowUri,
} from '@mercaria/shared-types';
import {
  deriveSellerIndexable,
  deriveSellerVisibility,
  oxyProfileIsPrivate,
  trustTierIsRestricted,
} from '../seller-visibility.js';

/** A minimal Oxy user. `privacySettings` is what each case varies. */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'oxy-user-1',
    publicKey: 'pk',
    username: 'ada',
    name: { displayName: 'Ada Lovelace' },
    ...overrides,
  } as User;
}

describe('Oxy profile privacy', () => {
  it('is not private when the account sends no privacy settings at all', () => {
    // The common case by a wide margin. Reading absence as a restriction would
    // hide the entire marketplace, which is why this case exists first.
    expect(oxyProfileIsPrivate(makeUser())).toBe(false);
    expect(oxyProfileIsPrivate(makeUser({ privacySettings: {} }))).toBe(false);
  });

  it('is private when the account switches the whole account private', () => {
    expect(oxyProfileIsPrivate(makeUser({ privacySettings: { isPrivateAccount: true } }))).toBe(true);
  });

  it('is private when the account switches profile visibility OFF', () => {
    // Read as "may this profile be seen", so `false` restricts. Reading it the
    // other way round would invert the setting for everyone who touched it —
    // a bug invisible until somebody complains their profile is hidden.
    expect(oxyProfileIsPrivate(makeUser({ privacySettings: { profileVisibility: false } }))).toBe(
      true,
    );
    expect(oxyProfileIsPrivate(makeUser({ privacySettings: { profileVisibility: true } }))).toBe(
      false,
    );
  });
});

describe('the Oxy Trust policy', () => {
  it('restricts exactly the tiers the named constant lists', () => {
    for (const tier of SELLER_TRUST_RESTRICTED_TIERS) {
      expect(trustTierIsRestricted({ tier, total: -50 })).toBe(true);
    }
    for (const tier of ['new', 'trusted', 'high_trust', 'verified']) {
      expect(trustTierIsRestricted({ tier, total: 10 })).toBe(false);
    }
  });

  it('restricts NOTHING when the trust signal is absent', () => {
    // Absent covers both "Oxy Trust has never scored this account" and "the
    // read failed", and the two are indistinguishable from here. Withholding on
    // absence would turn a reputation-service outage into a marketplace-wide
    // delisting, so this case is a policy decision and not an oversight.
    expect(trustTierIsRestricted(null)).toBe(false);
    expect(deriveSellerVisibility(makeUser(), null)).toEqual({ visibility: 'visible' });
  });
});

describe('the verdict', () => {
  it('is visible for an ordinary account with an ordinary tier', () => {
    expect(deriveSellerVisibility(makeUser(), { tier: 'trusted', total: 42 })).toEqual({
      visibility: 'visible',
    });
  });

  it('is private, naming its reason', () => {
    expect(
      deriveSellerVisibility(makeUser({ privacySettings: { isPrivateAccount: true } }), null),
    ).toEqual({ visibility: 'private', withheldReason: 'oxy_profile_private' });
  });

  it('is restricted, naming its reason', () => {
    expect(deriveSellerVisibility(makeUser(), { tier: 'restricted', total: -99 })).toEqual({
      visibility: 'restricted',
      withheldReason: 'trust_restricted',
    });
  });

  it('reports PRIVATE, not trust_restricted, when both apply', () => {
    // Order is load-bearing. Reporting the trust restriction for a private
    // account would leak Oxy Trust's opinion of a person who has asked that
    // nobody be shown their profile at all.
    expect(
      deriveSellerVisibility(makeUser({ privacySettings: { isPrivateAccount: true } }), {
        tier: 'restricted',
        total: -99,
      }),
    ).toEqual({ visibility: 'private', withheldReason: 'oxy_profile_private' });
  });

  it('only ever produces a value from the closed set', () => {
    const verdicts = [
      deriveSellerVisibility(makeUser(), null),
      deriveSellerVisibility(makeUser({ privacySettings: { isPrivateAccount: true } }), null),
      deriveSellerVisibility(makeUser(), { tier: 'restricted', total: 0 }),
    ];
    for (const verdict of verdicts) {
      expect(SELLER_PROFILE_VISIBILITIES).toContain(verdict.visibility);
    }
    // The vacuity floor: three distinct outcomes, so a derivation collapsed to
    // one constant cannot pass the membership check above.
    expect(new Set(verdicts.map((v) => v.visibility)).size).toBe(3);
  });
});

describe('indexability', () => {
  it('needs BOTH full visibility and at least one active listing', () => {
    expect(deriveSellerIndexable({ visibility: 'visible' }, 1)).toBe(true);
    // A thin page about a named person: visible, but nothing on it.
    expect(deriveSellerIndexable({ visibility: 'visible' }, 0)).toBe(false);
    expect(
      deriveSellerIndexable({ visibility: 'private', withheldReason: 'oxy_profile_private' }, 12),
    ).toBe(false);
    expect(
      deriveSellerIndexable({ visibility: 'restricted', withheldReason: 'trust_restricted' }, 12),
    ).toBe(false);
  });
});

describe('the follow identity', () => {
  it('is the platform kind and Oxy’s own URI, never a Mercaria one', () => {
    // The server's registry matches `^https://oxy\.so/users/([^/?#]+)$` and
    // DERIVES `localUserId` from the capture, refusing a mismatch — so this
    // shape is a server-side contract, not a display convention.
    expect(SELLER_FOLLOW_KIND).toBe('oxy.user');
    expect(oxyUserFollowUri('abc123')).toBe('https://oxy.so/users/abc123');
    expect(oxyUserFollowUri('abc123')).not.toContain('mercaria');
  });

  it('keeps the forbidden person kinds DISJOINT from the one allowed kind', () => {
    expect(SELLER_FORBIDDEN_FOLLOW_KINDS).not.toContain(SELLER_FOLLOW_KIND);
    expect(SELLER_FORBIDDEN_FOLLOW_KINDS).toContain('mercaria.seller');
    // Every forbidden kind sits in Mercaria's OWN namespace, which is the point:
    // the prohibition is not "do not follow people", it is "do not name a person
    // in a namespace a marketplace owns".
    for (const kind of SELLER_FORBIDDEN_FOLLOW_KINDS) {
      expect(kind.startsWith('mercaria.')).toBe(true);
    }
  });

  it('percent-encodes an id so a crafted one cannot escape the URI path', () => {
    expect(oxyUserFollowUri('a/b?c#d')).toBe('https://oxy.so/users/a%2Fb%3Fc%23d');
  });
});
