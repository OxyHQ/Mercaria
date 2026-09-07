/**
 * The two counting passes the sweep runs. Read-only, and read ONCE per run.
 *
 * Deliberately not correlated subqueries in a selection position: a drizzle
 * column interpolated there renders bare in a single-table statement and
 * resolves against the subquery's own table, returning 0 for every row with no
 * error at all (`schema/CONVENTIONS.md`, #313). Two grouped scans joined in
 * memory are both cheaper and impossible to get wrong that way.
 */

import { and, count, countDistinct, eq, gte, inArray, sum } from 'drizzle-orm';
import { DISCOVERY_COUNTED_ORDER_STATUSES } from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { orderItems, orders } from '../schema/orders.js';
import { analyticsEvents } from '../schema/analytics.js';

export interface ListingSalesCount {
  listingId: string;
  unitsSold: number;
  orderCount: number;
}

/** Units and orders per listing, over orders placed at or after `since`. */
export async function countListingSales(since: Date): Promise<ListingSalesCount[]> {
  const db = getDb();
  const rows = await db
    .select({
      listingId: orderItems.listingId,
      unitsSold: sum(orderItems.quantity),
      // DISTINCT orders, not order_items rows: a listing bought twice in one
      // order is one order, and a row-count here would over-state it for any
      // order carrying more than one line of the same listing.
      orderCount: countDistinct(orderItems.orderId),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        gte(orders.createdAt, since),
        inArray(orders.status, [...DISCOVERY_COUNTED_ORDER_STATUSES]),
      ),
    )
    .groupBy(orderItems.listingId);

  // `sum()` comes back as a string from Postgres — a numeric aggregate is
  // arbitrary-precision and the driver will not narrow it for us.
  return rows.map((row) => ({
    listingId: row.listingId,
    unitsSold: Number(row.unitsSold ?? 0),
    orderCount: row.orderCount,
  }));
}

export interface ListingViewCount {
  listingId: string;
  viewCount: number;
}

/** Product-page views per listing, at or after `since`. */
export async function countListingViews(since: Date): Promise<ListingViewCount[]> {
  const db = getDb();
  const rows = await db
    .select({ listingId: analyticsEvents.listingId, viewCount: count() })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventType, 'product_page_view'),
        gte(analyticsEvents.occurredAt, since),
      ),
    )
    .groupBy(analyticsEvents.listingId);

  // A view event with no listing id is a page view of something else.
  return rows.flatMap((row) =>
    row.listingId === null ? [] : [{ listingId: row.listingId, viewCount: row.viewCount }],
  );
}
