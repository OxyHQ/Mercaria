/**
 * The checkout conversion report — v1 of the paid `advanced_demand_analytics`
 * capability (#89 plan tools).
 *
 * ## Genuinely additional to what every store gets free
 *
 * Free, and untouched by this module: #77's aggregate summary
 * (`GET …/analytics/summary`) and the sales reports (`GET …/reports/*` —
 * revenue, paid orders over time, top products by units). What this adds is
 * CONVERSION: per listing and per period, how many native checkouts started,
 * how many were paid, how many are still open or were abandoned, the rate, the
 * best and worst converters, and the window against the one before it. No free
 * surface computes any of those.
 *
 * ## Why it is order-sourced, and what it therefore cannot say
 *
 * The capability's name promises demand and search intent too. The event
 * pipeline that would carry them (#77) has collection OFF in production until
 * its privacy review is signed, nothing emits a store-scoped impression or a
 * store-scoped checkout start, and no search is linked to the listing it led
 * to. A per-listing view or search-term column built on that today would be a
 * confident zero on every store, so v1 does not have one. Orders are the
 * durable truth that exists, and they need no collection switch.
 *
 * ## The cohort floor is #77's, applied the same way
 *
 * {@link toFigures} is the ONE place a figure set is published or suppressed:
 * below `ANALYTICS_MERCHANT_MIN_COHORT` checkouts started, every count is
 * reported as ZERO with `aboveThreshold: false` and the rate is null —
 * suppressed, not rounded and not bucketed. The cohort is checkouts started
 * because it is the largest checkout count (paid, open and abandoned are
 * subsets of it): that is #77's "threshold on the LARGEST count, not per
 * field", so no published field bounds a suppressed one. Units are not a
 * cohort — one checkout can carry twenty — and never decide publication.
 *
 * Suppressed LISTINGS are not listed one by one, only counted: a list of
 * suppressed rows in any order but alphabetical would leak their relative
 * sizes, and a list of zeros is noise.
 *
 * Differencing across reports (the store total minus the published listings)
 * is not defended further, and that is a decision rather than a gap: every
 * order behind these figures is already listed individually to the same
 * reader — every store role that holds `stats:read` also holds `orders:read`,
 * which `conversion-report.realdb.test.ts` pins — so a subtraction can reveal
 * nothing the order list does not show outright.
 *
 * ## Never reads a plan
 *
 * Whether the store may run this report is decided at the ROUTE
 * (`requireCapability`), never here: a figure computed with knowledge of what
 * a merchant pays is one join from a figure weighted by it.
 */

import type {
  ConversionFigures,
  ConversionPeriodChange,
  ConversionReportInterval,
  ConversionReportWindow,
  ConversionTrendBucket,
  ConversionTrendReport,
  ListingConversionReport,
  ListingConversionRow,
} from '@mercaria/shared-types';
import {
  ANALYTICS_MERCHANT_MIN_COHORT,
  CONVERSION_REPORT_MAX_LISTINGS,
  CONVERSION_REPORT_MAX_WINDOW_DAYS,
  CONVERSION_REPORT_RANKED_LISTINGS,
} from '@mercaria/shared-types';
import {
  countCheckoutsByBucket,
  countListingCheckouts,
  countStoreCheckouts,
  type ConversionCounts,
  type ConversionWindow,
} from '../db/orders/conversionReportRepository.js';
import { validationError } from '../lib/errors/error-codes.js';

const DAY_MS = 86_400_000;

/** The default window: the last 28 UTC days, today included. */
const DEFAULT_WINDOW_DAYS = 28;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → midnight UTC, or `undefined` for anything that is not a real date. */
function parseDate(raw: string): number | undefined {
  if (!DATE_PATTERN.test(raw)) return undefined;
  const at = Date.parse(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(at)) return undefined;
  // `2026-02-31` parses to March 3rd; round-tripping refuses it.
  return new Date(at).toISOString().slice(0, 10) === raw ? at : undefined;
}

function toDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Resolve the requested window: UTC calendar dates, both inclusive, at most
 * `CONVERSION_REPORT_MAX_WINDOW_DAYS` long, defaulting to the last 28 days.
 *
 * Refuses rather than repairs: a swapped or malformed bound is a 400, because a
 * report silently answering a different question than the one asked is the
 * failure a merchant cannot see.
 */
export function resolveConversionWindow(
  input: { from?: string; to?: string },
  now: Date = new Date(),
): ConversionReportWindow {
  const today = toDate(now.getTime());
  const toAt = input.to === undefined ? parseDate(today) : parseDate(input.to);
  if (toAt === undefined) throw validationError('to must be a date (YYYY-MM-DD)');
  const fromAt =
    input.from === undefined ? toAt - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS : parseDate(input.from);
  if (fromAt === undefined) throw validationError('from must be a date (YYYY-MM-DD)');
  if (fromAt > toAt) throw validationError('from must not be after to');
  const days = (toAt - fromAt) / DAY_MS + 1;
  if (days > CONVERSION_REPORT_MAX_WINDOW_DAYS) {
    throw validationError(
      `the window may span at most ${String(CONVERSION_REPORT_MAX_WINDOW_DAYS)} days`,
    );
  }
  return { from: toDate(fromAt), to: toDate(toAt) };
}

/** The half-open instant range a date window covers. */
function instants(window: ConversionReportWindow): ConversionWindow {
  return {
    from: new Date(`${window.from}T00:00:00.000Z`),
    to: new Date(Date.parse(`${window.to}T00:00:00.000Z`) + DAY_MS),
  };
}

/** The window of the same length that ends the day before `window.from`. */
export function previousConversionWindow(window: ConversionReportWindow): ConversionReportWindow {
  const fromAt = Date.parse(`${window.from}T00:00:00.000Z`);
  const days = (Date.parse(`${window.to}T00:00:00.000Z`) - fromAt) / DAY_MS + 1;
  return { from: toDate(fromAt - days * DAY_MS), to: toDate(fromAt - DAY_MS) };
}

/** A suppressed figure set: zeros, a null rate, and the flag saying why. */
const SUPPRESSED: ConversionFigures = {
  aboveThreshold: false,
  checkoutsStarted: 0,
  paidCheckouts: 0,
  openCheckouts: 0,
  abandonedCheckouts: 0,
  unitsSold: 0,
  conversionRate: null,
};

/**
 * Publish or suppress one cohort's counts — the ONLY place either happens.
 *
 * Exported so the threshold is tested at the boundary itself (9 and 10), not
 * through whichever report happens to call it.
 */
export function toFigures(counts: ConversionCounts): ConversionFigures {
  if (counts.started < ANALYTICS_MERCHANT_MIN_COHORT) return SUPPRESSED;
  return {
    aboveThreshold: true,
    checkoutsStarted: counts.started,
    paidCheckouts: counts.paid,
    // The remainder, so the three partition the started set exactly even if a
    // status outside the two named ones appears.
    openCheckouts: Math.max(0, counts.started - counts.paid - counts.abandoned),
    abandonedCheckouts: counts.abandoned,
    unitsSold: counts.unitsSold,
    conversionRate: counts.paid / counts.started,
  };
}

/** Best converters first; ties to the larger cohort, then the id, so the order is stable. */
function byConversionDesc(a: ListingConversionRow, b: ListingConversionRow): number {
  return (
    (b.figures.conversionRate ?? 0) - (a.figures.conversionRate ?? 0) ||
    b.figures.checkoutsStarted - a.figures.checkoutsStarted ||
    a.listingId.localeCompare(b.listingId)
  );
}

/** Worst converters first; ties to the larger cohort (the bigger problem), then the id. */
function byConversionAsc(a: ListingConversionRow, b: ListingConversionRow): number {
  return (
    (a.figures.conversionRate ?? 0) - (b.figures.conversionRate ?? 0) ||
    b.figures.checkoutsStarted - a.figures.checkoutsStarted ||
    a.listingId.localeCompare(b.listingId)
  );
}

