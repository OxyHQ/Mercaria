/**
 * The launch metrics #1015 W13 lists, computed over the whole deployment.
 *
 * W13 names ten things and this module produces all ten, in the shapes
 * `metrics.ts` defines them in. What it is careful about is the three places where
 * the obvious aggregation is the wrong one:
 *
 *  1. **`unsupported` is not a processing failure.** A `.blend` cannot be measured
 *     and `ASSET_INSPECTION_VERDICTS`' own docblock says *"`unsupported` is NOT a
 *     failure … the honest result"*. Folding it into the failure rate would make
 *     adding an unmeasurable format look like a regression, and would make the
 *     pipeline look worse the more honest it got.
 *  2. **Download refusals are never summed into one error rate.** ADR 0010 D5 makes
 *     "no right" and "somebody else's right" the SAME answer deliberately — the
 *     enumeration oracle of #1015 W12 threat 1 — so `no_right` is dominated by
 *     ordinary unauthenticated probes and is not an operational error. The reasons
 *     are reported individually, by name.
 *  3. **Refunds and disputes are two numerators over one denominator**, never
 *     added: a line can be disputed and then refunded, and one combined rate
 *     double-counts exactly the worst cases.
 *
 * ## Deployment scope, and why that is also the ranking wall
 *
 * Every figure here is a single number (or a per-currency or per-enum breakdown) for
 * the whole deployment. There is no asset in the output, let alone a listing, an
 * offer or a variant — so #1015 W13's closing rule and boundary 12 (*"downloads and
 * fee yield must never become a hidden organic-ranking boost"*) hold structurally:
 * an ordering engine that imported this module would get platform totals, which
 * cannot order anything. `__tests__/analytics-boundaries.test.ts` asserts the import
 * direction as well, so neither half rests on this paragraph.
 *
 * ## Latency
 *
 * Reported as a MEDIAN and a 95th percentile, not a mean, and computed only over
 * inspections that actually recorded a duration. A `null` latency is *not
 * measured* — the same distinction ADR 0010 D12 makes load-bearing for every
 * geometry column — so `measuredLatencyCount` travels beside the percentiles. A
 * mean over a population where lost timings counted as zero would report the
 * pipeline as faster the more often its timing was lost.
 */

import type {
  AssetDownloadRefusalReason,
  AssetInspectionVerdict,
  AssetRightStatus,
  CurrencyCode,
  DigitalLicenceUpdatePolicy,
} from '@mercaria/shared-types';
import {
  ASSET_DOWNLOAD_REFUSAL_REASONS,
  ASSET_INSPECTION_VERDICTS,
  ASSET_RIGHT_STATUSES,
} from '@mercaria/shared-types';
import type { DigitalAnalyticsFacts } from './facts.js';
import { summariseGeographicRevenue, type DigitalGeographicRevenueSummary } from './geography.js';
import { DIGITAL_METRICS, type DigitalMetricDefinition } from './metrics.js';

/**
 * The inspection verdicts that count as a FAILURE of the pipeline.
 *
 * Four of the seven. `pending` is work in flight, `measured` is success, and
 * `unsupported` is an honest absence — see the module docblock. Stated as a closed
 * list so a new verdict must be classified rather than defaulting into "fine".
 */
export const ASSET_PROCESSING_FAILURE_VERDICTS: readonly AssetInspectionVerdict[] = [
  'corrupt',
  'missing_resources',
  'failed',
  'refused_too_large',
];

/** Money for the whole deployment, per currency. */
export interface DeploymentMoneyTotals {
  readonly currency: CurrencyCode;
  readonly gmvAmount: number;
  readonly realizedFeeAmount: number;
  readonly creatorEarningsAmount: number;
}

export interface ProcessingOutcomes {
  /** Every verdict with its count, in tuple order, zeros included. */
  readonly byVerdict: readonly { verdict: AssetInspectionVerdict; count: number }[];
  readonly measuredCount: number;
  readonly unsupportedCount: number;
  readonly failedCount: number;
  /** `measured / (measured + failed)`, or `null` when that denominator is zero. */
  readonly successRate: number | null;
  readonly measuredLatencyCount: number;
  readonly latencyMsP50: number | null;
  readonly latencyMsP95: number | null;
}

