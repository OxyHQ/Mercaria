/**
 * Currency-safe offer price history and product-level trends — issue #78,
 * closing the seam ADR 0002 D18 opened when it assigned a price-history TABLE
 * to this issue and left #57 holding current state alone.
 *
 * An **observation** is what one source said about one offer's terms at one
 * instant. A **point** is a derived answer to one question — "what was the
 * lowest eligible new-condition price on this product that day" — and it names
 * the observation it came from. The two are different kinds of fact and this
 * file keeps them apart in the type system, because the failure this domain
 * exists to prevent is a chart that looks continuous, confident and cheap while
 * being a mixture of currencies, conditions and prices nobody could ever pay.
 *
 * ## The five distinctions this file makes STRUCTURAL
 *
 * 1. **A converted amount always names its quote.** {@link PriceHistoryValue}
 *    is a discriminated union on `basis`, so a consumer cannot render a
 *    reinterpreted point without seeing the discriminant. There is no branch
 *    that carries a converted `Money` and no rate, which is issue currency
 *    rules 4 and 5 held by the type rather than by a reviewer.
 * 2. **A gap and an unbuilt range are different answers.**
 *    {@link PriceHistoryGap} says "there was no eligible observation here" and
 *    {@link PriceHistoryUncovered} says "this domain has not looked yet". Both
 *    are returned as explicit RANGES beside the points, so a chart drawing a
 *    line through either has to ignore a field rather than fail to receive one
 *    (issue API rule 4).
 * 3. **Unknown shipping stays unknown.** {@link ObservedDeliveryCost} has an
 *    `unknown` branch with no `cost` property — #57's `deriveOfferDelivery`
 *    device — so `lowest_known_total` cannot be computed from silence.
 * 4. **A segment is a {@link ConditionGroup} and never a key.** #90 assigns
 *    price history the GROUP grain explicitly, and every stored point carries
 *    one, so "new, refurbished and used history remain separate" (acceptance 2)
 *    is a column rather than a filter somebody remembers to apply.
 * 5. **Nothing here can name a referral partner or a referred customer.**
 *    {@link PRICE_HISTORY_FORBIDDEN_DTO_FIELDS} states the prohibition as a
 *    VALUE, disjoint from every field this module defines, and
 *    `price-history-isolation.test.ts` scans both directions.
 *
 * ## What this file deliberately does NOT define
 *
 * - **No price ALERT of any kind.** #79 owns alerts and #80's
 *   `ProductSavePriceAlert` seam stays exactly as it is — one branch, and it is
 *   the unsupported one. There is no subscription, threshold or notification
 *   shape here for a client to read as an unbuilt feature existing.
 * - **No ranking input.** #74 owns ranking. A series is an answer to a question
 *   a buyer asked, not a signal an ordering consumes.
 * - **No checkout or payment rail.** A currency being representable in `Money`
 *   does not make it purchasable (issue currency rule 8), which is why
 *   {@link PRICE_HISTORY_DISPLAY_NOTICE} is part of every response rather than
 *   a sentence in a document nobody reads.
 */

import type { ConditionGroup } from './condition';
import type { CurrencyCode, FxRateSnapshot, Money } from './money';

// ---------------------------------------------------------------------------
// The policy version
// ---------------------------------------------------------------------------

/**
 * The version of the DERIVATION every stored point was produced under.
 *
 * A code CONSTANT and not a table, for `CATALOG_BACKFILL_MAPPING_VERSION`'s
 * reason: the derivation is a procedure, and a table would let somebody publish
 * a version whose rules nobody shipped. Acceptance 5 — "rebuilding a product
 * series produces identical output for the same policy and data" — is a claim
 * about a pair, so the series stores which half of it was in force, and a bump
 * makes every series stale rather than silently changing what old points mean.
 */
export const PRICE_HISTORY_POLICY_VERSION = 1;

// ---------------------------------------------------------------------------
// The observation
// ---------------------------------------------------------------------------

