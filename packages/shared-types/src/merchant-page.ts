/**
 * The merchant page and its catalogue browse — issue #73, bound by ADR 0002
 * (`docs/adr/0002-canonical-commerce-graph.md`) D3/D4/D8/D9/D10/D17.
 *
 * ## Four things, and the page may not collapse any pair
 *
 * A **merchant** is the commercial actor that sells (D3). A **storefront** is
 * one named channel — a domain, a country site, a marketplace account (D3). A
 * **native Mercaria store** is an operational `stores` row with its own members,
 * inventory, orders, handle and follow identity, joined to a merchant by a
 * verified 1:1 link (D4). A **brand** is what is being sold, and it is a
 * different entity again (#56), reachable from a merchant only through an
 * evidence-gated relationship row (#55, D10).
 *
 * Every shape in this file is written so that none of those four can stand in
 * for another:
 *
 *  - {@link MerchantPage} carries a merchant, its operated channels, its
 *    SELLING channels and (when one exists) a native-store REFERENCE. The
 *    reference is a link target and a handle — never an embedded store, never a
 *    follow control, never a policy or a member list, because those are the
 *    store APIs' and a second rendering of them could disagree.
 *  - A brand appears only as {@link MerchantBrandStanding}, which has THREE
 *    states and no boolean. "Sells this brand with no verified relationship" is
 *    a first-class state with its own copy, not the absence of a badge.
 *  - {@link MerchantCatalogEntry} is a CANONICAL PRODUCT card carrying the
 *    offers *this scope* makes. It has no rating field at all — see
 *    {@link MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS} — because a merchant page
 *    showing two star ratings is precisely how a merchant's reputation becomes
 *    a product's (#73 trust rule 5).
 *
 * ## Marketplace-ness stays derived, and that is why there are two channel lists
 *
 * ADR 0002 D8 makes an offer a marketplace offer by comparing its seller of
 * record against the operator of the channel it sits on — a comparison, never a
 * column. The page renders that comparison honestly by keeping the two
 * directions apart: {@link MerchantPage.operatedChannels} is what this merchant
 * OPERATES (`storefronts.merchant_id`), and {@link MerchantPage.sellingChannels}
 * is what it SELLS THROUGH (the channels its own offers sit on, each naming its
 * operator). For a first-party retailer the two lists coincide; for a
 * marketplace seller they do not, and collapsing them would either hide the
 * platform or attribute its catalogue to a seller.
 *
 * ## Nothing here is stored
 *
 * There is no merchant-page table and no migration. Every field is a projection
 * over `merchants`, `storefronts`, `native_store_links`, `commerce_relationships`,
 * `offers`, `canonical_products` and `review_aggregates`, derived per request —
 * the `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, taken for its reason: the inputs sit on tables this domain does not own,
 * and a stored copy would be a second answer that a moderation restriction, a
 * revoked claim or a lapsed relationship could leave stale.
 */

import type { ConditionGroup, OfferConditionKey } from './condition';
import type { ClaimState, Merchant, Storefront } from './merchant';
import type { MerchantClaimEligibility } from './merchant-claim';
import type { MerchantNativeCheckoutEligibility } from './merchant';
import type { Offer, OfferAvailability, OfferKind, OfferSellerRole } from './offer';
import type { PublicCommerceRelationship, PublicRelationshipBadge } from './relationship';
import type { ScopedRatingAggregate } from './review';

/* -------------------------------------------------------------------------- */
/*  Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One alternate spelling of a merchant's name (#73 merchant requirement 1).
 *
 * The alias row's actor, its normalized form and the source record that
 * supplied it stay graph-internal: a public page needs the words, and the
 * provenance of a name is an operator question.
 */
export interface MerchantPageAlias {
  readonly alias: string;
  /** `legal`, `trade`, `former`, … — #53's shared alias vocabulary. */
  readonly kind: string;
  /** Lowercased BCP-47 tag when the alias is language-specific. */
  readonly language: string | null;
}

/**
 * The operating legal entity, shown only when a VERIFIED
 * `organization_operates_merchant` relationship covers this instant
 * (#73 merchant requirement 3).
 *
 * "and useful" is a policy, not a shrug: an organization whose name is the
 * merchant's own name tells a reader nothing and is withheld
 * ({@link MERCHANT_ORGANIZATION_USEFULNESS} states the rule). The relationship
 * row itself is NOT published — #55 restricts its public reads to badge kinds,
 * and an operating-entity claim is not a badge. What appears is the
 * organization's own public identity and the instant the claim was verified.
 */
