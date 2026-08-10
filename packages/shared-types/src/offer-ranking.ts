/**
 * Transparent offer eligibility, ranking and comparison labels — issue #74,
 * over #44's money, #55's verified relationships, #57's offer model and #68's
 * freshness.
 *
 * ## The separation this file exists to make structural
 *
 * ELIGIBILITY decides whether an offer may appear at all; RANKING scores only
 * the set eligibility admitted. They are two vocabularies, two verdict types and
 * two modules, because a collapsed version has one specific failure: a weight
 * changed to make something rank better also makes an expired, restricted or
 * suppressed offer VISIBLE. Here a weight has nowhere to reach — the scoring
 * input type ({@link OfferRankingFacts}) carries no eligibility fact and the
 * ranker's candidate type ({@link EligibleOffer}) can only be produced by the
 * eligibility derivation, which records which of {@link OFFER_ELIGIBILITY_RULES}
 * it evaluated.
 *
 * ## Unknown is never zero, and the type is what says so
 *
 * #57's `deriveOfferDelivery` returns a union whose unknown branch has no `cost`
 * property. This file extends that shape all the way to the label:
 *
 *  - {@link OfferComparisonPrice} and {@link OfferComparisonTotal} have no
 *    `amount` on their unknown branch, so no arithmetic can read silence as
 *    zero without writing the coercion out loud.
 *  - {@link RankingSignalOutcome}'s `unknown` branch has no `normalized` and no
 *    `weight`, so an unknown signal cannot enter a weighted sum at all — which
 *    is how "an unknown is left out of the DENOMINATOR" (#58's rule) is held by
 *    the type rather than by whoever writes the loop.
 *  - `cheapest_known_total` is awarded by a function whose parameter type
 *    REQUIRES a known total, so an offer with unknown shipping has no shape that
 *    could be passed to it (issue acceptance 2).
 *
 * ## What may never be a ranking input
 *
 * {@link OFFER_RANKING_SIGNALS} and {@link OFFER_FORBIDDEN_RANKING_SIGNALS} are
 * DISJOINT unions — the `RetailCostComponentKind` device — and
 * {@link OfferRankingFacts} has no member for any forbidden one, so a
 * commission rate, a plan, a FAIR acceptance or a native preference has nowhere
 * to be read from. The published policy row has no column for one either. The
 * scanned half is `offer-ranking-isolation.test.ts`.
 */

import type { ConditionGroup, ItemConditionKey } from './condition';
import type { CurrencyCode, FxRateSnapshot, Money } from './money';
import type { OfferAvailability, OfferKind } from './offer';

/* ────────────────────────────────────────────────────────────────────────── */
/* Eligibility                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The ten questions eligibility asks, in the issue's own order.
 *
 * A TUPLE rather than a set of booleans, because the ranker asserts that a
 * candidate's admission evaluated EVERY one of them: adding a rule here without
 * evaluating it turns the ranker red rather than silently widening what may be
 * shown.
 *
 * Rules 7 and 9 are deliberately separate though both concern a native listing.
 * "The listing is not published" and "a jury restricted the listing" are
 * different facts about different systems with different remedies, and #57's
 * `NativeCheckoutBlockReason` already distinguishes them — collapsing them here
 * would lose the distinction at exactly the surface a seller reads.
 */
export type OfferEligibilityRule =
  /** 1 — the product, variant and offer row are all live. */
  | 'offer_active'
  /** 2 — the offer prices the canonical variant the comparison is about. */
  | 'canonical_variant_match'
  /** 3 — the observation is within the source's own freshness contract (#68). */
  | 'observation_freshness'
  /** 4 — the market and the customer class the source published. */
  | 'market_and_customer'
  /** 5 — availability consistent with the requested experience. */
  | 'availability_supported'
  /** 6 — the condition passes the filter the caller asked for. */
  | 'condition_filter'
  /** 7 — a native offer has a valid listing, variant, stock and payable seller. */
  | 'native_listing_valid'
  /** 8 — an external offer has somewhere to send a buyer. */
  | 'external_destination'
  /** 9 — no moderation restriction makes the native offer unavailable. */
  | 'moderation_restriction'
  /** 10 — no suppressed merchant, storefront or source. */
  | 'no_suppression';

export const OFFER_ELIGIBILITY_RULES: readonly OfferEligibilityRule[] = [
  'offer_active',
  'canonical_variant_match',
  'observation_freshness',
  'market_and_customer',
  'availability_supported',
  'condition_filter',
  'native_listing_valid',
  'external_destination',
  'moderation_restriction',
  'no_suppression',
];