export interface DownloadAuthorizationOutcomes {
  readonly completedCount: number;
  readonly refusedCount: number;
  /** Every reason with its count, in tuple order, zeros included. */
  readonly byReason: readonly { reason: AssetDownloadRefusalReason; count: number }[];
}

/**
 * What buyers actually HOLD, by right status.
 *
 * Every status in the tuple, zeros included, because the interesting ones are the
 * rare ones: a `revoked_for_policy` count going from 0 to 1 is a takedown, and a
 * status that stops occurring must not silently vanish from the chart that was
 * watching it.
 */
export interface RightHoldings {
  readonly byStatus: readonly { status: AssetRightStatus; count: number }[];
  readonly activeCount: number;
}

export interface LaunchMetricsSummary {
  readonly from: string;
  readonly to: string;
  readonly publishedAssetsByVertical: readonly { vertical: string; count: number }[];
  readonly views: { readonly free: number; readonly paid: number };
  readonly completedDownloads: { readonly free: number; readonly paid: number };
  readonly paidSaleCount: number;
  readonly freeClaimCount: number;
  /** `paidSaleCount / paid views`, or `null` when nobody viewed a paid option. */
  readonly paidConversionRate: number | null;
  readonly money: readonly DeploymentMoneyTotals[];
  readonly processing: ProcessingOutcomes;
  readonly downloadAuthorization: DownloadAuthorizationOutcomes;
  readonly rights: RightHoldings;
  readonly refundedSaleCount: number;
  readonly disputedSaleCount: number;
  /** Two rates over one denominator. Never added. */
  readonly refundRate: number | null;
  readonly disputeRate: number | null;
  readonly licenceMixByUpdatePolicy: readonly {
    policy: DigitalLicenceUpdatePolicy;
    saleCount: number;
  }[];
  /** The same cohort floor applies at deployment scope — see `geography.ts`. */
  readonly geography: DigitalGeographicRevenueSummary;
  readonly definitions: readonly DigitalMetricDefinition[];
}

/**
 * Compute the launch summary.
 *
 * Pure over the facts, for the reason `version-coverage.ts` is pure one directory
 * up: the interesting cases are populations — an empty window, a denominator of
 * zero, a verdict nobody has produced yet — and a test can drive every one of them
 * directly rather than seeding a database to reach each.
 */
export function computeLaunchMetrics(input: {
  readonly from: string;
  readonly to: string;
  readonly facts: DigitalAnalyticsFacts;
}): LaunchMetricsSummary {
  const { facts } = input;
  const paidSales = facts.sales.filter((sale) => sale.priceClass === 'paid');
  const freeSales = facts.sales.filter((sale) => sale.priceClass === 'free');
  const paidViews = facts.views.filter((view) => view.priceClass === 'paid').length;
  const freeViews = facts.views.length - paidViews;

  const completed = facts.downloads.filter((download) => download.kind === 'completed');
  const refused = facts.downloads.filter((download) => download.kind === 'refused');

  return {
    from: input.from,
    to: input.to,
    publishedAssetsByVertical: publishedByVertical(facts),
    views: { free: freeViews, paid: paidViews },
    completedDownloads: {
      free: completed.filter((download) => download.priceClass === 'free').length,
      paid: completed.filter((download) => download.priceClass === 'paid').length,
    },
    paidSaleCount: paidSales.length,
    freeClaimCount: freeSales.length,
    // The denominator is views of PAID options only. Dividing by every view would
    // mix the free catalogue in and make giving things away look like conversion.
    paidConversionRate: paidViews === 0 ? null : paidSales.length / paidViews,
    money: deploymentMoney(paidSales),
    processing: processingOutcomes(facts),
    downloadAuthorization: {
      completedCount: completed.length,
      refusedCount: refused.length,
      byReason: ASSET_DOWNLOAD_REFUSAL_REASONS.map((reason) => ({
        reason,
        count: refused.filter((download) => download.refusalReason === reason).length,
      })),
    },
    rights: {
      byStatus: ASSET_RIGHT_STATUSES.map((status) => ({
        status,
        count: facts.rights.filter((held) => held.status === status).length,
      })),
      activeCount: facts.rights.filter((held) => held.status === 'active').length,
    },
    refundedSaleCount: paidSales.filter((sale) => sale.refunded).length,
    disputedSaleCount: paidSales.filter((sale) => sale.disputed).length,
    refundRate:
      paidSales.length === 0
        ? null
        : paidSales.filter((sale) => sale.refunded).length / paidSales.length,
    disputeRate:
      paidSales.length === 0
        ? null
        : paidSales.filter((sale) => sale.disputed).length / paidSales.length,
    licenceMixByUpdatePolicy: licenceMix(paidSales),
    geography: summariseGeographicRevenue(facts.sales),
    definitions: DIGITAL_METRICS,
  };
}