export interface MerchantPageOrganization {
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  /** ISO 3166-1 alpha-2 home country, when the organization records one. */
  readonly countryCode: string | null;
  readonly verifiedAt: string;
}

/**
 * Why an operating organization is withheld even though one is linked.
 *
 * Published so a reader of the page (and of this file) can tell "no verified
 * operator" from "a verified operator we judged redundant" — the two are
 * different facts about the merchant and only one of them is a gap.
 */
export const MERCHANT_ORGANIZATION_USEFULNESS = ['useful', 'same_name_as_merchant'] as const;
export type MerchantOrganizationUsefulness =
  (typeof MERCHANT_ORGANIZATION_USEFULNESS)[number];

/* -------------------------------------------------------------------------- */
/*  Claim and activation, in safe public language                               */
/* -------------------------------------------------------------------------- */

/**
 * The closed vocabulary a merchant page may describe its standing with
 * (#73 merchant requirement 2, "safe public language").
 *
 * Four labels, derived from two published facts — `merchants.claim_state` and
 * #54's derived native-checkout verdict — and NOTHING else. In particular there
 * is no member that could mean "a claim was rejected", "an operator is
 * reviewing evidence" or "this merchant was reported": each of those is a
 * statement about a PERSON's dealings with Mercaria, and a page anybody can
 * load must not make one.
 */
export const MERCHANT_PUBLIC_STANDINGS = [
  /** Nobody has proved they operate this merchant. The normal state (D9). */
  'unclaimed',
  /** Somebody is proving it. A signal, never a refusal — #83's `claimInProgress`. */
  'claim_in_progress',
  /** An operator proved it and may act as this merchant. */
  'claimed',
  /** Claimed AND joined to a native store, so it can sell on Mercaria itself. */
  'selling_on_mercaria',
] as const;
export type MerchantPublicStanding = (typeof MERCHANT_PUBLIC_STANDINGS)[number];

/**
 * Standing plus the two facts it was derived from, so a client never has to
 * reconstruct one from the other.
 *
 * `eligibility` is #83's own public verdict, republished verbatim rather than
 * re-derived: it already names no claimant, no reviewer and no pending claim's
 * id, and a second derivation here could disagree with the endpoint the
 * `Claim this merchant` button actually posts to.
 */
export interface MerchantPageStanding {
  readonly standing: MerchantPublicStanding;
  readonly claimState: ClaimState;
  readonly nativeCheckout: MerchantNativeCheckoutEligibility;
  readonly eligibility: MerchantClaimEligibility;
}

/* -------------------------------------------------------------------------- */
/*  Channels                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One channel on a merchant page, with the operator stated separately
 * (#73 storefront rules 2, 3 and 5).
 *
 * `operatorMerchantId` is `storefronts.merchant_id` — who runs the channel —
 * and `operatedByThisMerchant` is the D8 comparison already made, so no client
 * has to make it and none can make it differently. When it is false the channel
 * is a marketplace this merchant sells ON, and the page says so in those words:
 * a product on `amazon.es` is not thereby sold by Amazon.
 */
export interface MerchantPageChannel {
  readonly storefront: Storefront;
  readonly operatorMerchantId: string;
  readonly operatorName: string | null;
  readonly operatedByThisMerchant: boolean;
  /**
   * How many of THIS merchant's current offers sit on this channel.
   *
   * Scoped to the merchant whose page this is, always — a channel's total
   * catalogue is a fact about its operator, and publishing it here would credit
   * a marketplace's whole inventory to one of its sellers.
   */
  readonly currentOfferCount: number;
  /**
   * The outbound action, which #67 owns and which does not exist yet.
   *
   * Present so the contract is visible rather than invented later: until #67
   * ships, {@link MerchantChannelOutbound} has one branch and it refuses.
   */
  readonly outbound: MerchantChannelOutbound;
}

/**
 * Whether a tracked outbound link to this channel can be produced.
 *
 * The `unavailable` branch carries no URL at all — a shape, not a check.
 * Mercaria composes no tracking parameters (#37/#67 own that, and every source
 * domain in this repository already refuses to build one), so a page that
 * wanted to "just link somewhere" has nothing here to reach for; the untracked
 * `storefront.publicUrl` is a separate, plainly-named field.
 *
 * The discriminant is a STRING rather than an `available: boolean` literal, and
 * that is the #68/#110 rule rather than a style choice: the backend compiles
 * with `strict: false`, and without `strictNullChecks` TypeScript does not
 * narrow a union on the truthiness of a boolean-literal discriminant — so
 * `if (!outbound.available)` would leave the caller holding the whole union and
 * a `url` read would type-check on the branch that has none.
 */
