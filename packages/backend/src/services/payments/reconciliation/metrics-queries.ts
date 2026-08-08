/**
 * The two metric aggregates whose tables belong to the REFUND domain.
 *
 * They live here rather than in `db/orders/refundRepository.ts` and
 * `db/payments/disputeRepository.ts` because of what they are FOR: neither is a
 * question the refund or dispute lifecycle ever asks, and adding a
 * count-everything query to a repository invites the next reader to use it for a
 * decision instead of a dashboard. Grouped counts over a whole table are safe
 * for an operator gauge and wrong for anything that acts on one row.
 *
 * Both are `count(*)` over an indexed enum column with no filter, so both are
 * bounded by the number of DISTINCT states rather than by table size.
 */

import { count, isNotNull, sql } from 'drizzle-orm';
import { disputes } from '../../../db/schema/payments.js';
import { refunds } from '../../../db/schema/orders.js';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';

/**
 * Refunds by the state of their MONEY — issue #50's metric 6, first half.
 *
 * `provider_state` and not `status`, and the distinction is #49's: `status` is
 * what a merchant approved and reaches its end state before any money moves,
 * while `provider_state` is whether the buyer has actually been paid. A refund
 * dashboard counting the first would report every refund as complete the moment
 * it was authorised.
 *
 * NULL is excluded rather than counted as a state: a refund with no provider
 * operation (an `external` order refunded on Shopify, a POS refund) never had
 * money to move through Mercaria, so including it would inflate the denominator
 * of every rate computed from this.
 */
export async function countRefundsByProviderState(
  db: DatabaseOrTransaction,
): Promise<{ providerState: string; total: number }[]> {
  const rows = await db
    .select({ providerState: refunds.providerState, total: count() })
    .from(refunds)
    .where(isNotNull(refunds.providerState))
    .groupBy(refunds.providerState);

  return rows.map((row) => ({ providerState: row.providerState ?? 'unknown', total: row.total }));
}

/**
 * Disputes by where they stand — issue #50's metric 6, second half.
 *
 * The dimension is the OUTCOME once closed and the literal `open` while running,
 * rather than the provider's `status` string. Two reasons: the status vocabulary
 * is the card networks' and grows on their schedule, so a dashboard keyed on it
 * gains columns nobody added; and the three facts an operator acts on are how
 * many are running, how many were won and how many were lost.
 */
export async function countDisputesByState(
  db: DatabaseOrTransaction,
): Promise<{ state: string; total: number }[]> {
  const rows = await db
    .select({
      state: sql<string>`coalesce(${disputes.outcome}, 'open')`,
      total: count(),
    })
    .from(disputes)
    .groupBy(sql`coalesce(${disputes.outcome}, 'open')`);

  return rows.map((row) => ({ state: row.state, total: row.total }));
}
