/**
 * `order_fee_snapshots` — READS ONLY.
 *
 * The WRITE lives in `db/orders/orderRepository.insertOrder`, deliberately: a
 * snapshot exists only as part of the order aggregate it describes, and the two
 * must land in ONE transaction (a fee snapshot without its order is an
 * unexplained commission record; an order without its snapshot silently
 * reverts to the zero-fee era). Keeping the insert beside the order's other
 * five child relations is what makes that atomicity structural. Nothing else
 * writes these tables, and the append-only trigger refuses everything but
 * INSERT anyway.
 */

import { asc, inArray } from 'drizzle-orm';
import { orderFeeSnapshotLines, orderFeeSnapshots } from '../schema/fees.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One row of `order_fee_snapshots`. */
export type OrderFeeSnapshotRow = typeof orderFeeSnapshots.$inferSelect;

/** One row of `order_fee_snapshot_lines`. */
export type OrderFeeSnapshotLineRow = typeof orderFeeSnapshotLines.$inferSelect;

/** A snapshot with its line allocations attached, lines in order position. */
export interface OrderFeeSnapshotRecord extends OrderFeeSnapshotRow {
  readonly lines: OrderFeeSnapshotLineRow[];
}

/** One order's fee snapshot, or `undefined` for a pre-#88 / out-of-scope order. */
export async function findOrderFeeSnapshot(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderFeeSnapshotRecord | undefined> {
  const records = await listOrderFeeSnapshots([orderId], db);
  return records.get(orderId);
}

/**
 * The fee snapshots of a batch of orders, keyed by order id. Two queries for
 * the whole batch, never one per order — the settlement path reads a whole
 * checkout group through this.
 */
export async function listOrderFeeSnapshots(
  orderIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, OrderFeeSnapshotRecord>> {
  if (orderIds.length === 0) return new Map();

  const snapshotRows = await db
    .select()
    .from(orderFeeSnapshots)
    .where(inArray(orderFeeSnapshots.orderId, [...orderIds]));
  if (snapshotRows.length === 0) return new Map();

  const lineRows = await db
    .select()
    .from(orderFeeSnapshotLines)
    .where(
      inArray(
        orderFeeSnapshotLines.snapshotId,
        snapshotRows.map((row) => row.id),
      ),
    )
    .orderBy(asc(orderFeeSnapshotLines.position), asc(orderFeeSnapshotLines.id));

  const result = new Map<string, OrderFeeSnapshotRecord>();
  for (const row of snapshotRows) {
    result.set(row.orderId, {
      ...row,
      lines: lineRows.filter((line) => line.snapshotId === row.id),
    });
  }
  return result;
}
