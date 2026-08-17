/**
 * Brand and product-family PAGES (#72, ADR 0002 D10/D17/D21/D24).
 *
 * The wire contract for the two navigation surfaces a shopper reaches from a
 * product: the BRAND behind it and the FAMILY it belongs to. Both are
 * COMPOSITIONS over catalogue identity (#53/#56), verified relationships (#55),
 * current eligible offers (#57/#68) and source rights (#62) — they own no table
 * of their own and they publish no fact none of those domains already holds.
 *
 * ## The three things this file makes structurally impossible
 *
 * 1. **A brand page cannot claim an official channel from a resemblance.**
 *    {@link CATALOG_PAGE_OFFICIAL_EVIDENCE} has exactly ONE member — a verified
 *    #55 relationship inside its validity window — and
 *    {@link CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS} names the twelve
 *    resemblances that may never produce one. The two tuples are DISJOINT (the
 *    `RetailCostComponentKind` device), so a matching name, a matching logo, a
 *    shared domain, a big feed or a claimed storefront has no vocabulary here
 *    to be recorded under. #72 identity rule 5 and acceptance 1.
 * 2. **A brand page cannot be mistaken for a merchant storefront.**
 *    {@link BrandPage} has no channel, no listing, no inventory and no seller
 *    of record; a merchant reaches it only as the SUBJECT of a relationship, in
 *    {@link BrandOfficialChannels}, and ordinary retailers selling the brand
 *    appear in neither list at all. #72 brand rule 8 and acceptance 2.
 * 3. **A rating on these pages is never a rating OF the brand.** #76 makes a
 *    brand rating unrepresentable, and this contract keeps it that way: the only
 *    rating any field here carries is a canonical PRODUCT's, on the product's
 *    own card. {@link CATALOG_PAGE_FORBIDDEN_FIELDS} names the prohibition as a
 *    VALUE so a gate can scan for it.
 *
 * ## Unknown is a STATE, never a zero and never an omission
 *
 * A page whose offer half was withdrawn by #60's `CANONICAL_OFFER_COMPARISON`
 * lever and a brand that genuinely has no current offers are different facts,
 * and a client that could not tell them apart would print "no offers" during an
 * incident. {@link CatalogOfferContextState} says which; a card's absent
 * {@link CatalogProductCard.offers} then means "no current offer" only when the
 * page reports `included`. #72 brand rule 10.
 */

import type { CatalogSourceKind } from './provenance';
import type { ConditionGroup } from './condition';
import type { CurrencyCode } from './money';
import type { OfferAvailability, OfferMoney } from './offer';
import type { ProductOfferSummary } from './offer-freshness';
import type { PublicRelationshipBadge } from './relationship';

/* -------------------------------------------------------------------------- */
/*  What may, and may never, establish an official channel                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything that may put a merchant into a brand's official or authorized
 * list. ONE member, deliberately.
 *
 * A verified #55 relationship inside its validity window is the whole of it:
 * `verification_method` has no `name_match` member, `SUFFICIENT_EVIDENCE_KINDS`
 * decides which evidence can carry which kind, and the public resolver requires
 * the window as well as the status. This page composes that answer and adds
 * nothing to it — which is why there is no second member here for "the operator
 * decided" or "the merchant told us".
 */
export const CATALOG_PAGE_OFFICIAL_EVIDENCE = ['verified_relationship'] as const;

/** One of {@link CATALOG_PAGE_OFFICIAL_EVIDENCE}. */
export type CatalogPageOfficialEvidence = (typeof CATALOG_PAGE_OFFICIAL_EVIDENCE)[number];

/**
 * The resemblances that may NEVER establish an official relationship
 * (#72 official-channel rule 5, identity rule 4).
 *
 * DISJOINT from {@link CATALOG_PAGE_OFFICIAL_EVIDENCE} by a test, and the
 * disjointness is the point: each member is a plausible-looking shortcut
 * somebody would otherwise reach for, and naming them as VALUES makes the
 * prohibition greppable rather than a paragraph in a review comment.
 *
 * `merchant_claim` is the sharpest one. #83 lets a merchant PROVE it operates a
 * merchant record, and that proof is real — it just answers a different
 * question. Being Amazon does not make Amazon Apple's official store, and #83
 * says so in its own isolation gate; this tuple says it from the other side.
 */
