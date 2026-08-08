/**
 * Report service — store analytics aggregations over orders (B7).
 *
 * The richer analytics surface beside the dashboard `storeStats` in
 * `order.service`. Every figure is scoped to ONE store and (for revenue/AOV/top
 * products/sales) derived from its PAID orders; money is summed on the SHOP
 * (settlement) side and filtered to the store's `defaultCurrency` IN SQL, so
 * reports NEVER mix currencies. Every aggregation runs server-side — `count`,
 * `sum`, `date_trunc` and a `GROUP BY` — rather than loading rows into the
 * process, so they scale with order volume. Reports are READ-only.
 *
 * This module owns the report SHAPE (ranges, limits, zero-filled breakdowns) and
 * nothing else; each aggregate itself lives beside the table it reads.
 */

import type {
  Money,
  OrderStatus,
  ReportSummary,
  SalesReportInterval,
  SalesReportPoint,
  SourceChannelBreakdown,
  TopProduct,
} from '@mercaria/shared-types';
import {
  countOrdersByStatus,
  countPaidOrdersBySourceChannel,
  findTopProducts,
  sumPaidRevenue,
  sumPaidRevenueByBucket,
} from '../db/orders/orderRepository.js';
import { sumStoreRefunds } from '../db/orders/refundRepository.js';
import { findStoreRow } from '../db/stores/storeRepository.js';
import { roundMinorUnits } from '../utils/money.js';

/** Number of days in the default report range when `from`/`to` are omitted. */
const DEFAULT_RANGE_DAYS = 30;
/** Milliseconds in one day, used to derive the default range start. */
const MS_PER_DAY = 86_400_000;
/** Default number of rows the top-products report returns. */
const DEFAULT_TOP_PRODUCTS_LIMIT = 10;
/** Hard upper bound on `limit` for the top-products report. */
const MAX_TOP_PRODUCTS_LIMIT = 100;

/** Every order status initialized to a zero count. */
function zeroStatusCounts(): Record<OrderStatus, number> {
  return {
    pending_payment: 0,
    paid: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
    refunded: 0,
    partially_refunded: 0,
  };
}

/** A zero `SourceChannelBreakdown`. */
function zeroChannels(): SourceChannelBreakdown {
  return { storefront: 0, pos: 0, draft: 0 };
}

/**
 * Resolve a store's default settlement currency, falling back to FAIR. Reports
 * never mix currencies — a store settles in one currency — so this single value
 * both tags every `Money` the reports emit and FILTERS the rows they sum.
 */
async function storeCurrency(storeId: string): Promise<Money['currency']> {
  const store = await findStoreRow(storeId);
  return (store?.defaultCurrency as Money['currency'] | undefined) ?? 'FAIR';
}

/**
 * Validate + clamp the date range. Defaults to the last `DEFAULT_RANGE_DAYS`
 * when `from`/`to` are omitted; an unparseable bound falls back to the default;
 * a `from` after `to` is swapped so the range is always ascending.
 */
function resolveRange(from?: string, to?: string): { from: Date; to: Date } {
  const now = Date.now();
  const parsedTo = to ? Date.parse(to) : NaN;
  const parsedFrom = from ? Date.parse(from) : NaN;

  const toDate = Number.isFinite(parsedTo) ? new Date(parsedTo) : new Date(now);
  const fromDate = Number.isFinite(parsedFrom)
    ? new Date(parsedFrom)
    : new Date(toDate.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);

  // Guarantee ascending order so the window predicate is valid.
  if (fromDate.getTime() > toDate.getTime()) {
    return { from: toDate, to: fromDate };
  }
  return { from: fromDate, to: toDate };
}

/** Parameters for the sales-over-time report. */
export interface SalesReportParams {
  from?: string;
  to?: string;
  interval?: SalesReportInterval;
}

/** Parameters for the top-products report. */
export interface TopProductsParams {
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * Compute a store's report summary: total + paid order counts, paid-order
 * revenue, average order value, lifetime refund total, per-status order counts,
 * and the paid-order split by source channel.
 *
 * `orderCount` sums the per-status counts rather than issuing a second `count(*)`
 * — one query cannot disagree with itself, and two run moments apart can.
 */
export async function getSummary(storeId: string): Promise<ReportSummary> {
  const currency = await storeCurrency(storeId);

  const [statusCounts, channelCounts, paid, refundAmount] = await Promise.all([
    countOrdersByStatus(storeId),
    countPaidOrdersBySourceChannel(storeId),
    sumPaidRevenue(storeId, currency),
    sumStoreRefunds(storeId, currency),
  ]);

  const byStatus = zeroStatusCounts();
  let orderCount = 0;
  for (const [status, n] of statusCounts) {
    byStatus[status] = n;
    orderCount += n;
  }

  const bySourceChannel = zeroChannels();
  for (const [channel, n] of channelCounts) {
    bySourceChannel[channel] = n;
  }

  const aovAmount =
    paid.paidOrderCount > 0 ? roundMinorUnits(paid.revenue / paid.paidOrderCount) : 0;

  return {
    orderCount,
    paidOrderCount: paid.paidOrderCount,
    revenue: { amount: paid.revenue, currency },
    averageOrderValue: { amount: aovAmount, currency },
    refundTotal: { amount: refundAmount, currency },
    byStatus,
    bySourceChannel,
  };
}

/**
 * Time-bucketed sales over the (validated/clamped) range, one point per non-empty
 * bucket of `interval` granularity, ascending by bucket.
 *
 * `date_trunc` replaces Mongo's `$dateTrunc` and buckets by the same timeline
 * anchor: `coalesce(paid_at, created_at)`, so an order whose platform reported no
 * settlement time still lands in the bucket it was created in rather than
 * vanishing from the report.
 */
export async function getSalesReport(
  storeId: string,
  params: SalesReportParams,
): Promise<SalesReportPoint[]> {
  const currency = await storeCurrency(storeId);
  const { from, to } = resolveRange(params.from, params.to);
  const interval: SalesReportInterval = params.interval ?? 'day';

  const buckets = await sumPaidRevenueByBucket(storeId, currency, { from, to }, interval);

  return buckets.map((bucket) => ({
    bucket: bucket.bucket.toISOString(),
    orders: bucket.orders,
    revenue: { amount: bucket.revenue, currency },
  }));
}

/**
 * The top-selling products over the (validated/clamped) range, ranked by units
 * sold then revenue, limited to `limit` (default 10, clamped to a max).
 *
 * A join to `order_items` replaces Mongo's `$unwind`. The title comes from
 * `max(title)` rather than `$last`: a listing renamed between two sales has two
 * titles in the snapshot set, and `$last` returned whichever the storage engine
 * happened to emit last, which Mongo never promised to order.
 */
export async function getTopProducts(
  storeId: string,
  params: TopProductsParams,
): Promise<TopProduct[]> {
  const currency = await storeCurrency(storeId);
  const { from, to } = resolveRange(params.from, params.to);
  const limit = Math.min(
    Math.max(1, params.limit ?? DEFAULT_TOP_PRODUCTS_LIMIT),
    MAX_TOP_PRODUCTS_LIMIT,
  );

  const rows = await findTopProducts(storeId, currency, { from, to }, limit);

  return rows.map((row) => ({
    listingId: row.listingId,
    title: row.title,
    unitsSold: row.unitsSold,
    revenue: { amount: row.revenue, currency },
  }));
}
