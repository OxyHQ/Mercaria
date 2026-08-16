/**
 * Grounded product comparison and multi-merchant basket optimization — issue
 * #96, over #44's money, #57's offers, #74's eligibility and ranking, #90's
 * conditions and #94's typed attribute registry and constraint language.
 *
 * Two capabilities, one vocabulary, because they answer two halves of one
 * shopper question: *which of these is right for me*, and *what is the best way
 * to actually buy the set of things I want*.
 *
 * ## Everything a shopper is shown resolves to a Mercaria record
 *
 * The unit of grounding is {@link ComparisonRecordRef} — an OPAQUE handle minted
 * per comparison. Every fact in the deterministic input, every cell in the
 * table, every line in a plan and every sentence in a generated explanation
 * cites one or more of them. A reference that is not in the input's own
 * {@link ComparisonInput.records} table is not resolvable, which is what makes
 * "every compared number resolves to a supplied Mercaria record" (acceptance 1)
 * checkable rather than aspirational.
 *
 * The handle is opaque on purpose. The bounded package handed to a language
 * model ({@link ExplanationPackage}) carries refs and no ids, so an explanation
 * cannot leak a canonical id, a merchant id or a URL into prose — and, more
 * usefully, a citation the model invented cannot accidentally resolve to a real
 * record somewhere else in the catalogue.
 *
 * ## Unknown is never zero, and the TYPE is what says so
 *
 * #74's device runs through this whole file:
 *
 *  - {@link BasketTotal}'s unknown branch has no `amount`, only the components
 *    that are missing, so `cheapest_known_total` has nothing to be built from
 *    (acceptance 4).
 *  - {@link ComparisonCell}'s `unknown` and `not_applicable` branches carry no
 *    value, and they are DIFFERENT branches: "nobody recorded this" and "this
 *    question does not apply to this category" lead a shopper to different
 *    conclusions.
 *  - {@link ComparisonSubjectAcquisition}'s unavailable branch has no channel
 *    and no offer ref, so nothing can describe an unpurchasable product as
 *    purchasable (product-comparison rule 8).
 *  - {@link BasketPickupResolution} has no branch carrying a distance, because
 *    a basket request carries no viewer position; `best_nearby_pickup` is
 *    therefore unreachable rather than guarded against.
 *
 * ## What may never enter a recommendation
 *
 * {@link COMPARISON_RECOMMENDATION_INPUTS} and
 * {@link COMPARISON_FORBIDDEN_RECOMMENDATION_INPUTS} are DISJOINT tuples — the
 * `RetailCostComponentKind` device #74 and #120 already use — and no type in
 * this file has a field for any forbidden one. The scanned half is
 * `comparison-isolation.test.ts`.
 */

import type { ConditionGroup, ItemConditionKey } from './condition';
import type { ConstraintSatisfaction, ConstraintStrength } from './constraint';
import type { CurrencyCode, FxRateSnapshot, Money } from './money';
import type { OfferAvailability, OfferKind } from './offer';
import type { OfferRelationshipStanding, OfferTaxInclusion } from './offer-ranking';

/* ────────────────────────────────────────────────────────────────────────── */
/* Versions                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The version of the COMPARISON POLICY — what may be compared, how a tradeoff
 * is identified, what an explanation may say and how a basket is scored.
 *
 * A code constant and not a table, for the house reason every other versioned
 * policy here is one (`CATALOG_BACKFILL_MAPPING_VERSION`, the ranking policy
 * key): the policy is a PROCEDURE, and a table would let somebody publish a
 * version whose rules nobody shipped. Changing any rule in this domain means a
 * new value here, in the same change.
 */
export const COMPARISON_POLICY_VERSION = 'compare-2026-08-v1';

/**
 * The version of the structured output schema an explanation provider must
 * produce.
 *
 * Recorded on every explanation (issue explanation rule 9) because a provider
 * upgraded to a newer schema and a validator still on the old one is the one
 * failure that produces plausible, ungrounded prose.
 */
export const EXPLANATION_SCHEMA_VERSION = 'cx-1';

/**
 * The version of the deterministic template set used when generation is
 * unavailable or rejected.
 *
 * Separate from {@link COMPARISON_POLICY_VERSION} because copy changes without
 * the policy changing, and a rendered sentence must say which template produced
 * it so two surfaces cannot drift.
 */
export const COMPARISON_TEMPLATE_VERSION = 'ct-1';

/* ────────────────────────────────────────────────────────────────────────── */
/* Record references                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What kind of Mercaria record a reference points at.
 *
 * A closed set: a reference kind nobody can render is a reference nobody can
 * verify, and an open member is where the unverifiable ones would accumulate.
 */
export type ComparisonRecordKind =
  | 'canonical_product'
  | 'canonical_variant'
  | 'offer'
  | 'merchant'
  | 'storefront'
  | 'attribute_value'
  | 'price_signal'
  | 'relationship'
  | 'constraint'
  | 'catalog_source';

export const COMPARISON_RECORD_KINDS: readonly ComparisonRecordKind[] = [
  'canonical_product',
  'canonical_variant',
  'offer',
  'merchant',
  'storefront',
  'attribute_value',
  'price_signal',
  'relationship',
  'constraint',
  'catalog_source',
];

/**
 * One opaque handle onto one Mercaria record.
 *
 * `ref` is minted per comparison from the record's POSITION in the input
 * (`p1`, `o3`, `a12`), never from its id and never from a hash of it: a
 * comparison is a bounded package, and a handle stable across comparisons would
 * be an identifier by another name.
 *
 * `canonicalPath` is Mercaria's OWN path for the record and is present exactly
 * when the record has a public page — which is how "link every displayed
 * product and offer to its canonical page" (product-comparison rule 10) is a
 * field rather than a client convention. It is deliberately a PATH and never an
 * absolute URL: a stored host is how an environment ships a link to another
 * environment.
 */
