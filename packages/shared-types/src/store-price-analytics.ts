/**
 * Competitive price analytics for a NATIVE store — the paid tool behind the
 * `competitive_price_analytics` capability (#89).
 *
 * "How is each of my live listings priced against the other offers in its
 * comparison, now and over time." It is the native-store counterpart of #82's
 * free `/merchant-competitiveness/:merchantId` surface (which stays free and is
 * about a CLAIMED canonical-graph merchant) and reuses #82's disclosure rules:
 *
 * - **Aggregates only.** A row carries the count of OTHER sellers, their lowest
 *   and their (lower) median price, and the store's own price. It has no field
 *   for another seller's id, name, offer, storefront or source, and
 *   {@link STORE_PRICE_ANALYTICS_FORBIDDEN_FIELDS} is walked against a REAL
 *   response by the backend suite.
 * - **A market, not a rival.** The aggregate is published only when the other
 *   sellers clear the active price-signal policy's floors (observations,
 *   distinct sellers, distinct offers), which can never be fewer sellers than
 *   `PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR`.
 * - **Every offer behind it is already public**: only offers the public
 *   comparison admits (#74's eligibility) enter the sample.
 *
 * Amounts are minor units in the listing's OWN currency. The store's price is
 * never converted; other sellers' prices are converted for display at read
 * time, with the rate's provider and date stated (`conversion`), and nothing
 * stored is rewritten.
 *
 * There is no recommendation of any kind, and in particular nothing that relates
 * a price to placement: a plan never buys ranking, and a price comparison is the
 * whole of this tool.
 */

import type { ConditionGroup } from './condition';
import type { PriceSeriesGranularity } from './price-history';

/**
 * Where the store's price sits against the other sellers, in a fixed order.
 *
 * - `lowest` — at or below every other seller's price.
 * - `near_lowest` — above the lowest, by at most {@link STORE_PRICE_NEAR_LOWEST_BPS}.
 * - `at_or_below_median` — further above the lowest, and not above the median.
 * - `above_median` — above the median of the other sellers.
 */
export const STORE_PRICE_POSITION_BANDS = [
  'lowest',
  'near_lowest',
  'at_or_below_median',
  'above_median',
] as const;

export type StorePricePositionBand = (typeof STORE_PRICE_POSITION_BANDS)[number];

/** "Within 5% of the lowest other offer", in basis points. */
export const STORE_PRICE_NEAR_LOWEST_BPS = 500;

/**
 * Why a listing has no comparison. Every member is a fact about the data or the
 * policy; there is no `error`.
 */
export const STORE_PRICE_UNMEASURED_REASONS = [
  /** Mercaria has no active price-comparison policy, so no claim is made. */
  'no_active_policy',
  /** The listing variant has no price. */
  'price_missing',
  /** The listing is priced in a currency Mercaria does not compare in. */
  'currency_not_comparable',
  /** The listing's condition maps to no comparison segment. */
  'condition_unknown',
  /** Too few other offers to call it a market. */
  'insufficient_observations',
  /** Too few other SELLERS — the floor that keeps a median from being one rival's price. */
  'insufficient_distinct_sellers',
  /** Too few other offers behind those sellers. */
  'insufficient_distinct_offers',
] as const;

export type StorePriceUnmeasuredReason = (typeof STORE_PRICE_UNMEASURED_REASONS)[number];

/** The other sellers in one comparison, as aggregates. Minor units, the row's currency. */
export interface StorePriceMarket {
  /** Distinct other sellers that survived deduplication and outlier exclusion. */
  readonly otherSellers: number;
  /** Distinct other offers behind them. */
  readonly otherOffers: number;
  readonly lowestAmount: number;
  /** The LOWER median (nearest rank, no interpolation), #82's method. */
  readonly medianAmount: number;
  /** Prices the robust method set aside as outliers. Counted, never shown. */
  readonly outliersExcluded: number;
}

/** The store's price against {@link StorePriceMarket}. */
export interface StorePricePosition {
  readonly band: StorePricePositionBand;
  /** `(own − lowest) / lowest`, basis points, rounded half away from zero. */
  readonly deltaToLowestBps: number;
  /** `(own − median) / median`, basis points. */
  readonly deltaToMedianBps: number;
}

/** The rate other sellers' prices were converted with, when any were. */
export interface StorePriceConversion {
  readonly provider: string;
  /** ISO-8601. */
  readonly asOf: string;
}