/** The per-listing report for one store and window. */
export async function getListingConversionReport(input: {
  storeId: string;
  window: ConversionReportWindow;
}): Promise<ListingConversionReport> {
  const range = instants(input.window);
  const [totals, perListing] = await Promise.all([
    countStoreCheckouts(input.storeId, range),
    countListingCheckouts(input.storeId, range),
  ]);

  const published: ListingConversionRow[] = [];
  let suppressedListingCount = 0;
  for (const row of perListing) {
    const figures = toFigures(row);
    if (figures.aboveThreshold) {
      published.push({ listingId: row.listingId, title: row.title, figures });
    } else {
      suppressedListingCount += 1;
    }
  }
  published.sort(
    (a, b) =>
      b.figures.checkoutsStarted - a.figures.checkoutsStarted ||
      a.listingId.localeCompare(b.listingId),
  );
  const listings = published.slice(0, CONVERSION_REPORT_MAX_LISTINGS);
  suppressedListingCount += published.length - listings.length;

  const bestConverting = [...listings]
    .sort(byConversionDesc)
    .slice(0, CONVERSION_REPORT_RANKED_LISTINGS);
  const best = new Set(bestConverting.map((row) => row.listingId));
  const worstConverting = [...listings]
    .filter((row) => !best.has(row.listingId))
    .sort(byConversionAsc)
    .slice(0, CONVERSION_REPORT_RANKED_LISTINGS);

  return {
    storeId: input.storeId,
    window: input.window,
    minimumCohort: ANALYTICS_MERCHANT_MIN_COHORT,
    totals: toFigures(totals),
    listings,
    suppressedListingCount,
    bestConverting,
    worstConverting,
  };
}

/** Every bucket start in the window, so an empty bucket is a row rather than a gap. */
function bucketStarts(
  window: ConversionReportWindow,
  interval: ConversionReportInterval,
): string[] {
  const fromAt = Date.parse(`${window.from}T00:00:00.000Z`);
  const toAt = Date.parse(`${window.to}T00:00:00.000Z`);
  // An ISO week starts on Monday; `getUTCDay` is 0 for Sunday.
  const first =
    interval === 'week' ? fromAt - ((new Date(fromAt).getUTCDay() + 6) % 7) * DAY_MS : fromAt;
  const step = interval === 'week' ? 7 * DAY_MS : DAY_MS;
  const starts: string[] = [];
  for (let at = first; at <= toAt; at += step) starts.push(toDate(at));
  return starts;
}

/** Relative change, or null when there is nothing to compare against. */
function relativeChange(current: number, previous: number): number | null {
  return previous === 0 ? null : (current - previous) / previous;
}

/** The trend report: zero-filled buckets plus the period-over-period comparison. */
export async function getConversionTrendReport(input: {
  storeId: string;
  window: ConversionReportWindow;
  interval: ConversionReportInterval;
}): Promise<ConversionTrendReport> {
  const previousWindow = previousConversionWindow(input.window);
  const [byBucket, current, previous] = await Promise.all([
    countCheckoutsByBucket(input.storeId, instants(input.window), input.interval),
    countStoreCheckouts(input.storeId, instants(input.window)),
    countStoreCheckouts(input.storeId, instants(previousWindow)),
  ]);

  const counted = new Map(byBucket.map((row) => [row.bucketStart, row]));
  const buckets: ConversionTrendBucket[] = bucketStarts(input.window, input.interval).map(
    (bucketStart) => ({
      bucketStart,
      figures: toFigures(
        counted.get(bucketStart) ?? { started: 0, paid: 0, abandoned: 0, unitsSold: 0 },
      ),
    }),
  );

  const currentFigures = toFigures(current);
  const previousFigures = toFigures(previous);
  // Only when BOTH periods are published: a change against a suppressed period
  // would disclose the suppressed figure to anyone who can divide.
  const change: ConversionPeriodChange | null =
    currentFigures.aboveThreshold && previousFigures.aboveThreshold
      ? {
          checkoutsStarted: relativeChange(
            currentFigures.checkoutsStarted,
            previousFigures.checkoutsStarted,
          ),
          paidCheckouts: relativeChange(
            currentFigures.paidCheckouts,
            previousFigures.paidCheckouts,
          ),
          conversionRate:
            (currentFigures.conversionRate ?? 0) - (previousFigures.conversionRate ?? 0),
        }
      : null;

  return {
    storeId: input.storeId,
    interval: input.interval,
    minimumCohort: ANALYTICS_MERCHANT_MIN_COHORT,
    window: input.window,
    buckets,
    current: currentFigures,
    previousWindow,
    previous: previousFigures,
    change,
  };
}