export interface ComparisonRecordRef {
  readonly ref: string;
  readonly kind: ComparisonRecordKind;
  /** The record's real Mercaria id. Present for the CLIENT; never in a model package. */
  readonly recordId: string;
  /** A Mercaria path such as `/p/apple-iphone-15`. Absent when the record has no page. */
  readonly canonicalPath?: string;
  /** A short human label — a product name, a merchant name. Never a sentence. */
  readonly label?: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* What may and may not influence a recommendation                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The inputs a comparison or a basket plan may be built from.
 *
 * Deliberately close to #74's ranking signals, because a comparison IS a
 * ranking with an explanation attached — but not identical: a basket adds
 * merchant count and per-merchant delivery, which no single-offer ranking has
 * a use for.
 */
export type ComparisonRecommendationInput =
  | 'typed_attribute'
  | 'hard_constraint_result'
  | 'preference_result'
  | 'offer_item_price'
  | 'offer_delivery_cost'
  | 'offer_tax_inclusion'
  | 'offer_availability'
  | 'offer_condition'
  | 'offer_freshness'
  | 'offer_channel'
  | 'verified_relationship'
  | 'merchant_count'
  | 'price_signal_summary';

export const COMPARISON_RECOMMENDATION_INPUTS: readonly ComparisonRecommendationInput[] = [
  'typed_attribute',
  'hard_constraint_result',
  'preference_result',
  'offer_item_price',
  'offer_delivery_cost',
  'offer_tax_inclusion',
  'offer_availability',
  'offer_condition',
  'offer_freshness',
  'offer_channel',
  'verified_relationship',
  'merchant_count',
  'price_signal_summary',
];

/**
 * What may NEVER influence a recommendation (issue explanation rule 8).
 *
 * Named as VALUES, DISJOINT from {@link COMPARISON_RECOMMENDATION_INPUTS}, so
 * the prohibition is something a test can check and a reviewer can read rather
 * than an omission somebody quietly fills in. No type in this file carries a
 * field for one and no module in the domain can reach the code that holds one.
 *
 * `review_sentiment` is the subtle one, and it is why this list is longer than
 * #74's. A star rating is a legitimate RANKING signal one domain over; what it
 * may never become here is a SPECIFICATION — a row in a comparison table
 * claiming a product "is" good — because a table row reads as a fact about the
 * object and a rating is an aggregate of opinions about it
 * (product-comparison rule 7).
 */
export type ForbiddenComparisonInput =
  | 'affiliate_commission_rate'
  | 'merchant_subscription_plan'
  | 'commercial_agreement_margin'
  | 'marketplace_fee_rate'
  | 'retail_margin'
  | 'fair_acceptance'
  | 'sponsored_placement'
  | 'review_sentiment'
  | 'model_general_knowledge'
  | 'ingestion_order';

export const COMPARISON_FORBIDDEN_RECOMMENDATION_INPUTS: readonly ForbiddenComparisonInput[] = [
  'affiliate_commission_rate',
  'merchant_subscription_plan',
  'commercial_agreement_margin',
  'marketplace_fee_rate',
  'retail_margin',
  'fair_acceptance',
  'sponsored_placement',
  'review_sentiment',
  'model_general_knowledge',
  'ingestion_order',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* The grounded comparison input                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Which policy and projection versions produced an input (issue grounded input
 * item 10).
 *
 * Four versions, because four independently versioned things decided what the
 * shopper sees, and an explanation that cannot be attributed to all four cannot
 * be reproduced.
 */
export interface ComparisonPolicyIdentity {
  readonly comparisonPolicyVersion: string;
  /** #74's ranking policy version, which decided the offer order inside each subject. */
  readonly rankingPolicyVersion: string;
  /** #94's constraint evaluation ruleset. */
  readonly constraintEvaluationVersion: string;
  /** #94's normalization ruleset, which decided what a stored attribute value MEANS. */
  readonly normalizationRuleVersion: string;
}

/**
 * Whether a comparison subject can actually be bought right now, and how.
 *
 * A STRING discriminant, and the unavailable branch carries no channel and no
 * offer: product-comparison rule 8 ("do not describe an unavailable product as
 * purchasable") is held by there being no shape in which an unavailable subject
 * has somewhere to buy it.
 */
export type ComparisonSubjectAcquisition =
  | {
      readonly state: 'purchasable';
      /** Every channel at least one eligible offer reaches. Never empty here. */
      readonly channels: readonly ComparisonAcquisitionChannel[];
      /** The best-ranked eligible offer for this subject, by opaque ref. */
      readonly leadOfferRef: string;
      readonly eligibleOfferCount: number;
    }
  | {
      readonly state: 'unavailable';
      readonly reason: ComparisonUnavailableReason;
    };

/** How a purchasable subject can be acquired. */
export type ComparisonAcquisitionChannel = 'native_checkout' | 'external_merchant';

export const COMPARISON_ACQUISITION_CHANNELS: readonly ComparisonAcquisitionChannel[] = [
  'native_checkout',
  'external_merchant',
];

/** Why a subject cannot be bought. Every member is a fact the derivation READ. */
export type ComparisonUnavailableReason =
  /** No offer at all survived #74's eligibility. */
  | 'no_eligible_offer'
  /** Offers exist but every one of them was refused by a hard constraint. */
  | 'all_offers_constrained_out'
  /** Offers exist and none is priced in a currency this comparison can quote. */
  | 'no_convertible_price'
  /** The offers half was not served at all — the canonical read lever is off. */
  | 'offer_comparison_withheld';

export const COMPARISON_UNAVAILABLE_REASONS: readonly ComparisonUnavailableReason[] = [
  'no_eligible_offer',
  'all_offers_constrained_out',
  'no_convertible_price',
  'offer_comparison_withheld',
];

/**
 * One thing being compared: a canonical product, optionally narrowed to one
 * configuration (issue grounded input item 1).
 */
export interface ComparisonSubject {
  /** The product's opaque ref. */
  readonly ref: string;
  /** The configuration's opaque ref, when the caller named one. */
  readonly variantRef?: string;
  readonly name: string;
  readonly brandRef?: string;
  readonly categoryId?: string;
  readonly acquisition: ComparisonSubjectAcquisition;
  /** Every eligible offer for this subject, in #74's ranked order, by ref. */
  readonly offerRefs: readonly string[];
}

/**
 * A typed value as a comparison renders it.
 *
 * A STRING discriminant and a rendered form beside the machine one: the
 * rendered form is what a table cell and an explanation may quote, and it is
 * composed ONCE here so a client, a template and a model cannot produce three
 * spellings of one number.
 */
export type ComparisonFactValue =
  | { readonly type: 'text'; readonly text: string; readonly rendered: string }
  | { readonly type: 'boolean'; readonly value: boolean; readonly rendered: string }
  | {
      readonly type: 'number';
      readonly value: number;
      readonly unit?: string;
      readonly rendered: string;
    }
  | {
      readonly type: 'range';
      readonly lower: number;
      readonly upper: number;
      readonly unit?: string;
      readonly rendered: string;
    }
  | { readonly type: 'money'; readonly amount: Money; readonly rendered: string }
  | { readonly type: 'date'; readonly iso: string; readonly rendered: string };

/**
 * Why a table cell has no value.
 *
 * `not_recorded` and `not_applicable` are the two the issue keeps apart
 * (product-comparison rule 3), and `conflicting` and `low_confidence` are #94's
 * own selection states surfacing here rather than being flattened into
 * "unknown": a shopper choosing between two sources' disagreeing answers is in
 * a different position from one whose feed said nothing.
 */
export type ComparisonUnknownReason =
  | 'not_recorded'
  | 'conflicting_sources'
  | 'low_confidence'
  | 'unit_not_comparable'
  | 'definition_not_published';

export const COMPARISON_UNKNOWN_REASONS: readonly ComparisonUnknownReason[] = [
  'not_recorded',
  'conflicting_sources',
  'low_confidence',
  'unit_not_comparable',
  'definition_not_published',
];

/** Why a fact does not apply to a subject at all. */
export type ComparisonNotApplicableReason =
  /** The attribute's category scope does not cover this subject's category. */
  | 'attribute_out_of_category'
  /** The attribute exists for the category and is not comparable by policy. */
  | 'attribute_not_comparable';

export const COMPARISON_NOT_APPLICABLE_REASONS: readonly ComparisonNotApplicableReason[] = [
  'attribute_out_of_category',
  'attribute_not_comparable',
];

/**
 * How a cell's value was arrived at (product-comparison rule 5).
 *
 * An INFERENCE is labelled distinctly from a source-backed fact, and it carries
 * the basis it was inferred from — never a bare flag. Today the only inference
 * Mercaria performs is a unit conversion into the row's comparison unit, which
 * is worth stating rather than leaving as an empty extension point: an
 * inference kind nobody implements is a claim nobody can audit.
 */
export type ComparisonInferenceBasis = 'unit_conversion' | 'range_midpoint';

export const COMPARISON_INFERENCE_BASES: readonly ComparisonInferenceBasis[] = [
  'unit_conversion',
  'range_midpoint',
];

/** One cell of the machine comparison table. */
export type ComparisonCell =
  | {
      readonly state: 'source_backed';
      readonly value: ComparisonFactValue;
      readonly recordRefs: readonly string[];
    }
  | {
      readonly state: 'inferred';
      readonly value: ComparisonFactValue;
      readonly basis: ComparisonInferenceBasis;
      readonly recordRefs: readonly string[];
    }
  | {
      readonly state: 'conflicting';
      /** Every parse that disagreed. Mercaria selects NEITHER (#94's rule). */
      readonly candidates: readonly ComparisonFactValue[];
      readonly recordRefs: readonly string[];
    }
  | { readonly state: 'unknown'; readonly reason: ComparisonUnknownReason }
  | { readonly state: 'not_applicable'; readonly reason: ComparisonNotApplicableReason };

/**
 * Whether a bigger number is better for one row (product-comparison rule 6).
 *
 * `not_comparable` is the DEFAULT and the overwhelmingly common answer, because
 * the registry records what an attribute MEANS and never which direction a
 * shopper prefers. A direction is declared, per attribute key, in the
 * comparison policy — and a row without one still shows both values and simply
 * refuses to call either better. A default of `higher_is_better` would announce
 * that a heavier laptop and a longer charging time are improvements.
 */
export type ComparisonDirection = 'higher_is_better' | 'lower_is_better' | 'not_comparable';

export const COMPARISON_DIRECTIONS: readonly ComparisonDirection[] = [
  'higher_is_better',
  'lower_is_better',
  'not_comparable',
];

/** One row of the machine comparison table — one attribute, across every subject. */
export interface ComparisonTableRow {
  /** The registry attribute key, or a commerce facet key such as `offer_price`. */
  readonly key: string;
  readonly label: string;
  /** Which #94 definition version the row's meaning came from. Absent for a commerce row. */
  readonly definitionVersion?: number;
  /** The unit every numeric cell in this row is expressed in. */
  readonly unit?: string;
  readonly direction: ComparisonDirection;
  /** Subject ref → cell. Every subject in the table has an entry. */
  readonly cells: Readonly<Record<string, ComparisonCell>>;
  /** Whether the cells in this row actually differ. Computed, never asserted. */
  readonly differs: boolean;
}

/**
 * One subject's constraint results, with the four states kept apart
 * (product-comparison rule 3).
 *
 * `notApplicable` is a genuine fourth list rather than a flavour of unknown: a
 * requirement about a laptop's battery cannot be unknown for a desk chair, it
 * simply does not apply, and telling a shopper the chair's battery life is
 * unrecorded is worse than saying nothing.
 */
export interface ComparisonConstraintColumn {
  readonly subjectRef: string;
  readonly verdict: 'included' | 'excluded';
  readonly satisfied: readonly ComparisonConstraintResult[];
  readonly failed: readonly ComparisonConstraintResult[];
  readonly unknown: readonly ComparisonConstraintResult[];
  readonly notApplicable: readonly ComparisonConstraintResult[];
}

/** One constraint's outcome against one subject. */
export interface ComparisonConstraintResult {
  /** The opaque ref of the constraint record. */
  readonly constraintRef: string;
  readonly constraintId: string;
  readonly strength: ConstraintStrength;
  readonly satisfaction: ConstraintSatisfaction | 'not_applicable';
  readonly explanation: string;
  readonly reason: string;
  readonly sourceBacked: boolean;
}

/**
 * A recorded difference between two subjects, and never anything else
 * (product-comparison rule 4).
 *
 * A tradeoff is DERIVED from two cells that differ on a row whose direction is
 * declared. Where the direction is `not_comparable` the difference is still
 * reported — as a {@link ComparisonDifference} — and no better/worse claim is
 * attached to it. That distinction is the whole of "identify tradeoffs only
 * from recorded differences".
 */
export interface ComparisonTradeoff {
  readonly rowKey: string;
  readonly label: string;
  /** The subject this row favours. */
  readonly betterSubjectRef: string;
  readonly worseSubjectRef: string;
  readonly betterValue: ComparisonFactValue;
  readonly worseValue: ComparisonFactValue;
  readonly direction: Exclude<ComparisonDirection, 'not_comparable'>;
  readonly recordRefs: readonly string[];
}

/** A recorded difference with no better/worse reading available. */
export interface ComparisonDifference {
  readonly rowKey: string;
  readonly label: string;
  /** Subject ref → the rendered value, for every subject that has one. */
  readonly values: Readonly<Record<string, string>>;
  readonly recordRefs: readonly string[];
}

/** The whole machine comparison table. */
export interface ComparisonTable {
  readonly subjectRefs: readonly string[];
  readonly rows: readonly ComparisonTableRow[];
  readonly constraints: readonly ComparisonConstraintColumn[];
  readonly tradeoffs: readonly ComparisonTradeoff[];
  readonly differences: readonly ComparisonDifference[];
}

/**
 * One eligible offer as the comparison input carries it (issue grounded input
 * item 4).
 *
 * A narrowed projection of #74's ranked offer rather than the DTO: everything
 * here is a fact a comparison may state, expressed in the ONE comparison
 * currency, and there is deliberately no destination URL, no affiliate routing
 * and no source payload. What an outbound click does is #37's, and a package a
 * model reads has no business carrying a link.
 */
export interface ComparisonOfferRecord {
  readonly ref: string;
  readonly subjectRef: string;
  readonly variantRef: string;
  readonly kind: OfferKind;
  readonly merchantRef?: string;
  readonly storefrontRef?: string;
  /** 1-based, from #74's tie-broken order. Never an ingestion position. */
  readonly rank: number;
  readonly itemPrice: ComparisonMoneyFact;
  readonly deliveryCost: ComparisonMoneyFact;
  readonly total: ComparisonMoneyFact;
  readonly taxInclusion: OfferTaxInclusion;
  readonly availability: OfferAvailability;
  readonly conditionKey?: ItemConditionKey;
  readonly conditionGroup?: ConditionGroup;
  readonly relationship?: OfferRelationshipStanding;
  readonly nativeCheckoutEligible: boolean;
  /** The slowest end of the quoted delivery window, in days. Absent when unquoted. */
  readonly deliveryMaxDays?: number;
  /** #68's freshness verdict, as a word a shopper can read. */
  readonly freshness: ComparisonOfferFreshness;
  /** The destination HOST for an external offer — never a URL (#71's decision). */
  readonly destinationHost?: string;
}

/** How current an offer's terms are, coarsely. */
export type ComparisonOfferFreshness = 'current' | 'ageing' | 'unknown';

export const COMPARISON_OFFER_FRESHNESS: readonly ComparisonOfferFreshness[] = [
  'current',
  'ageing',
  'unknown',
];

/**
 * A money fact in the comparison currency, or an honest absence.
 *
 * A STRING discriminant rather than #74's `known: boolean`, because the backend
 * compiles without `strictNullChecks` and a boolean-literal discriminant does
 * not narrow there (#68's finding, hit again in #110). The `unknown` branch
 * carries no `amount` and no `rendered`, so nothing can print a blank as free.
 */
export type ComparisonMoneyFact =
  | {
      readonly state: 'known';
      readonly amount: Money;
      readonly rendered: string;
      readonly fx?: FxRateSnapshot;
    }
  | { readonly state: 'unknown'; readonly reason: ComparisonMoneyUnknownReason };

/** Why a money fact is unknown. */
export type ComparisonMoneyUnknownReason =
  | 'not_published'
  | 'not_convertible'
  | 'component_missing';

export const COMPARISON_MONEY_UNKNOWN_REASONS: readonly ComparisonMoneyUnknownReason[] = [
  'not_published',
  'not_convertible',
  'component_missing',
];

/** A verified relationship carried into the input (issue grounded input item 5). */
export interface ComparisonRelationshipRecord {
  readonly ref: string;
  readonly merchantRef: string;
  readonly standing: Exclude<OfferRelationshipStanding, 'none'>;
  readonly brandRef?: string;
}

/**
 * A price-history summary, carried ONLY when policy permits (issue grounded
 * input item 6).
 *
 * #78 gates its buyer-facing reads behind `PRICE_HISTORY_PUBLIC_READS_ENABLED`,
 * and this input honours that lever rather than reaching past it: with the
 * lever off the array is EMPTY and the explanation package says so, instead of
 * a comparison quietly claiming a price is unusually low on evidence a
 * deployment decided not to publish.
 */
export interface ComparisonPriceSignal {
  readonly ref: string;
  readonly subjectRef: string;
  readonly currency: CurrencyCode;
  readonly lowest: Money;
  readonly rendered: string;
  readonly windowDays: number;
  /** The range the series actually covers, so a gap is never read as a low. */
  readonly coveredFrom: string;
  readonly coveredThrough: string;
}

/**
 * A missing, conflicting or low-confidence fact, stated OUT LOUD (issue
 * grounded input item 7).
 *
 * Carried as its own list rather than only as `unknown` cells, because
 * explanation rule 7 asks the narrative to STATE what is missing — and a
 * narrative composed from a table has no way to distinguish "this row was not
 * interesting" from "we do not know".
 */
export interface ComparisonFactGap {
  readonly subjectRef: string;
  readonly rowKey: string;
  readonly label: string;
  readonly reason: ComparisonUnknownReason;
}

/**
 * The deterministic, grounded package a comparison is computed from — the ten
 * items of the issue's "grounded comparison service", in one value.
 *
 * A language model may SUMMARIZE this and may not add to it. The mechanism is
 * {@link ExplanationPackage}, derived from this by dropping every id and every
 * path; the guarantee is {@link ExplanationRejection}, which refuses any draft
 * citing a reference this input does not contain.
 */
export interface ComparisonInput {
  readonly policy: ComparisonPolicyIdentity;
  /** ISO-8601. The instant every fact here was read at (grounded input item 8). */
  readonly evaluatedAt: string;
  readonly comparisonCurrency: CurrencyCode;
  /** ISO 3166-1 alpha-2. Absent = unrestricted, which is today's behaviour. */
  readonly market?: string;
  /** The condition segments the caller asked about. Empty = every segment. */
  readonly conditionGroups: readonly ConditionGroup[];
  readonly subjects: readonly ComparisonSubject[];
  readonly offers: readonly ComparisonOfferRecord[];
  readonly relationships: readonly ComparisonRelationshipRecord[];
  readonly priceSignals: readonly ComparisonPriceSignal[];
  readonly gaps: readonly ComparisonFactGap[];
  readonly table: ComparisonTable;
  /** Every rate applied, deduplicated by pair (grounded input item 8). */
  readonly rates: readonly FxRateSnapshot[];
  /** The whole reference table. Every ref cited anywhere resolves here. */
  readonly records: readonly ComparisonRecordRef[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The explanation adapter                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The bounded package a provider may see (issue explanation rule 2).
 *
 * Derived from {@link ComparisonInput} by dropping `recordId`, `canonicalPath`
 * and every URL, host and free-text description. What remains is opaque refs,
 * short labels, rendered values and constraint outcomes — enough to write a
 * useful paragraph, and nothing that could be exfiltrated into prose.
 *
 * `groundedValues` is the whole set of numeric tokens the package legitimately
 * contains, rendered exactly as a sentence may quote them. The validator's
 * "introduces new numbers" check is membership in that set, which is the one
 * formulation that is decidable rather than a judgement call.
 */
export interface ExplanationPackage {
  readonly schemaVersion: string;
  readonly comparisonPolicyVersion: string;
  readonly comparisonCurrency: CurrencyCode;
  readonly subjects: readonly ExplanationSubject[];
  readonly rows: readonly ExplanationRow[];
  readonly tradeoffs: readonly ExplanationTradeoff[];
  readonly gaps: readonly ExplanationGap[];
  readonly constraints: readonly ExplanationConstraint[];
  /** Every rendered numeric token that appears anywhere above. */
  readonly groundedValues: readonly string[];
  /** Every ref that appears anywhere above — the citation whitelist. */
  readonly validRefs: readonly string[];
}

/** One subject, as a provider sees it. No ids, no paths. */
export interface ExplanationSubject {
  readonly ref: string;
  readonly name: string;
  readonly acquisition: 'purchasable' | 'unavailable';
  readonly lowestKnownItemPrice?: string;
  readonly lowestKnownTotal?: string;
  readonly merchantCount: number;
}

/** One table row, as a provider sees it. */
export interface ExplanationRow {
  readonly key: string;
  readonly label: string;
  readonly direction: ComparisonDirection;
  /** Subject ref → the rendered cell, or a word naming why it has none. */
  readonly cells: Readonly<Record<string, string>>;
}

/** One tradeoff, as a provider sees it. */
export interface ExplanationTradeoff {
  readonly rowKey: string;
  readonly label: string;
  readonly betterSubjectRef: string;
  readonly worseSubjectRef: string;
  readonly betterValue: string;
  readonly worseValue: string;
}

/** One gap, as a provider sees it. */
export interface ExplanationGap {
  readonly subjectRef: string;
  readonly label: string;
  readonly reason: ComparisonUnknownReason;
}

/** One constraint outcome, as a provider sees it. */
export interface ExplanationConstraint {
  readonly constraintRef: string;
  readonly constraintId: string;
  readonly explanation: string;
  /** Subject ref → the deterministic outcome. A draft may not change one. */
  readonly outcomes: Readonly<Record<string, ConstraintSatisfaction | 'not_applicable'>>;
}

/** One sentence a provider produced, with the records it rests on. */
export interface ExplanationSentence {
  readonly text: string;
  /** At least one ref. A factual sentence citing nothing is rejected. */
  readonly citedRefs: readonly string[];
}

/** What a comparison point is claiming. */
export type ExplanationPointKind = 'advantage' | 'tradeoff' | 'unknown_fact';

export const EXPLANATION_POINT_KINDS: readonly ExplanationPointKind[] = [
  'advantage',
  'tradeoff',
  'unknown_fact',
];

/** One point about one subject. */
export interface ExplanationPoint {
  readonly subjectRef: string;
  readonly kind: ExplanationPointKind;
  readonly text: string;
  readonly citedRefs: readonly string[];
}

/**
 * The strict structured output a provider must return (issue explanation
 * rule 1).
 *
 * Structured, never prose: a free-text completion would have to be parsed
 * before it could be checked, and every parse is a place a citation goes
 * missing. `constraintEchoes` is the mechanism behind "may not change
 * constraint results" — a provider that wants to talk about a requirement must
 * restate its outcome, and a restatement that disagrees with the deterministic
 * one is a rejection rather than a sentence nobody diffed.
 */
export interface ExplanationDraft {
  readonly schemaVersion: string;
  readonly summary: readonly ExplanationSentence[];
  readonly points: readonly ExplanationPoint[];
  readonly constraintEchoes: readonly {
    readonly constraintRef: string;
    readonly subjectRef: string;
    readonly satisfaction: ConstraintSatisfaction | 'not_applicable';
  }[];
}

/** Which provider produced an explanation, and under which versions. */
export interface ExplanationProvenance {
  /** An opaque provider id (`deterministic_template`, a vendor slug). */
  readonly provider: string;
  /** The provider's own prompt version. Empty for the template renderer. */
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly comparisonPolicyVersion: string;
}

/** Why a draft was refused (issue explanation rule 4). */
export type ExplanationRejectionReason =
  /** The draft cites a reference the package does not contain. */
  | 'unknown_record_reference'
  /** A factual sentence cites nothing at all. */
  | 'uncited_statement'
  /** A number appears that is not in the package's grounded set. */
  | 'introduced_number'
  /** An echoed constraint outcome disagrees with the deterministic one. */
  | 'constraint_result_changed'
  /** The draft echoes a constraint the package does not carry. */
  | 'unknown_constraint_reference'
  /** The draft mentions affiliate economics, a merchant plan or FAIR acceptance. */
  | 'forbidden_topic'
  /** The draft does not match the declared schema at all. */
  | 'schema_invalid'
  /** The draft is longer than the policy permits. */
  | 'output_too_long'
  /** No provider is registered. */
  | 'provider_unavailable'
  /** The provider failed or timed out. */
  | 'provider_error';

export const EXPLANATION_REJECTION_REASONS: readonly ExplanationRejectionReason[] = [
  'unknown_record_reference',
  'uncited_statement',
  'introduced_number',
  'constraint_result_changed',
  'unknown_constraint_reference',
  'forbidden_topic',
  'schema_invalid',
  'output_too_long',
  'provider_unavailable',
  'provider_error',
];

/** One refusal, naming what was wrong and where. */
export interface ExplanationRejection {
  readonly reason: ExplanationRejectionReason;
  /** The offending token, ref or sentence prefix. Never the whole draft. */
  readonly detail: string;
}

/**
 * The explanation a surface renders (issue explanation rules 5–7, 10).
 *
 * A STRING discriminant with three states, and the `template` one is not a
 * degraded mode: rule 6 asks for rule-based templates for SIMPLE comparisons
 * and as the fallback, so a two-product comparison with three differing rows is
 * legitimately answered without a model at all.
 *
 * Every branch carries `provenance`, so "let users inspect why a recommendation
 * was made" (rule 10) is answerable for a templated explanation exactly as it
 * is for a generated one.
 */
export type ComparisonExplanation =
  | {
      readonly state: 'generated';
      readonly summary: readonly ExplanationSentence[];
      readonly points: readonly ExplanationPoint[];
      readonly provenance: ExplanationProvenance;
    }
  | {
      readonly state: 'template';
      readonly summary: readonly ExplanationSentence[];
      readonly points: readonly ExplanationPoint[];
      readonly provenance: ExplanationProvenance;
      readonly templateVersion: string;
      /** Present when a generated draft was tried and refused. */
      readonly rejections: readonly ExplanationRejection[];
    }
  | {
      readonly state: 'unavailable';
      readonly rejections: readonly ExplanationRejection[];
    };

/** The whole answer to "compare these products". */
export interface ComparisonResult {
  readonly input: ComparisonInput;
  readonly explanation: ComparisonExplanation;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The basket problem                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One thing the shopper wants, and how many.
 *
 * Shaped to #81's `WatchlistItem` on purpose — same product/variant/condition/
 * merchant/quantity fields — so a watchlist becomes a basket request with no
 * translation layer that could reinterpret a preference. It is NOT an import of
 * #81's type: this domain must build and solve a basket for a caller that has
 * no watchlist at all.
 */
export interface BasketRequestLine {
  /** A caller-stable id for this line, echoed on every result. */
  readonly lineId: string;
  readonly canonicalProductId: string;
  /** Narrow to one configuration. Absent = any configuration of the product. */
  readonly canonicalVariantId?: string;
  readonly quantity: number;
  /** Only offers in this segment may serve the line. */
  readonly conditionGroups?: readonly ConditionGroup[];
  /** Only this merchant may serve the line. */
  readonly merchantId?: string;
}

/**
 * Which channels a plan may draw on (issue solver requirement 3).
 *
 * `mixed` is the default and the only one that can produce a plan with both a
 * native cart action and external merchant actions — which is exactly why it is
 * spelled out rather than inferred from what the candidates happen to contain.
 */
export type BasketChannelPolicy = 'native_only' | 'external_only' | 'official_only' | 'mixed';

export const BASKET_CHANNEL_POLICIES: readonly BasketChannelPolicy[] = [
  'native_only',
  'external_only',
  'official_only',
  'mixed',
];

/**
 * What a plan is optimizing for (issue solver requirement 12).
 *
 * `cheapest_known_total` is reachable ONLY when every included cost is known;
 * see {@link BasketTotal}. `all_native` is a preference over channel rather
 * than a constraint — `native_only` is the constraint, and the two are separate
 * because "prefer to buy it all here, but do not refuse a plan if one item is
 * only sold elsewhere" is a real thing to ask for.
 */
export type BasketObjective =
  | 'cheapest_known_item_prices'
  | 'cheapest_known_total'
  | 'fewest_merchants'
  | 'all_native'
  | 'fastest_known_delivery';

export const BASKET_OBJECTIVES: readonly BasketObjective[] = [
  'cheapest_known_item_prices',
  'cheapest_known_total',
  'fewest_merchants',
  'all_native',
  'fastest_known_delivery',
];

/**
 * A shopper asking for nearby pickup — and the whole of what this domain
 * represents about it.
 *
 * NO coordinates, NO radius and NO collection point. Not because #93 publishes
 * none — it has shipped, and `resolvePickupProximity` answers real distances —
 * but because a basket has no ORIGIN to measure from: a plan is composed from a
 * saved list, not from where the shopper is standing. Carrying a bare request
 * is what lets the solver answer honestly that it cannot serve one.
 */
export interface BasketPickupPreference {
  readonly requested: true;
}

/** Why a pickup preference could not be honoured. */
export type BasketPickupResolution = {
  readonly state: 'unavailable';
  readonly reason: 'pickup_data_unavailable';
};

/** What a caller asks the solver for. */
export interface BasketRequest {
  readonly lines: readonly BasketRequestLine[];
  readonly comparisonCurrency: CurrencyCode;
  readonly market?: string;
  readonly channelPolicy: BasketChannelPolicy;
  /**
   * The condition segments every line accepts unless it names its own.
   *
   * A DEFAULT and never an intersection: a line that states
   * `conditionGroups` means it, and narrowing it further by a basket-wide
   * preference would be a second filter the shopper cannot see. Empty or
   * absent means every segment.
   *
   * It exists because a shopper expresses "second-hand is fine" ONCE — #95
   * produces exactly one `IntentCommercePreferences.conditionGroups` for a whole
   * query — and a contract that only accepted it per line would make every
   * caller fan one preference across forty of them, differently each time.
   * `solveBasketRequest` expands it onto the lines before anything reads them,
   * so there is one authority and the snapshot records what was actually solved.
   */
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly objectives: readonly BasketObjective[];
  /** Hard ceiling on distinct merchants (issue solver requirement 10). */
  readonly maxMerchants?: number;
  /** Merchant ids no plan may use (issue solver requirement 11). */
  readonly excludedMerchantIds?: readonly string[];
  /** Absent by default. #93 owns the data model; see {@link BasketPickupPreference}. */
  readonly pickupPreference?: BasketPickupPreference;
}

/**
 * A plan's total, or an honest statement of what is missing.
 *
 * The unknown branch has NO amount, which is what makes acceptance 4 ("unknown
 * shipping prevents a `cheapest known total` claim") a property of the type:
 * the named result that claims a cheapest total is constructed from a value
 * whose `state` must be `known`, so an incomplete plan has no shape that could
 * be passed to it.
 */
export type BasketTotal =
  | { readonly state: 'known'; readonly amount: Money; readonly rendered: string }
  | {
      readonly state: 'unknown';
      readonly missing: readonly BasketCostComponent[];
      /** The part that IS known, so a shopper sees a floor rather than nothing. */
      readonly knownFloor: Money;
      readonly renderedFloor: string;
    };

/** Which half of a basket cost is missing. */
export type BasketCostComponent = 'item_price' | 'delivery_cost' | 'tax_inclusion';

export const BASKET_COST_COMPONENTS: readonly BasketCostComponent[] = [
  'item_price',
  'delivery_cost',
  'tax_inclusion',
];

/** One line of a plan, served by exactly one offer. */
export interface BasketPlanLine {
  readonly lineId: string;
  readonly subjectRef: string;
  readonly offerRef: string;
  readonly merchantRef?: string;
  readonly quantity: number;
  readonly unitItemPrice: ComparisonMoneyFact;
  readonly lineItemPrice: ComparisonMoneyFact;
  readonly channel: ComparisonAcquisitionChannel;
  readonly conditionGroup?: ConditionGroup;
  readonly relationship?: OfferRelationshipStanding;
}

/**
 * One merchant's contribution to a plan.
 *
 * Delivery is priced PER MERCHANT rather than per line, because that is how a
 * merchant charges it — and pricing it per line is how a plan that looks
 * cheapest becomes the most expensive one at three checkouts.
 */
export interface BasketPlanMerchant {
  readonly merchantRef?: string;
  readonly channel: ComparisonAcquisitionChannel;
  readonly lineIds: readonly string[];
  readonly itemSubtotal: ComparisonMoneyFact;
  readonly delivery: ComparisonMoneyFact;
  /** The slowest quoted delivery in this merchant's lines, in days. */
  readonly deliveryMaxDays?: number;
  readonly taxInclusion: OfferTaxInclusion;
}

/**
 * Whether the solver PROVED this plan optimal (issue solver design rule 4).
 *
 * A STRING discriminant, and the approximate branch names why — a shopper being
 * told "this is the cheapest" and "this is the cheapest we could establish
 * within two seconds" are being told different things, and only one of them is
 * true.
 */
export type BasketOptimality =
  | { readonly status: 'proven_optimal' }
  | {
      readonly status: 'approximate';
      readonly reason: BasketApproximationReason;
      /** The best lower bound the search established, when it established one. */
      readonly lowerBound?: Money;
    };

/** Why optimality could not be proven. */
export type BasketApproximationReason =
  | 'candidate_limit_reached'
  | 'merchant_limit_reached'
  | 'time_limit_reached';

export const BASKET_APPROXIMATION_REASONS: readonly BasketApproximationReason[] = [
  'candidate_limit_reached',
  'merchant_limit_reached',
  'time_limit_reached',
];

/**
 * Why a line could not be served, or why a plan is what it is (issue result
 * types, "reason codes").
 *
 * One closed set for both, because a shopper reading "why is this item not in
 * my basket" and an operator reading "why did this plan pick three merchants"
 * are reading the same catalogue facts from two directions.
 */
export type BasketReasonCode =
  | 'no_eligible_offer'
  | 'no_offer_in_requested_condition'
  | 'no_offer_from_requested_merchant'
  | 'every_offer_from_excluded_merchant'
  | 'no_offer_in_channel_policy'
  | 'no_convertible_price'
  | 'quantity_exceeds_available_stock'
  | 'quantity_not_splittable'
  | 'merchant_limit_would_be_exceeded'
  | 'hard_constraint_failed'
  /** A #81 watchlist item a catalogue split left pointing at two products. */
  | 'watchlist_item_unresolved'
  | 'delivery_cost_unknown'
  | 'tax_inclusion_unknown'
  | 'objective_requires_complete_costs'
  | 'objective_requires_native_offer'
  | 'objective_requires_official_channel'
  | 'objective_requires_used_offer'
  | 'pickup_data_unavailable'
  | 'offer_no_longer_eligible'
  | 'offer_price_changed';

export const BASKET_REASON_CODES: readonly BasketReasonCode[] = [
  'no_eligible_offer',
  'no_offer_in_requested_condition',
  'no_offer_from_requested_merchant',
  'every_offer_from_excluded_merchant',
  'no_offer_in_channel_policy',
  'no_convertible_price',
  'quantity_exceeds_available_stock',
  'quantity_not_splittable',
  'merchant_limit_would_be_exceeded',
  'hard_constraint_failed',
  'watchlist_item_unresolved',
  'delivery_cost_unknown',
  'tax_inclusion_unknown',
  'objective_requires_complete_costs',
  'objective_requires_native_offer',
  'objective_requires_official_channel',
  'objective_requires_used_offer',
  'pickup_data_unavailable',
  'offer_no_longer_eligible',
  'offer_price_changed',
];

/** A line the plan could not cover, with every reason that applies. */
export interface BasketUnresolvedLine {
  readonly lineId: string;
  readonly canonicalProductId: string;
  readonly reasons: readonly BasketReasonCode[];
}

/**
 * One feasible plan.
 *
 * `planDigest` identifies the plan by CONTENT — the sorted offer refs and
 * quantities — so two solver runs that produce the same selection produce the
 * same digest, and a tie between two genuinely different plans is broken by
 * comparing digests rather than by whichever the loop reached first.
 */
export interface BasketPlan {
  readonly planDigest: string;
  readonly lines: readonly BasketPlanLine[];
  readonly merchants: readonly BasketPlanMerchant[];
  readonly merchantCount: number;
  readonly coveredLineIds: readonly string[];
  readonly unresolved: readonly BasketUnresolvedLine[];
  readonly itemSubtotal: BasketTotal;
  readonly deliveredTotal: BasketTotal;
  readonly currency: CurrencyCode;
  /** The coarsest freshness across every offer in the plan. */
  readonly freshness: ComparisonOfferFreshness;
  readonly taxInclusion: OfferTaxInclusion;
  /** The slowest known delivery across the plan's merchants, in days. */
  readonly deliveryMaxDays?: number;
}

/**
 * The eight named alternatives the issue asks for (§"Result types").
 *
 * `best_nearby_pickup` is in the tuple and is never produced: a basket request
 * carries no viewer position, so the result is always reported as
 * {@link BasketResultRefusal} with `pickup_data_unavailable`. Keeping it in the
 * vocabulary is what makes the seam visible — a result kind that is missing
 * from the tuple is a feature nobody notices is absent.
 */
export type BasketResultKind =
  | 'cheapest_known_item_prices'
  | 'cheapest_known_total'
  | 'fewest_merchants'
  | 'best_native_plan'
  | 'official_channel_plan'
  | 'best_nearby_pickup'
  | 'used_or_refurbished_value'
  | 'partial_coverage';

export const BASKET_RESULT_KINDS: readonly BasketResultKind[] = [
  'cheapest_known_item_prices',
  'cheapest_known_total',
  'fewest_merchants',
  'best_native_plan',
  'official_channel_plan',
  'best_nearby_pickup',
  'used_or_refurbished_value',
  'partial_coverage',
];

/** A named result that could not be produced, and why. */
export interface BasketResultRefusal {
  readonly kind: BasketResultKind;
  readonly state: 'refused';
  readonly reasons: readonly BasketReasonCode[];
}

/** A named result that WAS produced. */
export interface BasketResultPlan {
  readonly kind: BasketResultKind;
  readonly state: 'produced';
  readonly objective: BasketObjective;
  readonly optimality: BasketOptimality;
  readonly plan: BasketPlan;
  /** Everything worth saying about how this plan compares. */
  readonly reasons: readonly BasketReasonCode[];
}

export type BasketResult = BasketResultPlan | BasketResultRefusal;

/**
 * How a plan is actually transacted (issue solver design rule 8, UX rule 5).
 *
 * ONE native cart action at most, and a SEPARATE action per external merchant.
 * There is deliberately no combined "check out" member and no shape in which a
 * mixed plan is one transaction: a single action would imply Mercaria
 * guarantees an external merchant's final total, which UX rule 7 forbids by
 * name.
 */
export interface BasketPlanActions {
  /** Absent when the plan has no native line. */
  readonly nativeCart?: {
    readonly lines: readonly {
      readonly lineId: string;
      /** The native variant id a cart line is created from. */
      readonly productVariantId: string;
      readonly quantity: number;
    }[];
  };
  /** One per external merchant, each confirmed individually by the shopper. */
  readonly externalMerchants: readonly {
    readonly merchantRef?: string;
    readonly merchantLabel: string;
    readonly lineIds: readonly string[];
    /** The destination HOST. Composing a tracked URL is #37's, not this domain's. */
    readonly destinationHost?: string;
    readonly offerRefs: readonly string[];
  }[];
}

/**
 * The reproducible snapshot every result carries (issue solver design rule 6).
 *
 * `digest` is a sha-256 over a canonically ordered serialization of everything
 * the solver read: the request, the policy versions, the candidate set with its
 * prices, and the rates. Re-running the solver over the same snapshot produces
 * the same plans, byte for byte — which is what makes a stored or re-rendered
 * plan checkable rather than merely plausible.
 *
 * It is returned WITH the result and is deliberately not stored: a stored plan
 * served later is exactly the "stale plan presented as current" UX rule 9
 * forbids. What it is for is revalidation — the client hands it back and
 * {@link BasketRevalidation} says what moved.
 */
export interface BasketInputSnapshot {
  readonly digest: string;
  readonly policy: ComparisonPolicyIdentity;
  readonly evaluatedAt: string;
  readonly comparisonCurrency: CurrencyCode;
  readonly market?: string;
  readonly request: BasketRequest;
  readonly candidateOfferRefs: readonly string[];
  readonly rates: readonly FxRateSnapshot[];
  /**
   * Offer ref → every TERM the solve was performed against, as one string.
   *
   * The item price, the delivery cost and the free-shipping threshold, because
   * all three move a plan's numbers. Watching only the price would call a
   * merchant raising its delivery fee — or its free-over threshold above the
   * basket — `unchanged`, which is precisely the part a shopper was shown.
   */
  readonly candidateTerms: Readonly<Record<string, string>>;
}

/** The whole answer to "solve this basket". */
export interface BasketSolution {
  readonly snapshot: BasketInputSnapshot;
  readonly records: readonly ComparisonRecordRef[];
  readonly results: readonly BasketResult[];
  /** Actions keyed by result kind, so a client never composes them itself. */
  readonly actions: Readonly<Record<string, BasketPlanActions>>;
  readonly pickup?: BasketPickupResolution;
  /** How many candidate offers survived pruning — the solver's own honesty. */
  readonly candidateCount: number;
  /** How many distinct merchants the search considered. */
  readonly consideredMerchantCount: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Revalidation                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/** What changed about one planned line since the snapshot was taken. */
export type BasketLineRevalidation =
  | { readonly state: 'unchanged'; readonly lineId: string; readonly offerRef: string }
  | {
      readonly state: 'price_changed';
      readonly lineId: string;
      readonly offerRef: string;
      readonly wasRendered: string;
      readonly nowRendered: string;
    }
  | {
      readonly state: 'ineligible';
      readonly lineId: string;
      readonly offerRef: string;
      readonly reasons: readonly BasketReasonCode[];
    };

/**
 * The verdict a client must pass before navigating out or adding to the cart
 * (issue solver design rule 7).
 *
 * `mayProceed` is DERIVED from the line states inside the service and is
 * returned beside them, so a caller reading the flag and a caller reading the
 * lines cannot disagree — #94's constraint-verdict device.
 */
export interface BasketRevalidation {
  readonly snapshotDigest: string
  readonly revalidatedAt: string;
  readonly lines: readonly BasketLineRevalidation[];
  readonly mayProceed: boolean;
  /** Present when `mayProceed` is false. */
  readonly reasons: readonly BasketReasonCode[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure helpers every consumer shares                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a money fact carries an amount — the guard a caller must pass before
 * reading one.
 *
 * Exported because the solver, the table, the template renderer and the client
 * all need the same narrowing, and four hand-written `state === 'known'` checks
 * are four places to get it wrong.
 */
export function hasKnownComparisonMoney(
  fact: ComparisonMoneyFact,
): fact is Extract<ComparisonMoneyFact, { state: 'known' }> {
  return fact.state === 'known';
}

/**
 * Whether a PLAN's total is complete.
 *
 * The guard {@link BasketResultPlan} for `cheapest_known_total` is built
 * through, and the reason that result cannot be produced for a plan with
 * unknown shipping.
 *
 * Named `…PlanTotal` rather than `…BasketTotal` because #81 already exports the
 * latter for a WATCHLIST basket, whose total is a different type answering a
 * different question — its own `WatchlistBasketTotal`, with a basis and a
 * completeness this one does not have. Two guards with one name in the same
 * barrel is an ambiguous re-export; two guards with one name and two meanings
 * would be worse, because a caller that imported the wrong one would compile.
 */
export function hasKnownPlanTotal(
  total: BasketTotal,
): total is Extract<BasketTotal, { state: 'known' }> {
  return total.state === 'known';
}

/**
 * Whether a cell states a fact at all.
 *
 * `conflicting` deliberately answers FALSE: two sources disagreeing is not a
 * fact Mercaria is willing to state, which is #94's selection rule surfacing in
 * the table rather than being re-decided here.
 */
export function cellStatesAFact(
  cell: ComparisonCell,
): cell is Extract<ComparisonCell, { state: 'source_backed' | 'inferred' }> {
  return cell.state === 'source_backed' || cell.state === 'inferred';
}

/**
 * The coarser of two freshness readings.
 *
 * A plan is only as current as its least current offer, and there is exactly
 * one place that arithmetic happens so a summary and a line cannot disagree.
 */
export function coarserFreshness(
  a: ComparisonOfferFreshness,
  b: ComparisonOfferFreshness,
): ComparisonOfferFreshness {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  if (a === 'ageing' || b === 'ageing') return 'ageing';
  return 'current';
}

/**
 * Combine two tax-inclusion readings for a plan.
 *
 * `unknown` wins over everything and a DISAGREEMENT also answers `unknown`:
 * a plan half of whose merchants quote tax-inclusive prices has no single
 * comparable tax treatment, and reporting either one would misstate the other
 * half by whatever the rate happens to be.
 */
export function combineTaxInclusion(
  a: OfferTaxInclusion,
  b: OfferTaxInclusion,
): OfferTaxInclusion {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return a === b ? a : 'unknown';
}