/**
 * Why an observation was written down (issue snapshot policy 1, 2 and 7, and
 * the "change reason" half of snapshot field 13).
 *
 * An ARRAY of these is stored, not one value, because a single re-read can move
 * the price AND the condition AND the availability, and picking one of the
 * three to record would make the other two invisible to whoever is trying to
 * explain a step in a chart.
 *
 * - `initial` — the first observation of this offer. Never appears beside
 *   another reason: there is nothing for it to have changed from.
 * - `anchor` — nothing changed, and the last identical observation is older
 *   than the anchor interval. Issue snapshot policy 2's "periodic anchor
 *   observations only where needed to prove continued freshness": a chart
 *   drawn from change-only records cannot tell a price that held for ninety
 *   days from a feed that stopped publishing on day one.
 * - `correction` — a superseding record for an observation the source itself
 *   revised (policy 7). It carries `supersedesSnapshotId`, and the record it
 *   supersedes is never mutated.
 */
export type PriceObservationChangeReason =
  | 'initial'
  | 'price'
  | 'compare_at'
  | 'condition'
  | 'availability'
  | 'known_cost'
  | 'anchor'
  | 'correction';

export const PRICE_OBSERVATION_CHANGE_REASONS: readonly PriceObservationChangeReason[] = [
  'initial',
  'price',
  'compare_at',
  'condition',
  'availability',
  'known_cost',
  'anchor',
  'correction',
];

/**
 * What was wrong with an observation that was nonetheless STORED (issue
 * operations 3).
 *
 * #68 judges a whole PAGE against a source's baseline and quarantines the run;
 * this is the per-offer half, and the two are deliberately different
 * vocabularies. A flagged observation is persisted — provenance is never
 * withheld, whatever the verdict, which is #68's own rule — and is refused
 * entry to a series by {@link PriceObservationExclusionReason}. So the evidence
 * of a broken feed survives without a broken feed reaching a chart.
 *
 * An impossible NEGATIVE price is absent from this list on purpose: the column
 * refuses it outright, so there is no row for a flag to sit on. A vocabulary
 * member for it would describe a state the database cannot hold, which reads to
 * the next person as though one could.
 */
export type PriceObservationAnomaly =
  | 'currency_changed'
  | 'price_scale_shift'
  | 'compare_at_below_price';

export const PRICE_OBSERVATION_ANOMALIES: readonly PriceObservationAnomaly[] = [
  'currency_changed',
  'price_scale_shift',
  'compare_at_below_price',
];

/**
 * The factor by which an observation's price must move against the previous
 * observation of the SAME offer before it reads as a units error rather than a
 * sale (issue operations 3).
 *
 * Ten, matching #68's per-source default for the same reason it chose one: a
 * catalogue-wide half-price sale moves a price by two, and publishing majors
 * where minors were moves it by a hundred. This is per OFFER and #68's is per
 * FEED; neither replaces the other, because a single retailer fat-fingering one
 * SKU never shifts a feed's median at all.
 */
export const PRICE_SCALE_SHIFT_FACTOR = 10;

/**
 * Whether the observed price includes tax, when the source says (issue snapshot
 * field 7).
 *
 * `unknown` is the DEFAULT and, today, the only value any writer produces:
 * `offers` records no tax-inclusion fact, so there is nothing for this to be
 * read from. It is modelled rather than omitted because the alternative to an
 * honest `unknown` is a consumer assuming one — and the column is where an
 * adapter that does publish it will land once #57 grows the offer-side column
 * that carries it.
 */
export type PriceTaxInclusion = 'inclusive' | 'exclusive' | 'unknown';

export const PRICE_TAX_INCLUSIONS: readonly PriceTaxInclusion[] = [
  'inclusive',
  'exclusive',
  'unknown',
];

