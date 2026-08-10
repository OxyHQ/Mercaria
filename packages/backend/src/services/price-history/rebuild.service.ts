/**
 * Rebuilding one series from immutable observations (#78 operations 2,
 * acceptance 5).
 *
 * The rebuild is a DERIVATION and never an increment — `review_aggregates`'
 * rule — which is what makes it idempotent in the sense acceptance 5 means:
 * running it twice on the same observations, the same policy version and the
 * same rate map writes the same rows in the same order. `replacePriceSeriesPoints`
 * deletes before it inserts, inside one transaction, because an upsert would
 * leave behind every point the new derivation did NOT produce and a bucket that
 * stopped having an eligible observation would keep its old answer forever.
 */

import {
  ALL_CURRENCY_CODES,
  type CurrencyCode,
  type PriceSeriesGranularity,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  listOfficialStoreMerchantIds,
  listPriceDisplayPermittedSourceIds,
} from '../../db/priceHistory/priceEligibilityRepository.js';
import { listPriceObservationsForScope } from '../../db/priceHistory/priceSnapshotRepository.js';
import {
  replacePriceSeriesPoints,
  type OfferPriceSeriesRow,
} from '../../db/priceHistory/priceSeriesRepository.js';
import { getRates } from '../fx.service.js';
import { derivePriceSeries, type PriceDerivationOutput } from './derive.js';

/** How far back a rebuild looks. */
export function rebuildWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - config.priceHistory.retentionWindowDays * 24 * 60 * 60 * 1_000),
    to: now,
  };
}

/**
 * Derive one series' points, without writing anything.
 *
 * Shared by the rebuild below and by the merchant-filtered read, which is the
 * whole reason it is separated: two derivations of one answer can disagree, and
 * the filtered read exists precisely because a single seller's history is small
 * enough not to need materialising.
 */
export async function derivePointsForScope(
  scope: {
    canonicalProductId?: string | null;
    canonicalVariantId?: string | null;
    market?: string | null;
    merchantId?: string;
    storefrontId?: string;
    displayCurrency: CurrencyCode;
    granularity: PriceSeriesGranularity;
  },
  window: { from: Date; to: Date },
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceDerivationOutput> {
  const observations = await listPriceObservationsForScope(
    {
      canonicalProductId: scope.canonicalProductId ?? undefined,
      canonicalVariantId: scope.canonicalVariantId ?? undefined,
      market: scope.market ?? undefined,
      merchantId: scope.merchantId,
      storefrontId: scope.storefrontId,
      from: window.from,
      to: window.to,
      limit: config.priceHistory.rebuildObservationLimit,
    },
    db,
  );

  const [permittedSources, officialStores] = await Promise.all([
    listPriceDisplayPermittedSourceIds(db),
    listOfficialStoreMerchantIds(scope, now, db),
  ]);

  // EVERY presentment currency is requested, not just the observations' own:
  // `convert` reads both sides against the rate map's base, so a map holding
  // only the display currency cannot price a EUR offer into USD at all, and the
  // failure would be a silent `currency_not_convertible` on every point rather
  // than a visible error.
  //
  // `getRates` never throws and never fabricates a missing pair — it omits it —
  // and `derivePriceSeries` then excludes an observation it cannot convert
  // under `currency_not_convertible` rather than comparing raw minor units. So
  // an FX outage produces a SHORTER chart with a stated reason, never a wrong
  // one.
  const rates = await getRates(scope.displayCurrency, [...ALL_CURRENCY_CODES]);

  return derivePriceSeries({
    observations,
    displayCurrency: scope.displayCurrency,
    granularity: scope.granularity,
    rates,
    priceDisplayPermittedSourceIds: permittedSources,
    officialStoreMerchantIds: officialStores,
  });
}

/**
 * Rebuild one claimed series and release its lease.
 *
 * @returns `true` when this dispatcher still owned the lease at the end.
 */
export async function rebuildPriceSeries(
  series: OfferPriceSeriesRow,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const window = rebuildWindow(now);
  const derived = await derivePointsForScope(
    {
      canonicalProductId: series.canonicalProductId,
      canonicalVariantId: series.canonicalVariantId,
      market: series.market,
      displayCurrency: series.displayCurrency,
      granularity: series.granularity,
    },
    window,
    now,
  );

  return replacePriceSeriesPoints({
    seriesId: series.id,
    leaseOwner,
    points: derived.points.map((point) => ({
      bucketStart: point.bucketStart,
      measure: point.measure,
      segment: point.segment,
      offerId: point.offerId,
      snapshotId: point.snapshotId,
      observedAt: point.observedAt,
      admittedFreshness: point.admittedFreshness,
      contributingObservationCount: point.contributingObservationCount,
      nativeAmount: point.native.amount,
      nativeCurrency: point.native.currency,
      displayAmount: point.displayAmount,
      fxRate: point.fx?.rate ?? null,
      fxFrom: point.fx?.from ?? null,
      fxTo: point.fx?.to ?? null,
      fxProvider: point.fx?.provider ?? null,
      fxAsOf: point.fx?.asOf ?? null,
    })),
    coveredFrom: window.from,
    coveredThrough: window.to,
    now,
  });
}