export const CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS = [
  'brand_name_match',
  'merchant_name_match',
  'logo_match',
  'domain_match',
  'website_match',
  'feed_presence',
  'catalogue_volume',
  'offer_volume',
  'merchant_claim',
  'storefront_link',
  'payment_readiness',
  'ranking_position',
] as const;

/** One of {@link CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS}. */
export type CatalogPageForbiddenOfficialSignal =
  (typeof CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS)[number];

/**
 * Fields no catalogue page DTO may ever carry, named as values so a runtime
 * walk of a real response can look for them (#92's `SELLER_PROFILE_FORBIDDEN_FIELDS`
 * device).
 *
 * `brandRating` and `familyRating` are #76's prohibition seen from here: a
 * review answers a question about a product, a seller or a transaction, and
 * averaging those into a score for a BRAND invents a claim nobody made.
 * `sponsoredPlacement` and `commissionRate` are #74's: a brand page orders its
 * products by a catalogue order, and a page able to carry a paid position is
 * one somebody will eventually fill in.
 */
export const CATALOG_PAGE_FORBIDDEN_FIELDS = [
  'brandRating',
  'brandRatingCount',
  'familyRating',
  'sponsoredPlacement',
  'commissionRate',
  'affiliateCommission',
  'merchantRanking',
] as const;

/** One of {@link CATALOG_PAGE_FORBIDDEN_FIELDS}. */
export type CatalogPageForbiddenField = (typeof CATALOG_PAGE_FORBIDDEN_FIELDS)[number];

/* -------------------------------------------------------------------------- */
/*  Assets, provenance and rights                                              */
/* -------------------------------------------------------------------------- */

/** Where a displayable asset's right to be shown comes from (#72 identity 3). */
export const CATALOG_ASSET_RIGHTS_BASES = ['source_licensed', 'operator_uploaded'] as const;

/** One of {@link CATALOG_ASSET_RIGHTS_BASES}. */
export type CatalogAssetRightsBasis = (typeof CATALOG_ASSET_RIGHTS_BASES)[number];

/**
 * Why an asset Mercaria HOLDS is not being shown.
 *
 * `unresolved_provenance` is the fail-closed one: an asset whose source record
 * or registry row cannot be read is withheld rather than shown, because "we
 * could not check" and "we checked and it is fine" must not produce the same
 * page.
 */
export const CATALOG_ASSET_WITHHELD_REASONS = [
  'no_display_right',
  'unresolved_provenance',
] as const;

/** One of {@link CATALOG_ASSET_WITHHELD_REASONS}. */
export type CatalogAssetWithheldReason = (typeof CATALOG_ASSET_WITHHELD_REASONS)[number];

/**
 * Where a shown fact came from, and what showing it obliges.
 *
 * `attribution` is present exactly when the source's registry row requires it
 * (#62 `catalog_sources.attribution_required`). The string is the source's
 * REGISTRY NAME, because that is the only display identity a source has —
 * which is a real operational consequence rather than a hidden one: a source
 * configured with attribution required must be NAMED for a reader.
 */
export interface CatalogAssetProvenance {
  readonly sourceKind: CatalogSourceKind;
  readonly observedAt?: string;
  readonly staleAt?: string;
  readonly attribution?: string;
}

/**
 * One visual asset on a catalogue page — a discriminated union with a STRING
 * discriminant.
 *
 * The backend compiles without `strictNullChecks`, so a boolean-literal
 * discriminant does not narrow (the #68 finding); every union in this file uses
 * a string for that reason.
 */
export type CatalogPageAsset =
  | { readonly state: 'absent' }
  | { readonly state: 'withheld'; readonly reason: CatalogAssetWithheldReason }
  | {
      readonly state: 'displayable';
      /** An Oxy media file id. Resolved through Bloom's `ImageResolver`. */
      readonly fileId: string;
      readonly rightsBasis: CatalogAssetRightsBasis;
      readonly provenance?: CatalogAssetProvenance;
    };

/**
 * A public TEXT field with its rights, for the same reason the assets carry
 * theirs: a description copied out of a feed is somebody else's writing.
 */
