/**
 * What a CREATOR may see about their own assets (#1015 W6).
 *
 * ## Two kinds of number, and only one of them is suppressed
 *
 * `merchant-analytics.service.ts` suppresses all five of its counts below the
 * cohort floor, and that is right for what it measures: impressions, product views
 * and offer actions are OTHER PEOPLE'S behaviour, and a merchant with three
 * visitors a day plus a timestamp has a person.
 *
 * This summary measures two different things and treats them differently, which is
 * a deliberate departure rather than a relaxation:
 *
 * - **A creator's own commercial record is not suppressed.** Sales, gross, realized
 *   fee, earnings, refunds, disputes and the licence mix are facts about the
 *   creator's own business that their order list already shows them line by line.
 *   Suppressing "you made 3 sales" protects nobody and breaks the dashboard for
 *   exactly the creators a new marketplace has.
 * - **Everything that is somebody else's behaviour IS suppressed.** Views are the
 *   clear case and they follow the sibling rule exactly. Geography is the harder
 *   case and has its own module, because the cohort there is per country rather
 *   than per store (`geography.ts`).
 *
 * Downloads sit with the first group on purpose: a download is the exercise of a
 * right the creator already knows they sold, and the count is a delivery-load
 * figure rather than an audience one. It carries no requester, no session and no
 * country — `DigitalDownloadFact` has no field for any of them.
 *
 * ## The projection is the enforcement
 *
 * {@link CreatorDigitalSummary} has no field for a buyer, an order, an Oxy user, a
 * guest session, a pseudonym, an IP, a device or a postcode — so W6's privacy
 * requirement and `~/AGENTS.md`'s no-IP invariant are properties of the SHAPE here
 * rather than of a filter somebody has to keep correct. That is the device the
 * seller order projection (ADR 0003 D13) and `MerchantAnalyticsSummary` both use:
 * a response with no field for a thing cannot leak the thing.
 *
 * ## And it is not readable as a ranking signal
 *
 * Every figure is keyed by STORE and window, or by asset within one store. Nothing
 * is keyed by listing, variant, offer or canonical product, which are the things an
 * ordering engine scores — so #1015 W13's closing rule (*"downloads and fee yield
 * must never become a hidden organic-ranking boost"*) holds because there is
 * nothing here to join, not because a comment asks nicely.
 * `__tests__/analytics-boundaries.test.ts` asserts both directions.
 */

import { ANALYTICS_MERCHANT_MIN_COHORT, type CurrencyCode } from '@mercaria/shared-types';
import type { DigitalLicenceUpdatePolicy } from '@mercaria/shared-types';
import type {
  DigitalAnalyticsFacts,
  DigitalPriceClass,
  DigitalSaleFact,
} from './facts.js';
import {
  summariseGeographicRevenue,
  type DigitalCurrencyAmount,
  type DigitalGeographicRevenueSummary,
} from './geography.js';
import { creatorVisibleDigitalMetrics, type DigitalMetricDefinition } from './metrics.js';

/**
 * The floor applied to VIEWS, and to nothing else in this module.
 *
 * The sibling constant, imported. Views are the only figure here that measures
 * people who did not buy anything, so it is the only one a cohort floor is the
 * right instrument for.
 */
export const CREATOR_VIEW_MIN_COHORT = ANALYTICS_MERCHANT_MIN_COHORT;

/** Money per currency, gross and the creator's share. */
export interface CreatorMoneyTotals {
  readonly currency: CurrencyCode;
  readonly grossAmount: number;
  readonly realizedFeeAmount: number;
  readonly creatorEarningsAmount: number;
}

/** Free and paid counts, side by side, never added. */
export interface FreeAndPaidCounts {
  readonly free: number;
  readonly paid: number;
}

/** One asset's own line in the creator's summary. */
export interface CreatorAssetLine {
  readonly assetId: string;
  readonly paidSaleCount: number;
  readonly freeClaimCount: number;
  readonly completedDownloadCount: number;
  readonly amounts: readonly CreatorMoneyTotals[];
}

