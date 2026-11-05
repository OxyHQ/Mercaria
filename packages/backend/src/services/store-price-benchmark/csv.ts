/**
 * The store price-analytics export, as CSV.
 *
 * A RENDERING of exactly the rows the JSON carries — #82's rule: a second query
 * with its own idea of what a store may see is how an export ends up with a
 * column the API withholds. Every column is a field of `StorePriceAnalyticsRow`,
 * so there is no column for another seller: the file cannot carry what the type
 * does not have.
 *
 * Amounts are written in MAJOR units of the row's own currency, with the
 * currency beside them, because a spreadsheet is read by a person; the minor
 * units are the JSON's.
 */

import {
  CURRENCY_PRECISION,
  type CurrencyCode,
  type StorePriceAnalyticsResponse,
} from '@mercaria/shared-types';

const HEADER = [
  'listing_id',
  'product_variant_id',
  'listing_title',
  'variant_title',
  'sku',
  'canonical_product',
  'condition_segment',
  'currency',
  'your_price',
  'in_comparison',
  'state',
  'reason',
  'position',
  'other_sellers',
  'other_offers',
  'lowest_other_price',
  'median_other_price',
  'vs_lowest_percent',
  'vs_median_percent',
  'outliers_excluded',
  'fx_provider',
  'fx_as_of',
  'computed_at',
];

/**
 * One CSV cell. A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe,
 * because a spreadsheet reads it as a formula and a listing title is text the
 * store typed — #82's guard, for #82's reason. A plain number (`-3.25`) is not
 * a formula and is left as it is, so a negative percentage stays a number.
 */
function cell(value: string): string {
  const numeric = /^-?\d+(\.\d+)?$/.test(value);
  const guarded = !numeric && /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Minor units → a plain decimal string in the currency's own precision. */
function major(amount: number | null | undefined, currency: string | null): string {
  if (amount === null || amount === undefined) return '';
  const precision =
    currency !== null && currency in CURRENCY_PRECISION
      ? CURRENCY_PRECISION[currency as CurrencyCode]
      : 2;
  if (precision === 0) return String(amount);
  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(precision + 1, '0');
  const whole = digits.slice(0, -precision);
  const fraction = digits.slice(-precision);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Basis points → a percent with two decimals. */
function percent(bps: number | undefined): string {
  return bps === undefined ? '' : (bps / 100).toFixed(2);
}

export function toStorePriceAnalyticsCsv(response: StorePriceAnalyticsResponse): string {
  const lines = response.rows.map((row) =>
    [
      row.listingId,
      row.productVariantId,
      row.listingTitle,
      row.variantTitle ?? '',
      row.sku ?? '',
      row.canonicalProductName ?? '',
      row.segment ?? '',
      row.currency ?? '',
      major(row.ownAmount, row.currency),
      String(row.inComparison),
      row.state,
      row.reason ?? '',
      row.position?.band ?? '',
      row.market === undefined ? '' : String(row.market.otherSellers),
      row.market === undefined ? '' : String(row.market.otherOffers),
      major(row.market?.lowestAmount, row.currency),
      major(row.market?.medianAmount, row.currency),
      percent(row.position?.deltaToLowestBps),
      percent(row.position?.deltaToMedianBps),
      row.market === undefined ? '' : String(row.market.outliersExcluded),
      row.conversion?.provider ?? '',
      row.conversion?.asOf ?? '',
      response.computedAt,
    ]
      .map(cell)
      .join(','),
  );
  return [HEADER.map(cell).join(','), ...lines].join('\n');
}