export type CatalogPageText =
  | { readonly state: 'absent' }
  | { readonly state: 'withheld'; readonly reason: CatalogAssetWithheldReason }
  | {
      readonly state: 'displayable';
      readonly text: string;
      readonly rightsBasis: CatalogAssetRightsBasis;
      readonly provenance?: CatalogAssetProvenance;
    };

/* -------------------------------------------------------------------------- */
/*  Relationships as a page renders them                                       */
/* -------------------------------------------------------------------------- */

/**
 * One verified channel, as a brand page lists it.
 *
 * A SEPARATE type from #55's `PublicCommerceRelationship` rather than a reuse,
 * for the reason #55 gave its own projection a separate type: this one carries
 * the merchant's NAME and slug so a page can render a link, and #55's carries
 * neither. Widening #55's DTO to hold them would put display material into the
 * verdict a product page reads.
 */
export interface BrandChannelEntry {
  readonly relationshipId: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantSlug: string;
  readonly badge: PublicRelationshipBadge;
  readonly evidence: CatalogPageOfficialEvidence;
  /**
   * The markets this claim is scoped to. EMPTY means unrestricted — the
   * `commerce_relationships.territories` semantics, not "no markets" — and a
   * page must say "worldwide" for one and name the countries for the other.
   * #72 official-channel rule 4: a claim covering one market gets no global
   * badge.
   */
  readonly territories: readonly string[];
  readonly validFrom: string;
  readonly validTo?: string;
  /** The storefront the claim is scoped to, when it names one. */
  readonly storefrontId?: string;
}

/**
 * A brand's channels, in two SEPARATE lists (#55 product behaviour 3, #72
 * official-channel rule 2).
 *
 * Never one list with a discriminant field: "Apple Store" and "an authorized
 * Apple reseller" are different claims about different commercial arrangements,
 * and a single list sorted by badge is one CSS change away from erasing the
 * difference.
 */
export interface BrandOfficialChannels {
  /** The market the lists were resolved FOR. `null` means "any scope". */
  readonly market: string | null;
  readonly officialStores: readonly BrandChannelEntry[];
  readonly authorizedResellers: readonly BrandChannelEntry[];
}

/**
 * The organization a brand belongs to — present ONLY when a verified
 * `organization_owns_brand` relationship covers the instant asked about
 * (#72 brand rule 2).
 *
 * Absence is the normal state and is not an error: most brands in a catalogue
 * have no verified owner recorded, and printing a legal entity from a name
 * match is exactly the inference #55 exists to prevent.
 */
export interface BrandOwningOrganization {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly relationshipId: string;
  readonly evidence: CatalogPageOfficialEvidence;
  readonly validFrom: string;
  readonly validTo?: string;
}

/* -------------------------------------------------------------------------- */
/*  Product cards and the browse                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether the page's offer half was computed at all.
 *
 * `withdrawn` is #60's `CANONICAL_OFFER_COMPARISON` lever being off: the
 * identity half of a brand page keeps serving (that lever's own doc names the
 * brand page as the thing it must not take down), and every card arrives with
 * no summary. Without this field that is indistinguishable from a brand nobody
 * currently sells, which is the difference between an incident and an empty
 * catalogue.
 */
export const CATALOG_OFFER_CONTEXT_STATES = ['included', 'withdrawn'] as const;

/** One of {@link CATALOG_OFFER_CONTEXT_STATES}. */
export type CatalogOfferContextState = (typeof CATALOG_OFFER_CONTEXT_STATES)[number];

/**
 * What a price summary on a card or a page is ABOUT (#72 product-browse rule 3).
 *
 * A price range spanning a boxed new unit and a scratched used one is not a
 * range anybody can act on, so every summary states its condition coverage
 * rather than leaving a reader to assume. `mixed` is honest and is not a
 * failure: a page showing both is fine as long as it SAYS so.
 */
export const CATALOG_PRICE_CONDITION_SCOPES = ['new', 'used', 'mixed', 'unknown'] as const;

/** One of {@link CATALOG_PRICE_CONDITION_SCOPES}. */
export type CatalogPriceConditionScope = (typeof CATALOG_PRICE_CONDITION_SCOPES)[number];

/**
 * The offer facts one product card carries.
 *
 * Composed from #68's {@link ProductOfferSummary} rather than re-derived, so a
 * card on a brand page, a card on a search page and the product's own page
 * cannot disagree about how many current offers there are or what the cheapest
 * one costs.
 */
