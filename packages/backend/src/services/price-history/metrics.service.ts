/**
 * The operator surface's reads (#78 operations 1).
 *
 * Two things, and both exist because the domain's own rows cannot show them: a
 * DEDUPLICATION rate, which needs a counter of the writes that did not happen,
 * and an AGGREGATION LAG, which is the age of the oldest outstanding rebuild
 * rather than a property of anything stored.
 */

import {
  type OfferPriceObservation,
  type PriceHistoryOfferTrace,
  type PriceHistoryOperationalMetrics,
  type PriceObservationAnomaly,
  type PriceObservationChangeReason,
  type PriceTaxInclusion,
  CONDITION_KEY_GROUP,
  type ConditionGroup,
  type ItemConditionKey,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { summarizePriceSeries } from '../../db/priceHistory/priceSeriesRepository.js';
import {
  listPriceSnapshotsForOffer,
  type OfferPriceSnapshotRow,
} from '../../db/priceHistory/priceSnapshotRepository.js';
import {
  priceMetricsBucketDay,
  sumPriceWriteMetrics,
} from '../../db/priceHistory/priceWriteMetricsRepository.js';

/** How the domain is doing, over a window. */
export async function readPriceHistoryMetrics(
  windowDays: number,
  now: Date = new Date(),
): Promise<PriceHistoryOperationalMetrics> {
  const since = priceMetricsBucketDay(
    new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1_000),
  );
  const [writes, series] = await Promise.all([
    sumPriceWriteMetrics(since),
    summarizePriceSeries(undefined, now),
  ]);

  const offered = writes.written + writes.deduplicated;
  return {
    windowDays,
    observationsWritten: writes.written,
    observationsDeduplicated: writes.deduplicated,
    observationsRefused: writes.refused,
    observationsFlaggedAnomalous: writes.flaggedAnomalous,
    // Absent rather than zero when nothing was offered: a rate of 0 out of 0
    // reads as "the dedup is doing nothing", which is exactly the alarm this
    // metric exists to raise when it is true.
    ...(offered > 0 ? { deduplicationRate: writes.deduplicated / offered } : {}),
    seriesTotal: series.total,
    seriesPending: series.pending,
    seriesDeadLettered: series.deadLetter,
    ...(series.oldestPendingRebuildAgeSeconds === undefined
      ? {}
      : { oldestPendingRebuildAgeSeconds: series.oldestPendingRebuildAgeSeconds }),
  };
}

/** One offer's whole observation trail — what an operator opens to explain a step. */
export async function tracePriceHistoryForOffer(
  offerId: string,
): Promise<PriceHistoryOfferTrace> {
  const rows = await listPriceSnapshotsForOffer(offerId, config.priceHistory.traceLimit);
  const corrected = new Set(
    rows.flatMap((row) => (row.supersedesSnapshotId ? [row.supersedesSnapshotId] : [])),
  );

  return {
    offerId,
    observations: rows.map(toObservationDTO),
    // The exclusions this read can answer WITHOUT a rate map or a rights
    // resolution: a superseded correction and a flagged anomaly are properties
    // of the stored rows. Everything else — freshness, rights, currency,
    // segment — is a decision the derivation makes with inputs this trace does
    // not take, and reporting a guess at it would be worse than reporting
    // nothing, because an operator would act on it.
    exclusions: rows.flatMap((row) => {
      const reasons = [
        ...(corrected.has(row.id) ? (['superseded_observation'] as const) : []),
        ...(row.anomalies.length > 0 ? (['anomalous_observation'] as const) : []),
      ];
      return reasons.length > 0 ? [{ observationId: row.id, reasons }] : [];
    }),
  };
}

/** The projection. Every field named, and nothing about a person in any of them. */
function toObservationDTO(row: OfferPriceSnapshotRow): OfferPriceObservation {
  const segment: ConditionGroup | undefined =
    row.conditionKey === 'unknown'
      ? undefined
      : CONDITION_KEY_GROUP[row.conditionKey as ItemConditionKey];

  return {
    id: row.id,
    offerId: row.offerId,
    ...(row.sourceRecordId ? { sourceRecordId: row.sourceRecordId } : {}),
    ...(row.sourceRunId ? { sourceRunId: row.sourceRunId } : {}),
    observedAt: row.observedAt.toISOString(),
    itemPrice: { amount: row.itemPriceAmount, currency: row.itemPriceCurrency },
    ...(row.compareAtPriceAmount !== null && row.compareAtPriceCurrency !== null
      ? {
          compareAtPrice: {
            amount: row.compareAtPriceAmount,
            currency: row.compareAtPriceCurrency,
          },
        }
      : {}),
    delivery:
      row.shippingCostAmount !== null && row.shippingCostCurrency !== null
        ? {
            known: true,
            cost: { amount: row.shippingCostAmount, currency: row.shippingCostCurrency },
          }
        : { known: false },
    taxInclusion: row.taxInclusion as PriceTaxInclusion,
    conditionKey: row.conditionKey,
    ...(segment ? { segment } : {}),
    availability: row.availability,
    ...(row.market ? { market: row.market } : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.language ? { language: row.language } : {}),
    freshnessLevel: row.freshnessLevel,
    changeReasons: row.changeReasons as PriceObservationChangeReason[],
    anomalies: row.anomalies as PriceObservationAnomaly[],
    ...(row.supersedesSnapshotId ? { supersedesObservationId: row.supersedesSnapshotId } : {}),
  };
}