/**
 * An offer's own money, in the currency the SOURCE published (issue currency
 * rule 1).
 *
 * `OfferMoney`'s shape rather than `Money`'s, and for `offer.ts`'s reason: an
 * external platform reports whatever currency it trades in, which may be
 * outside Mercaria's presentment set, and declaring this `Money` would make the
 * type system assert something the column deliberately does not enforce. An
 * observation in a currency Mercaria cannot convert is still a true
 * observation; what it cannot do is enter a cross-currency comparison, and
 * {@link PriceObservationExclusionReason} is where that is said.
 */
export interface ObservedMoney {
  /** Integer minor units, in `currency`'s own precision. */
  readonly amount: number;
  /** An ISO-4217-style code exactly as the source published it. */
  readonly currency: string;
}

/**
 * What delivery cost at the moment of observation (issue snapshot field 6).
 *
 * The `unknown` branch has no `cost` property, so `lowest_known_total` cannot
 * be computed from an offer whose delivery the source never stated — #57's
 * `OfferDelivery` device, applied to history. "Unknown shipping or tax must
 * remain unknown rather than zero" is the union, not a convention.
 */
export type ObservedDeliveryCost =
  | { readonly known: false }
  | { readonly known: true; readonly cost: ObservedMoney };

/** One immutable observation of one offer's terms (issue §OfferPriceSnapshot). */
export interface OfferPriceObservation {
  readonly id: string;
  readonly offerId: string;
  /** The observation this reading came from. Absent for a native offer, which has no source. */
  readonly sourceRecordId?: string;
  /** The ingestion run, so an anomaly quarantine is answerable at READ time (policy 6). */
  readonly sourceRunId?: string;
  /** When the source was READ. May legitimately predate the row. */
  readonly observedAt: string;
  readonly itemPrice: ObservedMoney;
  readonly compareAtPrice?: ObservedMoney;
  readonly delivery: ObservedDeliveryCost;
  readonly taxInclusion: PriceTaxInclusion;
  /** #90's taxonomy key, or `unknown`. The SEGMENT is derived from it, never stored twice. */
  readonly conditionKey: string;
  readonly segment?: ConditionGroup;
  readonly availability: string;
  readonly market?: string;
  readonly region?: string;
  readonly language?: string;
  /** #68's verdict at the moment of observation — a record of what was believed, not a live read. */
  readonly freshnessLevel: string;
  readonly changeReasons: readonly PriceObservationChangeReason[];
  readonly anomalies: readonly PriceObservationAnomaly[];
  /** The observation this one CORRECTS. A correction is a new record, never a mutation (policy 7). */
  readonly supersedesObservationId?: string;
}

// ---------------------------------------------------------------------------
// The series
// ---------------------------------------------------------------------------

/** Whether a series is about a whole model or one exact configuration. */
export type PriceSeriesScopeKind = 'canonical_product' | 'canonical_variant';

export const PRICE_SERIES_SCOPE_KINDS: readonly PriceSeriesScopeKind[] = [
  'canonical_product',
  'canonical_variant',
];

/**
 * The bucket width of a stored series.
 *
 * Three widths rather than one, because issue operations 8 asks for a rollup
 * policy BY AGE and a rollup is a coarser series over the same observations —
 * not a second kind of row. A `week` point and a `day` point cite the same
 * immutable observation and are produced by the same derivation with a
 * different bucketing function, so a rollup cannot disagree with the detail it
 * summarises.
 */
export type PriceSeriesGranularity = 'day' | 'week' | 'month';

export const PRICE_SERIES_GRANULARITIES: readonly PriceSeriesGranularity[] = [
  'day',
  'week',
  'month',
];

