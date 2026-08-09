/**
 * The PUBLIC profile of an individual (P2P) seller — #92.
 *
 * A P2P seller is an **Oxy account**, not a Mercaria-local entity. That single
 * fact decides almost everything in this module:
 *
 *  - the profile is keyed by `oxyUserId` and nothing else;
 *  - display identity is READ from Oxy at request time and never copied into a
 *    Mercaria row (`seller_profiles` deliberately has no name, handle or avatar
 *    column, and #92 privacy rule 1 is why);
 *  - following one is `kind: 'oxy.user'` against the canonical Oxy user URI.
 *    Mercaria stores no follow state at all and registers no person kind — see
 *    {@link SELLER_FORBIDDEN_FOLLOW_KINDS}.
 *
 * ## The projection names every field, and the absent ones are the enforcement
 *
 * {@link PublicSellerProfile} is written out field by field — the
 * `provider_accounts` status-projection precedent (#46). There is no spread of
 * an Oxy user document, no spread of a `seller_profiles` row, and no open
 * property bag anywhere in the shape, so a home address, a precise pickup
 * point, a payment-onboarding verdict or a follower identity has nowhere to
 * appear even if a serializer somewhere grew careless.
 * {@link SELLER_PROFILE_FORBIDDEN_FIELDS} names the prohibition as a VALUE so a
 * scanned gate can fail the build on it rather than a reviewer having to notice.
 *
 * ## Three signals, three labels, never one number
 *
 * A seller page carries a REPUTATION aggregate (#76 `p2p_seller`), an Oxy Trust
 * summary, and a marketplace activity count. They answer different questions,
 * they are owned by different systems, and {@link PublicSellerProfile} keeps
 * them in three separate fields naming their own source — because a page that
 * merged them would be manufacturing the Mercaria trust score #92 reputation
 * rule 3 forbids.
 */

import type { ScopedRatingAggregate } from './review';

/**
 * What a viewer may see of a seller, as a closed set.
 *
 * DERIVED per request, never stored — the same shape as #57's
 * `deriveNativeCheckoutEligibility` and for the same reason: the inputs live in
 * systems this domain does not own (Oxy's profile privacy, Oxy Trust's tier,
 * Mercaria's catalogue), so a stored verdict would be a second authority that
 * can disagree with all three.
 *
 *  - `visible` — the ordinary case: identity, listings, aggregates.
 *  - `private` — the Oxy account restricts its profile. Identity is WITHHELD
 *    entirely and so is every Mercaria fact about them; the follow control
 *    stays available because following a private account is a REQUEST the Oxy
 *    graph decides, not a disclosure Mercaria makes.
 *  - `restricted` — an explicit Mercaria policy applies (see
 *    {@link SELLER_TRUST_RESTRICTED_TIERS}). Identity is shown, so a buyer
 *    holding an order can still see who they dealt with and report them, and
 *    the marketplace surface — listings, counts, aggregates — is withheld.
 *
 * A DELETED, unresolvable or mutually-blocked account is not a member of this
 * set: it is a 404, identical to an id that never existed. A distinguishable
 * response would tell a blocked caller they had been blocked.
 */
export const SELLER_PROFILE_VISIBILITIES = ['visible', 'private', 'restricted'] as const;

/** See {@link SELLER_PROFILE_VISIBILITIES}. */
export type SellerProfileVisibility = (typeof SELLER_PROFILE_VISIBILITIES)[number];

/**
 * Why a profile is not fully visible, as a stated reason rather than an
 * inference the client draws from which fields happen to be missing.
 *
 * #92 reputation rule 6: a suspension or trust restriction changes visibility
 * through an EXPLICIT policy, not a client guess. This is the value that
 * carries the policy's decision to the client.
 */
export const SELLER_PROFILE_WITHHELD_REASONS = ['oxy_profile_private', 'trust_restricted'] as const;

/** See {@link SELLER_PROFILE_WITHHELD_REASONS}. */
export type SellerProfileWithheldReason = (typeof SELLER_PROFILE_WITHHELD_REASONS)[number];

/**
 * The Oxy Trust tiers Mercaria treats as a visibility restriction.
 *
 * ONE constant, named, so the policy is a value somebody can read and change
 * deliberately — which is exactly what "an explicit policy, not a client guess"
 * means. `restricted` is Oxy Trust's own high-abuse-signal tier
 * (`TRUST_TIERS[0]`), and it is the only member: `new` is where every account
 * starts and hiding it would delist every first-time seller on the marketplace.
 *
 * Mercaria never COMPUTES a tier and never suspends an Oxy account — it reads
 * the canonical service's verdict and decides what its own marketplace surface
 * does about it. An UNAVAILABLE trust read withholds nothing (see
 * `services/sellers/seller-visibility.ts`): an outage must not delist every P2P
 * seller at once, and Mercaria's own moderation lever (`listings.status =
 * 'restricted'`) stops sales independently of Oxy Trust.
 */