export interface CatalogProductCardOffers {
  readonly summary: ProductOfferSummary;
  readonly conditionScope: CatalogPriceConditionScope;
  readonly conditionGroups: readonly ConditionGroup[];
}

/**
 * One product, as a grid renders it.
 *
 * `rating` is the canonical PRODUCT's (#56 product rule 11, #76's product
 * aggregate projected onto the entity) and is absent when nothing has been
 * rated — never zero, which a star row would draw as one empty star and a
 * reader would take for a bad product.
 */
export interface CatalogProductCard {
  readonly canonicalProductId: string;
  readonly slug: string;
  readonly name: string;
  readonly brandId?: string;
  readonly familyId?: string;
  readonly categoryId?: string;
  readonly image?: CatalogPageAsset;
  /** Release facts, present only when RELIABLY known (#56 never infers one). */
  readonly releasedAt?: string;
  readonly modelYear?: number;
  readonly rating?: { readonly value: number; readonly count: number };
  /**
   * ABSENT when this product has no current eligible offer, and also absent for
   * every card when the page reports `withdrawn` — see
   * {@link CatalogOfferContextState} for why the page-level state is what makes
   * the two distinguishable.
   */
  readonly offers?: CatalogProductCardOffers;
}

/**
 * How a browse is ordered (#72 family rule 6).
 *
 * `catalog_name` is the default and never implies a chronology. `release_desc`
 * is offered ONLY where every live product in the scope carries a release date,
 * because a mixed set ordered by release puts the undated ones in a position
 * that reads as a claim about when they came out — which is precisely what "does
 * not imply a chronology when release data is unknown" forbids.
 */
export const CATALOG_BROWSE_ORDERINGS = ['catalog_name', 'release_desc'] as const;

/** One of {@link CATALOG_BROWSE_ORDERINGS}. */
export type CatalogBrowseOrdering = (typeof CATALOG_BROWSE_ORDERINGS)[number];

/** The filters a brand or family browse accepts (#72 product-browse rule 5). */
export interface CatalogBrowseFilters {
  readonly categorySlugs?: readonly string[];
  readonly familyIds?: readonly string[];
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly availability?: readonly OfferAvailability[];
  readonly market?: string;
  readonly attributes?: readonly CatalogBrowseAttributeFilter[];
}

/** One attribute constraint, over #94's registry. */
export interface CatalogBrowseAttributeFilter {
  readonly key: string;
  readonly value?: string;
  readonly minNumber?: number;
  readonly maxNumber?: number;
}

/**
 * A price range over the current eligible offers of a whole scope, in ONE named
 * currency (#72 family rule 4).
 *
 * The currency is NAMED rather than assumed because the offers behind it are in
 * whatever their retailers publish; a range whose two ends came from different
 * currencies would be a number with no meaning. Offers whose currency has no
 * rate are EXCLUDED and counted, the #70 `SearchFxContext` posture — an
 * unconvertible price cannot be shown to be the cheapest.
 */
export interface CatalogPriceRange {
  readonly currency: CurrencyCode;
  readonly lowest: OfferMoney;
  readonly highest: OfferMoney;
  readonly conditionScope: CatalogPriceConditionScope;
  /** How many products contributed a convertible price to this range. */
  readonly productCount: number;
  /** Currencies excluded because they could not be priced. Named, never silent. */
  readonly unconvertibleCurrencies: readonly string[];
  /**
   * The subset of {@link unconvertibleCurrencies} Mercaria does not model at all
   * — permanent until the code is added, where a missing rate is transient
   * (#450). A subset rather than a disjoint list, so a reader of the complete
   * list alone still names every exclusion.
   */
  readonly unmodelledCurrencies: readonly string[];
  readonly fxProvider: string;
  readonly fxAsOf: string;
}

