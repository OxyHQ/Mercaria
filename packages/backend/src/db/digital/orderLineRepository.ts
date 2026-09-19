/**
 * One question about an order's lines that the digital domain asks and the order
 * domain has no reason to export: does this order carry any digital line at all?
 *
 * It lives here rather than in `db/orders/orderRepository.ts` because the answer
 * is a property of #1015's columns, and putting it there would make the order
 * repository import a vocabulary it otherwise does not know about. It reads
 * `order_items` directly, which is the table it is a question about.
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { orderItems } from '../schema/orders.js';

/**
 * Whether any line of `orderId` names an asset version.
 *
 * `limit 1` rather than a count: the caller asks a yes/no question and a count
 * invites somebody to compare it against something it is not.
 */
export async function orderHasDigitalLines(
  orderId: string,
  tx?: DatabaseOrTransaction,
): Promise<boolean> {
  const db = tx ?? getDb();
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), isNotNull(orderItems.digitalAssetVersionId)))
    .limit(1);
  return rows.length > 0;
}