/** The licence mix, by the closed policy tuple and by the creator's own versions. */
export interface CreatorLicenceMix {
  readonly byUpdatePolicy: readonly { policy: DigitalLicenceUpdatePolicy; saleCount: number }[];
  readonly byLicenceVersion: readonly { licenceVersionId: string; saleCount: number }[];
}

/** What a creator sees. Every field is an aggregate about their own assets. */
export interface CreatorDigitalSummary {
  readonly storeId: string;
  readonly from: string;
  readonly to: string;
  /** Published assets by vertical — #1015 W13's first metric, store-scoped. */
  readonly publishedAssets: readonly { vertical: string; count: number }[];
  readonly paidSaleCount: number;
  readonly freeClaimCount: number;
  readonly refundedSaleCount: number;
  readonly disputedSaleCount: number;
  readonly completedDownloads: FreeAndPaidCounts;
  /**
   * Views, or `null` when the cohort floor suppressed them.
   *
   * `null` rather than zero, because a creator reading `0` cannot tell "nobody
   * looked" from "we are not telling you", and the first is actionable while the
   * second is not.
   */
  readonly views: FreeAndPaidCounts | null;
  readonly viewsAboveCohortFloor: boolean;
  readonly amounts: readonly CreatorMoneyTotals[];
  readonly licenceMix: CreatorLicenceMix;
  readonly perAsset: readonly CreatorAssetLine[];
  readonly geography: DigitalGeographicRevenueSummary;
  /** Rendered beside the numbers, so no figure appears without its definition. */
  readonly definitions: readonly DigitalMetricDefinition[];
}

/**
 * Build one creator's summary.
 *
 * `storeId` is the SCOPE and has no default, the device
 * `getMerchantAnalyticsSummary` uses: the facts were read for one store and the
 * summary names which, so a surface cannot serve "every creator" by omission.
 *
 * Pure over the facts. The window is carried through as the caller's own ISO
 * strings rather than computed from a clock, so two readers of one window get one
 * answer and a test needs no fake timer.
 */
export function summariseCreatorDigitalSales(input: {
  readonly storeId: string;
  readonly from: string;
  readonly to: string;
  readonly facts: DigitalAnalyticsFacts;
}): CreatorDigitalSummary {
  const { facts } = input;
  const paidSales = facts.sales.filter((sale) => sale.priceClass === 'paid');
  const freeSales = facts.sales.filter((sale) => sale.priceClass === 'free');

  const viewCounts = countByPriceClass(facts.views);
  // The floor is applied to the LARGER of the two, not to each, for
  // merchant-analytics' reason: suppressing per field publishes whichever cleared
  // the threshold and suppresses the other, from which the suppressed value is
  // bounded — the differencing attack the floor exists to stop.
  const viewsAboveCohortFloor =
    Math.max(viewCounts.free, viewCounts.paid) >= CREATOR_VIEW_MIN_COHORT;

  return {
    storeId: input.storeId,
    from: input.from,
    to: input.to,
    publishedAssets: countPublishedByVertical(facts),
    paidSaleCount: paidSales.length,
    freeClaimCount: freeSales.length,
    refundedSaleCount: paidSales.filter((sale) => sale.refunded).length,
    disputedSaleCount: paidSales.filter((sale) => sale.disputed).length,
    completedDownloads: countByPriceClass(
      facts.downloads.filter((download) => download.kind === 'completed'),
    ),
    views: viewsAboveCohortFloor ? viewCounts : null,
    viewsAboveCohortFloor,
    amounts: moneyTotalsOf(paidSales),
    licenceMix: licenceMixOf(paidSales),
    perAsset: perAssetLinesOf(facts),
    geography: summariseGeographicRevenue(facts.sales),
    definitions: creatorVisibleDigitalMetrics(),
  };
}

/* -------------------------------------------------------------------------- */

function countByPriceClass(
  rows: readonly { readonly priceClass: DigitalPriceClass }[],
): FreeAndPaidCounts {
  return {
    free: rows.filter((row) => row.priceClass === 'free').length,
    paid: rows.filter((row) => row.priceClass === 'paid').length,
  };
}

