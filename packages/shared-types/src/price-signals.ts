/**
 * Trustworthy price signals and merchant competitiveness — issue #82.
 *
 * A **signal** is a CLAIM Mercaria makes about a price: "the lowest new price
 * observed in the last thirty days", "8% above the recent median", "good price".
 * #78 supplies the immutable observations and #74 supplies the eligible current
 * offers; what this module adds is the vocabulary in which such a claim may be
 * made, and — much more of it — the vocabulary in which Mercaria REFUSES to make
 * one.
 *
 * ## The failure mode that shapes everything here
 *
 * **A confident label computed off nothing.** Four shapes of it, and every
 * decision below exists to make one of them unrepresentable:
 *
 * 1. A "historic low" that is one retailer's decimal-point error.
 * 2. A "good price" derived from two observations, presented exactly like one
 *    derived from two hundred.
 * 3. A "lowest ever" that silently blends the used copy into the new one, or
 *    last year's euros into today's dollars.
 * 4. A syndicated feed republishing one merchant's offer five times, so a market
 *    of one reads as a market of five.
 *
 * ## The five distinctions this file makes STRUCTURAL
 *
 * 1. **`unmeasured` is a state, not a missing value.** {@link PriceSignal}'s
 *    unmeasured branch carries NO `value` and NO `evidence` — #74's
 *    `RankingSignalOutcome` device — so there is no arithmetic that can read a
 *    weak sample as a number, and no renderer that can show a label without
 *    switching on the discriminant first.
 * 2. **`not_present` is a MEASURED negative and is a different state.** "We
 *    looked and there was no material drop" and "we could not tell" lead a
 *    shopper to opposite conclusions, and collapsing them is precisely the
 *    dishonesty this issue is about.
 * 3. **Every published figure is a {@link PriceHistoryValue}, never a bare
 *    `Money`.** #78 made the FX basis a discriminant so a consumer cannot render
 *    a converted figure without seeing that it was converted; a signal that
 *    flattened it back to `Money` would undo that at the last hop, which is the
 *    hop a shopper actually reads.
 * 4. **Every signal NAMES its subject completely** — scope, segment, market,
 *    currency, range, and whether delivery is included ({@link PriceSignalSubject},
 *    every field required). Issue acceptance 1 is that type, not a review
 *    comment.
 * 5. **Commercial terms are unrepresentable as inputs.**
 *    {@link PRICE_SIGNAL_FORBIDDEN_INPUTS} names ten of them as VALUES, disjoint
 *    from {@link PRICE_SIGNAL_INPUTS}, and no field of any type here could carry
 *    one — statistical policy 10 held the way #74 holds its own.
 *
 * ## What this file deliberately does NOT define
 *
 * - **No ranking input.** A competitiveness score is not an ordering term
 *   (acceptance 6). `price-signal-isolation.test.ts` fails the build if any
 *   module under `services/ranking/` so much as names this domain.
 * - **No price WRITE.** A recommendation is informational
 *   ({@link PRICE_SIGNAL_RECOMMENDATION_KINDS}), and
 *   {@link PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS} names automatic repricing and
 *   sales promises as values that may never join it.
 * - **No competitor identity.** {@link MerchantCompetitivenessRow} has no field
 *   for one, which is the strongest available statement of "do not expose
 *   private competitor contract data".
 */

import type { ConditionGroup } from './condition';
import type { CurrencyCode } from './money';
import type { PriceHistoryValue, PriceSeriesMeasure, PriceSeriesScopeKind } from './price-history';

/* ────────────────────────────────────────────────────────────────────────── */
/* The policy                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The stable logical id every version of the signal policy shares.
 *
 * A code CONSTANT and never an environment variable, per the house rule every
 * other versioned policy in this codebase follows: a deployment able to name its
 * own key could publish a definition of "good price" that no other deployment
 * shares, and the version string an evaluation records would stop identifying
 * anything.
 */
export const PRICE_SIGNAL_POLICY_KEY = 'offer-price-signals';

/**
 * The lifecycle of one published signal policy.
 *
 * There is deliberately NO `canary`, which is the divergence from #74's
 * otherwise identical register. A ranking canary shows two shoppers two ORDERS
 * of the same offers, which is a difference of emphasis; a signal canary would
 * show two shoppers two contradictory CLAIMS about one price — one told it is a
 * good price and one told it is not — with nothing on either page saying a
 * rollout is in progress. Comparison between versions is answered instead by
 * running a candidate version over a cohort and reading both sets of numbers
 * (issue monitoring 6), which needs no shopper to see the candidate at all.
 */
export type PriceSignalPolicyStatus = 'draft' | 'active' | 'superseded' | 'archived';

export const PRICE_SIGNAL_POLICY_STATUSES: readonly PriceSignalPolicyStatus[] = [
  'draft',
  'active',
  'superseded',
  'archived',
];

