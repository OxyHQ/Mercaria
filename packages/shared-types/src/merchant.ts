/**
 * Canonical merchant / storefront DTOs and value sets — issue #54, bound by
 * ADR 0002 (`docs/adr/0002-canonical-commerce-graph.md`).
 *
 * A **merchant** is the commercial actor that sells — the canonical seller
 * identity, native or external, claimed or discovered (ADR 0002 D3/D9). A
 * **storefront** is one named channel that merchant operates: a domain, a
 * country site, a marketplace presence. A **native store link** is the verified
 * 1:1 join between a canonical merchant and an existing native `stores` row
 * (D4) — the operational store keeps its members, permissions, inventory and
 * orders untouched.
 *
 * ## Not `MerchantSummary`
 *
 * `MerchantSummary` in `./product` is a home-feed card projection of a NATIVE
 * store and predates the canonical graph (ADR 0002, entity glossary). Nothing
 * may import it as a canonical type, and nothing here replaces it — #70–#73
 * re-home it.
 *
 * ## Value sets shared with the rest of the graph
 *
 * The ADR-wide shapes are declared ONCE, in #53's files, and imported here:
 * `CanonicalEntityStatus` and `CanonicalAliasKind` from `./organization`,
 * the source-link vocabulary from `./provenance`. Merchants and storefronts
 * carry the SAME lifecycle every canonical entity does — a second
 * merchant-specific status tuple would be a copy that could drift.
 */

import type { CanonicalEntityStatus } from './organization';

/** `Merchant.merchantType` — what kind of commercial actor this is, when useful. */
export const MERCHANT_TYPES = [
  'retailer',
  'marketplace_seller',
  'manufacturer_direct',
  'cooperative',
  'individual_business',
] as const;
export type MerchantType = (typeof MERCHANT_TYPES)[number];

/**
 * `Merchant.claimState` — ADR 0002 D9's ONE stored verdict, following the
 * payments precedent (`provider_accounts.onboarding_state`): a gate reads one
 * stored state rather than re-deriving a conjunction, and there is deliberately
 * no `is_verified`/`is_claimed` boolean beside it. The claiming FLOW is owned
 * by #40/#83; this tuple is the seam it moves.
 */
export const CLAIM_STATES = ['unclaimed', 'claim_pending', 'claimed'] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

/**
 * `Storefront.channelKind` — how the channel is reached: a web domain, a
 * marketplace presence (amazon.es), a mobile/native app, or a physical channel.
 */
export const STOREFRONT_CHANNEL_KINDS = ['web', 'marketplace', 'app', 'physical'] as const;
export type StorefrontChannelKind = (typeof STOREFRONT_CHANNEL_KINDS)[number];

/**
 * `MerchantDomain.status` — a public-website OBSERVATION versus a VERIFIED
 * domain. Verification is a positive, deliberate act (#83's domain-control
 * mechanism or an operator); observation is just "a source said so". Many
 * merchants may be observed at one domain; at most ONE may hold it verified
 * (the partial unique in the schema is the collision gate).
 */
export const MERCHANT_DOMAIN_STATUSES = ['observed', 'verified', 'rejected'] as const;
export type MerchantDomainStatus = (typeof MERCHANT_DOMAIN_STATUSES)[number];

/** `NativeStoreLink.status` — the mapping is reversible; revoked rows are history. */
export const NATIVE_STORE_LINK_STATUSES = ['active', 'revoked'] as const;
export type NativeStoreLinkStatus = (typeof NATIVE_STORE_LINK_STATUSES)[number];

/**
 * How a native-store link was VERIFIED. Deliberately, there is no
 * `name_match` member: issue #54 is explicit that the mapping cannot be
 * created from a matching name alone, and a closed set with no such value
 * makes that structural rather than a rule a reviewer has to remember.
 */
export const NATIVE_STORE_LINK_METHODS = [
  'owner_authentication',
  'domain_verification',
  'operator',
] as const;
export type NativeStoreLinkMethod = (typeof NATIVE_STORE_LINK_METHODS)[number];

/**
 * The public merchant DTO.
 *
 * Every field is named explicitly (the payments status-projection rule): no
 * claim actor, no pinned-fields list, no operator metadata ever rides along.
 * Native-checkout eligibility is deliberately NOT a field here — it is DERIVED
 * state (see {@link MerchantNativeCheckoutEligibility}), never an identity
 * fact, so a stale copy of it cannot exist on the identity record.
 */