/** Published assets, counted once each however many versions or packages they have. */
function countPublishedByVertical(
  facts: DigitalAnalyticsFacts,
): { vertical: string; count: number }[] {
  const seen = new Map<string, Set<string>>();
  for (const publication of facts.publications) {
    const bucket = seen.get(publication.vertical) ?? new Set<string>();
    bucket.add(publication.assetId);
    seen.set(publication.vertical, bucket);
  }
  return [...seen.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([vertical, assets]) => ({ vertical, count: assets.size }));
}

/**
 * Money per currency.
 *
 * **Refunded lines stay in `grossAmount`** and are reported separately as a count,
 * because a refund is a later event and netting it into the gross of the window the
 * SALE fell in would make a historical figure change. `AGENTS.md`: nothing
 * auto-rewrites financial history. The refund's own money movement is a ledger
 * reversal, which is `digital_realized_fee`'s concern rather than a subtraction
 * performed here.
 */
function moneyTotalsOf(sales: readonly DigitalSaleFact[]): CreatorMoneyTotals[] {
  const byCurrency = new Map<CurrencyCode, { gross: number; fee: number; earnings: number }>();
  for (const sale of sales) {
    const entry = byCurrency.get(sale.currency) ?? { gross: 0, fee: 0, earnings: 0 };
    entry.gross += sale.grossAmount;
    entry.fee += sale.realizedFeeAmount;
    entry.earnings += sale.creatorEarningsAmount;
    byCurrency.set(sale.currency, entry);
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([currency, entry]) => ({
      currency,
      grossAmount: entry.gross,
      realizedFeeAmount: entry.fee,
      creatorEarningsAmount: entry.earnings,
    }));
}

function licenceMixOf(sales: readonly DigitalSaleFact[]): CreatorLicenceMix {
  const byPolicy = new Map<DigitalLicenceUpdatePolicy, number>();
  const byVersion = new Map<string, number>();
  for (const sale of sales) {
    byPolicy.set(sale.updatePolicy, (byPolicy.get(sale.updatePolicy) ?? 0) + 1);
    byVersion.set(sale.licenceVersionId, (byVersion.get(sale.licenceVersionId) ?? 0) + 1);
  }
  return {
    byUpdatePolicy: [...byPolicy.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([policy, saleCount]) => ({ policy, saleCount })),
    byLicenceVersion: [...byVersion.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([licenceVersionId, saleCount]) => ({ licenceVersionId, saleCount })),
  };
}

/**
 * One line per asset the creator has activity on.
 *
 * Keyed by ASSET and nothing else. An asset is not a listing, a variant or an offer
 * — ADR 0010 D2 keeps those in the catalogue — so this breakdown is the finest grain
 * this module produces and it is still one an ordering engine cannot use: scoring
 * an offer from it would need the `asset_variant_bindings` join, which nothing here
 * imports and which the isolation gate forbids ranking from reaching.
 */
function perAssetLinesOf(facts: DigitalAnalyticsFacts): CreatorAssetLine[] {
  const assetIds = new Set<string>([
    ...facts.sales.map((sale) => sale.assetId),
    ...facts.downloads.map((download) => download.assetId),
  ]);
  return [...assetIds]
    .sort((left, right) => (left < right ? -1 : 1))
    .map((assetId) => {
      const sales = facts.sales.filter((sale) => sale.assetId === assetId);
      const paid = sales.filter((sale) => sale.priceClass === 'paid');
      return {
        assetId,
        paidSaleCount: paid.length,
        freeClaimCount: sales.filter((sale) => sale.priceClass === 'free').length,
        completedDownloadCount: facts.downloads.filter(
          (download) => download.assetId === assetId && download.kind === 'completed',
        ).length,
        amounts: moneyTotalsOf(paid),
      };
    });
}

/** Re-exported so a caller need not import two modules to render one summary. */
export type { DigitalCurrencyAmount, DigitalGeographicRevenueSummary };