/**
 * The eight series issue §"Product-level aggregation" names, as TWO dimensions
 * rather than eight values.
 *
 * The issue's list mixes a MEASURE with a SEGMENT: "lowest eligible new item
 * price", "refurbished price" and "used price" are one measure asked three
 * times, and modelling them as three values would make a fourth segment
 * (`open_box`, which #90 has and the issue's prose does not) unrepresentable
 * without a vocabulary change. So the measure is here and the segment is a
 * {@link ConditionGroup} column beside it.
 *
 * - `lowest_item_price` — the cheapest eligible offer's own price.
 * - `lowest_known_total` — the cheapest eligible offer's price PLUS a delivery
 *   cost the source actually published. An offer whose delivery is unknown is
 *   excluded rather than treated as free, which is why this series is
 *   legitimately sparser than the one above and why the two must not be drawn
 *   as one line.
 * - `official_store_item_price` — the cheapest offer from a merchant #55 has
 *   VERIFIED as an official channel for the product's brand, inside that
 *   claim's validity window. A domain match, a name match and a logo are all
 *   incapable of producing this series, because #55 made them incapable of
 *   producing the relationship.
 * - `native_item_price` — Mercaria's own sellers.
 * - `mercaria_retail_item_price` — Mercaria as seller of record. Representable
 *   and PRODUCING NOTHING: `OfferKind` has no `mercaria_retail` member (ADR
 *   0002 D18 binds it to epic #116's own migration), so the derivation's branch
 *   for it can never select a row. It is here so that #116 adds an offer kind
 *   rather than a series vocabulary, and a test pins the emptiness so the seam
 *   cannot be mistaken for a bug.
 *
 * The issue's eighth — "selected merchant or storefront when filtered" — is
 * deliberately NOT a measure. See {@link PriceHistoryQuery}.
 */
export type PriceSeriesMeasure =
  | 'lowest_item_price'
  | 'lowest_known_total'
  | 'official_store_item_price'
  | 'native_item_price'
  | 'mercaria_retail_item_price';

export const PRICE_SERIES_MEASURES: readonly PriceSeriesMeasure[] = [
  'lowest_item_price',
  'lowest_known_total',
  'official_store_item_price',
  'native_item_price',
  'mercaria_retail_item_price',
];

/**
 * Which measures include a delivery cost, as a TABLE the derivation reads.
 *
 * `claim-methods.ts`'s device (#83): a per-measure property lives in one place
 * and nothing in the derivation ever asks "is the measure
 * `lowest_known_total`". Adding a measure without a row here is a compile
 * error, which is what stops a new measure silently inheriting the wrong
 * known-total semantics.
 */
export const PRICE_MEASURE_INCLUDES_DELIVERY: Readonly<Record<PriceSeriesMeasure, boolean>> = {
  lowest_item_price: false,
  lowest_known_total: true,
  official_store_item_price: false,
  native_item_price: false,
  mercaria_retail_item_price: false,
};

/**
 * The #68 freshness level that ADMITTED a point's contributing offer — the
 * "ranking-eligibility reason" issue §"Product-level aggregation" requires
 * every point to retain.
 *
 * Two values, because `mayAppearInComparison` admits exactly two and every
 * other condition is a FILTER whose failure means the offer produced no point
 * at all. Recording the filters that passed would be recording that a stored
 * row exists; recording which of the two admitting levels applied is the one
 * fact that varies between points and the one an operator asks about when a
 * chart shows a price from a feed that has since gone quiet.
 */
export type PricePointAdmittedFreshness = 'current' | 'warning';

export const PRICE_POINT_ADMITTED_FRESHNESS: readonly PricePointAdmittedFreshness[] = [
  'current',
  'warning',
];

/**
 * Why an eligible-looking observation did NOT contribute to a series.
 *
 * Not stored on a point — a point exists only for an observation that WAS
 * admitted — but returned by the derivation and surfaced on the operator trace,
 * because "why is this offer not on the chart" is the question the surface
 * exists to answer, and a boolean cannot answer it.
 */
export type PriceObservationExclusionReason =
  | 'offer_not_comparable'
  | 'price_display_not_permitted'
  | 'source_run_quarantined'
  | 'anomalous_observation'
  | 'superseded_observation'
  | 'currency_not_convertible'
  | 'condition_unknown'
  | 'market_mismatch'
  | 'delivery_cost_unknown'
  | 'not_official_store'
  | 'not_native_offer'
  | 'not_mercaria_retail_offer';

