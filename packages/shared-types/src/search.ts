/**
 * Canonical multi-entity product discovery (#70, ADR 0002 D21/D24).
 *
 * The wire contract for a search that answers with CANONICAL ENTITIES — one
 * product, one brand, one family, one merchant, one storefront — rather than
 * with the listings that happen to carry them. Twenty sellers of one phone are
 * one result here, which is #70 acceptance 1, and it is the reason the result
 * union names no listing kind at all: a listing reaches this surface only as
 * OFFER context attached to the canonical entity it was matched to.
 *
 * ## The three things this file makes structurally impossible
 *
 * 1. **A commercial payment cannot influence organic relevance.**
 *    {@link SEARCH_RELEVANCE_SIGNALS} and
 *    {@link SEARCH_FORBIDDEN_RELEVANCE_SIGNALS} are DISJOINT unions — the
 *    `RetailCostComponentKind` device — so an affiliate commission, a
 *    marketplace fee, a referral reward, a Pro plan, FAIR acceptance, a retail
 *    cost variance and a sponsored payment have no name a scorer could read.
 *    The backend pairs that with a scanned isolation gate over the whole
 *    discovery path, because a vocabulary alone does not stop an import.
 * 2. **A variant match cannot become a second row for one product.** There is
 *    no `variant` result kind; variant-level intent surfaces as
 *    {@link SearchProductResult.matchedVariant} on the product it configures.
 * 3. **A stale price cannot present as a current one.** Every price a result
 *    carries arrives inside {@link ProductOfferSummary}, which the backend
 *    derives through #68's freshness assessment; a product whose offers have
 *    all expired reports the summary as ABSENT rather than as a price of zero.
 *
 * ## Money is never compared across currencies without saying so
 *
 * {@link SearchPriceFilter} names its own currency, and a response that had to
 * convert to answer it carries the {@link SearchFxContext} it converted with.
 * An offer whose currency has no rate to the filter's is EXCLUDED — an unknown
 * price cannot satisfy a bound (`~/AGENTS.md`: unknown is never zero).
 */

import type { ConditionGroup } from './condition';
import type { OfferAvailability, OfferKind, OfferMoney } from './offer';
import type { ProductOfferSummary } from './offer-freshness';

/* -------------------------------------------------------------------------- */
/*  What a result IS                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The entity kinds a search result may be (#70 "Result model").
 *
 * `canonical_variant` is deliberately NOT here. #70 lists it as a search ENTITY
 * (a query naming a storage size or a colour must find the right thing) and not
 * as a result kind, and the two are different questions: a variant is retrieved
 * and scored, and then reported as the matched configuration of its PRODUCT.
 * Giving it its own kind would put forty rows of one phone on one page, which
 * is precisely the duplication acceptance 1 exists to remove.
 */
export const SEARCH_RESULT_KINDS = [
  'product',
  'brand',
  'product_family',
  'merchant',
  'storefront',
] as const;

/** One of {@link SEARCH_RESULT_KINDS}. */
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

/**
 * How a candidate ENTERED the result set.
 *
 * Reported per result because it is the only thing that makes a ranking
 * explicable without exposing a score nobody can interpret: "we found this
 * because its barcode is exactly what you typed" and "we found this because its
 * name looks a bit like what you typed" are different claims, and a shopper
 * (and an operator reading a trace) can act on the difference.
 *
 * The order of this tuple is the order of DETERMINISM, strongest first, and
 * `relevance.ts` reads it as such — so adding a stage in the middle changes the
 * ranking, which is the intended amount of friction.
 */
export const SEARCH_MATCH_STAGES = [
  /** An exact, check-digit-validated product identifier (GTIN/EAN/UPC/ISBN/MPN). */
  'identifier',
  /** The entity's own normalized name, matched exactly. */
  'exact_name',
  /** A normalized alias or historical name, matched exactly. */
  'exact_alias',
  /** A normalized-name prefix — what a partially typed query finds. */
  'prefix',
  /** PostgreSQL full-text search over the entity's `tsvector`. */
  'lexical',
  /** A discriminating token (a model code) contained in the entity's token set. */
  'token',
  /** `pg_trgm` similarity — the typo-tolerant last resort. */
  'fuzzy',
] as const;

/** One of {@link SEARCH_MATCH_STAGES}. */
export type SearchMatchStage = (typeof SEARCH_MATCH_STAGES)[number];

/* -------------------------------------------------------------------------- */
/*  Relevance: what may count, and what may never                              */
/* -------------------------------------------------------------------------- */