/**
 * The smallest number of distinct sellers a policy may call a MARKET.
 *
 * Three, and the reason is not disclosure: every offer this domain reads is one
 * a shopper can already see on `/offer-comparison`, so a median over them
 * discloses nothing that is not already published. The reason is that the WORD
 * has to mean something. A "market median" over two sellers is one competitor's
 * price wearing a statistical name, and a merchant told they are "12% above the
 * market" would be reading a comparison against a single rival with no way to
 * know it.
 *
 * It is a CHECK on the policy table, not a default, so no published version can
 * go below it.
 */
export const PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR = 3;

/**
 * Below how many subjects an operator-facing DISTRIBUTION is withheld rather
 * than disclosed (#80's `PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR`, same figure and
 * same reasoning).
 *
 * It applies to the monitoring breakdowns — label distribution by source, by
 * category, by market — and not to a signal itself. A breakdown over a source
 * carrying four products is that source's catalogue with a percentage sign on
 * it; a signal over the same products is a statement about prices that source
 * publishes publicly.
 */
export const PRICE_SIGNAL_DISTRIBUTION_DISCLOSURE_FLOOR = 10;

/** A distribution bucket, disclosed or withheld — never rounded to nothing. */
export type PriceSignalDisclosedCount =
  | { readonly disclosed: true; readonly count: number }
  | { readonly disclosed: false; readonly floor: number };

/**
 * Disclose a distribution count, or say it is below the floor.
 *
 * A WITHHELD state rather than a zero, so a renderer must write the branch out
 * loud instead of showing a number that reads as "nobody".
 */
export function disclosePriceSignalCount(count: number): PriceSignalDisclosedCount {
  if (count >= PRICE_SIGNAL_DISTRIBUTION_DISCLOSURE_FLOOR) return { disclosed: true, count };
  return { disclosed: false, floor: PRICE_SIGNAL_DISTRIBUTION_DISCLOSURE_FLOOR };
}

/**
 * Everything a version of the policy decides, as a value the pure derivation
 * takes.
 *
 * The table is the authority and this is its projection; the derivation reads
 * this and never a configuration object, which is what makes every signal
 * reproducible from `(observations, policy version)` and nothing else
 * (acceptance 4).
 */