export const PRICE_OBSERVATION_EXCLUSION_REASONS: readonly PriceObservationExclusionReason[] = [
  'offer_not_comparable',
  'price_display_not_permitted',
  'source_run_quarantined',
  'anomalous_observation',
  'superseded_observation',
  'currency_not_convertible',
  'condition_unknown',
  'market_mismatch',
  'delivery_cost_unknown',
  'not_official_store',
  'not_native_offer',
  'not_mercaria_retail_offer',
];

/** The lifecycle of one series' rebuild job. The series ROW is the job. */
export type PriceSeriesRebuildStatus = 'pending' | 'processing' | 'done' | 'dead_letter';

export const PRICE_SERIES_REBUILD_STATUSES: readonly PriceSeriesRebuildStatus[] = [
  'pending',
  'processing',
  'done',
  'dead_letter',
];

/** What a series is ABOUT — scope, segment-free, currency-pinned. */
export interface PriceSeriesScope {
  readonly kind: PriceSeriesScopeKind;
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  /** ISO 3166-1 alpha-2, or absent for "every market this product is offered in". */
  readonly market?: string;
  /**
   * The currency every point in this series is DISPLAYED in, and the currency
   * its cross-currency comparison was decided in.
   *
   * A `CurrencyCode` and not an `OfferMoney` currency: a display currency is a
   * PRESENTMENT currency by definition, and an observation whose own currency
   * Mercaria cannot convert into this one is excluded rather than compared in
   * raw minor units (issue currency rule 6).
   */
  readonly displayCurrency: CurrencyCode;
  readonly granularity: PriceSeriesGranularity;
}

// ---------------------------------------------------------------------------
// The value, and the three ways a chart can honestly show one
// ---------------------------------------------------------------------------

/**
 * One point's money, and the basis on which it may be shown.
 *
 * Issue currency rules 3, 4 and 5, as a union rather than as a flag beside a
 * number. The `basis` discriminant is what a client must switch on to read
 * `money` at all, so there is no path on which a rate-converted figure is
 * rendered as though it were the price the seller published.
 *
 * - `source_native` — the requested display currency IS the currency the source
 *   published. Nothing was converted and there is no quote, because there was
 *   no conversion to identify.
 * - `historical_quote` — converted at the rate captured when the point was
 *   built, which is stored with the point. A later rate move can never change
 *   this figure (the `FxRateSnapshot` contract, verbatim).
 * - `current_rate_reinterpretation` — the caller asked for a currency this
 *   series was not built in, and opted in to seeing today's rate applied to an
 *   old amount. BOTH quotes are carried: the historical one the point was built
 *   under and the current one that reinterpreted it. This is issue currency
 *   rule 5's "without labelling that interpretation" made impossible to omit.
 */
export type PriceHistoryValue =
  | {
      readonly basis: 'source_native';
      readonly money: Money;
      /** What the source published, verbatim. Equal to `money` in this branch. */
      readonly native: ObservedMoney;
    }
  | {
      readonly basis: 'historical_quote';
      readonly money: Money;
      readonly native: ObservedMoney;
      readonly quote: FxRateSnapshot;
    }
  | {
      readonly basis: 'current_rate_reinterpretation';
      readonly money: Money;
      readonly native: ObservedMoney;
      /** The rate applied NOW, to produce `money`. */
      readonly quote: FxRateSnapshot;
      /** The rate the point was BUILT under, which `quote` reinterprets. */
      readonly historicalQuote: FxRateSnapshot;
    };

/** One derived point of one series (issue §"Product-level aggregation"). */
export interface PriceHistoryPoint {
  /** The bucket this point summarises, as an ISO instant at its START. */
  readonly bucketStart: string;
  readonly measure: PriceSeriesMeasure;
  readonly segment: ConditionGroup;
  readonly value: PriceHistoryValue;
  /** The offer that produced this point (issue: "every point retains the contributing offer id"). */
  readonly offerId: string;
  /** The immutable observation behind it (acceptance 6). */
  readonly observationId: string;
  /** When that observation was taken — never the bucket boundary. */
  readonly observedAt: string;
  readonly eligibility: {
    readonly admittedFreshness: PricePointAdmittedFreshness;
    readonly measure: PriceSeriesMeasure;
    readonly segment: ConditionGroup;
  };
  /** How many eligible observations the bucket held. One is not the same as forty. */
  readonly contributingObservationCount: number;
}