/** One of the store's live native listing variants, against its comparison. */
export interface StorePriceAnalyticsRow {
  /** The store's own native variant — the row's identity. */
  readonly productVariantId: string;
  readonly listingId: string;
  readonly listingTitle: string;
  readonly variantTitle: string | null;
  readonly sku: string | null;
  /** The canonical product the listing is matched to, as the public page names it. */
  readonly canonicalProductName: string | null;
  readonly segment: ConditionGroup | null;
  /** The listing's own currency, which every amount on the row is in. */
  readonly currency: string | null;
  /** The store's own price, minor units, never converted. */
  readonly ownAmount: number | null;
  /**
   * Whether the store's own offer is shown on the public comparison right now.
   * `false` means it is held out (for example out of stock or not yet
   * checkout-ready), and the position below says where its price WOULD sit.
   */
  readonly inComparison: boolean;
  readonly state: 'measured' | 'unmeasured';
  /** Present exactly on `unmeasured`. */
  readonly reason?: StorePriceUnmeasuredReason;
  /** Present exactly on `measured`. */
  readonly market?: StorePriceMarket;
  /** Present exactly on `measured`. */
  readonly position?: StorePricePosition;
  /** Present when at least one other seller's price was converted into `currency`. */
  readonly conversion?: StorePriceConversion;
}

/** Counts over the analysed rows. */
export interface StorePriceAnalyticsSummary {
  readonly listingsAnalysed: number;
  readonly measured: number;
  readonly unmeasured: number;
  readonly byBand: Readonly<Record<StorePricePositionBand, number>>;
}

/** The rules the figures were computed under, shipped with them. */
export interface StorePriceAnalyticsSemantics {
  readonly policyVersion: string;
  readonly minObservations: number;
  readonly minDistinctSellers: number;
  readonly minDistinctOffers: number;
  readonly nearLowestBps: number;
  readonly deduplication: 'one_offer_per_distinct_seller';
  readonly medianMethod: 'lower_median_over_observed_values';
  readonly outlierMethod: 'modified_z_score_over_median_absolute_deviation';
}

export interface StorePriceAnalyticsResponse {
  readonly storeId: string;
  /** ISO-8601; the instant every row was computed at. */
  readonly computedAt: string;
  /** Absent when no price-comparison policy is active. */
  readonly semantics?: StorePriceAnalyticsSemantics;
  readonly summary: StorePriceAnalyticsSummary;
  readonly coverage: {
    /** Live native listing variants matched to a canonical product. */
    readonly listingsTotal: number;
    readonly listingsAnalysed: number;
    /** `true` when the store has more than one read analyses; the rest are named by count. */
    readonly truncated: boolean;
  };
  readonly rows: readonly StorePriceAnalyticsRow[];
}

/** The two windows the trend is offered over, in days. */
export const STORE_PRICE_TREND_WINDOWS_DAYS = [30, 90] as const;
export type StorePriceTrendWindowDays = (typeof STORE_PRICE_TREND_WINDOWS_DAYS)[number];

/** The bucket sizes the trend is offered in — a subset of #78's. */
export const STORE_PRICE_TREND_GRANULARITIES = [
  'day',
  'week',
] as const satisfies readonly PriceSeriesGranularity[];
export type StorePriceTrendGranularity = (typeof STORE_PRICE_TREND_GRANULARITIES)[number];

/** One bucket of the trend. Minor units, the trend's currency. */
export interface StorePriceTrendPoint {
  /** ISO-8601 start of the bucket (UTC). */
  readonly bucketStart: string;
  /** The store's own lowest observed price in the bucket, or `null` if none was admitted. */
  readonly ownAmount: number | null;
  /** The other sellers that bucket, when they cleared the policy's floors. */
  readonly market: {
    readonly otherSellers: number;
    readonly lowestAmount: number;
    readonly medianAmount: number;
  } | null;
  /** Present exactly when `market` is `null` because of the floors or the policy. */
  readonly marketReason?: StorePriceUnmeasuredReason;
}

export interface StorePriceTrendResponse {
  readonly productVariantId: string;
  readonly listingTitle: string;
  readonly variantTitle: string | null;
  readonly currency: string | null;
  readonly segment: ConditionGroup | null;
  readonly granularity: StorePriceTrendGranularity;
  readonly windowDays: StorePriceTrendWindowDays;
  /** ISO-8601. */
  readonly from: string;
  readonly to: string;
  /** Present when the whole trend could not be computed. */
  readonly reason?: StorePriceUnmeasuredReason;
  readonly points: readonly StorePriceTrendPoint[];
}

/**
 * Field names no response of this tool may carry, anywhere in its tree.
 *
 * #82's list plus the identities of the OTHER sellers this domain handles
 * internally (seller keys, merchant and storefront ids, their offers). The
 * store's own `listingId` and `productVariantId` are not here: they are the
 * store's own.
 */
export const STORE_PRICE_ANALYTICS_FORBIDDEN_FIELDS: readonly string[] = [
  'competitorMerchantId',
  'competitorMerchantName',
  'competitorOfferId',
  'competitorPrice',
  'competitorStoreId',
  'merchantId',
  'merchantName',
  'storefrontId',
  'sellerKey',
  'offerId',
  'offerIds',
  'evidence',
  'sourceRecordId',
  'destinationUrl',
  'commission',
  'merchantPlan',
  'planTier',
  'buyerId',
  'oxyUserId',
];
