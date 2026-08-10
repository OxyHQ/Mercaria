/**
 * The claimed-merchant demand dashboard (#86 §"Claimed merchant dashboard").
 *
 * ## The dashboard is a SNAPSHOT read, not a live computation
 *
 * A merchant reading the same window twice must see the same numbers, or the
 * export they downloaded on Tuesday cannot be reconciled with the screen on
 * Wednesday. So the surface builds a snapshot when there is none for the window
 * and reads the stored one when there is — and both paths return the same type.
 * `#86 acceptance 1` is a property of the snapshot, and this is what makes the
 * dashboard inherit it.
 *
 * ## Every figure ships its definition
 *
 * #86 acceptance 7 asks that a dashboard name time range, freshness,
 * denominator and known limitations. Shipping the DEFINITION beside the value
 * is how — a client that receives `attributionLimit` has to decide to hide it,
 * where one that receives only a number has to decide to look it up. #77's
 * merchant summary made the same choice.
 *
 * ## The export is the merchant's OWN aggregate rows and nothing else
 *
 * `toDemandCsv` serialises exactly what the view carries. There is no row in it
 * for a buyer, a session, a query or a competitor, because the view has no field
 * for one — the export cannot leak what the projection cannot hold.
 */

import {
  MERCHANT_DEMAND_METRICS,
  MERCHANT_DEMAND_WINDOW_DAYS,
  type CurrencyCode,
  type MerchantDemandCoverage,
  type MerchantDemandMetricRow,
  type MerchantDemandProductRow,
  type MerchantDemandSnapshotView,
  type MerchantDemandUnavailableReason,
  type MerchantDemandValue,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findLiveSnapshot,
  readSnapshotById,
  type StoredMerchantDemandSnapshot,
} from '../../db/merchantDemand/merchantDemandSnapshotRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { requireMerchantDemandMetric } from './metrics.js';
import { buildMerchantDemandSnapshot } from './snapshot.service.js';

/** What the dashboard was asked for. */
export interface MerchantDemandDashboardRequest {
  readonly merchantId: string;
  /** ISO 3166-1 alpha-2 upper-case, or `''` for every market. */
  readonly market: string;
  readonly windowDays: number;
  /** Rebuild even when a live snapshot for the window exists. */
  readonly refresh: boolean;
  readonly now?: Date;
}

/** Turn a stored metric row back into the union a client renders. */
function toValue(row: StoredMerchantDemandSnapshot['metrics'][number]): MerchantDemandValue {
  if (row.unavailableReason !== null) {
    return {
      state: 'unavailable',
      reason: row.unavailableReason as MerchantDemandUnavailableReason,
      ...(row.unavailableSeam === null ? {} : { seam: row.unavailableSeam }),
    };
  }
  if (row.suppressedBelow !== null) return { state: 'suppressed', floor: row.suppressedBelow };
  if (row.countValue !== null) {
    return { state: 'measured', measure: { unit: 'count', count: row.countValue } };
  }
  if (row.amountValue !== null && row.amountCurrency !== null) {
    return {
      state: 'measured',
      measure: {
        unit: 'money',
        amount: row.amountValue,
        currency: row.amountCurrency as CurrencyCode,
      },
    };
  }
  if (row.rateNumerator !== null && row.rateDenominator !== null) {
    return {
      state: 'measured',
      measure: {
        unit: 'rate',
        numerator: row.rateNumerator,
        denominator: row.rateDenominator,
      },
    };
  }
  // Unreachable through the CHECKs on `merchant_demand_metrics`, which admit
  // exactly one of the four shapes. A row that reached here was written by
  // something that is not this code, and answering `unavailable` is the only
  // honest reading of it.
  return { state: 'unavailable', reason: 'collection_disabled' };
}

/** Project a stored snapshot into the view a merchant reads. */
export function projectSnapshot(stored: StoredMerchantDemandSnapshot): MerchantDemandSnapshotView {
  const metrics: MerchantDemandMetricRow[] = stored.metrics.map((row) => ({
    metricKey: row.metricKey,
    kind: row.kind,
    channel: row.channel as MerchantDemandMetricRow['channel'],
    storefrontId: row.storefrontId,
    sourceId: row.sourceId,
    value: toValue(row),
    ...(row.aggregateBasis === null
      ? {}
      : { aggregateBasis: row.aggregateBasis }),
    definition: requireMerchantDemandMetric(row.metricKey),
  }));

  const products: MerchantDemandProductRow[] = stored.products.map((row) => ({
    canonicalProductId: row.canonicalProductId,
    productPageViews: row.productPageViews,
    offerImpressions: row.offerImpressions,
    hasNativeOffer: row.hasNativeOffer,
    offerFreshness: row.offerFreshness as MerchantDemandProductRow['offerFreshness'],
  }));

  const coverage: MerchantDemandCoverage = {
    productsOffered: stored.snapshot.productsOffered,
    productRowsDisclosed: stored.snapshot.productRowsDisclosed,
    productRowsSuppressed: stored.snapshot.productRowsSuppressed,
    unavailableMetrics: metrics.flatMap((metric) =>
      metric.value.state === 'unavailable'
        ? [
            {
              metricKey: metric.metricKey,
              reason: metric.value.reason,
              ...(metric.value.seam === undefined ? {} : { seam: metric.value.seam }),
            },
          ]
        : [],
    ),
  };

  return {
    id: stored.snapshot.id,
    merchantId: stored.snapshot.merchantId,
    market: stored.snapshot.market,
    windowFrom: stored.snapshot.windowFrom.toISOString(),
    windowTo: stored.snapshot.windowTo.toISOString(),
    dataFreshAsOf: stored.snapshot.dataFreshAsOf.toISOString(),
    eventPolicyVersion: stored.snapshot.eventPolicyVersion,
    attributionPolicyVersion: stored.snapshot.attributionPolicyVersion,
    collectionMode: stored.snapshot.collectionMode,
    aggregateFloor: stored.snapshot.aggregateFloor,
    productFloor: stored.snapshot.productFloor,
    metrics,
    products,
    coverage,
    createdAt: stored.snapshot.createdAt.toISOString(),
    ...(stored.snapshot.supersededAt === null
      ? {}
      : { supersededAt: stored.snapshot.supersededAt.toISOString() }),
  };
}