/**
 * A stretch of time inside the series' COVERAGE with no eligible observation
 * (issue API rule 4, acceptance 7).
 *
 * A real fact about the world: nobody was offering this thing, or every offer
 * had lapsed, or every observation was excluded. It is returned as a range so a
 * renderer must decide what to do with it, rather than inferring it from a
 * missing x value and quietly interpolating.
 */
export interface PriceHistoryGap {
  readonly from: string;
  readonly to: string;
  readonly buckets: number;
  readonly reason: 'no_eligible_observation';
}

/**
 * A stretch of the requested range this domain has not built yet — which is NOT
 * a gap and must never be drawn as one.
 *
 * The distinction is the whole reason the series stores a coverage window: "no
 * offer existed" and "the rebuild has not reached here" look identical from a
 * list of points, and only one of them is a fact about prices.
 */
export interface PriceHistoryUncovered {
  readonly from: string;
  readonly to: string;
  readonly reason: 'not_yet_built';
}

/**
 * The lowest value observed in a NAMED segment over a NAMED range (issue API
 * rule 5).
 *
 * Every field is required, which is the rule: a "lowest ever" with no segment
 * and no window is a number that cannot be wrong because it does not say what
 * it is about.
 */
export interface PriceHistoryExtreme {
  readonly value: PriceHistoryValue;
  readonly segment: ConditionGroup;
  readonly measure: PriceSeriesMeasure;
  readonly from: string;
  readonly to: string;
  readonly offerId: string;
  readonly observationId: string;
  readonly observedAt: string;
}

/**
 * What the numbers MEAN, shipped beside them (issue API rule 3).
 *
 * The analytics domain's decision that a metric whose definition is unstated
 * cannot be served, applied to a chart: a "known total" that does not say what
 * it did with an unpublished delivery cost is not a total anybody can act on.
 */
export interface PriceHistorySemantics {
  readonly displayCurrency: CurrencyCode;
  readonly measure: PriceSeriesMeasure;
  readonly segment: ConditionGroup;
  /** Observations always keep the currency the source published (currency rule 1). */
  readonly sourceCurrencyPolicy: 'observations_retain_source_currency';
  /** What the measure did with a delivery cost nobody published. */
  readonly knownTotalPolicy:
    | 'delivery_excluded_from_this_measure'
    | 'offers_without_published_delivery_are_excluded';
  readonly policyVersion: number;
}

/**
 * The standing statement that a converted figure is not a way to pay (issue API
 * rule 8, currency rule 8).
 *
 * A constant on every response rather than a note in a document: the claim a
 * display conversion makes by accident is that the currency is spendable, and
 * the only place to refuse that claim is beside the converted number.
 */
export const PRICE_HISTORY_DISPLAY_NOTICE = {
  conversionIsDisplayOnly: true,
  /**
   * Deliberately `null` and not a rail id. What a payment settles in is a
   * property of the provider handling it and is decided in the payment domain;
   * this domain has no way to know it and must not appear to.
   */
  supportedCheckoutRail: null,
} as const;

export type PriceHistoryDisplayNotice = typeof PRICE_HISTORY_DISPLAY_NOTICE;

/**
 * The accessible rendering of the chart (issue API rule 7).
 *
 * Part of the payload rather than a client concern, because a summary composed
 * on three clients is three summaries, and the one that gets a gap wrong is the
 * one nobody is looking at. `sentences` are plain statements a screen reader
 * can read in order; `table` is the same data as rows.
 */
