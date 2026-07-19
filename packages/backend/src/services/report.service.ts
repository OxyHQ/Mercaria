/**
 * Report service — store analytics aggregations over orders (B7).
 *
 * The richer analytics surface beside the dashboard `storeStats` in
 * `order.service`. Every figure is scoped to ONE store and (for revenue/AOV/top
 * products/sales) derived from its PAID orders; money is summed on the SHOP
 * (settlement) side and `$match`ed to the store's `defaultCurrency`, so reports
 * NEVER mix currencies. All three reports run server-side Mongo aggregations
 * (`$match`/`$group`/`$dateTrunc`) rather than loading documents into memory, so
 * they scale with order volume. Reports are READ-only — they never mutate orders.
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
import { Order } from '../models/order.js';
import { Refund } from '../models/refund.js';
import { Store, type IStore } from '../models/store.js';
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
 * tags every `Money` the reports emit.
 */
async function storeCurrency(storeId: string): Promise<Money['currency']> {
  const store = await Store.findById(storeId).select('defaultCurrency').lean<
    Pick<IStore, 'defaultCurrency'> | null
  >();
  return (store?.defaultCurrency ?? 'FAIR') as Money['currency'];
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

  // Guarantee ascending order so the aggregation `$gte`/`$lte` window is valid.
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
 * and the paid-order split by source channel. Aggregates the store's orders;
 * money is the store's default currency.
 */
export async function getSummary(storeId: string): Promise<ReportSummary> {
  const currency = await storeCurrency(storeId);

  const [statusGroups, channelGroups, revenueAgg, refundAgg] = await Promise.all([
    // All orders by status.
    Order.aggregate<{ _id: OrderStatus; n: number }>([
      { $match: { storeId } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    // PAID orders by source channel.
    Order.aggregate<{ _id: string; n: number }>([
      { $match: { storeId, 'payment.status': 'paid' } },
      { $group: { _id: '$sourceChannel', n: { $sum: 1 } } },
    ]),
    // PAID-order count + summed SHOP grandTotal (revenue), matched to the store's
    // shop currency so revenue never mixes currencies.
    Order.aggregate<{ _id: null; count: number; revenue: number }>([
      { $match: { storeId, 'payment.status': 'paid', 'totals.grandTotal.shop.currency': currency } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$totals.grandTotal.shop.amount' } } },
    ]),
    // Summed SHOP refund totals across the store's refunds (same shop currency).
    Refund.aggregate<{ _id: null; total: number }>([
      { $match: { storeId, 'totalRefunded.shop.currency': currency } },
      { $group: { _id: null, total: { $sum: '$totalRefunded.shop.amount' } } },
    ]),
  ]);

  const byStatus = zeroStatusCounts();
  let orderCount = 0;
  for (const group of statusGroups) {
    if (group._id in byStatus) {
      byStatus[group._id] = group.n;
    }
    orderCount += group.n;
  }

  const bySourceChannel = zeroChannels();
  for (const group of channelGroups) {
    if (group._id === 'storefront' || group._id === 'pos' || group._id === 'draft') {
      bySourceChannel[group._id] = group.n;
    }
  }

  const paidOrderCount = revenueAgg[0]?.count ?? 0;
  const revenueAmount = revenueAgg[0]?.revenue ?? 0;
  const refundAmount = refundAgg[0]?.total ?? 0;
  const aovAmount = paidOrderCount > 0 ? roundMinorUnits(revenueAmount / paidOrderCount) : 0;

  return {
    orderCount,
    paidOrderCount,
    revenue: { amount: revenueAmount, currency },
    averageOrderValue: { amount: aovAmount, currency },
    refundTotal: { amount: refundAmount, currency },
    byStatus,
    bySourceChannel,
  };
}

/**
 * Time-bucketed sales over the (validated/clamped) range, one point per
 * non-empty bucket of `interval` granularity, ascending by bucket. Aggregates
 * PAID orders by `paidAt` (falling back to `createdAt` when a legacy order lacks
 * a `paidAt`), summing `grandTotal` per bucket via Mongo `$dateTrunc`.
 */
export async function getSalesReport(
  storeId: string,
  params: SalesReportParams,
): Promise<SalesReportPoint[]> {
  const currency = await storeCurrency(storeId);
  const { from, to } = resolveRange(params.from, params.to);
  const interval: SalesReportInterval = params.interval ?? 'day';

  const buckets = await Order.aggregate<{ _id: Date; orders: number; revenue: number }>([
    {
      $match: {
        storeId,
        'payment.status': 'paid',
        'totals.grandTotal.shop.currency': currency,
      },
    },
    // Order timeline anchor: when the payment settled (fallback to createdAt).
    { $addFields: { paidMoment: { $ifNull: ['$payment.paidAt', '$createdAt'] } } },
    { $match: { paidMoment: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$paidMoment', unit: interval } },
        orders: { $sum: 1 },
        revenue: { $sum: '$totals.grandTotal.shop.amount' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return buckets.map((bucket) => ({
    bucket: bucket._id.toISOString(),
    orders: bucket.orders,
    revenue: { amount: bucket.revenue, currency },
  }));
}

/**
 * The top-selling products over the (validated/clamped) range, ranked by units
 * sold then revenue, limited to `limit` (default 10, clamped to a max).
 * Aggregates the line items of PAID orders by `listingId`, summing each line's
 * quantity (units) and `lineTotal` (revenue), keeping the latest seen `title`.
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

  const rows = await Order.aggregate<{
    _id: string;
    title: string;
    unitsSold: number;
    revenue: number;
  }>([
    { $match: { storeId, 'payment.status': 'paid', 'totals.grandTotal.shop.currency': currency } },
    { $addFields: { paidMoment: { $ifNull: ['$payment.paidAt', '$createdAt'] } } },
    { $match: { paidMoment: { $gte: from, $lte: to } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.listingId',
        title: { $last: '$items.title' },
        unitsSold: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.lineTotal.shop.amount' },
      },
    },
    { $sort: { unitsSold: -1, revenue: -1 } },
    { $limit: limit },
  ]);

  return rows.map((row) => ({
    listingId: row._id,
    title: row.title,
    unitsSold: row.unitsSold,
    revenue: { amount: row.revenue, currency },
  }));
}
