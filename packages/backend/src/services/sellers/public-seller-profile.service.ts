/**
 * The PUBLIC P2P seller profile (#92) — one place that decides what a stranger
 * may see of a person who sells here.
 *
 * ## The projection is written out, and that is the enforcement
 *
 * {@link projectSellerProfile} names every field it emits. Nothing is spread
 * from an Oxy `User`, nothing is spread from a `seller_profiles` row, and there
 * is no property bag anywhere in the shape — the `provider_accounts` status
 * projection (#46) and `services/payments/redact.ts`'s allow-list, applied to a
 * person. A home address, a precise pickup point, a payment-onboarding verdict
 * or a follower list therefore has nowhere to appear, and
 * `seller-identity-isolation.test.ts` fails the build if a field named like one
 * ever does.
 *
 * ## Three signals, three fields, never one number
 *
 * `transactionReviews` is #76's `p2p_seller` aggregate — "how was this seller to
 * buy from" — and ONLY that scope. `trust` is Oxy Trust's own verdict, read
 * through the canonical service. `marketplace` is activity. They answer
 * different questions and are owned by different systems, so they stay in three
 * fields; merging any two would be Mercaria manufacturing the trust score #92
 * reputation rule 3 forbids, and there is deliberately no field for the result.
 *
 * ## Follow state is not here, in either direction
 *
 * Mercaria stores no follow relationship, exposes no follower count and serves
 * no follower list. Following a seller is `kind: 'oxy.user'` in Oxy's own
 * user-owned graph, which `@oxyhq/services` reads and writes directly from the
 * client — so a Mercaria endpoint carrying follow state would be a second,
 * staler copy of somebody else's authority.
 */

import type { Listing, PublicSellerProfile, ScopedRatingAggregate } from '@mercaria/shared-types';
import { oxyUserFollowUri } from '@mercaria/shared-types';
import type { User } from '@oxyhq/core';
import {
  countActiveSellerListings,
  findActiveSellerListingsKeyset,
  findSellerFirstPublishedAt,
  type ListingRecord,
} from '../../db/catalog/listingRepository.js';
import { findSellerProfilesByUserIds } from '../../db/buyers/sellerProfileRepository.js';
import { getOrBuildScopedAggregate } from '../reviews/review-aggregate.service.js';
import { hydrateListings } from '../catalog-hydration.service.js';
import { toOxyProfile } from '../oxy-user.service.js';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import { readSellerTrust } from './seller-trust.js';
import {
  deriveSellerIndexable,
  deriveSellerVisibility,
  type SellerVisibilityVerdict,
} from './seller-visibility.js';
import {
  readSellerOxyUser,
  viewerHasBlocked,
  type SellerProfileViewer,
} from './viewer-oxy-client.js';

export type { SellerProfileViewer };

/**
 * Everything a public seller surface needs before it can decide anything: the
 * Oxy account, Oxy Trust's verdict, and what follows from the two.
 *
 * Resolved ONCE per request and shared by the profile read and the listings
 * read, so the two can never disagree about whether this person is visible —
 * the failure that would otherwise let a private seller's inventory be paged
 * through by asking for the listings directly.
 */
interface SellerAccess {
  user: User;
  trust: Awaited<ReturnType<typeof readSellerTrust>>;
  verdict: SellerVisibilityVerdict;
}

/**
 * Resolve a seller, or refuse.
 *
 * A refusal is ALWAYS the same 404, whether the account was deleted, was never
 * real, is hidden from this caller by Oxy's own enforcement, or has been
 * blocked by this viewer. Telling them apart would build an oracle: a blocked
 * caller would learn they had been blocked, and a probe would learn which
 * account ids exist. The four causes are genuinely different facts and they get
 * one indistinguishable answer on purpose.
 *
 * The block check runs FIRST and short-circuits, so a blocked viewer's request
 * costs no profile read and no trust read — the cheapest refusal, and one that
 * emits no Oxy traffic naming a person the viewer has asked not to see.
 */
