/**
 * `refunds` and `refund_line_items`.
 *
 * A refund is money leaving the business, so nothing here is best-effort: the
 * refund and its lines are written in one transaction, the RMA number comes from
 * a sequence that never repeats, and the two AGGREGATES below exist so no caller
 * has to load every prior refund into the process to answer a question about
 * quantities.
 *
 * ## The two aggregates are different questions and must not be merged
 *
 * {@link sumRefundedQuantities} counts every refunded unit, whatever became of
 * it — it answers "may this line be refunded again", the cumulative over-refund
 * guard. {@link sumRestockedQuantities} counts only the units a refund put BACK
 * ON THE SHELF (`restock = true`) — it answers "how much of this line does a
 * later full cancel still owe the shelf". A refund that returned a buyer's money
 * without taking the goods back contributes to the first and not the second, and
 * collapsing them would either block a legitimate refund or restock a unit
 * nobody ever received.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { CurrencyCode, DualMoney, RefundStatus, RefundType } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { refundLineItems, refunds } from '../schema/orders.js';

/** Zero-padding width of the numeric portion of an RMA number. */
const RMA_NUMBER_PAD = 6;
/** Prefix prepended to every RMA number — printed on the return label. */
const RMA_NUMBER_PREFIX = 'RMA-';

/** One row of `refunds`. */
export type RefundRow = InferSelectModel<typeof refunds>;

/** One row of `refund_line_items`. */
export type RefundLineItemRow = InferSelectModel<typeof refundLineItems>;

/** A refund with its lines attached — what callers read. */
export interface RefundRecord extends RefundRow {
  readonly lineItems: RefundLineItemRow[];
}

/** One refunded line as a caller supplies it. */
export interface NewRefundLineItem {
  variantId: string;
  quantity: number;
  amount: DualMoney;
  restock: boolean;
  locationId?: string;
}

/** A whole refund as a caller supplies it. */
export interface NewRefund {
  orderId: string;
  storeId?: string;
  sellerOxyUserId?: string;
  type: RefundType;
  status: RefundStatus;
  reason?: string;
  refundShipping?: DualMoney;
  totalRefunded: DualMoney;
  restockedAt?: Date;
  processedByOxyUserId?: string;
  rmaNumber?: string;
  idempotencyKey?: string;
  lineItems: NewRefundLineItem[];
}

/** Attach the line items to a batch of refund rows, in ONE query for the batch. */
async function withLineItems(
  rows: RefundRow[],
  db: DatabaseOrTransaction,
): Promise<RefundRecord[]> {
  if (rows.length === 0) return [];

  const lineRows = await db
    .select()
    .from(refundLineItems)
    // `inArray`, never `${col} in ${jsArray}` — the raw form binds a TUPLE and
    // Postgres raises `op ANY/ALL (array) requires array on right side`.
    .where(inArray(refundLineItems.refundId, rows.map((row) => row.id)))
    .orderBy(asc(refundLineItems.position), asc(refundLineItems.id));

  const byRefund = new Map<string, RefundLineItemRow[]>();
  for (const line of lineRows) {
    const bucket = byRefund.get(line.refundId);
    if (bucket) bucket.push(line);
    else byRefund.set(line.refundId, [line]);
  }

  return rows.map((row) => ({ ...row, lineItems: byRefund.get(row.id) ?? [] }));
}

/** One refund scoped to its store, or `null` — the scoping IS the authorization. */
export async function findRefundInStore(
  storeId: string,
  refundId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RefundRecord | null> {
  const rows = await db
    .select()
    .from(refunds)
    .where(and(eq(refunds.id, refundId), eq(refunds.storeId, storeId)))
    .limit(1);
  const [record] = await withLineItems(rows, db);
  return record ?? null;
}

/** One refund by its idempotency key, or `null` — the replay short-circuit. */
export async function findRefundByIdempotencyKey(
  idempotencyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RefundRecord | null> {
  const rows = await db
    .select()
    .from(refunds)
    .where(eq(refunds.idempotencyKey, idempotencyKey))
    .limit(1);
  const [record] = await withLineItems(rows, db);
  return record ?? null;
}

/** An order's refunds at one store, newest first. */
export async function findRefundsForOrderInStore(
  storeId: string,
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RefundRecord[]> {
  const rows = await db
    .select()
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), eq(refunds.storeId, storeId)))
    .orderBy(sql`${refunds.createdAt} desc nulls last`, sql`${refunds.id} desc nulls last`);
  return withLineItems(rows, db);
}

/**
 * How much of an order has already been refunded, on the SHOP (settlement) side.
 *
 * The comparison basis for "is this order now fully refunded", which is
 * single-currency by construction: the presentment side is what the buyer saw and
 * would mix currencies across a rate change.
 */