/** One page of a brand or family browse (#72 product-browse rules 1, 2 and 6). */
export interface CatalogProductBrowsePage {
  readonly products: readonly CatalogProductCard[];
  readonly ordering: CatalogBrowseOrdering;
  readonly offerContext: CatalogOfferContextState;
  /**
   * The keyset cursor for the NEXT page, absent at the end.
   *
   * Bound to the scope and the ordering it was minted under: a cursor from a
   * brand browse is unreadable on a family browse, and one minted under
   * `catalog_name` is unreadable under `release_desc` — the #70 rule, because a
   * cursor misapplied to another ordering silently skips or repeats rows rather
   * than failing.
   */
  readonly nextCursor?: string;
  /**
   * How many products this page CONSIDERED before the offer-side filters
   * dropped any. A page may return fewer than the requested limit; the cursor
   * is unaffected (the #70 rule — the cursor carries the last candidate
   * considered, not the last served).
   */
  readonly consideredCount: number;
  readonly filters: CatalogBrowseFilters;
}

/* -------------------------------------------------------------------------- */
/*  Navigation, redirects, SEO                                                 */
/* -------------------------------------------------------------------------- */

/** Why a request for one identity was answered by another (#72 brand rule 9). */
export const CATALOG_PAGE_REDIRECT_REASONS = ['merged', 'alias', 'slug'] as const;

/** One of {@link CATALOG_PAGE_REDIRECT_REASONS}. */
export type CatalogPageRedirectReason = (typeof CATALOG_PAGE_REDIRECT_REASONS)[number];

/**
 * The redirect a page reports when the handle asked for is not the canonical
 * one.
 *
 * Reported IN the 200 rather than as an HTTP 301, because the API serves an app
 * that owns its own URL bar: the client rewrites its address and renders the
 * page it already has, and a redirect status would cost a second round trip on
 * every stale link. `from` is what was asked for so a client can tell the
 * difference between "you followed an old link" and "you typed the slug".
 */
export interface CatalogPageRedirect {
  readonly from: string;
  readonly reason: CatalogPageRedirectReason;
}