// ---------------------------------------------------------------------------
// CSV — the same figures the JSON carries, and nothing else.
// ---------------------------------------------------------------------------

/**
 * One CSV cell, `price-signals.controller`'s rule: a leading `=`, `+`, `-` or
 * `@` is prefixed with an apostrophe, because a spreadsheet runs it as a
 * formula and a listing title is free text.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function csv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

const FIGURE_HEADER = [
  'checkouts_started',
  'paid_checkouts',
  'open_checkouts',
  'abandoned_checkouts',
  'units_sold',
  'conversion_rate',
] as const;

/** A figure set's cells; a suppressed one says so in every cell rather than writing zeros. */
function figureCells(figures: ConversionFigures, minimumCohort: number): string[] {
  if (!figures.aboveThreshold) {
    return FIGURE_HEADER.map(() => `suppressed_below_${String(minimumCohort)}`);
  }
  return [
    String(figures.checkoutsStarted),
    String(figures.paidCheckouts),
    String(figures.openCheckouts),
    String(figures.abandonedCheckouts),
    String(figures.unitsSold),
    (figures.conversionRate ?? 0).toFixed(4),
  ];
}

/**
 * The per-listing report as CSV: the store total first, then the published
 * listings. Suppressed listings are absent, as in the JSON, and the last row
 * says how many there were.
 */
export function listingReportCsv(report: ListingConversionReport): string {
  const rows: string[][] = [
    ['window_from', 'window_to', 'listing_id', 'title', ...FIGURE_HEADER],
    [
      report.window.from,
      report.window.to,
      '',
      'All listings',
      ...figureCells(report.totals, report.minimumCohort),
    ],
  ];
  for (const row of report.listings) {
    rows.push([
      report.window.from,
      report.window.to,
      row.listingId,
      row.title,
      ...figureCells(row.figures, report.minimumCohort),
    ]);
  }
  if (report.suppressedListingCount > 0) {
    rows.push([
      report.window.from,
      report.window.to,
      '',
      `${String(report.suppressedListingCount)} more listings below ${String(report.minimumCohort)} checkouts`,
      ...FIGURE_HEADER.map(() => `suppressed_below_${String(report.minimumCohort)}`),
    ]);
  }
  return csv(rows);
}

/** The trend as CSV: one row per bucket, then both period totals. */
export function trendReportCsv(report: ConversionTrendReport): string {
  const rows: string[][] = [['period', 'bucket_start', 'interval', ...FIGURE_HEADER]];
  for (const bucket of report.buckets) {
    rows.push([
      'bucket',
      bucket.bucketStart,
      report.interval,
      ...figureCells(bucket.figures, report.minimumCohort),
    ]);
  }
  rows.push([
    'current_total',
    report.window.from,
    `${report.window.from}..${report.window.to}`,
    ...figureCells(report.current, report.minimumCohort),
  ]);
  rows.push([
    'previous_total',
    report.previousWindow.from,
    `${report.previousWindow.from}..${report.previousWindow.to}`,
    ...figureCells(report.previous, report.minimumCohort),
  ]);
  return csv(rows);
}
