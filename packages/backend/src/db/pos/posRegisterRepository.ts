/**
 * `pos_registers` — the named registers of the paid `expanded_pos_registers`
 * tool — and the one aggregate over the sales rung up on them.
 *
 * Every write takes its handle as a REQUIRED parameter where the plan allowance
 * must commit with it (create and remove), so the counter and the row cannot
 * land in different transactions. Reads default the handle, the house
 * convention for a read.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { CurrencyCode } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { posRegisters } from '../schema/posRegisters.js';
import { orders } from '../schema/orders.js';
import { draftOrders } from '../schema/pos.js';

/** One row of `pos_registers`. */
export type PosRegisterRecord = InferSelectModel<typeof posRegisters>;

/** Insert a live register. A duplicate live name raises `pos_registers_live_name_key`. */
export async function insertPosRegister(
  db: DatabaseOrTransaction,
  input: { storeId: string; locationId: string; name: string; createdByOxyUserId: string },
): Promise<PosRegisterRecord> {
  const [row] = await db.insert(posRegisters).values(input).returning();
  if (!row) throw new Error('pos_registers insert returned no row');
  return row;
}

/** A store's registers, oldest first; live only unless `includeArchived`. */
export async function findPosRegisters(
  storeId: string,
  filter: { locationId?: string; includeArchived?: boolean } = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<PosRegisterRecord[]> {
  return db
    .select()
    .from(posRegisters)
    .where(
      and(
        eq(posRegisters.storeId, storeId),
        filter.locationId ? eq(posRegisters.locationId, filter.locationId) : undefined,
        filter.includeArchived ? undefined : isNull(posRegisters.archivedAt),
      ),
    )
    .orderBy(asc(posRegisters.createdAt), asc(posRegisters.id));
}

/** One of the store's registers, live or archived, or `null`. */
export async function findPosRegister(
  storeId: string,
  registerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PosRegisterRecord | null> {
  const [row] = await db
    .select()
    .from(posRegisters)
    .where(and(eq(posRegisters.id, registerId), eq(posRegisters.storeId, storeId)))
    .limit(1);
  return row ?? null;
}

/** Rename a LIVE register. `null` when there is no live register by that id. */
export async function renamePosRegister(
  storeId: string,
  registerId: string,
  name: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PosRegisterRecord | null> {
  const [row] = await db
    .update(posRegisters)
    .set({ name, updatedAt: new Date() })
    .where(
      and(
        eq(posRegisters.id, registerId),
        eq(posRegisters.storeId, storeId),
        isNull(posRegisters.archivedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Remove a LIVE register: DELETE it when no sale names it, ARCHIVE it when one
 * does (`orders.pos_register_id` is RESTRICT — a sale's register is part of its
 * record). `null` when there is no live register by that id, so the caller
 * gives no allowance back for a register that was already gone.
 *
 * The row is locked first, so two concurrent removals cannot both see it live
 * and both release the allowance.
 */
export async function removePosRegister(
  db: DatabaseOrTransaction,
  input: { storeId: string; registerId: string },
): Promise<'deleted' | 'archived' | null> {
  const [live] = await db
    .select({ id: posRegisters.id })
    .from(posRegisters)
    .where(
      and(
        eq(posRegisters.id, input.registerId),
        eq(posRegisters.storeId, input.storeId),
        isNull(posRegisters.archivedAt),
      ),
    )
    .for('update');
  if (!live) return null;

  const [sale] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.posRegisterId, live.id))
    .limit(1);

  if (sale) {
    const now = new Date();
    await db
      .update(posRegisters)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(posRegisters.id, live.id));
    return 'archived';
  }
  await db.delete(posRegisters).where(eq(posRegisters.id, live.id));
  return 'deleted';
}

/** One register's sales on one UTC day in one currency, as the aggregate reads it. */
export interface PosRegisterSalesAggregate {
  day: string;
  locationId: string | null;
  registerId: string | null;
  currency: CurrencyCode;
  salesCount: number;
  grossSales: number;
}

/**
 * Every POS sale of the store in the window, grouped by UTC day, location,
 * register (NULL = the location's default register) and currency.
 *
 * A sale counts once its payment was TAKEN (`payment_paid_at`), whatever
 * happened to it afterwards — a refund is its own record, and a till's takings
 * on a day do not change because a customer came back on another. The day is
 * rendered as text in SQL, so no `timestamptz` crosses the driver unmapped
 * (CONVENTIONS.md's read-direction trap). Money is summed on the SHOP side,
 * per currency, never across currencies.
 *
 * The location is the DRAFT's — the place the sale committed stock at — read
 * through the one-to-one `draft_orders.converted_order_id` link, so a default
 * register sale (no register row to carry a location) is still placed.
 */
export async function summarizePosRegisterSales(
  storeId: string,
  window: { from: Date; to: Date; locationId?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<PosRegisterSalesAggregate[]> {
  const day = sql<string>`to_char(${orders.paymentPaidAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      locationId: draftOrders.locationId,
      registerId: orders.posRegisterId,
      currency: orders.totalsGrandTotalShopCurrency,
      salesCount: sql<number>`count(*)::int`,
      grossSales: sql<string>`coalesce(sum(${orders.totalsGrandTotalShopAmount}), 0)::bigint`,
    })
    .from(orders)
    .innerJoin(draftOrders, eq(draftOrders.convertedOrderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.sourceChannel, 'pos'),
        sql`${orders.paymentPaidAt} >= ${window.from.toISOString()}::timestamptz`,
        sql`${orders.paymentPaidAt} <= ${window.to.toISOString()}::timestamptz`,
        window.locationId ? eq(draftOrders.locationId, window.locationId) : undefined,
      ),
    )
    .groupBy(day, draftOrders.locationId, orders.posRegisterId, orders.totalsGrandTotalShopCurrency)
    .orderBy(
      sql`1 desc`,
      asc(draftOrders.locationId),
      sql`${orders.posRegisterId} asc nulls first`,
      asc(orders.totalsGrandTotalShopCurrency),
    );

  return rows.map((row) => ({
    day: row.day,
    locationId: row.locationId,
    registerId: row.registerId,
    currency: row.currency as CurrencyCode,
    salesCount: Number(row.salesCount),
    grossSales: Number(row.grossSales),
  }));
}