/**
 * The deterministic signals entity relevance is a weighted combination of
 * (#70 "Ranking boundaries" 1–5).
 *
 * Every member is a property of the QUERY against the ENTITY. None of them is
 * a property of a seller, a payment, a plan or a rail — see
 * {@link SEARCH_FORBIDDEN_RELEVANCE_SIGNALS}, which is disjoint from this tuple
 * by a test.
 *
 * #70's boundary 5 admits "product popularity/quality signals only when
 * explicitly defined and resistant to manipulation", and this tuple has NO
 * popularity member: a member here would be a promise the backend does not
 * keep, since nothing in this issue defines a manipulation-resistant popularity
 * measure. #77 measures popularity and its own isolation gate forbids a
 * discovery module reading a rollup, so adding one is a decision with a
 * mechanism to change, not an omission to fill in quietly.
 */
export const SEARCH_RELEVANCE_SIGNALS = [
  /** A validated identifier resolved to exactly this entity. */
  'identifier_exact',
  /** The query's normalization equals the entity's normalized name. */
  'name_exact',
  /** The query contains the entity's own model code. */
  'model_exact',
  /** The query's normalization equals one of the entity's aliases. */
  'alias_exact',
  /** WHICH kind of alias matched — a former name outranks a marketing variant. */
  'alias_quality',
  /** `ts_rank` of the entity's search vector against the parsed query. */
  'lexical_rank',
  /** How many of the query's discriminating tokens the entity carries. */
  'token_overlap',
  /** `pg_trgm` similarity between the query and the entity's normalized name. */
  'trigram_similarity',
  /** How many of the request's structured filters the entity satisfies. */
  'filter_agreement',
] as const;

/** One of {@link SEARCH_RELEVANCE_SIGNALS}. */
export type SearchRelevanceSignal = (typeof SEARCH_RELEVANCE_SIGNALS)[number];

/**
 * Signals that may NEVER influence organic entity relevance (#70 "Ranking
 * boundaries", the second list).
 *
 * Stated as VALUES rather than as prose, and DISJOINT from
 * {@link SEARCH_RELEVANCE_SIGNALS} by a test, so a future signal that reads
 * like a plausible ranking input fails the build instead of being added. The
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` / `REVIEW_FORBIDDEN_EVIDENCE_SOURCES`
 * device, applied to ranking.
 *
 * The last member carries #70's own caveat: a sponsored placement is not
 * forbidden forever, it is forbidden HERE. If Mercaria ever sells placement it
 * gets a separately labelled surface with its own contract, and organic
 * relevance still cannot read it.
 */
export const SEARCH_FORBIDDEN_RELEVANCE_SIGNALS = [
  'affiliate_commission',
  'marketplace_fee',
  'referral_reward',
  'merchant_pro_plan',
  'fair_acceptance',
  'retail_cost_variance',
  'sponsored_payment',
] as const;

/** One of {@link SEARCH_FORBIDDEN_RELEVANCE_SIGNALS}. */
export type SearchForbiddenRelevanceSignal =
  (typeof SEARCH_FORBIDDEN_RELEVANCE_SIGNALS)[number];

/**
 * The version of the relevance policy in force.
 *
 * A code CONSTANT and deliberately not a table — the
 * `CATALOG_BACKFILL_MAPPING_VERSION` reasoning: the policy is a procedure, and
 * a table would let somebody publish a version whose weights nobody shipped.
 * It travels on every analytics event as `searchPolicyVersion`, so a ranking
 * change is separable from a seasonal demand change in the metrics.
 */
export const SEARCH_RELEVANCE_POLICY_VERSION = 'sr-1';

/* -------------------------------------------------------------------------- */
/*  Filters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A price bound, in ONE named currency (#70 filter 3).
 *
 * The currency is REQUIRED. A bound with no currency is not a weaker filter, it
 * is an incoherent one — 1,199 of something is not comparable with 4,500 of
 * something else — and #70's "never compare raw money amounts across currencies
 * without conversion context" is enforced by there being nowhere to put an
 * amount that does not name its unit.
 */
export interface SearchPriceFilter {
  /** The currency both bounds are expressed in. */
  readonly currency: string;
  /** Inclusive lower bound, in `currency`'s minor units. */
  readonly minMinor?: number;
  /** Inclusive upper bound, in `currency`'s minor units. */
  readonly maxMinor?: number;
}

/**
 * One attribute constraint from #94's registry (#70 filter 9).
 *
 * Exactly one of `value` / (`minNumber`, `maxNumber`) is meaningful; the
 * backend refuses a request carrying both rather than picking. Only SELECTED
 * values are matched — a `conflicting` value is two sources disagreeing, and
 * filtering on one of them would answer with whichever source happened to be
 * written first.
 */
export interface SearchAttributeFilter {
  /** The registry key — `storage`, `screen_size`. */
  readonly key: string;
  /** Exact normalized text match. */
  readonly value?: string;
  /** Inclusive numeric lower bound, in the attribute's base unit. */
  readonly minNumber?: number;
  /** Inclusive numeric upper bound, in the attribute's base unit. */
  readonly maxNumber?: number;
}