export type MerchantChannelOutbound =
  | { readonly outcome: 'unavailable'; readonly reason: MerchantOutboundUnavailableReason }
  | { readonly outcome: 'available'; readonly url: string };

/** Why an outbound action is unavailable. One member until #67 lands. */
export const MERCHANT_OUTBOUND_UNAVAILABLE_REASONS = ['outbound_redirect_not_built'] as const;
export type MerchantOutboundUnavailableReason =
  (typeof MERCHANT_OUTBOUND_UNAVAILABLE_REASONS)[number];

/* -------------------------------------------------------------------------- */
/*  The native store                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What the canonical merchant route does about a verified native store
 * (#73 native-store requirement 2). The decision is **link**.
 *
 * A REDIRECT would make the merchant route unreachable, and with it every
 * external channel, every offer this merchant makes elsewhere and the claim
 * action itself — the merchant would BE the store, which is the collapse this
 * whole issue exists to prevent. An EMBED would be a second rendering of an
 * experience the store APIs own (members, collections, policies, theme,
 * inventory), and two renderings of one thing disagree the moment either
 * changes.
 *
 * A link keeps one follow identity by construction: the follow control lives on
 * the store route and this page renders none, so there is no code path on which
 * a second `mercaria.store` target could be minted (native-store requirements 3
 * and 6). {@link MERCHANT_REJECTED_NATIVE_STORE_PRESENTATIONS} is disjoint from
 * this one-member union, so the rejected options are named values a gate can
 * check rather than a decision recorded only in prose.
 */
export const MERCHANT_NATIVE_STORE_PRESENTATIONS = ['link'] as const;
export type MerchantNativeStorePresentation =
  (typeof MERCHANT_NATIVE_STORE_PRESENTATIONS)[number];

/** The two presentations #73 considered and this domain refuses. */
export const MERCHANT_REJECTED_NATIVE_STORE_PRESENTATIONS = ['redirect', 'embed'] as const;
export type MerchantRejectedNativeStorePresentation =
  (typeof MERCHANT_REJECTED_NATIVE_STORE_PRESENTATIONS)[number];

/**
 * The verified native store a merchant is linked to — a REFERENCE and nothing
 * more (#73 native-store requirements 1, 3, 4 and 5).
 *
 * `handle` is what `/m/<handle>` and the store's own `mercaria.store` follow
 * target are built from, and it is carried verbatim from the `stores` row: this
 * page reads it and never writes it, so external merchant data has no path to
 * overwrite a merchant-managed native-store field (requirement 5) — there is no
 * writer in this domain at all.
 *
 * Deliberately ABSENT: policies, members, collections, inventory, orders, the
 * store's own rating and any follow state. Each is the store APIs' to serve
 * (requirement 4), and #76's `resolveStoreRatingSource` already decides that a
 * linked store shows the MERCHANT's rating — which this page carries once, at
 * the top, under its own scope label.
 */
