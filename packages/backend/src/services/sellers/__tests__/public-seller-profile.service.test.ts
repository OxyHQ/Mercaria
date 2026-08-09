/**
 * The public seller PROJECTION (#92) — what each outcome actually emits.
 *
 * `seller-visibility.test.ts` pins the derivation; this file pins the
 * consequence, which is a different thing and the one that can leak: a verdict
 * can be correct while the projection beside it still ships an identity, a
 * listing count or a trust tier the verdict said to withhold.
 *
 * Every Oxy read is mocked at the module seam, so blocked / deleted /
 * privacy-restricted / trust-restricted are ordinary cases rather than network
 * fixtures.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@oxyhq/core';
import { SELLER_PROFILE_FORBIDDEN_FIELDS } from '@mercaria/shared-types';

const readSellerOxyUser = vi.fn();
const viewerHasBlocked = vi.fn();
const readSellerTrust = vi.fn();
const countActiveSellerListings = vi.fn();
const findSellerFirstPublishedAt = vi.fn();
const findActiveSellerListingsKeyset = vi.fn();
const findSellerProfilesByUserIds = vi.fn();
const getOrBuildScopedAggregate = vi.fn();
const hydrateListings = vi.fn();

vi.mock('../viewer-oxy-client.js', () => ({
  readSellerOxyUser: (...args: unknown[]) => readSellerOxyUser(...args),
  viewerHasBlocked: (...args: unknown[]) => viewerHasBlocked(...args),
}));

vi.mock('../seller-trust.js', () => ({
  readSellerTrust: (...args: unknown[]) => readSellerTrust(...args),
}));

vi.mock('../../../db/catalog/listingRepository.js', () => ({
  countActiveSellerListings: (...args: unknown[]) => countActiveSellerListings(...args),
  findSellerFirstPublishedAt: (...args: unknown[]) => findSellerFirstPublishedAt(...args),
  findActiveSellerListingsKeyset: (...args: unknown[]) => findActiveSellerListingsKeyset(...args),
}));

vi.mock('../../../db/buyers/sellerProfileRepository.js', () => ({
  findSellerProfilesByUserIds: (...args: unknown[]) => findSellerProfilesByUserIds(...args),
}));

vi.mock('../../reviews/review-aggregate.service.js', () => ({
  getOrBuildScopedAggregate: (...args: unknown[]) => getOrBuildScopedAggregate(...args),
}));

vi.mock('../../catalog-hydration.service.js', () => ({
  hydrateListings: (...args: unknown[]) => hydrateListings(...args),
}));

const { getPublicSellerProfile, listPublicSellerListings } = await import(
  '../public-seller-profile.service.js'
);

const SELLER_ID = 'oxy-user-seller';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: SELLER_ID,
    publicKey: 'pk',
    username: 'ada',
    avatar: 'file-1',
    name: { displayName: 'Ada Lovelace' },
    ...overrides,
  } as User;
}

/** The #76 `p2p_seller` aggregate a visible profile carries. */
const AGGREGATE = {
  scope: 'p2p_seller' as const,
  targetType: 'seller' as const,
  targetId: SELLER_ID,
  rating: 4.6,
  reviewCount: 12,
  unverified: { rating: 3.1, count: 2 },
  dimensions: [],
};

beforeEach(() => {
  viewerHasBlocked.mockReset().mockResolvedValue(false);
  readSellerOxyUser.mockReset().mockResolvedValue(makeUser());
  readSellerTrust.mockReset().mockResolvedValue({ tier: 'trusted', total: 120 });
  countActiveSellerListings.mockReset().mockResolvedValue(3);
  findSellerFirstPublishedAt.mockReset().mockResolvedValue(new Date('2024-03-01T00:00:00.000Z'));
  findActiveSellerListingsKeyset.mockReset().mockResolvedValue([]);
  findSellerProfilesByUserIds
    .mockReset()
    .mockResolvedValue([{ oxyUserId: SELLER_ID, salesCount: 41, isVerified: true }]);
  getOrBuildScopedAggregate.mockReset().mockResolvedValue(AGGREGATE);
  hydrateListings.mockReset().mockResolvedValue([]);
});