export interface PriceHistorySummary {
  readonly sentences: readonly string[];
  readonly pointCount: number;
  readonly gapCount: number;
  readonly lowest?: PriceHistoryExtreme;
  readonly highest?: PriceHistoryExtreme;
  readonly first?: PriceHistoryPoint;
  readonly latest?: PriceHistoryPoint;
}

/** One row of the accessible data table — the same facts a point carries. */
export interface PriceHistoryTableRow {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly value?: PriceHistoryValue;
  readonly offerId?: string;
  readonly observedAt?: string;
  readonly state: 'observed' | 'gap' | 'not_yet_built';
}

/**
 * The live offer a caller may follow from the newest point (issue API rule 6).
 *
 * Present ONLY when that offer is still eligible right now — re-derived, never
 * carried over from the rebuild, because #68's whole point is that an offer
 * which was current when a chart was built is exactly the one that is not
 * current when somebody clicks it.
 */
export interface PriceHistoryCurrentOfferLink {
  readonly offerId: string;
  readonly stillEligible: true;
}

/** What a caller asks for. */
export interface PriceHistoryQuery {
  readonly scope: PriceSeriesScope;
  readonly measure: PriceSeriesMeasure;
  readonly segment: ConditionGroup;
  readonly from: string;
  readonly to: string;
  /**
   * Narrow the series to ONE seller — issue §"Product-level aggregation" item
   * 8.
   *
   * Deliberately not a stored series. Materialising every (merchant × product ×
   * segment × measure × currency × granularity) combination is a combinatorial
   * explosion for a question hardly anybody asks, and it does not need to be
   * materialised: an unfiltered series spans every seller of a popular product
   * and needs the cross-currency comparison a database cannot do, while a
   * single seller's history on one product is a few hundred rows the derivation
   * runs live. The SAME pure derivation answers both, so the filtered and
   * unfiltered answers cannot disagree about anything but their input set.
   */
  readonly merchantId?: string;
  readonly storefrontId?: string;
  /**
   * Whether the caller accepts points reinterpreted at today's rate when the
   * series was built in a different currency.
   *
   * Defaults to FALSE. Off, such a point is simply absent and the range reads
   * as uncovered; on, it arrives with `basis: 'current_rate_reinterpretation'`
   * and both quotes. Opt-in rather than opt-out because the honest default for
   * "I cannot answer that in your currency" is silence, not a number with a
   * footnote.
   */
  readonly allowCurrentRateReinterpretation?: boolean;
}