export interface PriceSignalPolicy {
  readonly policyKey: string;
  readonly version: string;
  /** Sample floors — issue statistical policy 4. All four must be cleared. */
  readonly minObservations: number;
  readonly minDistinctSellers: number;
  readonly minDistinctOffers: number;
  readonly minCoverageDays: number;
  /** How far back "recent" reaches, in days. */
  readonly recentWindowDays: number;
  /**
   * The modified z-score above which an observation is an OUTLIER (issue
   * statistical policy 5).
   *
   * Iglewicz–Hoaglin: `0.6745 × (x − median) / MAD`, conventionally 3.5. A
   * documented robust method with a citable constant, rather than a percentile
   * trim somebody chose because it removed the number they disliked.
   */
  readonly outlierModifiedZThreshold: number;
  /**
   * How far from the median an observation must ALSO be before the z-score may
   * exclude it, in basis points (issue statistical policy 5 and 6).
   *
   * The outlier rule is a CONJUNCTION, and each half is wrong on its own:
   *
   * - The **z-score alone** deletes every real discount on a tight market.
   *   Measured: twelve retailers within 2% of each other give a MAD of ten minor
   *   units, and a genuine half-price sale scores a modified z of 33 — so
   *   "recent low", the signal that exists to report a sale, would report
   *   everything except the sale.
   * - The **relative floor alone** deletes a legitimate low on a volatile
   *   market, where a 90% spread between sellers is ordinary.
   *
   * Together they say "far from the rest of this sample AND far enough that it
   * cannot be a promotion", which is the distinction issue statistical policy 6
   * asks for by name: separate a sale price from invalid zero or scale-error
   * data. #78 reached the same place from the other side with
   * `PRICE_SCALE_SHIFT_FACTOR` — a catalogue-wide half-price sale moves a price
   * by two and a minor/major units error moves it by a hundred.
   *
   * It is a POLICY column rather than a constant precisely because it is where
   * "a deep discount" ends and "a data error" begins, which is a judgement
   * somebody has to publish, version and be able to roll back.
   */
  readonly outlierMinDeviationBps: number;
  /** How far a price must fall against a prior valid observation to be MATERIAL. */
  readonly materialDropBps: number;
  /** The band around the median that reads as `near` / `typical_price`. */
  readonly typicalBandBps: number;
  /** How far BELOW the median a price must sit to read as `good_price`. */
  readonly goodPriceBelowMedianBps: number;
  /**
   * The multiple of every floor a sample must clear before a label is `strong`
   * rather than merely `sufficient`.
   */
  readonly strongSampleMultiplier: number;
  /** #77 metric keys this version is judged on, and what may not get worse. */
  readonly objectiveMetricKeys: readonly string[];
  readonly guardrailMetricKeys: readonly string[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* What a signal may and may not be computed from                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The facts a signal derivation is allowed to read (issue statistical policy
 * 1–6).
 *
 * Every one is either an immutable #78 observation, a live #74 eligibility
 * verdict, or a #90 condition segment. There is no member for anything a
 * merchant pays for, and there is no member for anything a buyer did.
 */
export type PriceSignalInput =
  | 'eligible_offer_price'
  | 'eligible_offer_delivery_cost'
  | 'offer_price_observation'
  | 'observation_freshness'
  | 'observation_anomaly_flag'
  | 'condition_segment'
  | 'market_scope'
  | 'currency_conversion_quote'
  | 'seller_identity'
  | 'verified_official_channel';

export const PRICE_SIGNAL_INPUTS: readonly PriceSignalInput[] = [
  'eligible_offer_price',
  'eligible_offer_delivery_cost',
  'offer_price_observation',
  'observation_freshness',
  'observation_anomaly_flag',
  'condition_segment',
  'market_scope',
  'currency_conversion_quote',
  'seller_identity',
  'verified_official_channel',
];

/**
 * What may never enter a signal calculation, stated as VALUES (issue
 * statistical policy 10, acceptance 6).
 *
 * DISJOINT from {@link PRICE_SIGNAL_INPUTS} — the `RetailCostComponentKind`
 * device — and asserted so by a test with a floor on both sides. The list is not
 * where the prohibition is ENFORCED (no type here has a field for one of them,
 * and `price-signal-isolation.test.ts` fails the build on a reachable import);
 * it is where the prohibition is written down in a form a test can walk, so a
 * plausible future addition to the allowed set fails the build rather than
 * passing review.
 */
export type PriceSignalForbiddenInput =
  | 'affiliate_commission'
  | 'commission_rate'
  | 'merchant_plan'
  | 'plan_tier'
  | 'sponsored_placement'
  | 'referral_attribution'
  | 'marketplace_fee'
  | 'retail_margin'
  | 'ledger_balance'
  | 'buyer_identity';

export const PRICE_SIGNAL_FORBIDDEN_INPUTS: readonly PriceSignalForbiddenInput[] = [
  'affiliate_commission',
  'commission_rate',
  'merchant_plan',
  'plan_tier',
  'sponsored_placement',
  'referral_attribution',
  'marketplace_fee',
  'retail_margin',
  'ledger_balance',
  'buyer_identity',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* The subject — what a signal is ABOUT                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Whose "current price" a signal compares against.
 *
 * `market_best` is the cheapest eligible offer — what a shopper on the product
 * page would actually pay. `seller` is one merchant's own offer, which is the
 * merchant surface's question and a different one. The same derivation answers
 * both; recording WHICH is what stops a merchant's dashboard figure and a
 * shopper's badge being read as the same claim.
 */
export type PriceSignalFocus = 'market_best' | 'seller';

/**
 * Everything a signal is about — issue §"User-facing signals": "Every signal
 * names variant, condition, market, currency basis, time range and whether
 * shipping or tax is included."
 *
 * Every field is REQUIRED except the two that are genuinely optional facts
 * (`market`, and the scope id the other kind does not use). A subject with an
 * absent segment or an absent currency is exactly the "one unlabeled signal"
 * acceptance 1 forbids, so there is no shape here that could carry one.
 */
export interface PriceSignalSubject {
  readonly scopeKind: PriceSeriesScopeKind;
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  /** #90's SEGMENT, never a condition key: a chart mixes models, not copies. */
  readonly segment: ConditionGroup;
  /** ISO 3166-1 alpha-2, or absent for "every market this is offered in". */
  readonly market?: string;
  /** The currency every figure in this signal is expressed in. */
  readonly currency: CurrencyCode;
  /** The #78 measure the historical half was drawn from. */
  readonly measure: PriceSeriesMeasure;
  /** Whether the figures include a published delivery cost. */
  readonly deliveryIncluded: boolean;
  /**
   * Whether the figures include tax.
   *
   * `unknown` for every row today and stated rather than omitted: `offers`
   * records no tax-inclusion fact (#78's seam, #74's `resolveOfferTaxInclusion`),
   * and a signal that quietly said `exclusive` would be asserting a 21% error in
   * half of Europe.
   */
  readonly taxInclusion: 'inclusive' | 'exclusive' | 'unknown';
  /** The named time range, inclusive of both ends, as ISO instants. */
  readonly from: string;
  readonly to: string;
  readonly focus: PriceSignalFocus;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The sample — the confidence half of every claim                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What the claim was computed FROM (issue statistical policy 4 and 9, merchant
 * competitiveness 8).
 *
 * Carried on the unmeasured branch too, which is the point: "we could not tell"
 * is far more useful beside "from 2 observations across 1 seller" than on its
 * own, and it is what lets a merchant see that a comparison is weak rather than
 * absent.
 */
export interface PriceSignalSample {
  /** Eligible observations that survived deduplication and outlier exclusion. */
  readonly observations: number;
  /** Distinct SELLERS, after source-aware deduplication (statistical policy 3). */
  readonly distinctSellers: number;
  /** Distinct offer rows behind them, BEFORE deduplication. */
  readonly distinctOffers: number;
  /** Days between the first and last surviving observation. */
  readonly coverageDays: number;
  /** How many observations the robust method set aside — never deleted. */
  readonly outliersExcluded: number;
  /** How many observations deduplication folded into another seller's. */
  readonly deduplicated: number;
}

/**
 * Why a signal could not be computed.
 *
 * Every member is a fact about the DATA or about the policy, never about a
 * failure to try. There is deliberately no `error` and no `other`: a reason
 * nobody can act on is a reason nobody will read.
 */
export type PriceSignalUnmeasuredReason =
  | 'no_active_policy'
  | 'insufficient_observations'
  | 'insufficient_distinct_sellers'
  | 'insufficient_distinct_offers'
  | 'insufficient_time_coverage'
  | 'no_eligible_current_offer'
  | 'no_comparable_history'
  | 'currency_not_convertible'
  | 'segment_not_applicable'
  | 'measure_not_applicable'
  | 'demand_measurement_unavailable';

export const PRICE_SIGNAL_UNMEASURED_REASONS: readonly PriceSignalUnmeasuredReason[] = [
  'no_active_policy',
  'insufficient_observations',
  'insufficient_distinct_sellers',
  'insufficient_distinct_offers',
  'insufficient_time_coverage',
  'no_eligible_current_offer',
  'no_comparable_history',
  'currency_not_convertible',
  'segment_not_applicable',
  'measure_not_applicable',
  'demand_measurement_unavailable',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* The signals                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The seven signals, which are the issue's eight minus the one that is a
 * DIMENSION rather than a signal.
 *
 * Issue §"User-facing signals" item 7 — "used or refurbished value signals kept
 * separate from new" — is not a seventh kind of claim, it is
 * {@link PriceSignalSubject.segment} being part of every signal's identity. #78
 * made the same reading of its own list and for the same reason: modelling it as
 * a value would leave `open_box` (which #90 has and the prose does not)
 * unrepresentable without a vocabulary change.
 *
 * - `lowest_observed_item_price` — item 1.
 * - `lowest_observed_known_total` — item 2. Sparser than the one above BY
 *   DESIGN: an offer whose delivery nobody published is excluded rather than
 *   treated as free.
 * - `current_vs_recent_median` — item 3, and TEMPORAL: the current price against
 *   the median of the recent history. Its cross-seller cousin is
 *   `MerchantCompetitivenessInsightKind.position_vs_eligible_median`, and the
 *   two are deliberately different signals with different names, because "cheap
 *   for this product lately" and "cheap compared with other sellers today" are
 *   different claims that a shopper would otherwise be unable to tell apart.
 * - `material_price_drop` — item 4. Against a prior VALID observation, so a
 *   scale error cannot manufacture one.
 * - `typical_recent_range` — item 5. The inter-quartile range of the
 *   outlier-filtered sample, at NEAREST RANK, so both endpoints are prices
 *   somebody actually published.
 * - `official_store_position` — item 6. Defined only for the `new` segment,
 *   because the issue's own phrasing is "relative to other new offers".
 * - `price_quality_label` — item 8, backed by {@link PriceSignalPolicy}'s
 *   thresholds and by {@link PriceQualityConfidence}.
 */
export type PriceSignalKind =
  | 'lowest_observed_item_price'
  | 'lowest_observed_known_total'
  | 'current_vs_recent_median'
  | 'material_price_drop'
  | 'typical_recent_range'
  | 'official_store_position'
  | 'price_quality_label';

export const PRICE_SIGNAL_KINDS: readonly PriceSignalKind[] = [
  'lowest_observed_item_price',
  'lowest_observed_known_total',
  'current_vs_recent_median',
  'material_price_drop',
  'typical_recent_range',
  'official_store_position',
  'price_quality_label',
];

/** Which #78 measure each signal reads, as a TABLE the derivation consults. */
export const PRICE_SIGNAL_MEASURE: Readonly<Record<PriceSignalKind, PriceSeriesMeasure>> = {
  lowest_observed_item_price: 'lowest_item_price',
  lowest_observed_known_total: 'lowest_known_total',
  current_vs_recent_median: 'lowest_item_price',
  material_price_drop: 'lowest_item_price',
  typical_recent_range: 'lowest_item_price',
  official_store_position: 'official_store_item_price',
  price_quality_label: 'lowest_item_price',
};

/**
 * Where a price sits against a reference.
 *
 * Three values and no fourth: `near` is the policy's band and exists so a price
 * one minor unit above the median is not reported as "above market", which is
 * the shape that makes a merchant chase a number rather than read a comparison.
 */
export type PriceMarketPosition = 'below' | 'near' | 'above';

export const PRICE_MARKET_POSITIONS: readonly PriceMarketPosition[] = ['below', 'near', 'above'];

/**
 * The label issue item 8 asks for, and nothing stronger.
 *
 * There is no `great_price`, no `lowest_ever` and no `deal` — a superlative is a
 * claim about every offer that has ever existed, and the sample this domain has
 * is the one it can see.
 */
export type PriceQualityLabel = 'good_price' | 'typical_price' | 'above_typical';

export const PRICE_QUALITY_LABELS: readonly PriceQualityLabel[] = [
  'good_price',
  'typical_price',
  'above_typical',
];

/**
 * How strong the sample behind a label is.
 *
 * TWO values, and the absence of a third is acceptance 3: a sample that does not
 * clear the policy's floors produces no label at all, so there is no `low` for a
 * renderer to show in smaller type beside a confident-looking badge.
 */
export type PriceQualityConfidence = 'sufficient' | 'strong';

export const PRICE_QUALITY_CONFIDENCES: readonly PriceQualityConfidence[] = [
  'sufficient',
  'strong',
];

/**
 * One signal's value.
 *
 * A discriminated union on `measure` rather than a bag of optional fields, so a
 * renderer handling `money_range` cannot accidentally read a `label`. Every
 * money figure is a {@link PriceHistoryValue}: the FX basis survives all the way
 * to the badge, which is the hop that matters.
 */
export type PriceSignalValue =
  | { readonly measure: 'money'; readonly value: PriceHistoryValue }
  | {
      readonly measure: 'money_range';
      readonly low: PriceHistoryValue;
      readonly high: PriceHistoryValue;
    }
  | {
      readonly measure: 'relative';
      readonly current: PriceHistoryValue;
      readonly reference: PriceHistoryValue;
      /** Signed basis points: negative is cheaper than the reference. */
      readonly deltaBps: number;
      readonly position: PriceMarketPosition;
    }
  | {
      readonly measure: 'drop';
      readonly current: PriceHistoryValue;
      readonly previous: PriceHistoryValue;
      /** Always negative — a `material_price_drop` that rose is `not_present`. */
      readonly deltaBps: number;
    }
  | {
      readonly measure: 'label';
      readonly current: PriceHistoryValue;
      readonly reference: PriceHistoryValue;
      readonly deltaBps: number;
      readonly label: PriceQualityLabel;
      readonly confidence: PriceQualityConfidence;
    };

/**
 * The observations and offers a measured signal was computed from (issue
 * statistical policy 9).
 *
 * The observations are immutable, so carrying their ids IS preserving them — a
 * copy of the amounts beside them would be a second representation of a fact
 * that cannot change, which is the one thing worth never duplicating.
 * `excludedOutlierObservationIds` is what makes "handle outliers with a
 * documented robust method rather than deleting inconvenient data" checkable:
 * the excluded rows are named, not dropped.
 */
export interface PriceSignalEvidence {
  readonly observationIds: readonly string[];
  readonly offerIds: readonly string[];
  readonly excludedOutlierObservationIds: readonly string[];
}

/**
 * One signal.
 *
 * THREE states, and the middle one is the one people forget:
 *
 * - `measured` — the claim holds, and carries its value and its evidence.
 * - `not_present` — the derivation RAN and the condition does not hold. There
 *   was no material drop; no verified official store publishes an offer. It
 *   carries the sample (which is what proves it ran) and no value.
 * - `unmeasured` — the sample could not support a claim either way. It carries
 *   the sample and a reason and no value.
 *
 * Only the `measured` branch has a `value` or an `evidence`, so a consumer that
 * wants a number must switch on the discriminant, and a consumer that forgets to
 * gets a type error rather than `undefined`.
 */
export type PriceSignal =
  | {
      readonly kind: PriceSignalKind;
      readonly state: 'measured';
      readonly subject: PriceSignalSubject;
      readonly sample: PriceSignalSample;
      readonly policyVersion: string;
      readonly value: PriceSignalValue;
      readonly evidence: PriceSignalEvidence;
    }
  | {
      readonly kind: PriceSignalKind;
      readonly state: 'not_present';
      readonly subject: PriceSignalSubject;
      readonly sample: PriceSignalSample;
      readonly policyVersion: string;
    }
  | {
      readonly kind: PriceSignalKind;
      readonly state: 'unmeasured';
      readonly subject: PriceSignalSubject;
      readonly sample: PriceSignalSample;
      readonly reason: PriceSignalUnmeasuredReason;
      /** Absent exactly when the reason is `no_active_policy`. */
      readonly policyVersion?: string;
    };

/**
 * What the numbers MEAN, shipped beside them.
 *
 * #78's `PriceHistorySemantics` one layer up, and for the same reason the
 * analytics domain refuses to serve a metric whose definition is unstated: a
 * "good price" that does not say what it was compared against, over what window,
 * after what exclusions, is a badge rather than information.
 */
export interface PriceSignalSemantics {
  readonly policyKey: string;
  readonly policyVersion: string;
  readonly outlierMethod: 'modified_z_score_over_median_absolute_deviation';
  readonly outlierThreshold: number;
  /** The relative floor the z-score is CONJOINED with — see the policy field. */
  readonly outlierMinDeviationBps: number;
  readonly quantileMethod: 'nearest_rank_over_observed_values';
  readonly deduplication: 'one_offer_per_distinct_seller';
  readonly minObservations: number;
  readonly minDistinctSellers: number;
  readonly minDistinctOffers: number;
  readonly minCoverageDays: number;
  readonly typicalBandBps: number;
  readonly goodPriceBelowMedianBps: number;
  readonly materialDropBps: number;
}

/** What a public read of a product's signals returns. */
export interface PriceSignalsResponse {
  readonly subject: PriceSignalSubject;
  /** Absent when no policy version is active — every signal is then unmeasured. */
  readonly semantics?: PriceSignalSemantics;
  readonly signals: readonly PriceSignal[];
  /** Plain sentences a screen reader can read in order (issue UI 5). */
  readonly explanation: readonly string[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Recommendations                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The deterministic, informational recommendations issue §"Recommendations"
 * names — its own four, verbatim in intent.
 *
 * Each is DERIVED from a signal or a competitiveness row that has already been
 * computed, so a recommendation can never assert something the signals do not.
 */
export type PriceSignalRecommendationKind =
  | 'above_eligible_median'
  | 'delivery_unknown_blocks_known_total'
  | 'refresh_would_restore_eligibility'
  | 'would_be_cheapest_item_price';

export const PRICE_SIGNAL_RECOMMENDATION_KINDS: readonly PriceSignalRecommendationKind[] = [
  'above_eligible_median',
  'delivery_unknown_blocks_known_total',
  'refresh_would_restore_eligibility',
  'would_be_cheapest_item_price',
];

/**
 * What a recommendation may never be, as VALUES disjoint from the set above.
 *
 * "Do not automatically change merchant prices. Do not promise a sales outcome."
 * Both halves are here, plus the three adjacent things a later reader would
 * reach for first. `price-signal-isolation.test.ts` asserts the disjointness with
 * a floor on both sides, and separately asserts that no module in the domain
 * imports a catalogue WRITE.
 */
export type PriceSignalForbiddenRecommendation =
  | 'set_merchant_price'
  | 'auto_reprice'
  | 'guarantee_sales_outcome'
  | 'guarantee_ranking_position'
  | 'purchase_placement';

export const PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS: readonly PriceSignalForbiddenRecommendation[] =
  [
    'set_merchant_price',
    'auto_reprice',
    'guarantee_sales_outcome',
    'guarantee_ranking_position',
    'purchase_placement',
  ];

/**
 * One recommendation.
 *
 * It carries the FACTS and never the sentence: the copy lives in `@mercaria/ui`
 * `lib/price-signal-labels.ts`, keyed on the kind, so two surfaces rendering the
 * same recommendation cannot drift and a wording change is not a contract
 * change (#74's `offer-labels.ts` rule).
 */
export interface PriceSignalRecommendation {
  readonly kind: PriceSignalRecommendationKind;
  readonly subject: PriceSignalSubject;
  /** Signed basis points, where the recommendation is about a distance. */
  readonly deltaBps?: number;
  /** The signal this was derived from, so it can never assert more than one. */
  readonly derivedFrom: PriceSignalKind | MerchantCompetitivenessInsightKind;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Merchant competitiveness                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The insights issue §"Merchant competitiveness" names, one member each.
 *
 * Item 7 — "market and condition scope for every comparison" — is not a member:
 * it is {@link PriceSignalSubject} on every row. Item 8 — "coverage and
 * confidence" — is {@link PriceSignalSample} on every row. Both are properties
 * the shape carries rather than insights a merchant asks for.
 */
export type MerchantCompetitivenessInsightKind =
  | 'position_vs_eligible_median'
  | 'cheapest_item_price'
  | 'cheapest_known_total'
  | 'losing_eligibility'
  | 'demand_without_native_offer'
  | 'own_price_movement'
  | 'official_channel_position';

export const MERCHANT_COMPETITIVENESS_INSIGHT_KINDS: readonly MerchantCompetitivenessInsightKind[] =
  [
    'position_vs_eligible_median',
    'cheapest_item_price',
    'cheapest_known_total',
    'losing_eligibility',
    'demand_without_native_offer',
    'own_price_movement',
    'official_channel_position',
  ];

/**
 * Why a merchant's offer is losing eligibility (competitiveness item 3).
 *
 * A NARROWING of #74's exclusion reasons to the ones a merchant can act on, and
 * the narrowing is the point: `merchant_suppressed` and `listing_restricted` are
 * moderation decisions with their own notification path, and repeating them on a
 * competitiveness dashboard would be a second channel for a decision that has
 * one.
 */
export type MerchantEligibilityLossReason =
  | 'observation_stale'
  | 'availability_unknown'
  | 'delivery_cost_unknown'
  | 'destination_missing'
  | 'condition_unknown'
  | 'price_missing';

export const MERCHANT_ELIGIBILITY_LOSS_REASONS: readonly MerchantEligibilityLossReason[] = [
  'observation_stale',
  'availability_unknown',
  'delivery_cost_unknown',
  'destination_missing',
  'condition_unknown',
  'price_missing',
];

/**
 * One row of a merchant's own competitiveness analysis.
 *
 * ## What is NOT here is the security property
 *
 * There is no competitor id, no competitor name, no competitor price, no
 * commission, no plan, no buyer and no source credential — and
 * {@link MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS} states that as a VALUE a
 * test walks a REAL emitted response against, because a static scan catches a
 * declared field and only a runtime walk catches one a serializer spread in
 * (#92's two-gate rule).
 *
 * The market reference IS disclosed, as a {@link PriceHistoryValue}, and that is
 * deliberate rather than an oversight: every offer behind it is one Mercaria
 * already publishes on `/offer-comparison`, so withholding the aggregate would
 * protect nothing while making the comparison unreadable. What the floor of
 * {@link PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR} protects is the word "market".
 */
export interface MerchantCompetitivenessRow {
  readonly kind: MerchantCompetitivenessInsightKind;
  readonly subject: PriceSignalSubject;
  readonly sample: PriceSignalSample;
  readonly state: 'measured' | 'not_present' | 'unmeasured';
  /** Present exactly on `measured`. */
  readonly value?: PriceSignalValue;
  /** Present exactly on `unmeasured`. */
  readonly reason?: PriceSignalUnmeasuredReason;
  /** Present exactly on a measured `losing_eligibility`. */
  readonly eligibilityLossReasons?: readonly MerchantEligibilityLossReason[];
  /** The merchant's OWN offer this row is about. Never a competitor's. */
  readonly offerId?: string;
}

/** Field names that may never appear in a competitiveness DTO. */
export const MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS: readonly string[] = [
  'competitorMerchantId',
  'competitorMerchantName',
  'competitorOfferId',
  'competitorPrice',
  'competitorContract',
  'commission',
  'commissionAmount',
  'commissionRate',
  'merchantPlan',
  'planTier',
  'buyerId',
  'oxyUserId',
  'buyerEmail',
  'sourceFeedUrl',
  'sourceCredential',
  'rawPayload',
];

/** What a merchant's competitiveness read returns. */
export interface MerchantCompetitivenessResponse {
  readonly merchantId: string;
  readonly semantics?: PriceSignalSemantics;
  readonly rows: readonly MerchantCompetitivenessRow[];
  readonly recommendations: readonly PriceSignalRecommendation[];
  /** Everything the read could not answer, so a weak page is legible as one. */
  readonly coverage: {
    readonly subjectsExamined: number;
    readonly subjectsMeasured: number;
    readonly subjectsUnmeasured: number;
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Correction reports (issue monitoring 4)                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What a merchant says is wrong with a signal about their own offer.
 *
 * A closed set, because free text cannot be counted and issue monitoring 4 asks
 * for correction reports as a MEASURE of the policy. The note beside it is for a
 * person; the code is what a distribution is built from.
 */
export type PriceSignalFeedbackReason =
  | 'stale_observation'
  | 'wrong_condition'
  | 'wrong_currency'
  | 'duplicate_offer'
  | 'scale_error'
  | 'not_our_offer'
  | 'outdated_delivery_cost';

export const PRICE_SIGNAL_FEEDBACK_REASONS: readonly PriceSignalFeedbackReason[] = [
  'stale_observation',
  'wrong_condition',
  'wrong_currency',
  'duplicate_offer',
  'scale_error',
  'not_our_offer',
  'outdated_delivery_cost',
];

/**
 * The lifecycle of a correction report.
 *
 * `resolved` and `rejected` are both CLOSED, and the difference is recorded
 * rather than derived: "we changed something" and "we did not" are the two
 * answers a merchant is owed, and a single `closed` state would make the
 * correction rate — the number monitoring 4 exists to produce — unreadable.
 */
export type PriceSignalFeedbackStatus = 'open' | 'resolved' | 'rejected';

export const PRICE_SIGNAL_FEEDBACK_STATUSES: readonly PriceSignalFeedbackStatus[] = [
  'open',
  'resolved',
  'rejected',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* Monitoring                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** Whether a recorded sweep is the live measurement or a candidate's dry run. */
export type PriceSignalRunMode = 'monitor' | 'candidate_comparison';

export const PRICE_SIGNAL_RUN_MODES: readonly PriceSignalRunMode[] = [
  'monitor',
  'candidate_comparison',
];

export type PriceSignalRunStatus = 'pending' | 'processing' | 'done' | 'failed';

export const PRICE_SIGNAL_RUN_STATUSES: readonly PriceSignalRunStatus[] = [
  'pending',
  'processing',
  'done',
  'failed',
];

/** One dimension a label distribution may be broken down by (issue monitoring 2). */
export type PriceSignalDistributionDimension = 'source' | 'category' | 'market';

export const PRICE_SIGNAL_DISTRIBUTION_DIMENSIONS: readonly PriceSignalDistributionDimension[] = [
  'source',
  'category',
  'market',
];

/** Coverage and the insufficient-data rate (issue monitoring 1). */
export interface PriceSignalCoverageMetrics {
  readonly runId: string;
  readonly policyVersion: string;
  readonly mode: PriceSignalRunMode;
  readonly subjectsScanned: number;
  readonly signalsEvaluated: number;
  readonly signalsMeasured: number;
  readonly signalsNotPresent: number;
  readonly signalsUnmeasured: number;
  /** Measured ÷ evaluated. Absent when nothing was evaluated at all. */
  readonly coverageRate?: number;
  /** Unmeasured ÷ evaluated. Absent for the same reason. */
  readonly insufficientDataRate?: number;
  /** Why the unmeasured ones were, so a falling coverage rate is diagnosable. */
  readonly unmeasuredByReason: Readonly<Record<string, number>>;
  /**
   * The evaluated count read back off the EVIDENCE rows rather than off the
   * run's own counter, and whether the two agree.
   *
   * #60's `scannedFromRecords` device: a sweep whose page swallowed a subject
   * reports a perfectly healthy run, and the only thing that can see it is a
   * second count taken from what was actually written.
   */
  readonly signalsFromRecords: number;
  readonly countsAgree: boolean;
}

/** One bucket of a label distribution (issue monitoring 2). */
export interface PriceSignalDistributionBucket {
  readonly dimension: PriceSignalDistributionDimension;
  /** The source id, category id or market code. Never a person. */
  readonly key: string;
  readonly label: PriceQualityLabel | 'unlabelled';
  readonly count: PriceSignalDisclosedCount;
}

/**
 * A sudden mass change between two runs of the same policy (issue monitoring 3).
 *
 * Reported, never repaired. #82's own framing is "sudden mass signal changes
 * AFTER policy or feed updates" — the interesting fact is the coincidence, and a
 * domain that reacted to it would be a domain that suppresses evidence of its
 * own instability.
 */
export interface PriceSignalMassChangeFinding {
  readonly kind: PriceSignalKind;
  readonly previousRunId: string;
  readonly currentRunId: string;
  readonly subjectsCompared: number;
  readonly subjectsChanged: number;
  readonly changeRate: number;
  /** Whether the two runs ran under DIFFERENT policy versions. */
  readonly policyVersionChanged: boolean;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Derivations                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A signed basis-point distance from a reference.
 *
 * Integer basis points and never a float ratio: a percentage rendered from a
 * float differs in its last digit between two clients, and the badge a shopper
 * screenshots has to match the one a merchant is shown. Half-away-from-zero, so
 * a rise and an equal fall round symmetrically.
 */
export function priceDeltaBps(current: number, reference: number): number {
  if (reference === 0) return 0;
  const raw = ((current - reference) / reference) * 10_000;
  return raw < 0 ? -Math.round(-raw) : Math.round(raw);
}

/**
 * Where a delta sits against the policy's `near` band.
 *
 * The band is SYMMETRIC and inclusive at both ends, so a price exactly on the
 * band edge is `near` rather than being pushed to whichever side an operator's
 * rounding happened to favour.
 */
export function priceMarketPositionFor(deltaBps: number, bandBps: number): PriceMarketPosition {
  if (deltaBps < -bandBps) return 'below';
  if (deltaBps > bandBps) return 'above';
  return 'near';
}

/**
 * The label for a price against a reference, under a policy.
 *
 * `good_price` requires a strictly LARGER discount than the `near` band, which
 * is why {@link PriceSignalPolicy.goodPriceBelowMedianBps} is CHECK-constrained
 * to be at least the band: otherwise the two verdicts would overlap and one
 * price would satisfy both, with the answer decided by the order of the
 * comparisons.
 */
export function priceQualityLabelFor(
  deltaBps: number,
  policy: Pick<PriceSignalPolicy, 'typicalBandBps' | 'goodPriceBelowMedianBps'>,
): PriceQualityLabel {
  if (deltaBps <= -policy.goodPriceBelowMedianBps) return 'good_price';
  if (deltaBps > policy.typicalBandBps) return 'above_typical';
  return 'typical_price';
}

/**
 * Whether a sample clears every floor the policy sets, and which one it failed.
 *
 * Returns the FIRST unmet floor in a fixed order rather than a list, and the
 * order is the one a merchant can act on: more observations, then more sellers,
 * then more offers, then more time. A caller wanting them all can read the
 * sample, which travels with every signal.
 */
export function priceSampleShortfall(
  sample: PriceSignalSample,
  policy: PriceSignalPolicy,
): PriceSignalUnmeasuredReason | undefined {
  if (sample.observations < policy.minObservations) return 'insufficient_observations';
  if (sample.distinctSellers < policy.minDistinctSellers) return 'insufficient_distinct_sellers';
  if (sample.distinctOffers < policy.minDistinctOffers) return 'insufficient_distinct_offers';
  if (sample.coverageDays < policy.minCoverageDays) return 'insufficient_time_coverage';
  return undefined;
}

/**
 * `strong` when the sample clears every floor by the policy's multiple.
 *
 * All four, not any: a hundred observations from one seller is a long record of
 * one shop's pricing, and calling it a strong market sample is exactly the
 * over-claim the multiplier exists to prevent.
 */
export function priceQualityConfidenceFor(
  sample: PriceSignalSample,
  policy: PriceSignalPolicy,
): PriceQualityConfidence {
  const multiple = policy.strongSampleMultiplier;
  const strong =
    sample.observations >= policy.minObservations * multiple &&
    sample.distinctSellers >= policy.minDistinctSellers * multiple &&
    sample.distinctOffers >= policy.minDistinctOffers * multiple &&
    sample.coverageDays >= policy.minCoverageDays * multiple;
  return strong ? 'strong' : 'sufficient';
}