/**
 * The structured filters a search may carry (#70 "Filters").
 *
 * Two of #70's ten are deliberately ABSENT rather than accepted and ignored:
 *
 * - **Nearby / pickup (#70 filter 10)** has no field, because #93 supplies no
 *   collectable-inventory or publication state to filter on and a parameter
 *   that silently changed nothing would read as a working feature. The native
 *   listing search keeps its own `near` filter, which is a fact about a LISTING
 *   and not about a canonical product.
 * - **A free-form seller NAME** has no field either; `merchantIds` names
 *   merchants by id, resolved from a merchant result or a merchant page. A name
 *   filter would be a second, weaker spelling of the merchant search that is
 *   already a result kind here.
 */
export interface SearchFilters {
  /** Category slugs. A product matches if its category is any of them. */
  readonly categorySlugs?: readonly string[];
  /** Brand ids. */
  readonly brandIds?: readonly string[];
  /** The market a result's offers must be published for, ISO 3166-1 alpha-2. */
  readonly market?: string;
  readonly price?: SearchPriceFilter;
  /** Whole condition SEGMENTS (#90) — never a raw condition key. */
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly availability?: readonly OfferAvailability[];
  /** Native Mercaria versus external (#70 filter 6). */
  readonly offerKinds?: readonly OfferKind[];
  /**
   * Only products with a current offer from an OFFICIAL or AUTHORIZED channel
   * for their own brand (#70 filter 7), read live from #55's temporal
   * relationships — so a lapsed authorization stops qualifying with no sweep
   * having run.
   */
  readonly officialChannelOnly?: boolean;
  /** Merchant ids (#70 filter 8). */
  readonly merchantIds?: readonly string[];
  readonly attributes?: readonly SearchAttributeFilter[];
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                    */
/* -------------------------------------------------------------------------- */

/** A canonical entity reference, as a result carries its neighbours. */
export interface SearchEntityRef {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** Representative media for a result — the canonical image, never a seller's. */
export interface SearchImageRef {
  /** An Oxy media file id, when Mercaria holds the asset. */
  readonly fileId?: string;
  /** The image's address at its source, when Mercaria holds no copy. */
  readonly sourceUrl?: string;
  readonly alt?: string;
}

/** The exact configuration a variant-level query matched. */
export interface SearchMatchedVariant {
  readonly canonicalVariantId: string;
  readonly name?: string;
  /** The order-independent option digest — how a caller re-finds this exact one. */
  readonly signature: string;
}

/**
 * The ONE offer a product result leads with, when #74's selector supplies one.
 *
 * ABSENT until a ranking selector is registered, and that absence is the point:
 * choosing among a product's offers is #74's decision, and a search that picked
 * "the cheapest" itself would be a second, quieter answer to the question #74
 * exists to answer once. The lowest price is still reported — inside
 * {@link ProductOfferSummary}, where it is a FACT about the offers rather than a
 * recommendation about which to buy.
 */
export interface SearchSelectedOffer {
  readonly offerId: string;
  readonly kind: OfferKind;
  readonly price?: OfferMoney;
  readonly availability: OfferAvailability;
  readonly merchantId?: string;
  /** The policy version #74's selector ran under, for the analytics envelope. */
  readonly rankingPolicyVersion: string;
}

/** Fields every result kind carries. */
interface SearchResultBase {
  /** Which deterministic stages found this entity. Never empty. */
  readonly matchStages: readonly SearchMatchStage[];
  /**
   * The composite relevance score, 0–1.
   *
   * Published because a client sorting a merged list (or an operator reading a
   * trace) needs the value the server ordered on. It is NOT a quality rating
   * and carries no meaning across two different queries.
   */
  readonly relevance: number;
}

/** A canonical PRODUCT — the result kind a shopping query usually wants. */
export interface SearchProductResult extends SearchResultBase {
  readonly kind: 'product';
  readonly canonicalProductId: string;
  readonly slug: string;
  readonly name: string;
  readonly brand?: SearchEntityRef;
  readonly family?: SearchEntityRef;
  readonly categoryId?: string;
  readonly image?: SearchImageRef;
  readonly matchedVariant?: SearchMatchedVariant;
  /**
   * The freshness-obeying availability and lowest-price summary (#68).
   *
   * ABSENT when the product has no CURRENT eligible offer at all — which is
   * #70 freshness rules 1 and 3 together: a canonical product with no offer is
   * still a useful answer, and it must not carry a price that would read as one
   * somebody could pay.
   */
  readonly offerSummary?: ProductOfferSummary;
  /** #74's chosen offer. Absent while no selector is registered — see the type. */
  readonly selectedOffer?: SearchSelectedOffer;
  /** New/used context — the segments the current offers actually cover. */
  readonly conditionGroups: readonly ConditionGroup[];
}

/**
 * A BRAND.
 *
 * It deliberately names no owning ORGANIZATION. `brands` has no
 * `organization_id` column: who owns a brand is an evidence-gated
 * `commerce_relationships` claim (#55 D11), temporal and revocable, and
 * publishing it from a search result would be publishing a badge this surface
 * did not verify. A brand page resolves it through the relationship layer,
 * where the validity window is evaluated live.
 */
export interface SearchBrandResult extends SearchResultBase {
  readonly kind: 'brand';
  readonly brandId: string;
  readonly slug: string;
  readonly name: string;
}

/** A product FAMILY — a brand's product line. */
export interface SearchProductFamilyResult extends SearchResultBase {
  readonly kind: 'product_family';
  readonly productFamilyId: string;
  readonly slug: string;
  readonly name: string;
  readonly brand?: SearchEntityRef;
  /** The rollup the write chokepoint maintains; nothing decides on it. */
  readonly productCount: number;
}

/** A canonical MERCHANT — a seller of record across every channel it operates. */
export interface SearchMerchantResult extends SearchResultBase {
  readonly kind: 'merchant';
  readonly merchantId: string;
  readonly slug: string;
  readonly name: string;
  /**
   * ADR 0002 D9's ONE stored verdict, republished verbatim.
   *
   * Present because "is this the real shop" is the first question a merchant
   * result raises, and re-deriving it here would be a second answer to what
   * `merchants.claim_state` already answers.
   */
  readonly claimState: string;
}

/** A STOREFRONT — one channel a merchant sells through. */
export interface SearchStorefrontResult extends SearchResultBase {
  readonly kind: 'storefront';
  readonly storefrontId: string;
  readonly slug: string;
  readonly name: string;
  readonly merchant: SearchEntityRef;
  readonly channelKind: string;
  readonly domain?: string;
  /** #54's stored verification verdict for the operator's control of the channel. */
  readonly verificationState: string;
}

/** One row of a search page. */
export type SearchResult =
  | SearchProductResult
  | SearchBrandResult
  | SearchProductFamilyResult
  | SearchMerchantResult
  | SearchStorefrontResult;

/* -------------------------------------------------------------------------- */
/*  The response                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The conversion a price filter or a cross-currency comparison ran under
 * (#70 filter 3's "explicit FX behavior").
 *
 * Present exactly when the request carried a {@link SearchPriceFilter} AND at
 * least one candidate offer was priced in another currency. Its absence
 * therefore means no conversion happened, which is a stronger statement than an
 * empty rate map.
 */
export interface SearchFxContext {
  /** The currency the filter was expressed in — every rate is INTO this one. */
  readonly currency: string;
  /** The FX provider id whose rates were used. */
  readonly provider: string;
  /** When the rates were published, ISO-8601. */
  readonly asOf: string;
  /** Currencies that had no rate, and whose offers were therefore EXCLUDED. */
  readonly unconvertibleCurrencies: readonly string[];
}

/** What the server actually applied, echoed so a client never has to guess. */
export interface SearchAppliedQuery {
  /**
   * The normalized form of the term the server searched on.
   *
   * The RAW term is never echoed: #77 redacts query text before storing it, and
   * a response that reflected the original back would be a second copy of it in
   * every intermediary's logs.
   */
  readonly normalized: string;
  /** The tokens the normalizer kept. */
  readonly tokens: readonly string[];
  /**
   * The identifiers the query was read as, if any — `gtin:05012345678900`.
   *
   * Present so a shopper who pasted a barcode can see it was understood as one,
   * which is the difference between "no results" and "we searched for that as
   * words".
   */
  readonly identifiers: readonly string[];
  readonly filters: SearchFilters;
  readonly kinds: readonly SearchResultKind[];
}

/** One page of search results. */
export interface SearchResponse {
  readonly results: readonly SearchResult[];
  /** Opaque. Absent when there is no next page, or when {@link truncated}. */
  readonly nextCursor?: string;
  /**
   * Whether the retrieval DEPTH cap stopped this page short of the true tail.
   *
   * Candidate generation is bounded per stage, and paging deeper widens that
   * bound up to a ceiling. Past the ceiling the surface says so instead of
   * quietly serving a shorter tail — the difference between "there is no more"
   * and "we stopped looking" is exactly what a silent truncation destroys.
   */
  readonly truncated: boolean;
  readonly applied: SearchAppliedQuery;
  /** The relevance policy the ordering was produced under. */
  readonly policyVersion: string;
  readonly fx?: SearchFxContext;
  /**
   * #77's correlation handle, to echo on the impression and click events that
   * follow. Absent when analytics collection is off — so a client has nothing
   * to send and no branch to write.
   */
  readonly queryEventId?: string;
}
