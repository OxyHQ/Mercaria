/**
 * Summarising one pass of observations, so a later pass can be compared against
 * it (#68 anomaly 1 and 3).
 *
 * PURE. It takes the prices a page carried and answers four numbers; it reads
 * nothing and writes nothing. That is what makes "does a legitimate sale trip
 * the detector" answerable from a table of inputs rather than from a seeded
 * database — and the question is not rhetorical, because a detector that
 * quarantines a sale is one whoever hits it next switches off.
 *
 * ## The MEDIAN, deliberately, and not the mean
 *
 * A feed that publishes one item at a hundred thousand euro moves a mean by an
 * order of magnitude and a median not at all. The failure this detector exists
 * to catch — minor units published where majors were, a currency renamed, a
 * placeholder served — moves EVERY row, so it moves the median too. Using the
 * mean would fire on a single outlier and miss nothing extra.
 *
 * ## A price with no currency is not counted as priced
 *
 * `pricedCount` counts rows carrying BOTH halves of a money, matching
 * `offers_price_paired_check` one domain over. Counting a bare amount would let
 * a feed that dropped its currency column read as fully priced while the
 * currency detector had nothing to compare.
 */

import type { SourceObservationDistribution } from '@mercaria/shared-types';

/** One observed price, as the summariser reads it. */
export interface ObservedPrice {
  readonly amount: number;
  readonly currency: string;
}

/**
 * The median of a sorted-in-place copy.
 *
 * Even-length arrays take the LOWER of the two middles rather than their mean:
 * the value is compared as a ratio against another median, and averaging two
 * integers introduces a half-unit that means nothing in minor units and can
 * only make an exact 100× shift read as 99.5×.
 */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) / 2);
  return sorted[index] ?? null;
}

/**
 * Summarise the prices one pass observed.
 *
 * `sampleSize` counts every record the pass READ, priced or not, because it is
 * what the minimum-sample floor is measured against: a pass over ten thousand
 * unpriced informational records is a large sample about which the price
 * detectors have nothing to say, and calling it a small sample would let a feed
 * dodge every threshold by publishing prices on one row in a thousand.
 */
export function summariseObservations(input: {
  readonly sampleSize: number;
  readonly prices: readonly ObservedPrice[];
}): SourceObservationDistribution {
  const byCurrency = new Map<string, number[]>();
  let zeroPricedCount = 0;
  for (const price of input.prices) {
    if (price.amount === 0) zeroPricedCount += 1;
    const bucket = byCurrency.get(price.currency);
    if (bucket === undefined) byCurrency.set(price.currency, [price.amount]);
    else bucket.push(price.amount);
  }

  let dominantCurrency: string | null = null;
  let dominantCount = 0;
  for (const [currency, amounts] of byCurrency) {
    if (amounts.length > dominantCount) {
      dominantCurrency = currency;
      dominantCount = amounts.length;
    }
  }

  // The median is taken WITHIN the dominant currency, never across all of them.
  // A feed serving 90% EUR and 10% HUF has a perfectly stable EUR median and a
  // mixed-currency median that jumps whenever the mix moves — which would make
  // the scale detector fire on a change in the FEED's composition rather than
  // in its prices.
  const dominantAmounts = dominantCurrency === null ? [] : (byCurrency.get(dominantCurrency) ?? []);

  return {
    sampleSize: input.sampleSize,
    pricedCount: input.prices.length,
    zeroPricedCount,
    medianPriceMinor: medianOf(dominantAmounts),
    dominantCurrency,
    dominantCurrencyShare:
      input.prices.length === 0 ? 0 : dominantCount / input.prices.length,
  };
}

/**
 * Merge two distributions of the same pass.
 *
 * A run is many pages and the baseline is written once at the end, so the
 * page-level summaries have to combine. The medians CANNOT be merged — a median
 * of medians is not a median — so the merged value is the one from the larger
 * sample, which is the closest honest answer available without keeping every
 * price in memory for a feed of a million rows.
 *
 * That approximation is stated rather than hidden because it bounds what the
 * scale detector can claim: over pages of comparable size it is the median of
 * one representative page, which is exactly what a 100× shift moves and a sale
 * does not.
 */
export function mergeDistributions(
  left: SourceObservationDistribution,
  right: SourceObservationDistribution,
): SourceObservationDistribution {
  const dominantFrom = right.pricedCount > left.pricedCount ? right : left;
  const pricedCount = left.pricedCount + right.pricedCount;
  return {
    sampleSize: left.sampleSize + right.sampleSize,
    pricedCount,
    zeroPricedCount: left.zeroPricedCount + right.zeroPricedCount,
    medianPriceMinor: dominantFrom.medianPriceMinor,
    dominantCurrency: dominantFrom.dominantCurrency,
    dominantCurrencyShare:
      pricedCount === 0
        ? 0
        : (left.dominantCurrencyShare * left.pricedCount +
            right.dominantCurrencyShare * right.pricedCount) /
          pricedCount,
  };
}

/** The empty distribution — a pass that read nothing yet. */
export const EMPTY_DISTRIBUTION: SourceObservationDistribution = {
  sampleSize: 0,
  pricedCount: 0,
  zeroPricedCount: 0,
  medianPriceMinor: null,
  dominantCurrency: null,
  dominantCurrencyShare: 0,
};
