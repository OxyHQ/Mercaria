/**
 * The pure core of the store price-analytics tool: from the OTHER sellers'
 * prices to an aggregate a store may see, and from the store's own price to a
 * position band. No clock, no connection.
 *
 * Every statistic is #82's, imported rather than re-spelled: one entry per
 * seller (`deduplicateBySeller`, the cheapest), the modified-z-score outlier
 * method (`partitionOutliers`), the LOWER median (`lowerMedianIndex`) and the
 * basis-point delta (`priceDeltaBps`). A second spelling of "the median of the
 * market" would be a second answer to a question a shopper's badge already
 * answers (ADR 0002's one-verdict rule).
 *
 * ## The floors are #82's four, applied by #82's own check
 *
 * The aggregate is published only when the other sellers clear the active
 * policy's `minObservations`, `minDistinctSellers`, `minDistinctOffers` AND
 * `minCoverageDays` — `priceSampleShortfall`, the function the free
 * `/merchant-competitiveness` rows and the shopper's badge call. The coverage
 * floor works on a cross-section because each current entry carries its offer's
 * own observation record (`PriceSampleEntry.observedFrom`, set by
 * `buildPriceSignalContext`), so a market of offers first seen an hour ago is
 * `insufficient_time_coverage` rather than a median. The trend's per-bucket
 * entries carry the same record, from the same `observationSpanStart`.
 */

import {
  priceDeltaBps,
  priceSampleShortfall,
  STORE_PRICE_NEAR_LOWEST_BPS,
  type PriceSignalPolicy,
  type StorePriceMarket,
  type StorePricePosition,
  type StorePricePositionBand,
  type StorePriceUnmeasuredReason,
} from '@mercaria/shared-types';
import { buildSample } from '../price-signals/sample.js';
import { lowerMedianIndex, type PriceSampleEntry } from '../price-signals/statistics.js';

/** The policy fields this tool reads — the four floors and the outlier method. */
export type StorePriceFloors = Pick<
  PriceSignalPolicy,
  | 'version'
  | 'minObservations'
  | 'minDistinctSellers'
  | 'minDistinctOffers'
  | 'minCoverageDays'
  | 'outlierModifiedZThreshold'
  | 'outlierMinDeviationBps'
>;

export type MarketOutcome =
  | { readonly outcome: 'measured'; readonly market: StorePriceMarket }
  | { readonly outcome: 'unmeasured'; readonly reason: StorePriceUnmeasuredReason };

/**
 * The other sellers' aggregate, or why there is none.
 *
 * `others` must already exclude every entry of the store itself (its other
 * listings and a linked canonical merchant): comparing a price against a market
 * it is part of answers "am I me".
 */
export function summarizeMarket(
  others: readonly PriceSampleEntry[],
  policy: StorePriceFloors,
): MarketOutcome {
  const built = buildSample(others, {
    deduplicate: true,
    outlierModifiedZThreshold: policy.outlierModifiedZThreshold,
    outlierMinDeviationBps: policy.outlierMinDeviationBps,
  });
  const shortfall: StorePriceUnmeasuredReason | undefined = priceSampleShortfall(
    built.sample,
    policy,
  );
  if (shortfall !== undefined) return { outcome: 'unmeasured', reason: shortfall };

  const lowest = built.kept[0];
  const medianIndex = lowerMedianIndex(built.kept);
  const median = medianIndex === undefined ? undefined : built.kept[medianIndex];
  if (lowest === undefined || median === undefined) {
    // Unreachable once the floors are cleared (they are ≥ 1), and answered as
    // the floor it would have failed rather than with a number.
    return { outcome: 'unmeasured', reason: 'insufficient_observations' };
  }
  return {
    outcome: 'measured',
    market: {
      otherSellers: built.sample.distinctSellers,
      otherOffers: built.sample.distinctOffers,
      lowestAmount: lowest.amount,
      medianAmount: median.amount,
      outliersExcluded: built.sample.outliersExcluded,
    },
  };
}

/**
 * Where the store's own price sits, in {@link STORE_PRICE_POSITION_BANDS}' order.
 *
 * Inclusive at each edge, toward the better band: a price equal to the lowest
 * IS the lowest, one exactly 5% above it is `near_lowest`, one equal to the
 * median is `at_or_below_median`.
 */
export function positionBandFor(
  ownAmount: number,
  market: Pick<StorePriceMarket, 'lowestAmount' | 'medianAmount'>,
): StorePricePositionBand {
  if (ownAmount <= market.lowestAmount) return 'lowest';
  if (priceDeltaBps(ownAmount, market.lowestAmount) <= STORE_PRICE_NEAR_LOWEST_BPS) {
    return 'near_lowest';
  }
  if (ownAmount <= market.medianAmount) return 'at_or_below_median';
  return 'above_median';
}

export function positionFor(ownAmount: number, market: StorePriceMarket): StorePricePosition {
  return {
    band: positionBandFor(ownAmount, market),
    deltaToLowestBps: priceDeltaBps(ownAmount, market.lowestAmount),
    deltaToMedianBps: priceDeltaBps(ownAmount, market.medianAmount),
  };
}