export const SELLER_TRUST_RESTRICTED_TIERS = ['restricted'] as const;

/** See {@link SELLER_TRUST_RESTRICTED_TIERS}. */
export type SellerTrustRestrictedTier = (typeof SELLER_TRUST_RESTRICTED_TIERS)[number];

/**
 * Follow kinds that MAY NOT exist for a person, named so the prohibition is a
 * value rather than an omission somebody can quietly fill in.
 *
 * #92 identity rule 3 and #26's whole argument: a `follow_targets` row carries
 * ONE kind and `ensureFollowTarget` is idempotent on the URI, so whoever
 * registers a URI first fixes its kind permanently. Registering a person under
 * a `mercaria.*` kind at a `mercaria.co` URI would split that human being's
 * followers from the identity every other Oxy application already follows, with
 * no repair short of a data migration.
 *
 * DISJOINT from the one kind a person may carry ({@link SELLER_FOLLOW_KIND}),
 * asserted by a test, and scanned across both the backend and the storefront by
 * `seller-identity-isolation.test.ts`.
 */
export const SELLER_FORBIDDEN_FOLLOW_KINDS = [
  'mercaria.seller',
  'mercaria.user',
  'mercaria.person',
  'mercaria.buyer',
  'mercaria.account',
] as const;

/** See {@link SELLER_FORBIDDEN_FOLLOW_KINDS}. */
export type SellerForbiddenFollowKind = (typeof SELLER_FORBIDDEN_FOLLOW_KINDS)[number];

/**
 * The ONE kind a person is followed under, anywhere in the ecosystem.
 *
 * A PLATFORM kind, owned by no application and seeded by Oxy's own migration —
 * Mercaria must not `claimFollowNamespace('oxy')` or `registerFollowKind` it,
 * and the registry would refuse anyway (`namespace_not_owned`). A native
 * `Store` keeps `mercaria.store`, which Mercaria does own, because a store is a
 * Mercaria-local organisation with no Oxy account behind it.
 */
export const SELLER_FOLLOW_KIND = 'oxy.user';

/**
 * The origin of the canonical Oxy user URI.
 *
 * Deliberately a constant and deliberately NOT environment-derived: a target's
 * URI is its identity, so a follow taken from a laptop, from staging and from
 * production has to land on ONE row. Oxy's own registry matches
 * `^https://oxy\.so/users/([^/?#]+)$` and DERIVES `localUserId` from the
 * captured id, refusing a `localUserId` that disagrees — so this string is a
 * server-side contract, not a display convention.
 */
export const OXY_USER_URI_ORIGIN = 'https://oxy.so';

/**
 * The canonical Oxy user URI for an account — the follow target's identity.
 *
 * Never a `mercaria.co` URL (#26). The id is the account's immutable Oxy id and
 * never its handle: a handle can be changed, and a renamed seller would mint a
 * SECOND target nobody follows.
 */
export function oxyUserFollowUri(oxyUserId: string): string {
  return `${OXY_USER_URI_ORIGIN}/users/${encodeURIComponent(oxyUserId)}`;
}

/**
 * Field names that may NEVER appear on a public seller projection.
 *
 * The `retail_pricing` markup device and `services/payments/redact.ts`'s
 * allow-list reasoning, applied to a person: the point is not that these are
 * currently absent, it is that a gate FAILS THE BUILD when one appears. Three
 * families, and each is on the list for its own reason:
 *
 *  - **contact and location** — #92 privacy rules 3 and 10. A P2P seller's home
 *    is where the goods are; a coarse hint belongs on a LISTING that opted into
 *    local discovery, never on the person.
 *  - **payment onboarding** — #92 public-route rule 10. Whether a seller has
 *    finished Stripe onboarding is commercially and personally revealing, and
 *    it is already derivable where it legitimately matters (checkout).
 *  - **follower identities and viewer graph** — #26 follow rule 8 and #92
 *    privacy rule 4. `mercaria.store` chose `reverse: 'aggregate'` for shops;
 *    for a PERSON the reverse side is Oxy's own decision and Mercaria publishes
 *    no list either way.
 */
export const SELLER_PROFILE_FORBIDDEN_FIELDS = [
  // Contact and location.
  'email',
  'emailHash',
  'phone',
  'address',
  'line1',
  'line2',
  'postalCode',
  'birthday',
  'latitude',
  'longitude',
  'geo',
  'preciseLocation',
  'pickupAddress',
  'pickupLocation',
  // Payment onboarding and money.
  'providerAccountId',
  'stripeAccountId',
  'onboardingState',
  'chargesEnabled',
  'payoutsEnabled',
  'payoutHealth',
  'requirementsDue',
  'balance',
  'taxId',
  // Identity graph and device.
  'followers',
  'followerIds',
  'followerIdentities',
  'blockedBy',
  'blockedUserIds',
  'ipAddress',
  'deviceId',
  'cardFingerprint',
  'guestSessionId',
] as const;