describe('a visible seller', () => {
  it('carries identity, marketplace facts, the p2p_seller aggregate and Oxy Trust', async () => {
    const profile = await getPublicSellerProfile(SELLER_ID, null);

    expect(profile.visibility).toBe('visible');
    expect(profile.withheldReason).toBeUndefined();
    expect(profile.identity).toEqual({
      oxyUserId: SELLER_ID,
      handle: 'ada',
      displayName: 'Ada Lovelace',
      avatar: 'file-1',
      followTargetUri: `https://oxy.so/users/${SELLER_ID}`,
    });
    expect(profile.marketplace).toEqual({
      sellerSince: '2024-03-01T00:00:00.000Z',
      activeListingCount: 3,
      salesCount: 41,
      isVerified: true,
    });
    expect(profile.trust).toEqual({ tier: 'trusted', total: 120 });
    expect(profile.indexable).toBe(true);

    // The ONE scope. A product rating and an item-condition rating answer
    // different questions about different targets, and neither may appear here
    // under this person's name.
    expect(getOrBuildScopedAggregate).toHaveBeenCalledWith('p2p_seller', SELLER_ID);
    expect(profile.transactionReviews?.scope).toBe('p2p_seller');
  });

  it('falls back to the HANDLE when the Oxy display name is absent', async () => {
    // `name.displayName` is optional on the Oxy contract. The sanctioned
    // coalesce is `displayName?.trim() || handle` — never a name recomposed
    // from `name.first`/`last`/`full`, and never an empty string.
    readSellerOxyUser.mockResolvedValue(makeUser({ name: {} }));
    const profile = await getPublicSellerProfile(SELLER_ID, null);
    expect(profile.identity?.displayName).toBe('ada');

    readSellerOxyUser.mockResolvedValue(makeUser({ name: { displayName: '   ' } }));
    expect((await getPublicSellerProfile(SELLER_ID, null)).identity?.displayName).toBe('ada');
  });

  it('is NOT indexable with nothing for sale', async () => {
    countActiveSellerListings.mockResolvedValue(0);
    expect((await getPublicSellerProfile(SELLER_ID, null)).indexable).toBe(false);
  });

  it('omits `sellerSince` for a seller who has never published', async () => {
    findSellerFirstPublishedAt.mockResolvedValue(null);
    const profile = await getPublicSellerProfile(SELLER_ID, null);
    expect(profile.marketplace?.sellerSince).toBeUndefined();
    // The rest of the block still arrives — an absent date is not a withheld
    // marketplace.
    expect(profile.marketplace?.activeListingCount).toBe(3);
  });

  it('reads a seller with no profile row as never-sold and never-verified', async () => {
    findSellerProfilesByUserIds.mockResolvedValue([]);
    const profile = await getPublicSellerProfile(SELLER_ID, null);
    expect(profile.marketplace?.salesCount).toBe(0);
    expect(profile.marketplace?.isVerified).toBe(false);
  });

  it('omits `trust` entirely when Oxy Trust does not answer', async () => {
    // Absent, not zero and not a tier — the caller must be able to tell "no
    // signal" from "a low one".
    readSellerTrust.mockResolvedValue(null);
    const profile = await getPublicSellerProfile(SELLER_ID, null);
    expect(profile.trust).toBeUndefined();
    expect(profile.visibility).toBe('visible');
  });

  it('emits no field named like anything the projection forbids', async () => {
    const profile = await getPublicSellerProfile(SELLER_ID, null);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        keys.add(key);
        walk(child);
      }
    };
    walk(profile);

    for (const forbidden of SELLER_PROFILE_FORBIDDEN_FIELDS) {
      expect(keys.has(forbidden), `public seller profile emitted "${forbidden}"`).toBe(false);
    }
    // Vacuity floor: a walk that found nothing would satisfy every assertion
    // above. A visible profile has well over a dozen keys.
    expect(keys.size).toBeGreaterThan(12);
  });
});

describe('a privacy-restricted seller', () => {
  beforeEach(() => {
    readSellerOxyUser.mockResolvedValue(makeUser({ privacySettings: { isPrivateAccount: true } }));
  });

  it('discloses NOTHING but the state and its reason', async () => {
    const profile = await getPublicSellerProfile(SELLER_ID, null);
    expect(profile).toEqual({
      visibility: 'private',
      withheldReason: 'oxy_profile_private',
      indexable: false,
    });
    // Not even the name, the handle or the avatar — a private account has asked
    // that nobody be shown it.
    expect(profile.identity).toBeUndefined();
    expect(profile.marketplace).toBeUndefined();
    expect(profile.transactionReviews).toBeUndefined();
    expect(profile.trust).toBeUndefined();
  });

  it('does not even COUNT their listings', async () => {
    await getPublicSellerProfile(SELLER_ID, null);
    expect(countActiveSellerListings).not.toHaveBeenCalled();
    expect(getOrBuildScopedAggregate).not.toHaveBeenCalled();
  });

  it('serves an EMPTY listings page rather than their inventory', async () => {
    // The path a client takes when it skips the profile call and asks for the
    // listings directly. Without the shared gate this is how a private seller's
    // inventory gets paged through.
    const page = await listPublicSellerListings(SELLER_ID, { limit: 10, viewer: null });
    expect(page).toEqual({ listings: [] });
    expect(findActiveSellerListingsKeyset).not.toHaveBeenCalled();
  });
});