async function resolveSellerAccess(
  oxyUserId: string,
  viewer: SellerProfileViewer | null,
): Promise<SellerAccess> {
  if (await viewerHasBlocked(viewer, oxyUserId)) {
    throw notFound('Seller not found');
  }

  const user = await readSellerOxyUser(oxyUserId, viewer);
  if (!user) {
    throw notFound('Seller not found');
  }

  // Trust is read even when the profile turns out to be private, because the
  // verdict's ORDERING is what withholds it rather than the read being skipped
  // — keeping the two independent is what lets `deriveSellerVisibility` be a
  // pure function with every case in a unit test.
  const trust = await readSellerTrust(oxyUserId);

  return { user, trust, verdict: deriveSellerVisibility(user, trust) };
}

/**
 * Build the public profile.
 *
 * Every branch is written out rather than folded into conditional spreads,
 * because "what a private profile discloses" is the question this function
 * exists to answer and it should be readable as three separate answers:
 *
 *  - `private` — the state and nothing else. No identity, so a client cannot
 *    even render a name; a private account has asked that nobody be shown it,
 *    and "this seller keeps their profile private" is the whole page.
 *  - `restricted` — identity, and nothing about the marketplace. A buyer
 *    holding an order from this person still needs to see who they dealt with
 *    and still needs a report action; what is withheld is the SELLING surface —
 *    inventory, counts, ratings and Oxy Trust's number.
 *  - `visible` — everything.
 */
function projectSellerProfile(input: {
  access: SellerAccess;
  marketplace: {
    sellerSince: Date | null;
    activeListingCount: number;
    salesCount: number;
    isVerified: boolean;
  } | null;
  transactionReviews: ScopedRatingAggregate | null;
}): PublicSellerProfile {
  const { access } = input;
  const { visibility, withheldReason } = access.verdict;

  if (visibility === 'private') {
    return { visibility, ...(withheldReason ? { withheldReason } : {}), indexable: false };
  }

  const oxy = toOxyProfile(access.user);
  const identity = {
    oxyUserId: oxy.id,
    handle: oxy.username,
    displayName: oxy.displayName,
    ...(oxy.avatar === undefined ? {} : { avatar: oxy.avatar }),
    followTargetUri: oxyUserFollowUri(oxy.id),
  };

  if (visibility === 'restricted') {
    return {
      visibility,
      ...(withheldReason ? { withheldReason } : {}),
      identity,
      indexable: false,
    };
  }

  const marketplace = input.marketplace;
  if (!marketplace) {
    // Unreachable by construction — a `visible` verdict always loads the
    // marketplace block — and a throw rather than an empty object, because an
    // absent block means "withheld" to every reader and inventing a zeroed one
    // here would make a bug look like a seller with nothing for sale.
    throw new Error('A visible seller profile must carry its marketplace block');
  }

  return {
    visibility,
    identity,
    marketplace: {
      ...(marketplace.sellerSince ? { sellerSince: marketplace.sellerSince.toISOString() } : {}),
      activeListingCount: marketplace.activeListingCount,
      salesCount: marketplace.salesCount,
      isVerified: marketplace.isVerified,
    },
    ...(input.transactionReviews ? { transactionReviews: input.transactionReviews } : {}),
    ...(access.trust ? { trust: access.trust } : {}),
    indexable: deriveSellerIndexable(access.verdict, marketplace.activeListingCount),
  };
}