/** What a caller gets. */
export interface PriceHistoryResponse {
  readonly scope: PriceSeriesScope;
  readonly semantics: PriceHistorySemantics;
  readonly notice: PriceHistoryDisplayNotice;
  readonly points: readonly PriceHistoryPoint[];
  readonly gaps: readonly PriceHistoryGap[];
  readonly uncovered: readonly PriceHistoryUncovered[];
  readonly summary: PriceHistorySummary;
  readonly table: readonly PriceHistoryTableRow[];
  readonly currentOffer?: PriceHistoryCurrentOfferLink;
  /** When this series was last rebuilt, or absent if it never has been. */
  readonly rebuiltAt?: string;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * What an operator can see about the domain's health (issue operations 1).
 *
 * `deduplicationRate` needs its own counter and cannot be derived: a
 * deduplicated observation leaves no row, so counting rows answers "how much
 * did we keep" and never "how much did we suppress" — the
 * `catalog_source_rejections` residual lesson, one layer down. A domain whose
 * dedup logic broke would write ten times the rows and report a perfectly
 * healthy write volume.
 */
export interface PriceHistoryOperationalMetrics {
  readonly windowDays: number;
  readonly observationsWritten: number;
  readonly observationsDeduplicated: number;
  readonly observationsRefused: number;
  readonly observationsFlaggedAnomalous: number;
  /** Written ÷ (written + deduplicated). Absent when nothing was offered at all. */
  readonly deduplicationRate?: number;
  readonly seriesTotal: number;
  readonly seriesPending: number;
  readonly seriesDeadLettered: number;
  /**
   * How far behind the oldest outstanding rebuild is, in seconds. Absent when
   * nothing is outstanding — which is a different fact from zero, and reporting
   * zero for it would make a stalled dispatcher indistinguishable from an idle
   * one.
   */
  readonly oldestPendingRebuildAgeSeconds?: number;
}

/** One offer's observation trail, for the operator surface. */
export interface PriceHistoryOfferTrace {
  readonly offerId: string;
  readonly observations: readonly OfferPriceObservation[];
  readonly exclusions: readonly {
    readonly observationId: string;
    readonly reasons: readonly PriceObservationExclusionReason[];
  }[];
}

// ---------------------------------------------------------------------------
// The referral wall, stated as values
// ---------------------------------------------------------------------------

/**
 * Field names that may never appear in a price-history DTO (issue §"Referral
 * boundary" rule 4).
 *
 * The `SELLER_PROFILE_FORBIDDEN_FIELDS` device (#92): the prohibition is a
 * VALUE a test can walk a real emitted response against, not a sentence in a
 * document. A commission, a campaign or an attribution cannot alter a
 * historical price — and it cannot leak into the response that reports one
 * either, which is the half a behavioural test would miss.
 */
export const PRICE_HISTORY_FORBIDDEN_DTO_FIELDS: readonly string[] = [
  'referralPartnerId',
  'referralPartner',
  'referredCustomerId',
  'referredCustomer',
  'commission',
  'commissionAmount',
  'campaignId',
  'campaign',
  'attribution',
  'attributionId',
  'affiliateEarnings',
  'partnerId',
];

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * Bucket an instant, in UTC, for one granularity.
 *
 * UTC and never a market's local time, deliberately: a series scoped to no
 * market has no local time to use, and two series of the same product bucketed
 * on different clocks would disagree about which day a price changed. The cost
 * is stated rather than hidden — a Tokyo evening price change lands on the
 * following UTC day — and it is the same cost every UTC-bucketed report in this
 * codebase already pays.
 *
 * `week` starts on MONDAY (ISO-8601), which is the week every other Oxy report
 * uses; `month` starts on the first.
 */
export function priceHistoryBucketStart(instant: Date, granularity: PriceSeriesGranularity): Date {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const day = instant.getUTCDate();

  if (granularity === 'month') return new Date(Date.UTC(year, month, 1));
  if (granularity === 'day') return new Date(Date.UTC(year, month, day));

  const midnight = new Date(Date.UTC(year, month, day));
  // `getUTCDay()` is 0 for Sunday; ISO weeks start on Monday, so Sunday is six
  // days into its week rather than zero.
  const offset = (midnight.getUTCDay() + 6) % 7;
  return new Date(midnight.getTime() - offset * 24 * 60 * 60 * 1_000);
}

/** The exclusive end of the bucket `priceHistoryBucketStart` returned. */
export function priceHistoryBucketEnd(start: Date, granularity: PriceSeriesGranularity): Date {
  if (granularity === 'month') {
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
  const days = granularity === 'week' ? 7 : 1;
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1_000);
}

/**
 * Every bucket start between two instants, inclusive of the bucket containing
 * `from` and of the one containing `to`.
 *
 * This is what makes a GAP expressible at all: a list of points can only say
 * where there was data, and the difference between that list and this one is
 * the answer to issue API rule 4.
 */
export function priceHistoryBuckets(
  from: Date,
  to: Date,
  granularity: PriceSeriesGranularity,
): Date[] {
  const buckets: Date[] = [];
  let cursor = priceHistoryBucketStart(from, granularity);
  const last = priceHistoryBucketStart(to, granularity);
  // A bounded walk rather than a computed count: month lengths differ, so a
  // division would be wrong for exactly the granularity people check least.
  while (cursor.getTime() <= last.getTime()) {
    buckets.push(cursor);
    cursor = priceHistoryBucketEnd(cursor, granularity);
  }
  return buckets;
}