describe('a trust-restricted seller', () => {
  beforeEach(() => {
    readSellerTrust.mockResolvedValue({ tier: 'restricted', total: -140 });
  });

  it('keeps the identity and withholds the whole selling surface', async () => {
    const profile = await getPublicSellerProfile(SELLER_ID, null);
    expect(profile.visibility).toBe('restricted');
    expect(profile.withheldReason).toBe('trust_restricted');
    // Identity stays: a buyer holding an order needs to see who they dealt with
    // and needs the report action beside it.
    expect(profile.identity?.displayName).toBe('Ada Lovelace');
    expect(profile.marketplace).toBeUndefined();
    expect(profile.transactionReviews).toBeUndefined();
    // Oxy Trust's own figure is withheld too. Rendering the number that caused
    // the restriction would publish a reputation verdict about a person on a
    // page that has just refused to show anything else about them.
    expect(profile.trust).toBeUndefined();
    expect(profile.indexable).toBe(false);
  });

  it('serves an empty listings page', async () => {
    expect(await listPublicSellerListings(SELLER_ID, { limit: 10, viewer: null })).toEqual({
      listings: [],
    });
  });
});

describe('a deleted or unresolvable seller', () => {
  it('is a 404 from both surfaces', async () => {
    readSellerOxyUser.mockResolvedValue(null);
    await expect(getPublicSellerProfile(SELLER_ID, null)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(
      listPublicSellerListings(SELLER_ID, { limit: 10, viewer: null }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('a seller the viewer has blocked', () => {
  const viewer = { oxyUserId: 'oxy-user-viewer', accessToken: 'token' };

  beforeEach(() => {
    viewerHasBlocked.mockResolvedValue(true);
  });

  it('is answered with the SAME 404 as an id that never existed', async () => {
    // Indistinguishable on purpose: a different response would tell a blocked
    // caller they had been blocked, and would let a probe learn which ids exist.
    const blocked = await getPublicSellerProfile(SELLER_ID, viewer).catch((e: unknown) => e);
    readSellerOxyUser.mockResolvedValue(null);
    viewerHasBlocked.mockResolvedValue(false);
    const missing = await getPublicSellerProfile('never-existed', viewer).catch((e: unknown) => e);

    expect(blocked).toMatchObject({ httpStatus: 404 });
    expect(missing).toMatchObject({ httpStatus: 404 });
    expect((blocked as Error).message).toBe((missing as Error).message);
  });

  it('short-circuits before ANY Oxy read naming the seller', async () => {
    await getPublicSellerProfile(SELLER_ID, viewer).catch(() => undefined);
    expect(readSellerOxyUser).not.toHaveBeenCalled();
    expect(readSellerTrust).not.toHaveBeenCalled();
  });
});

describe('the listings keyset', () => {
  it('emits a cursor only when a further page exists, and never serves the probe row', async () => {
    const rows = [
      { id: 'l1', publishedAt: new Date('2025-01-03T00:00:00.000Z') },
      { id: 'l2', publishedAt: new Date('2025-01-02T00:00:00.000Z') },
      { id: 'l3', publishedAt: new Date('2025-01-01T00:00:00.000Z') },
    ];
    findActiveSellerListingsKeyset.mockResolvedValue(rows);
    hydrateListings.mockImplementation((page: { id: string }[]) => Promise.resolve(page));

    const page = await listPublicSellerListings(SELLER_ID, { limit: 2, viewer: null });

    // `limit + 1` is fetched; the extra row is DROPPED and its existence is the
    // cursor — no second count query.
    expect(findActiveSellerListingsKeyset).toHaveBeenCalledWith(SELLER_ID, 3, undefined);
    expect(page.listings).toHaveLength(2);
    expect(page.nextCursor).toBe('2025-01-02T00:00:00.000Z|l2');

    findActiveSellerListingsKeyset.mockResolvedValue(rows.slice(0, 2));
    expect((await listPublicSellerListings(SELLER_ID, { limit: 2, viewer: null })).nextCursor)
      .toBeUndefined();
  });

  it('round-trips a cursor, including one on a NULL-published row', async () => {
    findActiveSellerListingsKeyset.mockResolvedValue([]);

    await listPublicSellerListings(SELLER_ID, {
      limit: 5,
      cursor: '2025-01-02T00:00:00.000Z|l2',
      viewer: null,
    });
    expect(findActiveSellerListingsKeyset).toHaveBeenLastCalledWith(SELLER_ID, 6, {
      publishedAt: new Date('2025-01-02T00:00:00.000Z'),
      id: 'l2',
    });

    await listPublicSellerListings(SELLER_ID, { limit: 5, cursor: '|l9', viewer: null });
    expect(findActiveSellerListingsKeyset).toHaveBeenLastCalledWith(SELLER_ID, 6, {
      publishedAt: null,
      id: 'l9',
    });
  });

  it('refuses a malformed cursor with a 400 instead of silently paging from the start', async () => {
    for (const cursor of ['garbage', 'not-a-date|l1', '2025-01-02T00:00:00.000Z|']) {
      await expect(
        listPublicSellerListings(SELLER_ID, { limit: 5, cursor, viewer: null }),
      ).rejects.toMatchObject({ httpStatus: 400 });
    }
  });
});