/** `GET /sellers/:oxyUserId` — the public profile. */
export async function getPublicSellerProfile(
  oxyUserId: string,
  viewer: SellerProfileViewer | null,
): Promise<PublicSellerProfile> {
  const access = await resolveSellerAccess(oxyUserId, viewer);

  if (access.verdict.visibility !== 'visible') {
    return projectSellerProfile({ access, marketplace: null, transactionReviews: null });
  }

  const [activeListingCount, sellerSince, sellerProfileRows, transactionReviews] = await Promise.all([
    countActiveSellerListings(oxyUserId),
    findSellerFirstPublishedAt(oxyUserId),
    findSellerProfilesByUserIds([oxyUserId]),
    // The #76 aggregate for THIS scope, built on the spot when the seller has
    // no row yet — the same `getOrBuildScopedAggregate` a product page uses, so
    // the stars a seller page shows and the stars a review page shows are one
    // number derived one way, and a seller with no reviews gets a zero that
    // names its own scope rather than a borrowed figure.
    getOrBuildScopedAggregate('p2p_seller', oxyUserId),
  ]);

  const [sellerProfileRow] = sellerProfileRows;

  return projectSellerProfile({
    access,
    marketplace: {
      sellerSince,
      activeListingCount,
      // A seller with no `seller_profiles` row has never sold and has never been
      // verified. Reading the absence as zero/false is correct here and is NOT
      // the "unknown is never zero" violation it resembles: the row is created
      // lazily on first use, so its absence is a complete statement about a
      // person who has done neither thing.
      salesCount: sellerProfileRow?.salesCount ?? 0,
      isVerified: sellerProfileRow?.isVerified ?? false,
    },
    transactionReviews,
  });
}

/** How a caller asks for a page of a seller's public listings. */
export interface ListPublicSellerListingsInput {
  limit: number;
  cursor?: string;
  viewer: SellerProfileViewer | null;
}

/** One keyset page of a seller's public listings. */
export interface PublicSellerListingsResult {
  listings: Listing[];
  nextCursor?: string;
}

/**
 * Encode/decode the keyset cursor.
 *
 * `<publishedAt ISO or empty>|<id>`, opaque to the client and deliberately not
 * base64 — the `GET /offers` precedent: an encoding that only LOOKS opaque
 * invites somebody to decode and hand-craft one, and the decoder validates both
 * parts anyway. The separator is `|`, which appears in neither an ISO instant
 * nor a uuid v7, so the split is unambiguous.
 */
function encodeCursor(row: ListingRecord): string {
  return `${row.publishedAt ? row.publishedAt.toISOString() : ''}|${row.id}`;
}

function decodeCursor(cursor: string): { publishedAt: Date | null; id: string } | undefined {
  const separator = cursor.indexOf('|');
  if (separator < 0) return undefined;
  const rawPublishedAt = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (id === '') return undefined;
  if (rawPublishedAt === '') return { publishedAt: null, id };
  const publishedAt = new Date(rawPublishedAt);
  if (Number.isNaN(publishedAt.getTime())) return undefined;
  return { publishedAt, id };
}

/**
 * `GET /sellers/:oxyUserId/listings` — the seller's public inventory.
 *
 * Runs the SAME access resolution as the profile read, and that is the point
 * rather than an inefficiency: a client that skipped the profile call and asked
 * for the listings directly must not page through a private seller's inventory.
 * A withheld profile answers with an empty page and no cursor — an honest
 * statement that there is no public inventory here — while a blocked, deleted
 * or unresolvable account throws the same 404 the profile read does.
 */
export async function listPublicSellerListings(
  oxyUserId: string,
  input: ListPublicSellerListingsInput,
): Promise<PublicSellerListingsResult> {
  const access = await resolveSellerAccess(oxyUserId, input.viewer);
  if (access.verdict.visibility !== 'visible') {
    return { listings: [] };
  }

  const after = input.cursor ? decodeCursor(input.cursor) : undefined;
  if (input.cursor && !after) throw validationError('Malformed cursor');

  const rows = await findActiveSellerListingsKeyset(oxyUserId, input.limit + 1, after);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];

  return {
    listings: await hydrateListings(page, {
      ...(input.viewer ? { viewerId: input.viewer.oxyUserId } : {}),
    }),
    ...(rows.length > input.limit && last ? { nextCursor: encodeCursor(last) } : {}),
  };
}