/** One breadcrumb hop (#72 SEO rule 3). */
export interface CatalogBreadcrumb {
  readonly kind: 'category' | 'brand' | 'product_family';
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Whether this page may be indexed, and why not when it may not
 * (#72 SEO rules 2 and 5).
 *
 * A verdict rather than a boolean, because a page can be un-indexable for
 * reasons a client should render differently: a THIN page is one Mercaria
 * simply knows little about, while `no_index_right` is a source's contractual
 * refusal (#62's `index` right) and `merged` is a tombstone that should point
 * somewhere else entirely.
 *
 * #75 owns the SITEMAP and this domain does not build one — it publishes the
 * verdict a sitemap builder needs and nothing more.
 */
export const CATALOG_PAGE_INDEXABILITY = [
  'indexable',
  'thin',
  'no_index_right',
  'merged',
] as const;

/** One of {@link CATALOG_PAGE_INDEXABILITY}. */
export type CatalogPageIndexability = (typeof CATALOG_PAGE_INDEXABILITY)[number];

/**
 * Structured data, emitted ONLY when visible facts support it (#72 SEO rule 2).
 *
 * A discriminated union whose `none` branch has no payload, so "we have nothing
 * to assert" cannot be rendered as an empty `Brand` object — which is what a
 * nullable payload field would have allowed. The `organization` branch is
 * reachable only from a verified ownership relationship, so the JSON-LD cannot
 * assert a legal entity the page itself does not show.
 */
export type CatalogStructuredData =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'brand';
      readonly name: string;
      readonly url: string;
      readonly logoFileId?: string;
      readonly description?: string;
      readonly sameAs?: readonly string[];
    }
  | {
      readonly kind: 'organization';
      readonly name: string;
      readonly url: string;
      readonly brandName: string;
      readonly logoFileId?: string;
    };

/* -------------------------------------------------------------------------- */
/*  The pages themselves                                                       */
/* -------------------------------------------------------------------------- */

/** One family, as the brand page lists it. */
export interface BrandFamilyEntry {
  readonly familyId: string;
  readonly slug: string;
  readonly name: string;
  readonly productCount: number;
}

/** One category the brand's catalogue actually reaches (#72 brand rule 5). */
export interface BrandCategoryEntry {
  readonly categoryId: string;
  readonly slug: string;
  readonly name: string;
  /** How many of the brand's live products sit in it. */
  readonly productCount: number;
}

/**
 * The brand page (#72 brand rules 1–10).
 *
 * It carries no channel of its own, no listing, no inventory and no seller of
 * record — see this file's header for why that absence is the contract rather
 * than an omission.
 */
export interface BrandPage {
  readonly brandId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: CatalogPageText;
  readonly logo: CatalogPageAsset;
  readonly websiteUrl?: string;
  /** Other names this brand is known by — display forms, never the lookups. */
  readonly aliases: readonly string[];
  readonly owningOrganization?: BrandOwningOrganization;
  readonly channels: BrandOfficialChannels;
  readonly families: readonly BrandFamilyEntry[];
  readonly categories: readonly BrandCategoryEntry[];
  readonly productCount: number;
  readonly breadcrumbs: readonly CatalogBreadcrumb[];
  readonly indexability: CatalogPageIndexability;
  readonly structuredData: CatalogStructuredData;
  readonly canonicalPath: string;
  readonly redirect?: CatalogPageRedirect;
}

/**
 * The product-family page (#72 family rules 1–7).
 *
 * A family page is served only where the canonical model marks the family
 * public and useful (family rule "use a family page only when…"), which
 * {@link ProductFamilyPage.publishable} states rather than hides: a family with
 * one product is a page that says nothing a product page does not, and serving
 * it would be the thin page #75's sitemap must exclude.
 */
export interface ProductFamilyPage {
  readonly familyId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: CatalogPageText;
  readonly brand?: { readonly brandId: string; readonly slug: string; readonly name: string };
  readonly categoryId?: string;
  readonly productCount: number;
  /**
   * Whether this family earns a page of its own. A family below the threshold
   * still ANSWERS — its identity is real and an old link must resolve — and
   * carries `indexability: 'thin'` so nothing puts it in a sitemap.
   */
  readonly publishable: boolean;
  /** Attributes every live product in the family shares, with their values. */
  readonly sharedAttributes: readonly CatalogFamilySharedAttribute[];
  readonly priceRange?: CatalogPriceRange;
  readonly offerContext: CatalogOfferContextState;
  readonly breadcrumbs: readonly CatalogBreadcrumb[];
  readonly indexability: CatalogPageIndexability;
  readonly canonicalPath: string;
  readonly redirect?: CatalogPageRedirect;
}

/**
 * One attribute every live product of a family agrees on (#72 family rule 3).
 *
 * "Shared" means UNANIMOUS, not "common": an attribute two of five products
 * carry is a difference between the generations, and putting it in a family
 * header would state it of the other three. A family whose products disagree on
 * a key simply does not list that key.
 */
export interface CatalogFamilySharedAttribute {
  readonly key: string;
  readonly value: string;
}

/* -------------------------------------------------------------------------- */
/*  Corrections                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The fields a reader may DISPUTE on a catalogue page (#72 identity rule 2).
 *
 * A closed set and no free text at all. A correction says WHICH published fact
 * is wrong and reaches #59's review queue; it does not carry a sentence,
 * because an unmoderated free-text channel into an operator surface is a
 * content-moderation problem this domain has no way to solve and CrowdSource
 * already owns for the surfaces that need one.
 *
 * Submitting one confers NOTHING — no edit, no standing, no priority — which is
 * #72 identity rule 1 made structural: there is no write path from this domain
 * to a brand, a family or a canonical product at all, and a gate fails the
 * build if one appears.
 */
export const CATALOG_CORRECTION_FIELDS = [
  'name',
  'description',
  'logo',
  'website',
  'owning_organization',
  'family_membership',
  'category',
  'official_channel',
] as const;

/** One of {@link CATALOG_CORRECTION_FIELDS}. */
export type CatalogCorrectionField = (typeof CATALOG_CORRECTION_FIELDS)[number];

/** What a correction may be filed against. */
export const CATALOG_CORRECTION_SUBJECTS = ['brand', 'product_family'] as const;

/** One of {@link CATALOG_CORRECTION_SUBJECTS}. */
export type CatalogCorrectionSubject = (typeof CATALOG_CORRECTION_SUBJECTS)[number];

/**
 * What a submitter is told back.
 *
 * `reviewItemId` is #59's queue item — the same row a detector raises, so a
 * public correction and a machine detection converge on ONE piece of work
 * rather than two. `converged` says the dispute was already open, which is the
 * honest answer to a second submission and is not an error.
 */
export interface CatalogCorrectionReceipt {
  readonly reviewItemId: string;
  readonly converged: boolean;
}
