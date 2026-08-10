/**
 * Turning raw entries into a SAMPLE a claim may or may not be made from (#82
 * statistical policy 3, 4 and 5) — PURE.
 *
 * Two families, and the difference is what deduplication MEANS:
 *
 * - A **cross-sectional** sample is every eligible offer at one instant. One
 *   merchant reached through two syndicators is one seller, so it is folded.
 * - A **longitudinal** sample is one price per time bucket over a window. Folding
 *   it by seller would collapse a month of history into one point, which is why
 *   `deduplicate` is a parameter rather than something this module decides. Its
 *   `deduplicated` count is honestly zero: nothing was foldable, and reporting a
 *   number there would suggest a fold that never applied.
 *
 * Both families report their `distinctSellers`, and the policy's floor applies to
 * both — a thirty-day chart drawn entirely from one shop is a record of that
 * shop's pricing and not of a market, and it must not become a "typical range".
 */

import type { PriceSignalSample } from '@mercaria/shared-types';
import {
  coverageDays,
  deduplicateBySeller,
  partitionOutliers,
  type PriceSampleEntry,
} from './statistics.js';

/** A sample, the entries it kept, and the entries the robust method set aside. */
export interface BuiltSample {
  readonly sample: PriceSignalSample;
  /** Ascending by amount, then time, then id — the total order every selection uses. */
  readonly kept: readonly PriceSampleEntry[];
  readonly excluded: readonly PriceSampleEntry[];
}

/**
 * Build one sample.
 *
 * The order is load-bearing: deduplicate FIRST, then detect outliers. Reversed,
 * five syndicated copies of one wrong price form their own cluster, pull the
 * median toward themselves and make the CORRECT prices look like the outliers —
 * which is the failure "source-aware deduplication" exists to prevent, arriving
 * through the door marked "robust statistics".
 */
export function buildSample(
  entries: readonly PriceSampleEntry[],
  options: {
    readonly deduplicate: boolean;
    readonly outlierModifiedZThreshold: number;
    readonly outlierMinDeviationBps: number;
  },
): BuiltSample {
  const deduped = options.deduplicate
    ? deduplicateBySeller(entries)
    : {
        entries: [...entries].sort((left, right) => {
          if (left.amount !== right.amount) return left.amount - right.amount;
          const byTime = left.observedAt.getTime() - right.observedAt.getTime();
          if (byTime !== 0) return byTime;
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        }),
        deduplicated: 0,
        distinctSellers: new Set(entries.map((entry) => entry.sellerKey)).size,
        distinctOffers: new Set(entries.map((entry) => entry.offerId)).size,
      };

  const partition = partitionOutliers(
    deduped.entries,
    options.outlierModifiedZThreshold,
    options.outlierMinDeviationBps,
  );

  return {
    sample: {
      observations: partition.kept.length,
      // Counted over what SURVIVED, so a sample whose only second seller was an
      // outlier reports one seller and fails the floor — the alternative reports
      // a market of two and computes a median over one.
      distinctSellers: new Set(partition.kept.map((entry) => entry.sellerKey)).size,
      distinctOffers: new Set(partition.kept.map((entry) => entry.offerId)).size,
      coverageDays: coverageDays(partition.kept),
      outliersExcluded: partition.excluded.length,
      deduplicated: deduped.deduplicated,
    },
    kept: partition.kept,
    excluded: partition.excluded,
  };
}

/** An empty sample, for the branches that never got as far as gathering one. */
export const EMPTY_PRICE_SIGNAL_SAMPLE: PriceSignalSample = {
  observations: 0,
  distinctSellers: 0,
  distinctOffers: 0,
  coverageDays: 0,
  outliersExcluded: 0,
  deduplicated: 0,
};