export async function sumRefundedShopAmount(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${refunds.totalRefundedShopAmount}), 0)::bigint` })
    .from(refunds)
    .where(eq(refunds.orderId, orderId));
  return Number(row?.total ?? 0);
}

/**
 * Units already refunded per variant on an order — the cumulative over-refund
 * guard. Counts every refunded unit regardless of restock; see the module header.
 */
export async function sumRefundedQuantities(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, number>> {
  return sumLineQuantities(orderId, undefined, db);
}

/**
 * Units already put BACK ON THE SHELF per variant on an order — what a later full
 * cancel must NOT restock a second time. Counts only `restock = true` lines.
 */
export async function sumRestockedQuantities(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, number>> {
  return sumLineQuantities(orderId, true, db);
}

/**
 * The shared aggregate behind the two above.
 *
 * A join rather than a correlated subquery: `refunds` is in the statement's own
 * FROM, so `refund_line_items.refund_id = refunds.id` is unambiguous. Written as
 * a correlated `where ${refundLineItems.refundId} = ${refunds.id}` inside a
 * subquery it would render both names bare, resolve both against the subquery's
 * own table, and return an empty map with no error at all — the trap
 * `CONVENTIONS.md` names, and the one that would silently permit an unlimited
 * over-refund here.
 */
async function sumLineQuantities(
  orderId: string,
  restockOnly: boolean | undefined,
  db: DatabaseOrTransaction,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      variantId: refundLineItems.variantId,
      quantity: sql<number>`coalesce(sum(${refundLineItems.quantity}), 0)::int`,
    })
    .from(refundLineItems)
    .innerJoin(refunds, eq(refunds.id, refundLineItems.refundId))
    .where(
      restockOnly === undefined
        ? eq(refunds.orderId, orderId)
        : and(eq(refunds.orderId, orderId), eq(refundLineItems.restock, restockOnly)),
    )
    .groupBy(refundLineItems.variantId);

  return new Map(rows.map((row) => [row.variantId, Number(row.quantity)]));
}

/** A store's lifetime refund total in ONE currency — the report summary figure. */
export async function sumStoreRefunds(
  storeId: string,
  shopCurrency: CurrencyCode,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${refunds.totalRefundedShopAmount}), 0)::bigint` })
    .from(refunds)
    .where(
      and(eq(refunds.storeId, storeId), eq(refunds.totalRefundedShopCurrency, shopCurrency)),
    );
  return Number(row?.total ?? 0);
}

/**
 * The next RMA number, `RMA-000123`. Same sequence reasoning as the order number
 * — see `nextOrderNumber` in `orderRepository.ts`.
 */
export async function nextRmaNumber(db: DatabaseOrTransaction = getDb()): Promise<string> {
  const rows = await db.execute<{ n: string }>(sql`select nextval('rma_number_seq') as n`);
  const seq = Number(rows[0]?.n ?? 0);
  return `${RMA_NUMBER_PREFIX}${String(seq).padStart(RMA_NUMBER_PAD, '0')}`;
}

/**
 * Create a refund and its lines in ONE transaction.
 *
 * @throws A unique-violation on `refunds_idempotency_key_key` when a replayed
 *   submit raced this one. The caller converges on the prior refund rather than
 *   refunding twice.
 */
export async function insertRefund(
  input: NewRefund,
  db: DatabaseOrTransaction = getDb(),
): Promise<RefundRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<RefundRecord> => {
    const [row] = await tx
      .insert(refunds)
      .values({
        orderId: input.orderId,
        storeId: input.storeId ?? null,
        sellerOxyUserId: input.sellerOxyUserId ?? null,
        type: input.type,
        status: input.status,
        reason: input.reason ?? null,
        // All four columns present or absent together —
        // `refunds_refund_shipping_complete_check`.
        refundShippingShopAmount: input.refundShipping?.shop.amount ?? null,
        refundShippingShopCurrency: input.refundShipping?.shop.currency ?? null,
        refundShippingPresentmentAmount: input.refundShipping?.presentment.amount ?? null,
        refundShippingPresentmentCurrency: input.refundShipping?.presentment.currency ?? null,
        totalRefundedShopAmount: input.totalRefunded.shop.amount,
        totalRefundedShopCurrency: input.totalRefunded.shop.currency,
        totalRefundedPresentmentAmount: input.totalRefunded.presentment.amount,
        totalRefundedPresentmentCurrency: input.totalRefunded.presentment.currency,
        restockedAt: input.restockedAt ?? null,
        processedByOxyUserId: input.processedByOxyUserId ?? null,
        rmaNumber: input.rmaNumber ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();

    if (input.lineItems.length > 0) {
      await tx.insert(refundLineItems).values(
        input.lineItems.map((line, position) => ({
          refundId: row.id,
          variantId: line.variantId,
          quantity: line.quantity,
          amountShopAmount: line.amount.shop.amount,
          amountShopCurrency: line.amount.shop.currency,
          amountPresentmentAmount: line.amount.presentment.amount,
          amountPresentmentCurrency: line.amount.presentment.currency,
          restock: line.restock,
          locationId: line.locationId ?? null,
          position,
        })),
      );
    }

    const [record] = await withLineItems([row], tx);
    return record;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}