export interface Merchant {
  id: string;
  /** Canonical display name. Alternate spellings live in aliases, never here. */
  name: string;
  /** URL identity. Unique forever — a merged tombstone keeps its slug (D12). */
  slug: string;
  merchantType: MerchantType | null;
  description: string | null;
  claimState: ClaimState;
  status: CanonicalEntityStatus;
  /** The FINAL merge winner when `status === 'merged'`; NULL otherwise. */
  mergedIntoId: string | null;
  /** Aggregate mean rating, 0 when unrated. A rollup, not a permission. */
  rating: number;
  ratingCount: number;
  /** Rollup of offers attributed to this merchant (#57 maintains it). */
  offerCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One public-website observation or verified domain of a merchant. */
export interface MerchantDomain {
  id: string;
  merchantId: string;
  /** Normalized lowercase hostname, no scheme, no path. */
  domain: string;
  status: MerchantDomainStatus;
  firstObservedAt: string;
  lastObservedAt: string;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The public storefront DTO — one named sales channel a merchant operates.
 *
 * An offer made *on* this channel by a DIFFERENT merchant is a marketplace
 * offer — derived per offer from `offers.merchant_id ≠ storefronts.merchant_id`
 * (ADR 0002 D8), which is what keeps "Sold by Amazon" and "Sold by Shop X on
 * Amazon" from ever collapsing into one identity. The offer table itself is
 * #57; this DTO carries the operator side of that pair.
 */
export interface Storefront {
  id: string;
  /** The operating merchant. NOT NULL — a storefront cannot exist without one (D3). */
  merchantId: string;
  name: string;
  slug: string;
  channelKind: StorefrontChannelKind;
  /** The external platform's own id (`shopify`, `amazon`, …) — an open set. */
  provider: string | null;
  /** Normalized lowercase hostname when the channel is domain-addressed. */
  domain: string | null;
  /** The source platform's own shop id — a foreign key space, never Mercaria's. */
  externalShopId: string | null;
  /** ISO 3166-1 alpha-2 primary market; NULL = not market-scoped. */
  country: string | null;
  /** Lowercased BCP-47 tags the channel publishes in; NULL = unknown. */
  languages: string[] | null;
  /**
   * The channel's OWN currency, as the source platform reports it — possibly a
   * code outside Mercaria's presentment set, so it is shape-checked, never
   * tuple-checked (the `connections.shop_currency` exemption class).
   */
  currency: string | null;
  publicUrl: string | null;
  /** Whether outbound affiliate routing (#67) can target this channel. */
  affiliateCapable: boolean;
  status: CanonicalEntityStatus;
  mergedIntoId: string | null;
  firstSeenAt: string;
  /** Moved by ANY sighting of the channel; NULL when never sighted since minting. */
  lastSeenAt: string | null;
  /** Last SUCCESSFUL refresh — distinct from last seen, which any sighting moves. */
  lastRefreshedAt: string | null;
  /** Whether the operating merchant's control of this channel is verified. */
  verificationState: 'unverified' | 'verified';
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `Storefront.verificationState` values, as a tuple for CHECKs and schemas. */
export const STOREFRONT_VERIFICATION_STATES = ['unverified', 'verified'] as const;
export type StorefrontVerificationState = (typeof STOREFRONT_VERIFICATION_STATES)[number];

/**
 * The verified, reversible join between a canonical merchant and a native
 * `stores` row (ADR 0002 D4). At most one ACTIVE link per store and per
 * merchant; revoked links remain as history. Actor ids stay on the row (it IS
 * the audit record) and are exposed only on the operator surface.
 */
export interface NativeStoreLink {
  id: string;
  merchantId: string;
  storeId: string;
  status: NativeStoreLinkStatus;
  verificationMethod: NativeStoreLinkMethod;
  verificationNote: string | null;
  verifiedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Native-checkout eligibility, DERIVED at read time (issue #54 requirement 7).
 *
 * Never stored: only `native` offers reach checkout structurally (ADR 0002
 * D18), so eligibility is a conjunction over the claim verdict and the active
 * native-store link — restated here for display, with the conjuncts beside the
 * verdict so a client can say WHY.
 */
export interface MerchantNativeCheckoutEligibility {
  merchantId: string;
  eligible: boolean;
  claimState: ClaimState;
  hasActiveNativeStoreLink: boolean;
}

/** A public merchant read: the merchant plus its channels and verified domains. */
export interface MerchantPublicProfile {
  merchant: Merchant;
  storefronts: Storefront[];
  /** Verified domains only — observations are graph-internal until verified. */
  verifiedDomains: string[];
  /** Set when the requested id/slug was a merge tombstone resolved to its winner. */
  redirectedFrom?: string;
}

/** A public storefront read, with the same tombstone-redirect contract. */
export interface StorefrontPublicProfile {
  storefront: Storefront;
  redirectedFrom?: string;
}
