/**
 * What a merchant may see about their OWN offers (#77 "Merchant analytics").
 *
 * ## Aggregate-only, and the projection is the enforcement
 *
 * `MerchantAnalyticsSummary` has five counts, a store id, a window and the
 * metric definitions behind them. It has NO field for a user, a guest, a query
 * string, a contact, a portal access, a claim status or a payment-method
 * identity — so merchant rules 3 and 4 are enforced by the shape of the
 * response rather than by a filter somebody has to keep correct. The seller
 * order projection (ADR 0003 D13) uses the same device for the same reason: a
 * response with no field for a thing cannot leak the thing.
 *
 * ## The threshold suppresses, it does not round
 *
 * Below `ANALYTICS_MERCHANT_MIN_COHORT` the figures are reported as ZERO with
 * `aboveThreshold: false`, not rounded, not bucketed and not blurred. Rounding
 * a 3 to "under 10" still tells a merchant somebody was there; on a store with
 * one product and one visitor a day, "under 10" plus a timestamp is a person.
 * Suppression is the only aggregation that survives a merchant who knows their
 * own traffic.
 *
 * ## Bots, previews and internal traffic are already gone
 *
 * They were excluded when the rollup wrote the bucket (`humanOnly`), not here.
 * That matters: a filter applied at READ leaves the inflated figure in the
 * stored aggregate for the next reader to forget about, and merchant rule 7 is
 * about what a merchant is shown, not about what a particular endpoint
 * remembered to subtract.
 *
 * ## Guest and authenticated are NOT compared here
 *
 * Merchant rule 5 permits the comparison "only when sample size and product
 * purpose justify it", and neither is established. So the summary carries no
 * buyer-origin breakdown at all: it reads the `''` (undimensioned) buckets. A
 * merchant cannot therefore learn that a named purchase came from a guest,
 * which is rule 3 and identity rule 7 arriving at the same place from two
 * directions.
 */

import type { AnalyticsMetricDefinition, MerchantAnalyticsSummary } from '@mercaria/shared-types';
import { ANALYTICS_MERCHANT_MIN_COHORT } from '@mercaria/shared-types';
import { readRollups } from '../../db/analytics/rollupRepository.js';
import { merchantVisibleMetrics } from './metrics.js';

/**
 * The metric keys a store summary is built from.
 *
 * Each contributes its DENOMINATOR to one of the five counts, because a
 * denominator is the event that actually happened on the merchant's own
 * surface: `search_to_product_click_rate`'s denominator is impressions of their
 * results, `product_to_offer_selection_rate`'s is views of their product pages.
 * Reading the numerators instead would report the merchant's clicks as their
 * impressions, which is the kind of off-by-one-concept mistake a chart never
 * reveals.
 */
const SUMMARY_METRICS = {
  impressions: 'search_to_product_click_rate',
  productViews: 'product_to_offer_selection_rate',
  offerActions: 'external_click_through_rate',
  checkoutStarts: 'native_checkout_conversion',
  paidOrders: 'native_checkout_conversion',
} as const;

/**
 * Build one store's summary.
 *
 * `storeId` is the SCOPE and is passed straight to the repository's required
 * `storeId` discriminator, so there is no way to call this for "every store"
 * — the parameter has no default and the repository has no unscoped reader that
 * a merchant path could reach by omission.
 */
export async function getMerchantAnalyticsSummary(input: {
  storeId: string;
  from: string;
  to: string;
}): Promise<MerchantAnalyticsSummary> {
  const rows = await readRollups({
    metricKeys: [...new Set(Object.values(SUMMARY_METRICS))],
    from: input.from,
    to: input.to,
    storeId: input.storeId,
  });

  let impressions = 0;
  let productViews = 0;
  let offerActions = 0;
  let checkoutStarts = 0;
  let paidOrders = 0;

  for (const row of rows) {
    if (row.metricKey === SUMMARY_METRICS.impressions) impressions += row.denominator;
    if (row.metricKey === SUMMARY_METRICS.productViews) productViews += row.denominator;
    if (row.metricKey === SUMMARY_METRICS.offerActions) offerActions += row.numerator;
    if (row.metricKey === SUMMARY_METRICS.checkoutStarts) checkoutStarts += row.denominator;
    // Paid orders come from the CONVERSION metric's numerator, which the rollup
    // sourced from `payments` — never from a checkout-start event. A merchant's
    // "paid orders" figure that a client could inflate is worse than no figure.
    if (row.metricKey === SUMMARY_METRICS.paidOrders) paidOrders += row.numerator;
  }

  // The threshold is applied to the LARGEST count, not to each independently.
  // Suppressing per-field would publish the ones that happened to clear it and
  // suppress the ones that did not — from which the suppressed values are
  // trivially bounded, which is the differencing attack the threshold exists to
  // stop.
  const largest = Math.max(impressions, productViews, offerActions, checkoutStarts, paidOrders);
  const aboveThreshold = largest >= ANALYTICS_MERCHANT_MIN_COHORT;

  return {
    storeId: input.storeId,
    from: input.from,
    to: input.to,
    aboveThreshold,
    impressions: aboveThreshold ? impressions : 0,
    productViews: aboveThreshold ? productViews : 0,
    offerActions: aboveThreshold ? offerActions : 0,
    checkoutStarts: aboveThreshold ? checkoutStarts : 0,
    paidOrders: aboveThreshold ? paidOrders : 0,
    definitions: merchantDefinitions(),
  };
}

/**
 * The definitions rendered beside the figures.
 *
 * Merchant rule 8 ("every merchant metric names its denominator and attribution
 * limit") is satisfied by SHIPPING the definition, not by documenting it: a
 * dashboard that receives `attributionLimit` in the payload has to decide to
 * hide it, where one that receives only a number has to decide to look it up.
 */
function merchantDefinitions(): readonly AnalyticsMetricDefinition[] {
  const keys = new Set<string>(Object.values(SUMMARY_METRICS));
  return merchantVisibleMetrics().filter((metric) => keys.has(metric.key));
}