/**
 * Why one offer is not eligible — machine-readable, renderable, and each one
 * naming the rule it came from ({@link OFFER_EXCLUSION_RULE}).
 *
 * Every member is a fact the derivation actually READ. There is deliberately no
 * `other`, no `policy` and no free-text member: a reason nobody can render is a
 * reason nobody can act on, and an open member is where the unrenderable ones
 * would accumulate.
 */
export type OfferExclusionReason =
  | 'offer_retired'
  | 'wrong_canonical_variant'
  | 'observation_expired'
  | 'observation_unavailable'
  | 'freshness_unknown'
  | 'market_not_served'
  | 'customer_not_eligible'
  | 'availability_unsupported'
  | 'condition_excluded'
  | 'listing_not_active'
  | 'listing_restricted'
  | 'variant_missing'
  | 'out_of_stock'
  | 'seller_not_payment_ready'
  | 'destination_missing'
  | 'merchant_suppressed'
  | 'storefront_suppressed'
  | 'source_display_withheld';

export const OFFER_EXCLUSION_REASONS: readonly OfferExclusionReason[] = [
  'offer_retired',
  'wrong_canonical_variant',
  'observation_expired',
  'observation_unavailable',
  'freshness_unknown',
  'market_not_served',
  'customer_not_eligible',
  'availability_unsupported',
  'condition_excluded',
  'listing_not_active',
  'listing_restricted',
  'variant_missing',
  'out_of_stock',
  'seller_not_payment_ready',
  'destination_missing',
  'merchant_suppressed',
  'storefront_suppressed',
  'source_display_withheld',
];

/**
 * Reason → the rule that produced it. Total by construction: a reason added to
 * the union without a rule is a compile error here, which is the point of a
 * `Record` over a function with a `default`.
 */
export const OFFER_EXCLUSION_RULE: Readonly<Record<OfferExclusionReason, OfferEligibilityRule>> = {
  offer_retired: 'offer_active',
  wrong_canonical_variant: 'canonical_variant_match',
  observation_expired: 'observation_freshness',
  observation_unavailable: 'observation_freshness',
  freshness_unknown: 'observation_freshness',
  market_not_served: 'market_and_customer',
  customer_not_eligible: 'market_and_customer',
  availability_unsupported: 'availability_supported',
  condition_excluded: 'condition_filter',
  listing_not_active: 'native_listing_valid',
  listing_restricted: 'moderation_restriction',
  variant_missing: 'native_listing_valid',
  out_of_stock: 'native_listing_valid',
  seller_not_payment_ready: 'native_listing_valid',
  destination_missing: 'external_destination',
  merchant_suppressed: 'no_suppression',
  storefront_suppressed: 'no_suppression',
  source_display_withheld: 'no_suppression',
};

/**
 * What the eligibility derivation evaluated, carried on every admitted offer.
 *
 * The ranker asserts `rulesEvaluated` covers {@link OFFER_ELIGIBILITY_RULES}
 * before it scores anything. That is a RUNTIME guarantee and it is stated as
 * one rather than dressed up as a type-level proof: TypeScript is structural, so
 * nothing stops a caller hand-writing this object. What it does buy is real —
 * a rule added to the tuple and not wired into the derivation fails loudly at
 * the first comparison instead of quietly admitting whatever it was meant to
 * exclude.
 */
export interface OfferAdmission {
  readonly rulesEvaluated: readonly OfferEligibilityRule[];
}

/**
 * An offer that passed every eligibility rule, with the facts ranking reads.
 *
 * This is the ONLY shape {@link OfferRankingInput} accepts, and the eligibility
 * derivation is the only thing that builds one. The offer's own DTO is carried
 * whole so a caller does not have to re-fetch it, and the ranking facts are
 * separate so the scorer's input surface stays exactly what it is allowed to
 * see.
 */
export interface EligibleOffer {
  readonly offerId: string;
  readonly kind: OfferKind;
  readonly admission: OfferAdmission;
  readonly facts: OfferRankingFacts;
}

/**
 * One offer's eligibility verdict.
 *
 * A discriminated union with no common `reasons` field, so a caller that wants
 * the reasons must first establish that there are some — the
 * `NativeCheckoutEligibility` shape, one domain over. Narrow it with
 * `if (!verdict.eligible)` or `verdict.eligible === true`: the backend compiles
 * without `strictNullChecks`, where a bare truthiness test on a boolean-literal
 * discriminant does not narrow.
 */
export type OfferEligibilityVerdict =
  | { readonly eligible: true; readonly admitted: EligibleOffer }
  | {
      readonly eligible: false;
      readonly offerId: string;
      /** Every reason that applies, in rule order. Never just the first. */
      readonly reasons: readonly OfferExclusionReason[];
      readonly admission: OfferAdmission;
    };