/** See {@link SELLER_PROFILE_FORBIDDEN_FIELDS}. */
export type SellerProfileForbiddenField = (typeof SELLER_PROFILE_FORBIDDEN_FIELDS)[number];

/**
 * The public Oxy identity of a seller, resolved live through the supported user
 * DTO (`getUserById` / `POST /users/by-ids`) and never copied into a Mercaria
 * row.
 *
 * `displayName` follows the SANCTIONED coalesce and nothing else:
 * `name.displayName?.trim() || handle`. `name.displayName` is OPTIONAL on the
 * Oxy contract (federated and unresolved actors routinely omit it), and
 * recomposing one from `name.first`/`last`/`full` is forbidden ecosystem-wide —
 * so the handle is the fallback, never a synthesised name.
 */
export interface PublicSellerIdentity {
  /** The Oxy account id. The seller's whole identity, and the follow target's. */
  oxyUserId: string;
  /** The normalized Oxy handle (`getNormalizedUserHandle`), without a leading `@`. */
  handle: string;
  /** `name.displayName?.trim() || handle` — the sanctioned coalesce. */
  displayName: string;
  /** An Oxy media file id, resolved through the ONE media chokepoint. */
  avatar?: string | null;
  /**
   * The canonical Oxy user URI, so a client follows the same target the server
   * is describing rather than reconstructing the convention for itself.
   */
  followTargetUri: string;
}

/**
 * The MERCARIA facts about a seller — activity in this marketplace, and
 * nothing about the person.
 *
 * Present only when {@link PublicSellerProfile.visibility} is `visible`: a
 * private or restricted profile withholds the whole block rather than zeroing
 * its fields, so a client cannot read "0 active listings" as a fact when it is
 * really an absence.
 */
export interface PublicSellerMarketplace {
  /**
   * When this person first PUBLISHED a listing, ISO 8601. Absent when they
   * never have — a lazily-created seller-profile row is not a "seller since"
   * date, and dating somebody from the moment they opened a screen would be a
   * fact about their browsing rather than about their selling.
   */
  sellerSince?: string;
  /** Active, publicly visible P2P listings. Sold, archived, restricted and draft are excluded. */
  activeListingCount: number;
  /** Completed sales, as a safe aggregate. Never a list, never a buyer. */
  salesCount: number;
  /** Mercaria's own seller verification flag. NOT a trust score and never derived from one. */
  isVerified: boolean;
}

/**
 * Oxy Trust's PUBLIC verdict, read through the canonical reputation service.
 *
 * Copied nowhere and recomputed never (#92 reputation rules 3 and 4). Two
 * fields, because two fields are what Oxy serves a third party — the full
 * balance (breakdown, influence, reliability) is the subject's own and Mercaria
 * has no business holding it. Absent when the service does not answer, which is
 * a different fact from a tier of `new` and must stay distinguishable.
 */
export interface PublicSellerTrust {
  /** Oxy Trust's tier for this account. A `TrustTier` from `@oxyhq/contracts`. */
  tier: string;
  /** Net lifetime reputation total. */
  total: number;
}

/**
 * A seller's public Mercaria profile.
 *
 * Every field is named here; nothing is spread in. See the module header for
 * why that is the enforcement rather than a style.
 */
export interface PublicSellerProfile {
  visibility: SellerProfileVisibility;
  /** Present exactly when `visibility !== 'visible'`. */
  withheldReason?: SellerProfileWithheldReason;
  /**
   * Present unless the Oxy profile is `private` — a private account discloses
   * no identity at all, so there is nothing to render but the state.
   */
  identity?: PublicSellerIdentity;
  /** Present exactly when `visibility === 'visible'`. */
  marketplace?: PublicSellerMarketplace;
  /**
   * The #76 `p2p_seller` aggregate — "how was this seller to buy from" — and
   * ONLY that scope. A product rating and an item-condition rating answer
   * different questions about different targets and are never shown here as if
   * they were this person's. Present exactly when `visibility === 'visible'`.
   */
  transactionReviews?: ScopedRatingAggregate;
  /** Oxy Trust. Absent when unavailable, or when the profile is not visible. */
  trust?: PublicSellerTrust;
  /**
   * Whether a search engine may index this page (#92 privacy rule 7).
   *
   * Server-derived so the policy has one home: a page is indexable only when it
   * is fully visible AND carries at least one active listing. A profile with
   * nothing on it is a thin page about a named person, which is precisely what
   * a minimum-content policy exists to keep out of an index.
   */
  indexable: boolean;
}

/** One keyset page of a seller's public listings. */
export interface PublicSellerListingsPage<TListing> {
  listings: TListing[];
  /** Opaque; pass back verbatim. Absent on the last page. */
  nextCursor?: string;
}