/* -------------------------------------------------------------------------- */

function publishedByVertical(
  facts: DigitalAnalyticsFacts,
): { vertical: string; count: number }[] {
  const byVertical = new Map<string, Set<string>>();
  for (const publication of facts.publications) {
    const bucket = byVertical.get(publication.vertical) ?? new Set<string>();
    bucket.add(publication.assetId);
    byVertical.set(publication.vertical, bucket);
  }
  return [...byVertical.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([vertical, assets]) => ({ vertical, count: assets.size }));
}

function deploymentMoney(
  sales: readonly { currency: CurrencyCode; grossAmount: number; realizedFeeAmount: number; creatorEarningsAmount: number }[],
): DeploymentMoneyTotals[] {
  const byCurrency = new Map<CurrencyCode, { gmv: number; fee: number; earnings: number }>();
  for (const sale of sales) {
    const entry = byCurrency.get(sale.currency) ?? { gmv: 0, fee: 0, earnings: 0 };
    entry.gmv += sale.grossAmount;
    entry.fee += sale.realizedFeeAmount;
    entry.earnings += sale.creatorEarningsAmount;
    byCurrency.set(sale.currency, entry);
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([currency, entry]) => ({
      currency,
      gmvAmount: entry.gmv,
      realizedFeeAmount: entry.fee,
      creatorEarningsAmount: entry.earnings,
    }));
}

function licenceMix(
  sales: readonly { updatePolicy: DigitalLicenceUpdatePolicy }[],
): { policy: DigitalLicenceUpdatePolicy; saleCount: number }[] {
  const byPolicy = new Map<DigitalLicenceUpdatePolicy, number>();
  for (const sale of sales) {
    byPolicy.set(sale.updatePolicy, (byPolicy.get(sale.updatePolicy) ?? 0) + 1);
  }
  return [...byPolicy.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([policy, saleCount]) => ({ policy, saleCount }));
}

function processingOutcomes(facts: DigitalAnalyticsFacts): ProcessingOutcomes {
  const byVerdict = ASSET_INSPECTION_VERDICTS.map((verdict) => ({
    verdict,
    count: facts.processing.filter((run) => run.verdict === verdict).length,
  }));
  const measuredCount = facts.processing.filter((run) => run.verdict === 'measured').length;
  const unsupportedCount = facts.processing.filter((run) => run.verdict === 'unsupported').length;
  const failedCount = facts.processing.filter((run) =>
    ASSET_PROCESSING_FAILURE_VERDICTS.includes(run.verdict),
  ).length;

  const latencies = facts.processing
    .map((run) => run.latencyMs)
    .filter((latency): latency is number => latency !== null)
    .sort((left, right) => left - right);

  return {
    byVerdict,
    measuredCount,
    unsupportedCount,
    failedCount,
    // `unsupported` is in NEITHER half of this ratio. It is not a success (nothing
    // was measured) and not a failure (nothing went wrong), so including it either
    // way would be a claim the pipeline never made.
    successRate:
      measuredCount + failedCount === 0 ? null : measuredCount / (measuredCount + failedCount),
    measuredLatencyCount: latencies.length,
    latencyMsP50: percentile(latencies, 0.5),
    latencyMsP95: percentile(latencies, 0.95),
  };
}

/**
 * The nearest-rank percentile of an already-sorted list, or `null` when empty.
 *
 * Nearest-rank rather than interpolated: an interpolated p95 invents a latency no
 * run had, and the number is read as "the slow case took this long".
 */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}
