/**
 * The checkout conversion aggregates (#89 `advanced_demand_analytics`).
 *
 * Three reads over ONE predicate — a store's native checkouts created in a
 * window — grouped by listing, by time bucket, or not at all. They live here,
 * beside the table they read, for the reason `report.service` gives for the
 * sales aggregates: the report service owns the shape, the repository owns the
 * SQL.
 *
 * ## What a "checkout" is here
 *
 * A NATIVE checkout order: `source_channel = 'storefront'` with no connector
 * provenance. A POS sale and a converted draft order are rung up by the store
 * itself, and a connector import is another platform's sale — none of them is a
 * buyer starting a checkout on Mercaria, so counting them would put sales the
 * funnel never saw into its denominator. That is the order-side counterpart of
 * #77 excluding bots, previews and internal traffic: exclusion by WHAT the row
 * is, in the statement, never by a filter a reader has to remember.
 *
 * A checkout started is one ORDER (one seller's share of a checkout group). It
 * converted when its payment settled — `payment_status` `paid` or `refunded`,
 * because a later refund is a separate fact and must not rewrite a conversion
 * somebody already acted on (`verified-conversion.ts`'s rule, applied to the
 * order's own payment column). Otherwise it is abandoned when cancelled and
 * open while anything else, so the three partition the started set exactly.
 *
 * ## Counts only, and no buyer column is read
 *
 * Every select is an aggregate over order ids, statuses, timestamps, listing
 * ids, line titles and quantities. No amount, currency, buyer, guest, address
 * or checkout-group column appears in a projection, so nothing returned here
 * can identify who bought.
 */

import { and, eq, gte, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { ConversionReportInterval } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { orderItems, orders } from '../schema/orders.js';

/** A half-open instant window: `from` inclusive, `to` exclusive. */
export interface ConversionWindow {
  readonly from: Date;
  readonly to: Date;
}

/** One group's raw counts. `open` is derived by the caller as the remainder. */
export interface ConversionCounts {
  readonly started: number;
  readonly paid: number;
  readonly abandoned: number;
  readonly unitsSold: number;
}

/** One listing's counts. */
export interface ListingConversionCounts extends ConversionCounts {
  readonly listingId: string;
  readonly title: string;
}

/** One bucket's counts; `bucketStart` is `YYYY-MM-DD`. */
export interface BucketConversionCounts extends ConversionCounts {
  readonly bucketStart: string;
}

/** The payment statuses that mean the money arrived (a refund came later). */
const CONVERTED = sql`${orders.paymentStatus} in ('paid', 'refunded')`;
/** Cancelled without a settled payment. */
const ABANDONED = sql`${orders.paymentStatus} not in ('paid', 'refunded') and ${orders.status} = 'cancelled'`;

/** The one predicate every read shares. */
function nativeCheckoutsOf(storeId: string, window: ConversionWindow): SQL | undefined {
  return and(
    eq(orders.storeId, storeId),
    eq(orders.sourceChannel, 'storefront'),
    isNull(orders.sourceProvider),
    gte(orders.createdAt, window.from),
    lt(orders.createdAt, window.to),
  );
}

/** The aggregate columns, identical across the three groupings. */
function countColumns() {
  return {
    started: sql<number>`count(distinct ${orders.id})::int`,
    paid: sql<number>`(count(distinct ${orders.id}) filter (where ${CONVERTED}))::int`,
    abandoned: sql<number>`(count(distinct ${orders.id}) filter (where ${ABANDONED}))::int`,
    // `bigint` from `sum`, narrowed: a line quantity is an `integer` and a
    // window's units cannot approach 2^31 on one store.
    unitsSold: sql<number>`(coalesce(sum(${orderItems.quantity}) filter (where ${CONVERTED}), 0))::int`,
  };
}

function toCounts(row: {
  started: number;
  paid: number;
  abandoned: number;
  unitsSold: number;
}): ConversionCounts {
  return {
    started: Number(row.started),
    paid: Number(row.paid),
    abandoned: Number(row.abandoned),
    unitsSold: Number(row.unitsSold),
  };
}

/**
 * The whole store's counts — DISTINCT checkouts, so an order holding two of
 * the store's listings is one checkout here and one per listing below.
 *
 * A LEFT join, so an order whose lines are somehow absent still counts as a
 * checkout started (it contributes no units).
 */
export async function countStoreCheckouts(
  storeId: string,
  window: ConversionWindow,
  db: DatabaseOrTransaction = getDb(),
): Promise<ConversionCounts> {
  const rows = await db
    .select(countColumns())
    .from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(nativeCheckoutsOf(storeId, window));
  const row = rows[0];
  return row ? toCounts(row) : { started: 0, paid: 0, abandoned: 0, unitsSold: 0 };
}

/**
 * Counts per listing. A checkout counts once for EVERY listing on it — the
 * attribution limit a per-listing funnel cannot avoid, since one payment pays
 * for the whole order.
 *
 * The title is `max(title)` over the line snapshots, `findTopProducts`'s rule:
 * deterministic for the same input when a listing was renamed mid-window.
 */
export async function countListingCheckouts(
  storeId: string,
  window: ConversionWindow,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ListingConversionCounts[]> {
  const rows = await db
    .select({
      listingId: orderItems.listingId,
      title: sql<string>`max(${orderItems.title})`,
      ...countColumns(),
    })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(nativeCheckoutsOf(storeId, window))
    .groupBy(orderItems.listingId);
  return rows.map((row) => ({ listingId: row.listingId, title: row.title, ...toCounts(row) }));
}

/**
 * Counts per UTC bucket of the order's creation time.
 *
 * The interval is one of two literals from a closed tuple and is rendered as
 * SQL text — `date_trunc`'s unit is not a bindable parameter in a GROUP BY the
 * planner can match. `at time zone 'UTC'` first, so the bucket is a UTC calendar
 * day or ISO week whatever the session's time zone is.
 */
export async function countCheckoutsByBucket(
  storeId: string,
  window: ConversionWindow,
  interval: ConversionReportInterval,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly BucketConversionCounts[]> {
  const unit = interval === 'week' ? 'week' : 'day';
  const bucket = sql<string>`to_char(date_trunc(${sql.raw(`'${unit}'`)}, ${orders.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await db
    .select({ bucketStart: bucket, ...countColumns() })
    .from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(nativeCheckoutsOf(storeId, window))
    .groupBy(bucket)
    .orderBy(bucket);
  return rows.map((row) => ({ bucketStart: row.bucketStart, ...toCounts(row) }));
}
