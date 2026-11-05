/**
 * The checkout conversion report — the v1 of the paid `advanced_demand_analytics`
 * capability (#89 plan tools).
 *
 * ## What it measures, and what it deliberately does not
 *
 * Built from the store's OWN native checkout orders, never from telemetry: a
 * checkout started is an order a buyer's checkout created on Mercaria, and it
 * converted when its payment settled. Both are durable facts the merchant's
 * order list already shows one by one, so this report adds the rates, the
 * per-listing breakdown, the trend and the period comparison — not access to
 * anything new.
 *
 * Views, impressions and search terms are NOT in it. Discovery collection
 * (#77) is off in production pending its privacy review, nothing emits a
 * store-scoped impression or checkout-start event, and no search is linked to
 * a store's listing — so any such column would be a confident zero. A figure
 * that cannot be measured is absent rather than reported as nothing happening.
 *
 * ## The cohort floor is #77's, unchanged
 *
 * Every figure set is suppressed — reported as ZERO with `aboveThreshold:
 * false`, never rounded — when its cohort (checkouts started, the largest of
 * its checkout counts; every other count is a subset of it) is below
 * `ANALYTICS_MERCHANT_MIN_COHORT`. Units sold are not a cohort (one checkout
 * can carry twenty), so they never decide whether a set is published.
 *
 * ## No buyer field, by shape
 *
 * None of these types has a field for a buyer, a guest, a contact, an address,
 * an order id, a checkout group or a buyer origin. The projection IS the
 * enforcement, as for `MerchantAnalyticsSummary`.
 */

/** The trend's bucket width. UTC calendar days; weeks start on Monday (ISO). */
export const CONVERSION_REPORT_INTERVALS = ['day', 'week'] as const;
export type ConversionReportInterval = (typeof CONVERSION_REPORT_INTERVALS)[number];

/** The two reports a merchant can export as CSV. */
export const CONVERSION_REPORT_EXPORTS = ['listings', 'trend'] as const;
export type ConversionReportExport = (typeof CONVERSION_REPORT_EXPORTS)[number];

/** The longest window one report may span, in days (the #77 summary's bound). */
export const CONVERSION_REPORT_MAX_WINDOW_DAYS = 92;

/** How many listings the per-listing report returns at most. */
export const CONVERSION_REPORT_MAX_LISTINGS = 200;

/** How many listings each of the best- and worst-converting lists holds at most. */
export const CONVERSION_REPORT_RANKED_LISTINGS = 5;

/**
 * One cohort's checkout figures.
 *
 * `checkoutsStarted = paidCheckouts + openCheckouts + abandonedCheckouts` when
 * published. Suppressed (`aboveThreshold: false`): every count is 0 and
 * `conversionRate` is null.
 */
export interface ConversionFigures {
  readonly aboveThreshold: boolean;
  /** Native checkout orders created in the window. */
  readonly checkoutsStarted: number;
  /** Of those, the ones whose payment settled (a later refund still counts). */
  readonly paidCheckouts: number;
  /** Of those, the ones still awaiting payment. */
  readonly openCheckouts: number;
  /** Of those, the ones cancelled without a payment. */
  readonly abandonedCheckouts: number;
  /** Units on the paid checkouts' lines. */
  readonly unitsSold: number;
  /** `paidCheckouts / checkoutsStarted`, 0–1; null when suppressed. */
  readonly conversionRate: number | null;
}

/** The window a report covers: UTC calendar dates, both inclusive. */
export interface ConversionReportWindow {
  readonly from: string;
  readonly to: string;
}

/** One listing's figures. */
export interface ListingConversionRow {
  readonly listingId: string;
  /** The title on the order lines (the snapshot buyers saw). */
  readonly title: string;
  readonly figures: ConversionFigures;
}

/** `GET /admin/stores/:storeId/analytics/advanced/listings`. */
export interface ListingConversionReport {
  readonly storeId: string;
  readonly window: ConversionReportWindow;
  readonly minimumCohort: number;
  /** The whole store: distinct checkouts, not a sum of the listing rows. */
  readonly totals: ConversionFigures;
  /** Published listings, most checkouts first, at most `CONVERSION_REPORT_MAX_LISTINGS`. */
  readonly listings: readonly ListingConversionRow[];
  /** Listings with at least one checkout whose cohort was below the floor (or past the cap). */
  readonly suppressedListingCount: number;
  /** The best converters among the published listings. */
  readonly bestConverting: readonly ListingConversionRow[];
  /** The worst converters among the published listings, never repeating a best one. */
  readonly worstConverting: readonly ListingConversionRow[];
}

/** One bucket of the trend. */
export interface ConversionTrendBucket {
  /** `YYYY-MM-DD`, the bucket's first UTC day. */
  readonly bucketStart: string;
  readonly figures: ConversionFigures;
}

/** How the window compares with the one immediately before it. */
export interface ConversionPeriodChange {
  /** Relative change, e.g. 0.25 for +25 %; null when not comparable. */
  readonly checkoutsStarted: number | null;
  readonly paidCheckouts: number | null;
  /** Conversion-rate difference in absolute terms, e.g. 0.05 for +5 points. */
  readonly conversionRate: number | null;
}

/** `GET /admin/stores/:storeId/analytics/advanced/trend`. */
export interface ConversionTrendReport {
  readonly storeId: string;
  readonly interval: ConversionReportInterval;
  readonly minimumCohort: number;
  readonly window: ConversionReportWindow;
  /** Every bucket in the window, zero-filled, each suppressed on its own. */
  readonly buckets: readonly ConversionTrendBucket[];
  readonly current: ConversionFigures;
  /** The same number of days immediately before `window.from`. */
  readonly previousWindow: ConversionReportWindow;
  readonly previous: ConversionFigures;
  /** Null unless BOTH periods are published. */
  readonly change: ConversionPeriodChange | null;
}
