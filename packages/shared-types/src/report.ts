/**
 * Report DTOs for the Mercaria store analytics surface (B7).
 *
 * Reports are the richer analytics surface over a store's orders, sitting beside
 * the existing dashboard `storeStats`. Every figure is scoped to ONE store and
 * derived from its PAID orders; money is always FAIR integer minor units. The
 * summary gives a single snapshot (counts, revenue, AOV, refunds, channel + status
 * breakdowns); the sales report buckets revenue over time; the top-products report
 * ranks the best sellers by units and revenue.
 */

import type { Money } from './money';
import type { OrderStatus } from './order';

/** Time-bucket granularity for the sales-over-time report. */
export type SalesReportInterval = 'day' | 'week' | 'month';

/**
 * Per-channel paid-order counts. Mirrors `OrderSourceChannel` — `storefront`
 * (online checkout), `pos` (in-store register sale) and `draft` (a draft order
 * converted to a sale).
 */
export interface SourceChannelBreakdown {
  /** Paid orders that originated from the online storefront. */
  storefront: number;
  /** Paid orders that originated from an in-store POS sale. */
  pos: number;
  /** Paid orders that originated from a converted draft order. */
  draft: number;
}

/**
 * A single-snapshot summary of a store's order performance, derived from PAID
 * orders (revenue/AOV/refunds) and ALL orders (`byStatus`). All money is FAIR
 * integer minor units.
 */
export interface ReportSummary {
  /** Total number of orders the store has, across every status. */
  orderCount: number;
  /** Number of orders whose payment settled (`payment.status === 'paid'`). */
  paidOrderCount: number;
  /** Sum of `grandTotal` across every paid order. */
  revenue: Money;
  /** `revenue / paidOrderCount`, rounded half-even (zero when no paid orders). */
  averageOrderValue: Money;
  /** Sum of every refund's `totalRefunded` for the store's orders. */
  refundTotal: Money;
  /** Order counts keyed by lifecycle status (every status present, zero-filled). */
  byStatus: Record<OrderStatus, number>;
  /** Paid-order counts split by the channel the order originated from. */
  bySourceChannel: SourceChannelBreakdown;
}

/** One time-bucketed point in the sales-over-time report. */
export interface SalesReportPoint {
  /** ISO-8601 start of the bucket (UTC), truncated to the report interval. */
  bucket: string;
  /** Number of paid orders that fall in the bucket. */
  orders: number;
  /** Sum of `grandTotal` of the paid orders in the bucket (FAIR minor units). */
  revenue: Money;
}

/** One ranked entry in the top-products report. */
export interface TopProduct {
  /** The listing the units were sold from. */
  listingId: string;
  /** The listing title at sale time (snapshot from the order item). */
  title: string;
  /** Total units of this listing sold across paid orders in the range. */
  unitsSold: number;
  /** Total revenue this listing contributed (sum of line totals, FAIR minor units). */
  revenue: Money;
}