export interface MerchantPageNativeStore {
  readonly storeId: string;
  readonly handle: string;
  readonly name: string;
  readonly presentation: MerchantNativeStorePresentation;
  /** When the 1:1 link was verified (#54's `native_store_links.verified_at`). */
  readonly linkedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Brands                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The THREE relationship states a merchant page distinguishes for one brand
 * (#73 relationship-display rules 1–3).
 *
 * They are three states rather than a badge plus its absence because the third
 * is a real, common and honest answer: an ordinary retailer selling a brand
 * holds no relationship row at all (ADR 0002 D10), and a page that rendered
 * silence would leave a reader unable to tell "we checked and there is none"
 * from "we have not looked". Each state carries different copy and a different
 * badge — `official_store`, `authorized_reseller`, or no badge and an explicit
 * sentence.
 */
export const MERCHANT_BRAND_STANDINGS = [
  'official_store',
  'authorized_reseller',
  'no_verified_relationship',
] as const;
export type MerchantBrandStandingKind = (typeof MERCHANT_BRAND_STANDINGS)[number];

/** One brand this merchant sells, and what Mercaria has verified about it. */
export interface MerchantBrandStanding {
  readonly brandId: string;
  readonly brandSlug: string;
  readonly brandName: string;
  readonly standing: MerchantBrandStandingKind;
  /** #55's badge; `null` on `no_verified_relationship`, by construction. */
  readonly badge: PublicRelationshipBadge | null;
  /**
   * The verified claim behind a badge, absent on the third state.
   *
   * #55's public projection, which carries no evidence, no reviewer, no actor
   * and no confidence — so a claimed merchant reading its own page learns
   * nothing it could use to argue with the verification, and cannot edit it
   * from here because this domain has no write route at all.
   */
  readonly relationship?: PublicCommerceRelationship;
  /** How many of this merchant's current offers are for this brand's products. */
  readonly currentOfferCount: number;
}

/* -------------------------------------------------------------------------- */
/*  Offer mix                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Offer counts by native, external, condition and market
 * (#73 merchant requirement 7).
 *
 * ### What "current" counts, and the one direction it can be wrong
 *
 * These counts are taken over `status = 'active' AND stale_at > now` — the same
 * indexed stored deadline every offer read pre-filters on. #68's rule is that
 * the stored deadline is a PRE-FILTER and the live per-source derivation is the
 * authority, and the two can only disagree after a policy change: a shortened
 * contractual lifetime bites at the next LIST read with no sweep having run,
 * while these counts still include the offer until the sweep catches up. So the
 * mix is an upper bound on what a list would show, never a lower one, and it is
 * stated here rather than hidden because the alternative — projecting a
 * merchant's entire offer set through the live derivation to count it — is not
 * something a page read can afford.
 *
 * `staleOfferCount` is the difference between active and current, which is what
 * makes an honest stale-source state possible without a second query.
 */
export interface MerchantOfferMix {
  /** Active offers regardless of freshness — the denominator of staleness. */
  readonly activeOfferCount: number;
  /** Active offers inside their stored deadline. */
  readonly currentOfferCount: number;
  /** `activeOfferCount - currentOfferCount`; > 0 means a source has gone quiet. */
  readonly staleOfferCount: number;
  /** Current offers by #57 offer kind — `native` versus the external kinds. */
  readonly byKind: readonly MerchantOfferMixBucket<OfferKind>[];
  /**
   * Current offers by seller role — this merchant selling on its OWN channel
   * versus on somebody else's (ADR D8's comparison, counted).
   */
  readonly bySellerRole: readonly MerchantOfferMixBucket<OfferSellerRole>[];
  /** Current offers by #90 condition key. */
  readonly byCondition: readonly MerchantOfferMixBucket<OfferConditionKey>[];
  /**
   * Current offers by market. `null` is an offer published for NO particular
   * market, which is a real answer and not a missing one — a market-less offer
   * is available everywhere, so it must not be filed under a country it never
   * named.
   */
  readonly byMarket: readonly MerchantOfferMixBucket<string | null>[];
}

/** One counted bucket. Sorted descending by count, then by key, so it is stable. */
export interface MerchantOfferMixBucket<TKey> {
  readonly key: TKey;
  readonly count: number;
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything a merchant page renders except its catalogue, which is paged
 * separately.
 *
 * Every field is named (the `provider_accounts` status-projection precedent).
 * {@link MERCHANT_PAGE_FORBIDDEN_FIELDS} names what may never appear, as VALUES
 * a gate can scan for rather than as an omission a reviewer has to notice.
 */
export interface MerchantPage {
  readonly merchant: Merchant;
  /** Set when a merged tombstone's URL resolved to this winner (D12/D16). */
  readonly redirectedFrom?: string;
  readonly aliases: readonly MerchantPageAlias[];
  readonly standing: MerchantPageStanding;
  readonly organization?: MerchantPageOrganization;
  /** Why an organization is absent when one is in fact linked. */
  readonly organizationUsefulness?: MerchantOrganizationUsefulness;
  readonly operatedChannels: readonly MerchantPageChannel[];
  readonly sellingChannels: readonly MerchantPageChannel[];
  readonly nativeStore?: MerchantPageNativeStore;
  /** Domains this merchant has been VERIFIED to control. Observations stay internal. */
  readonly verifiedDomains: readonly string[];
  /**
   * The `merchant`-scoped #76 aggregate, and only that one.
   *
   * A merchant page can reach four rating aggregates — the merchant's, a linked
   * store's, each product's and each P2P seller's — and they answer four
   * different questions. Publishing one, under its own scope label, is #73
   * trust rule 5 and #76 UI rule 6 in one field.
   */
  readonly reviews: ScopedRatingAggregate | null;
  readonly brandStandings: readonly MerchantBrandStanding[];
  readonly offerMix: MerchantOfferMix;
  /**
   * Merchant-managed policies, support and public contact
   * (#73 merchant requirement 10).
   *
   * Present ONLY through a verified native store, whose operator manages those
   * fields themselves in Mercaria. For an external merchant Mercaria records no
   * sourced policy, support channel, postal address or physical location at
   * all — see {@link MerchantPageContact} — and the honest rendering of that is
   * an absent field rather than an inferred one.
   */
  readonly contact: MerchantPageContact;
}

/**
 * What a merchant page may say about how to reach this merchant.
 *
 * `source` is the whole point of the shape. `native_store` means the merchant's
 * own operator typed it into Mercaria; `none` means Mercaria holds nothing and
 * says nothing. There is deliberately NO `payment_onboarding` member and no
 * `inventory_location` member: a Stripe onboarding address is a legal-entity
 * record a seller gave a payment processor (#73 trust rule 2), and an
 * `inventory_locations` row is a warehouse, not a shop somebody chose to
 * publish (trust rule 3). Neither has a member here, so neither can arrive by
 * somebody wiring up a field.
 */
export interface MerchantPageContact {
  readonly source: MerchantContactSource;
  /** The store route a buyer reaches policies and support through. */
  readonly nativeStoreHandle?: string;
  /** The merchant's own public website, from a VERIFIED channel. Never a guess. */
  readonly publicUrl?: string;
}

/** Where a merchant page's contact information may come from. */
export const MERCHANT_CONTACT_SOURCES = ['native_store', 'verified_channel', 'none'] as const;
export type MerchantContactSource = (typeof MERCHANT_CONTACT_SOURCES)[number];

/**
 * Facts a merchant page may never publish, as values.
 *
 * The first group is #73 trust rule 1: claim evidence and operator notes are
 * what a reviewer looked at and what they wrote down, and a page anybody can
 * load must contain neither. The second is trust rules 2 and 3 — an address
 * inferred from payment onboarding, and a physical location the merchant never
 * chose to publish. The third is #73's title: a native store's members,
 * inventory and orders belong to the store APIs and appear nowhere here.
 */
export const MERCHANT_PAGE_FORBIDDEN_FIELDS = [
  // Claim evidence and operator material (trust rule 1).
  'claimEvidence',
  'claimToken',
  'claimantOxyUserId',
  'claimedByOxyUserId',
  'reviewerNote',
  'operatorNote',
  'internalNote',
  'pinnedFields',
  // Inferred or unpublished location and contact (trust rules 2 and 3).
  'billingAddress',
  'legalAddress',
  'payoutAddress',
  'onboardingAddress',
  'physicalLocations',
  'inventoryLocations',
  'email',
  'phone',
  'taxId',
  // Native-store internals the store APIs own (native-store rule 4).
  'storeMembers',
  'storePolicies',
  'storeInventory',
  'storeOrders',
] as const;
export type MerchantPageForbiddenField = (typeof MERCHANT_PAGE_FORBIDDEN_FIELDS)[number];

/* -------------------------------------------------------------------------- */
/*  Catalogue browse                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How a catalogue browse is scoped (#73 storefront-navigation rule 1).
 *
 * Three kinds, and the third is the one that makes acceptance criterion 2
 * work. `merchant` and `merchant_on_channel` both answer "what does THIS
 * merchant sell", the second narrowed to one channel it sells through.
 * `channel_all_sellers` answers "what is offered on this channel", including by
 * OTHER merchants — which is how a marketplace operator's page shows its
 * third-party sellers' offers without merging anybody's identity, since every
 * offer keeps its own seller of record.
 *
 * `channel_all_sellers` is permitted only for a channel this merchant OPERATES.
 * Somebody else's channel is somebody else's page, and serving it here would
 * make one merchant's route a viewer for another's catalogue.
 */
export const MERCHANT_CATALOG_SCOPE_KINDS = [
  'merchant',
  'merchant_on_channel',
  'channel_all_sellers',
] as const;
export type MerchantCatalogScopeKind = (typeof MERCHANT_CATALOG_SCOPE_KINDS)[number];

export type MerchantCatalogScope =
  | { readonly kind: 'merchant' }
  | { readonly kind: 'merchant_on_channel'; readonly storefrontId: string }
  | { readonly kind: 'channel_all_sellers'; readonly storefrontId: string };

/** The filters a catalogue browse accepts (#73 catalogue-browse rule 3). */
export interface MerchantCatalogFilters {
  readonly categoryId?: string;
  readonly brandId?: string;
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly availability?: readonly OfferAvailability[];
  /** ISO 3166-1 alpha-2; admits market-less offers, which are sold everywhere. */
  readonly market?: string;
}

/**
 * One canonical product card (#73 catalogue-browse rules 1 and 2, acceptance 5).
 *
 * DEDUPLICATED by canonical product across every offer and channel in scope, so
 * a retailer listing one phone on four country sites is one card. What varies
 * between those four is reported as counts and as the representative offer, not
 * as four cards.
 *
 * `representativeOffer` is a fully projected {@link Offer} — the same object
 * `GET /offers` and the offer-level view emit, through the same
 * `projectOffer`. That is deliberate: the seller of record, the channel and its
 * operator, the condition, the market, the language, the currency, the
 * freshness and the destination are all facts a card must state, and a second
 * slimmer spelling of them is a second thing to keep in step.
 */
export interface MerchantCatalogEntry {
  readonly canonicalProductId: string;
  readonly slug: string;
  readonly name: string;
  readonly brand?: { readonly id: string; readonly slug: string; readonly name: string };
  readonly categoryId?: string;
  readonly image?: { readonly fileId: string | null; readonly sourceUrl: string | null; readonly alt: string | null };
  /**
   * The offer this card is priced from: the cheapest CURRENT offer in scope.
   *
   * Absent when every offer of this product in scope failed the live freshness
   * derivation — which is why a card can exist with no price rather than
   * carrying a price nobody could pay (#68 public behaviour 7).
   */
  readonly representativeOffer?: Offer;
  /** Current offers of this product in scope, after the live freshness filter. */
  readonly currentOfferCount: number;
  /**
   * Distinct channels carrying a current offer of this product in scope
   * (#73 catalogue-browse rule 2, "eligible storefront count").
   *
   * Counted over the offers that SURVIVED the freshness derivation, so it can
   * never claim a channel whose price has lapsed.
   */
  readonly eligibleChannelCount: number;
  /** The new/used segments the current offers actually cover (#90). */
  readonly conditionGroups: readonly ConditionGroup[];
  /** Rolled up across the current offers; never `in_stock` from silence (#68). */
  readonly availability: OfferAvailability;
  /** Whether any current offer in scope is by a seller other than this merchant. */
  readonly hasOtherSellers: boolean;
}

/**
 * Fields a catalogue entry may never carry.
 *
 * A merchant page renders a merchant's rating once, at the top, under its own
 * scope label. A star on a product card beside it would be read as the same
 * measurement — which is #73 trust rule 5 exactly ("merchant ratings never
 * become product ratings"). A product's own rating belongs on the product page
 * (#71), where it is the only rating on the screen.
 */
export const MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS = [
  'rating',
  'ratingCount',
  'reviewCount',
  'merchantRating',
  'sellerRating',
] as const;
export type MerchantCatalogForbiddenEntryField =
  (typeof MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS)[number];

/**
 * Why a catalogue page is empty (#73 catalogue-browse rule 6).
 *
 * Three answers, because they lead a reader to three different conclusions and
 * a single "nothing here" hides which one is true. `stale_sources` is the one
 * worth having: it says Mercaria HAS offers for this merchant and has not heard
 * from their source recently enough to show them, which is a statement about
 * Mercaria rather than about the shop.
 */
export const MERCHANT_CATALOG_EMPTY_REASONS = [
  'no_offers',
  'stale_sources',
  'filtered_out',
] as const;
export type MerchantCatalogEmptyReason = (typeof MERCHANT_CATALOG_EMPTY_REASONS)[number];

/** One page of deduplicated canonical-product cards. */
export interface MerchantCatalogPage {
  readonly merchantId: string;
  readonly scope: MerchantCatalogScope;
  readonly entries: readonly MerchantCatalogEntry[];
  /** Keyset cursor; absent when this is the last page. */
  readonly nextCursor?: string;
  /** Present exactly when `entries` is empty. */
  readonly emptyReason?: MerchantCatalogEmptyReason;
}

/**
 * One page of the OFFER-level view (#73 catalogue-browse rule 4).
 *
 * The view a shopper opens when the question is "which of this merchant's
 * channels, or which seller on this channel, has it" — so it is deliberately
 * NOT deduplicated: every offer stands on its own, with its own seller of
 * record, channel, operator, market, currency and freshness.
 */
export interface MerchantOfferPage {
  readonly merchantId: string;
  readonly scope: MerchantCatalogScope;
  readonly offers: readonly Offer[];
  readonly nextCursor?: string;
  readonly emptyReason?: MerchantCatalogEmptyReason;
}