/** The outcome of assessing a whole page: what may be shown, and what may not. */
export interface OfferEligibilitySelection {
  readonly eligible: readonly EligibleOffer[];
  readonly excluded: readonly Extract<OfferEligibilityVerdict, { eligible: false }>[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Ranking signals — the allowed set, and the forbidden one                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The documented ranking inputs (issue §"Ranking inputs", 1–10).
 *
 * The issue's eleventh input — a user-selected preference — is deliberately NOT
 * a signal: it is an {@link OfferComparisonIntent}, which selects a documented
 * PRIMARY sort key rather than re-weighting anything. A preference expressed as
 * a weight would make one buyer's chosen ordering indistinguishable from a
 * policy change, and the two must be separately explainable.
 */
export type OfferRankingSignal =
  /** Item price, converted into the comparison currency with a captured quote. */
  | 'item_price'
  /** Delivery or pickup cost, when the source published one. */
  | 'delivery_cost'
  /** Whether the price includes tax, where that is comparable at all. */
  | 'tax_inclusion'
  /** The delivery estimate, when the source supplies one reliably. */
  | 'delivery_speed'
  /** The item condition (#90). */
  | 'condition'
  /** The merchant's rating (#76), read only above the policy's confidence floor. */
  | 'merchant_rating'
  /** Normalized return-policy facts. */
  | 'return_policy'
  /** How confident the availability statement is. */
  | 'availability_confidence'
  /** How recently the source confirmed these terms (#68). */
  | 'observation_freshness'
  /** A VERIFIED official-channel or authorized-reseller relationship (#55). */
  | 'verified_relationship'
  /** Distance to a pickup point, only when the viewer enabled location. */
  | 'pickup_proximity';

export const OFFER_RANKING_SIGNALS: readonly OfferRankingSignal[] = [
  'item_price',
  'delivery_cost',
  'tax_inclusion',
  'delivery_speed',
  'condition',
  'merchant_rating',
  'return_policy',
  'availability_confidence',
  'observation_freshness',
  'verified_relationship',
  'pickup_proximity',
];

/**
 * What may NEVER influence organic rank (issue §"Prohibited ranking inputs").
 *
 * Named as VALUES so the prohibition is a thing a test can check and a reviewer
 * can read, rather than an omission somebody quietly fills in. DISJOINT from
 * {@link OFFER_RANKING_SIGNALS} — asserted by `offer-ranking-isolation.test.ts`
 * — so widening the allowed set can never accidentally admit one, and there is
 * no column, weight or fact field for any of them anywhere in the domain.
 *
 * `native_offer_preference` is the subtle one and it is the reason the list
 * exists rather than the schema alone being trusted: `native_mercaria_checkout`
 * IS a label, because "you can buy this here" is information a shopper wants.
 * What it must never be is a term in the score. A property test pins it — a
 * native and an external candidate with identical facts score identically.
 */
export type ForbiddenRankingSignal =
  | 'affiliate_commission_rate'
  | 'commercial_agreement_margin'
  | 'marketplace_fee_rate'
  | 'retail_margin'
  | 'fair_acceptance'
  | 'merchant_subscription_plan'
  | 'native_offer_preference'
  | 'brand_popularity'
  | 'merchant_popularity'
  | 'sponsored_placement'
  | 'sensitive_personal_attribute';

export const OFFER_FORBIDDEN_RANKING_SIGNALS: readonly ForbiddenRankingSignal[] = [
  'affiliate_commission_rate',
  'commercial_agreement_margin',
  'marketplace_fee_rate',
  'retail_margin',
  'fair_acceptance',
  'merchant_subscription_plan',
  'native_offer_preference',
  'brand_popularity',
  'merchant_popularity',
  'sponsored_placement',
  'sensitive_personal_attribute',
];

/** Why a signal could not be scored. Never a soft yes, never a zero. */
export type RankingUnknownReason =
  /** The source published nothing for it. */
  | 'not_published'
  /** A price exists in a currency this comparison cannot convert from. */
  | 'not_convertible'
  /** A rating exists but below the policy's review-count floor. */
  | 'below_confidence_floor'
  /** The fact is supplied by a seam nothing has filled in yet. */
  | 'no_provider'
  /** The viewer supplied no location, so a distance cannot be computed. */
  | 'viewer_location_absent'
  /** Nothing in the comparison set carries the fact, so there is nothing to rank against. */
  | 'no_comparable_basis';

export const RANKING_UNKNOWN_REASONS: readonly RankingUnknownReason[] = [
  'not_published',
  'not_convertible',
  'below_confidence_floor',
  'no_provider',
  'viewer_location_absent',
  'no_comparable_basis',
];

/**
 * One signal's contribution, or its refusal to contribute.
 *
 * The `unknown` branch carries NO `normalized` and NO `weight`. That is the
 * whole mechanism behind "an unknown is left out of the denominator": summing
 * `outcome.weight` over the outcomes only type-checks after a narrowing to
 * `scored`, so nothing can average an unknown in as a zero by forgetting a
 * check.
 */
export type RankingSignalOutcome =
  | {
      readonly signal: OfferRankingSignal;
      readonly state: 'scored';
      /** 0–1, where 1 is the best value present in THIS comparison set. */
      readonly normalized: number;
      /** The policy's weight for this signal, echoed so an explanation is self-contained. */
      readonly weight: number;
      /** A short, value-bearing note — figures and units, never prose about a seller. */
      readonly detail: string;
    }
  | {
      readonly signal: OfferRankingSignal;
      readonly state: 'unknown';
      readonly reason: RankingUnknownReason;
      readonly detail: string;
    };

/* ────────────────────────────────────────────────────────────────────────── */
/* The facts a scorer may read                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/** Whether the published price includes tax, where the source says at all. */
export type OfferTaxInclusion = 'inclusive' | 'exclusive' | 'unknown';

export const OFFER_TAX_INCLUSIONS: readonly OfferTaxInclusion[] = [
  'inclusive',
  'exclusive',
  'unknown',
];

/** A verified relationship between the offer's merchant and the subject's brand (#55). */
export type OfferRelationshipStanding = 'official_channel' | 'authorized_reseller' | 'none';

export const OFFER_RELATIONSHIP_STANDINGS: readonly OfferRelationshipStanding[] = [
  'official_channel',
  'authorized_reseller',
  'none',
];

/**
 * Everything the scorer is allowed to know about one offer.
 *
 * The ABSENT fields are the enforcement, exactly as `analytics_events`' absent
 * columns are: there is no commission, no fee, no plan, no margin, no FAIR flag
 * and no popularity count here, so a scorer cannot read one whatever anybody
 * later wants it to do. A forbidden input would have to be ADDED to this type,
 * which is a visible act and a failing gate.
 *
 * Every optional fact is optional because it is genuinely absent sometimes, and
 * every consumer must handle that as `unknown` rather than as a default.
 */
export interface OfferRankingFacts {
  /** The offer's own price, converted into the comparison currency. */
  readonly itemPrice: OfferComparisonPrice;
  /** The delivery cost, converted. `known: false` when the source published none. */
  readonly deliveryCost: OfferComparisonPrice;
  /** Item plus delivery. Known ONLY when both halves are (issue acceptance 2). */
  readonly total: OfferComparisonTotal;
  readonly taxInclusion: OfferTaxInclusion;
  /** The slowest end of the quoted window, in days. Absent when unquoted. */
  readonly deliveryMaxDays?: number;
  readonly condition?: ItemConditionKey;
  readonly conditionGroup?: ConditionGroup;
  /** Mean over VERIFIED reviews (#76), 0–5. Absent when there is no aggregate. */
  readonly merchantRating?: number;
  /** How many verified reviews produced it — the confidence half. */
  readonly merchantReviewCount?: number;
  /** The stated return window in days, when the source publishes one. */
  readonly returnWindowDays?: number;
  readonly availability: OfferAvailability;
  /**
   * How far through its own lifetime the observation is, 0–1, where 0 is
   * just-confirmed. Absent for an offer with no bounded deadline — a native
   * offer's `stale_at` measures the converger, not the seller (#68).
   */
  readonly freshnessElapsedFraction?: number;
  /**
   * A VERIFIED relationship, or `none`. Absent when the question could not be
   * asked at all — the comparison subject resolves to no brand, so there is
   * nothing to be an official channel FOR.
   */
  readonly relationship?: OfferRelationshipStanding;
  /**
   * Metres to the nearest collection point. Absent whenever it is not known —
   * which is always today, because #93 publishes no collection points and the
   * seam that would supply them refuses rather than inventing a merchant's
   * registered address.
   */
  readonly pickupDistanceMetres?: number;
  /** Whether Mercaria can sell this offer itself — a LABEL input, never a score input. */
  readonly nativeCheckoutEligible: boolean;
}

/**
 * A money value in the comparison currency, or an honest absence.
 *
 * The known branch carries the {@link FxRateSnapshot} that produced it, so the
 * conversion is reproducible after the fact and a later rate move can never
 * change a comparison somebody saw (#44's rule, applied to a read).
 */
export type OfferComparisonPrice =
  | { readonly known: false; readonly reason: RankingUnknownReason }
  | { readonly known: true; readonly amount: Money; readonly fx: FxRateSnapshot };

/**
 * Item plus delivery, in the comparison currency.
 *
 * The unknown branch NAMES which component was missing, because "we do not know
 * the shipping" and "we do not know the price" lead a shopper to different next
 * actions. It carries no `amount`, which is what makes
 * `cheapest_known_total` unreachable for it.
 */
export type OfferComparisonTotal =
  | { readonly known: false; readonly missing: readonly OfferCostComponent[] }
  | { readonly known: true; readonly amount: Money };

export type OfferCostComponent = 'item_price' | 'delivery_cost';

export const OFFER_COST_COMPONENTS: readonly OfferCostComponent[] = [
  'item_price',
  'delivery_cost',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* Intent, labels and reasons                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What the shopper asked for (issue ranking input 11).
 *
 * An intent selects a documented PRIMARY sort key and leaves the policy score as
 * the secondary; it never changes a weight and never invents a value. An offer
 * whose fact is unknown sorts LAST under an intent keyed on that fact and can
 * never carry the intent's label — which is the same "unknown never wins" rule
 * the score obeys, applied to the ordering.
 */
export type OfferComparisonIntent = 'balanced' | 'cheapest' | 'fastest' | 'official' | 'used';

export const OFFER_COMPARISON_INTENTS: readonly OfferComparisonIntent[] = [
  'balanced',
  'cheapest',
  'fastest',
  'official',
  'used',
];

/**
 * What kind of comparison this is (eligibility rule 5).
 *
 * `buy_now` refuses an offer the source POSITIVELY declared unbuyable
 * (`out_of_stock`, `unavailable`) and admits one that published nothing, whose
 * availability signal is then unknown and scores nothing. Refusing the silent
 * ones would empty most comparisons, because most feeds publish no availability
 * at all; treating them as in stock would be the "unknown as a soft yes" this
 * domain exists to prevent. Admitting them with the fact marked unknown is the
 * only reading that is neither.
 */
export type OfferComparisonExperience = 'buy_now' | 'browse';

export const OFFER_COMPARISON_EXPERIENCES: readonly OfferComparisonExperience[] = [
  'buy_now',
  'browse',
];

/**
 * The deterministic labels (issue §"Labels").
 *
 * One offer may carry several. Each is awarded independently, carries its own
 * reason code and its own basis, and is rendered independently — a label is
 * never a summary of the others.
 *
 * ## `cheapest_new` is #71's addition, and it belongs HERE rather than there
 *
 * #71's product page asks for a "cheapest new offer" beside its "best overall",
 * and a page that picked one itself would be running a second comparison —
 * outside the versioned policy, attributable to no impression, and impossible
 * to reproduce from an operator trace. It is awarded exactly as
 * `cheapest_used` already is (lowest KNOWN item price within one condition
 * segment, taken from the tie-broken order), so the two segments are answered
 * by one mechanism instead of one being a policy fact and the other a UI
 * decision. Like every label it is awarded from the ranked order and is never
 * a term in the score.
 */
export type OfferComparisonLabel =
  | 'best_overall'
  | 'cheapest_item_price'
  | 'cheapest_known_total'
  | 'official_direct_store'
  | 'authorized_reseller'
  | 'fastest_known_delivery'
  | 'best_nearby_pickup'
  | 'cheapest_new'
  | 'cheapest_used'
  | 'native_mercaria_checkout';

export const OFFER_COMPARISON_LABELS: readonly OfferComparisonLabel[] = [
  'best_overall',
  'cheapest_item_price',
  'cheapest_known_total',
  'official_direct_store',
  'authorized_reseller',
  'fastest_known_delivery',
  'best_nearby_pickup',
  'cheapest_new',
  'cheapest_used',
  'native_mercaria_checkout',
];

/**
 * Whether a label is a COMPARISON against the others or a STANDING fact about
 * one offer.
 *
 * The distinction was documented from the start and was not readable by code:
 * a comparison label goes to exactly one offer, taken from the already
 * tie-broken order, while a standing label goes to every offer that holds it.
 * #71's product page needs to render the two differently — a highlight names
 * one offer, a badge sits on a row — and deriving it from the label's SPELLING
 * (`cheapest_*`, `best_*`) would be a string rule that rots the first time a
 * label is renamed.
 *
 * A `Record` over the union, so a label added without a classification is a
 * compile error rather than something that silently reads as a comparison.
 */
export const OFFER_LABEL_KIND: Readonly<
  Record<OfferComparisonLabel, 'comparison' | 'standing'>
> = {
  best_overall: 'comparison',
  cheapest_item_price: 'comparison',
  cheapest_known_total: 'comparison',
  official_direct_store: 'standing',
  authorized_reseller: 'standing',
  fastest_known_delivery: 'comparison',
  best_nearby_pickup: 'comparison',
  cheapest_new: 'comparison',
  cheapest_used: 'comparison',
  native_mercaria_checkout: 'standing',
};

/**
 * Why a label was awarded — machine-readable, one per label, total by
 * construction.
 *
 * The reason code is what a client renders a sentence from and what an operator
 * greps for; the {@link OfferLabelAward} beside it carries the FIGURES, so a
 * client can say "cheapest total including €4.90 delivery" without the server
 * shipping a localized sentence.
 */
export type OfferLabelReason =
  | 'highest_policy_score'
  | 'lowest_item_price'
  | 'lowest_known_total'
  | 'verified_official_channel'
  | 'verified_authorized_reseller'
  | 'shortest_known_delivery'
  | 'nearest_collection_point'
  | 'lowest_item_price_new_segment'
  | 'lowest_item_price_used_segment'
  | 'buyable_on_mercaria';

export const OFFER_LABEL_REASONS: readonly OfferLabelReason[] = [
  'highest_policy_score',
  'lowest_item_price',
  'lowest_known_total',
  'verified_official_channel',
  'verified_authorized_reseller',
  'shortest_known_delivery',
  'nearest_collection_point',
  'lowest_item_price_new_segment',
  'lowest_item_price_used_segment',
  'buyable_on_mercaria',
];

/** Label → its reason code. A label added without one is a compile error. */
export const OFFER_LABEL_REASON: Readonly<Record<OfferComparisonLabel, OfferLabelReason>> = {
  best_overall: 'highest_policy_score',
  cheapest_item_price: 'lowest_item_price',
  cheapest_known_total: 'lowest_known_total',
  official_direct_store: 'verified_official_channel',
  authorized_reseller: 'verified_authorized_reseller',
  fastest_known_delivery: 'shortest_known_delivery',
  best_nearby_pickup: 'nearest_collection_point',
  cheapest_new: 'lowest_item_price_new_segment',
  cheapest_used: 'lowest_item_price_used_segment',
  native_mercaria_checkout: 'buyable_on_mercaria',
};

/**
 * One awarded label, with the fact that earned it.
 *
 * `basis` is a `Money`, a day count or a metre count — never a sentence. The
 * copy lives in `@mercaria/ui`'s `lib/offer-labels.ts`, so it can change without
 * touching a stored value or a wire contract, which is #90's rule for the
 * condition taxonomy applied to a label.
 */
export interface OfferLabelAward {
  readonly label: OfferComparisonLabel;
  readonly reason: OfferLabelReason;
  /** The comparison currency amount that earned a price label. */
  readonly amount?: Money;
  /** The day count that earned a delivery label. */
  readonly days?: number;
  /** The distance that earned a pickup label. */
  readonly metres?: number;
  /** The 0–1 score that earned `best_overall`. */
  readonly score?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The policy                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** The lifecycle of one published ranking policy version. */
export type RankingPolicyStatus = 'draft' | 'canary' | 'active' | 'superseded' | 'archived';

export const RANKING_POLICY_STATUSES: readonly RankingPolicyStatus[] = [
  'draft',
  'canary',
  'active',
  'superseded',
  'archived',
];

/** Where the policy in force came from. */
export type RankingPolicySource = 'builtin' | 'published';

export const RANKING_POLICY_SOURCES: readonly RankingPolicySource[] = ['builtin', 'published'];

/** Which arm of a rollout served this comparison. */
export type RankingPolicyArm = 'active' | 'canary';

export const RANKING_POLICY_ARMS: readonly RankingPolicyArm[] = ['active', 'canary'];

/**
 * What a policy version measures itself by (issue policy rule 5).
 *
 * Two lists, and the guardrail one may not be empty: "evaluate click and
 * conversion outcomes ALONGSIDE trust guardrails, not as the only objective" is
 * a `cardinality(...) >= 1` CHECK on the row rather than a sentence in a
 * runbook. The values are #77 metric keys; this domain names them and never
 * reads a measurement, which `analytics-ranking-isolation.test.ts` enforces.
 */
export interface RankingEvaluationPlan {
  readonly objectiveMetricKeys: readonly string[];
  readonly guardrailMetricKeys: readonly string[];
}

/**
 * The weights, one per signal, exhaustive by TYPE.
 *
 * A `Record` over the signal union rather than a list of pairs: a signal added
 * to {@link OFFER_RANKING_SIGNALS} without a weight fails `tsc` at every policy
 * literal, which is what stops a new input silently defaulting to zero — or,
 * worse, to whatever the map's `?? 1` happened to be.
 */
export type RankingWeights = Readonly<Record<OfferRankingSignal, number>>;

/**
 * The policy in force for one comparison.
 *
 * `version` is what an impression is logged under (issue policy rule 1) and what
 * an operator quotes. A BUILT-IN policy is a real version with a real name, not
 * a nameless default: a deployment that has published nothing still produces
 * traceable, reproducible orderings, and every ranked result says which policy
 * produced it. That is a deliberate divergence from #58's and #121's "no active
 * version ⇒ refuse", and the reason is the consequence: refusing a compliance
 * verdict withholds a sale nobody proved may happen, while refusing to rank
 * would withhold the comparison surface itself on every fresh deployment.
 */
export interface RankingPolicy {
  readonly policyKey: string;
  readonly version: string;
  readonly source: RankingPolicySource;
  readonly arm: RankingPolicyArm;
  readonly weights: RankingWeights;
  /** Below this many VERIFIED reviews a rating is not confident enough to score. */
  readonly minReviewCount: number;
  /** How many top positions the dominance detector looks at. */
  readonly dominanceWindow: number;
  /** The share of that window one source/merchant/network may hold. */
  readonly dominanceShare: number;
  readonly evaluation: RankingEvaluationPlan;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The ranked result                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Which comparison a tie was broken by (issue policy rule 7).
 *
 * `stable_digest` is the last resort and it is deliberately NOT an id
 * comparison: `generatedId()` is a uuid v7, whose leading bits are a timestamp,
 * so ordering by id is ordering by INGESTION TIME — precisely what the rule
 * forbids, and precisely the tie-break that hands a permanent advantage to
 * whichever source crawled first. The digest is `sha256(policyVersion + offerId)`
 * compared as hex: deterministic for one policy version (acceptance 1), stable
 * across re-reads, and uncorrelated with when a row was written.
 */
export type OfferTieBreaker = 'known_total' | 'item_price' | 'stable_digest';

export const OFFER_TIE_BREAKERS: readonly OfferTieBreaker[] = [
  'known_total',
  'item_price',
  'stable_digest',
];

/** One offer's place in the comparison, and every reason for it. */
export interface RankedOffer {
  readonly offerId: string;
  /** 1-based. */
  readonly rank: number;
  /** 0–1, the weighted mean over the signals that were KNOWN. */
  readonly score: number;
  /** Every signal, scored or unknown — the explanation, in full. */
  readonly signals: readonly RankingSignalOutcome[];
  readonly labels: readonly OfferLabelAward[];
  readonly cost: {
    readonly itemPrice: OfferComparisonPrice;
    readonly deliveryCost: OfferComparisonPrice;
    readonly total: OfferComparisonTotal;
    readonly taxInclusion: OfferTaxInclusion;
  };
  /** Which comparison decided this offer's place against the one above it. */
  readonly tieBreakerApplied?: OfferTieBreaker;
}

/**
 * A whole comparison: what was shown, in what order, under which policy, in
 * which currency, and what was left out and why.
 *
 * `comparisonCurrency` and `rates` are the issue's "every comparison names ONE
 * currency and captures the quote it used". `excluded` travels WITH the ranked
 * list rather than being discarded, because "why is my offer not here" is the
 * question this surface exists to be able to answer.
 */
export interface RankedOfferComparison {
  readonly policy: RankingPolicy;
  readonly intent: OfferComparisonIntent;
  readonly experience: OfferComparisonExperience;
  readonly comparisonCurrency: CurrencyCode;
  /** One snapshot per distinct source currency converted, deduplicated. */
  readonly rates: readonly FxRateSnapshot[];
  readonly offers: readonly RankedOffer[];
  readonly excluded: readonly {
    readonly offerId: string;
    readonly reasons: readonly OfferExclusionReason[];
  }[];
  readonly dominance: readonly RankingDominanceFinding[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Dominance and regression (issue policy rules 5 and 6)                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** Which axis a concentration was measured on. */
export type RankingDominanceDimension = 'source' | 'merchant' | 'affiliate_network';

export const RANKING_DOMINANCE_DIMENSIONS: readonly RankingDominanceDimension[] = [
  'source',
  'merchant',
  'affiliate_network',
];

/**
 * One axis holding more of the top positions than the policy permits.
 *
 * A FINDING and never an adjustment: nothing in this domain re-ranks to satisfy
 * a dominance threshold, because a shuffle applied to make a report look better
 * would be an undocumented ranking input — the one thing the whole issue is
 * about. It is reported so a person can decide whether the catalogue, the
 * policy or the source is what needs changing.
 */
export interface RankingDominanceFinding {
  readonly dimension: RankingDominanceDimension;
  /** The source id, merchant id or network name that holds the positions. */
  readonly key: string;
  /** How many of the observed top positions it holds. */
  readonly positions: number;
  /** Out of how many. */
  readonly window: number;
  /** `positions / window`. */
  readonly share: number;
  readonly threshold: number;
}

/**
 * How one policy version's order differs from another's over the SAME input
 * (issue acceptance 7).
 *
 * Computed live from two rankings of one eligible set, so a canary comparison
 * needs no re-ingestion and no stored evaluation: the offers did not move, only
 * the weights did.
 */
export interface RankingComparisonDiff {
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly compared: number;
  /** Offers whose rank moved, worst movement first. */
  readonly moved: readonly {
    readonly offerId: string;
    readonly baselineRank: number;
    readonly candidateRank: number;
    readonly delta: number;
  }[];
  /** Did the top position change hands, and to whom. */
  readonly leaderChanged: boolean;
  readonly baselineLeaderOfferId?: string;
  readonly candidateLeaderOfferId?: string;
  /** Findings the CANDIDATE produces that the baseline did not. */
  readonly newDominance: readonly RankingDominanceFinding[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure helpers the backend and any client may share                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a comparison total is known — the guard a caller must pass before it
 * can read an amount.
 *
 * Exported because the label writer, the sorter and the projection all need the
 * same narrowing, and three hand-written `total.known === true` checks are three
 * places to get it wrong.
 */
export function hasKnownTotal(
  total: OfferComparisonTotal,
): total is Extract<OfferComparisonTotal, { known: true }> {
  return total.known === true;
}

/**
 * Whether a converted price is known.
 *
 * Same reasoning as {@link hasKnownTotal}, and note that `known: false` here
 * means the comparison could not express the value in its own currency — an
 * offer priced in a currency no rate covers is UNKNOWN, never zero and never
 * silently dropped from the list.
 */
export function hasKnownPrice(
  price: OfferComparisonPrice,
): price is Extract<OfferComparisonPrice, { known: true }> {
  return price.known === true;
}

/**
 * The weighted mean over the signals that were KNOWN (#58's denominator rule).
 *
 * An unknown signal is left out of BOTH sides, so it neither helps nor hurts. It
 * is worth stating why that is the right treatment rather than a penalty: a
 * penalty would be a claim about the offer, and the only thing actually known is
 * a gap in Mercaria's information. The consequence a shopper sees is the reason
 * code beside the offer, not a worse position it did not earn.
 *
 * Returns 0 when nothing at all is known, which is a real state — an unpriced,
 * unlabelled informational record — and it sorts last with `no_comparable_basis`
 * recorded against every signal.
 */
export function weightedSignalScore(outcomes: readonly RankingSignalOutcome[]): number {
  let weighted = 0;
  let weight = 0;
  for (const outcome of outcomes) {
    if (outcome.state !== 'scored') continue;
    weighted += outcome.normalized * outcome.weight;
    weight += outcome.weight;
  }
  return weight === 0 ? 0 : weighted / weight;
}

/**
 * Normalize a value where LOWER is better, against the range present in this
 * comparison set.
 *
 * Returns 1 when every value in the set is identical: with no spread there is
 * nothing to distinguish, and answering 0 would penalize every offer for the
 * catalogue's uniformity. The range is the SET's, never a global constant — a
 * comparison is a statement about the offers in it.
 */
export function normalizeLowerIsBetter(value: number, min: number, max: number): number {
  if (!(max > min)) return 1;
  const clamped = Math.min(Math.max(value, min), max);
  return 1 - (clamped - min) / (max - min);
}

/**
 * Normalize a value where HIGHER is better, against the range present in this
 * comparison set.
 *
 * The twin of {@link normalizeLowerIsBetter} and it answers 1 on a flat set for
 * the same reason: with no spread nothing is distinguished, and answering 0
 * would penalize every offer for the catalogue's uniformity. The two live beside
 * each other so the flat-set decision is made once rather than rediscovered per
 * signal.
 */
export function normalizeHigherIsBetter(value: number, min: number, max: number): number {
  if (!(max > min)) return 1;
  const clamped = Math.min(Math.max(value, min), max);
  return (clamped - min) / (max - min);
}

/**
 * Whether a condition group belongs to the USED half of the taxonomy — what
 * `cheapest_used` is awarded within, and what the `used` intent sorts by.
 *
 * `open_box` and `refurbished` are deliberately excluded: a shopper who asked
 * for used is asking for the second-hand market, and a refurbished unit with a
 * manufacturer warranty is a different product proposition. `for_parts` is
 * excluded too — it is not a working item.
 */
export function isUsedConditionGroup(group: ConditionGroup): boolean {
  return group === 'used';
}