/** The window a request describes, aligned to whole days ending now. */
export function resolveWindow(
  request: MerchantDemandDashboardRequest,
): { readonly from: Date; readonly to: Date; readonly now: Date } {
  const now = request.now ?? new Date();
  // The request schema admits only `MERCHANT_DEMAND_WINDOW_DAYS`; this is the
  // same closed set applied again for callers that do not come through HTTP
  // (the operator rescore, and the tests). A clamp would silently answer a
  // different window than the one asked for, which is the one thing a
  // reproducible snapshot may not do.
  const days = (MERCHANT_DEMAND_WINDOW_DAYS as readonly number[]).includes(request.windowDays)
    ? request.windowDays
    : config.merchantDemand.defaultWindowDays;
  // Whole UTC days, so two requests a minute apart describe the SAME window and
  // land on the same snapshot rather than superseding each other every time
  // somebody reloads the page.
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1_000);
  return { from, to, now };
}

/**
 * Read (or build) one merchant's demand dashboard.
 *
 * The access check is the CALLER's — `resolveMerchantDemandAccess` runs in the
 * controller, before this is reached, so this function takes a merchant id it
 * has already been told the caller may read. Re-deciding it here would be a
 * second answer to one question.
 */
export async function readMerchantDemandDashboard(
  request: MerchantDemandDashboardRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantDemandSnapshotView> {
  const window = resolveWindow(request);

  if (!request.refresh) {
    const live = await findLiveSnapshot(
      { merchantId: request.merchantId, market: request.market },
      db,
    );
    if (
      live !== undefined &&
      live.snapshot.windowFrom.getTime() === window.from.getTime() &&
      live.snapshot.windowTo.getTime() === window.to.getTime()
    ) {
      return projectSnapshot(live);
    }
  }

  const built = await buildMerchantDemandSnapshot(
    {
      merchantId: request.merchantId,
      market: request.market,
      windowFrom: window.from,
      windowTo: window.to,
      now: window.now,
    },
    db,
  );
  return projectSnapshot(built);
}

/** One stored snapshot by id, for the merchant it belongs to. */
export async function readMerchantSnapshotById(
  input: { readonly merchantId: string; readonly snapshotId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantDemandSnapshotView> {
  const stored = await readSnapshotById(input.snapshotId, db);
  // The tenant check is a PROPERTY of the read rather than a filter applied
  // after it: a snapshot belonging to another merchant answers the same 404 as
  // one that does not exist, so an id cannot be probed for existence.
  if (stored === undefined || stored.snapshot.merchantId !== input.merchantId) {
    throw notFound('Snapshot not found');
  }
  return projectSnapshot(stored);
}

/** Render one metric value as a CSV cell. */
function csvValue(value: MerchantDemandValue): string {
  if (value.state === 'suppressed') return `suppressed_below_${value.floor}`;
  if (value.state === 'unavailable') {
    return value.seam === undefined ? value.reason : `${value.reason}:${value.seam}`;
  }
  if (value.measure.unit === 'count') return String(value.measure.count);
  if (value.measure.unit === 'money') {
    return `${value.measure.amount} ${value.measure.currency}`;
  }
  return `${value.measure.numerator}/${value.measure.denominator}`;
}

/** Escape one CSV field. */
function csvField(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

/**
 * The merchant's own aggregate rows, as CSV (#86 dashboard 7).
 *
 * The attribution limit travels in the file. An exported number outlives the
 * screen it was read on by months, so a column saying what it cannot tell you
 * is worth more here than anywhere.
 */
export function toDemandCsv(view: MerchantDemandSnapshotView): string {
  const header = [
    'metric_key',
    'title',
    'kind',
    'value',
    'aggregate_basis',
    'numerator',
    'denominator',
    'source',
    'window_from',
    'window_to',
    'data_fresh_as_of',
    'attribution_limit',
  ];
  const lines = [header.map(csvField).join(',')];

  for (const metric of view.metrics) {
    lines.push(
      [
        metric.metricKey,
        metric.definition.title,
        metric.kind,
        csvValue(metric.value),
        metric.aggregateBasis ?? '',
        metric.definition.numerator,
        metric.definition.denominator,
        metric.definition.source,
        view.windowFrom,
        view.windowTo,
        view.dataFreshAsOf,
        metric.definition.attributionLimit,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Every definition, so a client can build the legend without a second call. */
export function demandMetricCatalogue(): typeof MERCHANT_DEMAND_METRICS {
  return MERCHANT_DEMAND_METRICS;
}
