/**
 * The four retail-checkout tables, read and written (#123).
 *
 * ONE repository for all four, unlike most domains, and the reason is that they
 * are one lifecycle rather than four: a binding produces an intent, an intent's
 * lines produce a purchase order, and a purchase order produces a variance
 * record. Splitting them would put four files between a reader and a story that
 * has to be read end to end.
 *
 * Every function here takes the caller's `DatabaseOrTransaction`. Two of them
 * MUST be handed a real transaction — `insertRetailProcurementIntents` commits
 * with the order it procures for, and there is no valid state in which one
 * exists without the other.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CurrencyCode, RetailProcurementFailureKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  retailCostVarianceRecords,
  retailOfferBindings,
  retailProcurementIntentLines,
  retailProcurementIntents,
} from '../schema/retailCheckout.js';

/** A live or retired binding, as stored. */
export type RetailOfferBindingRecord = typeof retailOfferBindings.$inferSelect;
/** One supplier's frozen share of one retail order. */
export type RetailProcurementIntentRecord = typeof retailProcurementIntents.$inferSelect;
/** One catalogue line of that share, and the lock it was priced under. */
export type RetailProcurementIntentLineRecord = typeof retailProcurementIntentLines.$inferSelect;
/** One observed actual against one locked amount. */
export type RetailCostVarianceRecordRow = typeof retailCostVarianceRecords.$inferSelect;

/**
 * One catalogue line of a supplier's share, as checkout composed it.
 *
 * Every field is a SNAPSHOT of what was true when the buyer paid. Nothing on
 * this path re-reads a procurement offer, a policy version or an agreement at
 * trigger time, which is what makes "consume the exact supplier/cost quote
 * snapshotted at checkout" a property of the call graph rather than a rule.
 */
export interface NewRetailProcurementIntentLine {
  procurementOfferId: string;
  bindingId: string;
  acceptanceId: string;
  quoteId: string;
  supplierQuoteRef?: string;
  supplierSku: string;
  canonicalProductId?: string;
  canonicalVariantId?: string;
  quantity: number;
  supplierUnitCost: { amount: number; currency: CurrencyCode };
  supplierLineTotal: { amount: number; currency: CurrencyCode };
  buyerAcceptedTotal: { amount: number; currency: CurrencyCode };
}

/** What one intent is composed from at checkout. */
export interface NewRetailProcurementIntent {
  orderId: string;
  checkoutGroupId: string;
  supplierId: string;
  supplierAccountId: string;
  agreementId: string;
  supplierCost: { amount: number; currency: CurrencyCode };
  buyerLockedTotal: { amount: number; currency: CurrencyCode };
  lines: readonly NewRetailProcurementIntentLine[];
}

/**
 * Every live binding for a set of catalogue variants.
 *
 * The `retired_at is null` predicate is repeated here rather than left to the
 * partial unique index: an index constrains what may be WRITTEN and says
 * nothing about what a read returns, and a read that included retired bindings
 * would resolve a cart line to a supplier Mercaria stopped buying from.
 */
export async function findLiveRetailBindingsForVariants(
  variantIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, RetailOfferBindingRecord>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(retailOfferBindings)
    .where(
      and(
        sql`${retailOfferBindings.productVariantId} = any(${sql.param([...variantIds])}::text[])`,
        isNull(retailOfferBindings.retiredAt),
      ),
    );
  return new Map(rows.map((row) => [row.productVariantId, row]));
}

/** One binding by id, live or retired — the operator trace's entry point. */
export async function findRetailBindingById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailOfferBindingRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailOfferBindings)
    .where(eq(retailOfferBindings.id, id))
    .limit(1);
  return row;
}

/**
 * Bind a catalogue variant to a procurement offer.
 *
 * A unique violation on `retail_offer_bindings_variant_live_key` propagates
 * rather than being swallowed: two live bindings for one variant is exactly the
 * condition that constraint exists to prevent, and converging on the incumbent
 * would silently tell an operator their new supplier route is live when the old
 * one still is.
 */
export async function insertRetailBinding(
  input: {
    productVariantId: string;
    procurementOfferId: string;
    supplierId: string;
    supplierAccountId: string;
    agreementId: string;
    boundByOxyUserId: string;
    boundReason: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailOfferBindingRecord> {
  const [row] = await db.insert(retailOfferBindings).values(input).returning();
  if (!row) throw new Error('insertRetailBinding wrote no row');
  return row;
}

/**
 * Retire a live binding. A CAS on `retired_at is null`, so two operators
 * converge on one retirement and the loser learns it lost.
 */
export async function retireRetailBinding(
  input: { id: string; retiredByOxyUserId: string; retiredReason: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailOfferBindingRecord | undefined> {
  const [row] = await db
    .update(retailOfferBindings)
    .set({
      retiredAt: input.at ?? new Date(),
      retiredByOxyUserId: input.retiredByOxyUserId,
      retiredReason: input.retiredReason,
    })
    .where(and(eq(retailOfferBindings.id, input.id), isNull(retailOfferBindings.retiredAt)))
    .returning();
  return row;
}

/**
 * Write a retail order's procurement intents — IN the order's transaction.
 *
 * @param db MUST be the transaction the order row is written in. An intent that
 *   committed without its order would be a promise to buy goods for a sale that
 *   never happened, and an order that committed without its intents would be a
 *   captured charge nobody can procure against — the second is worse, because
 *   the buyer has paid.
 */
export async function insertRetailProcurementIntents(
  db: DatabaseOrTransaction,
  intents: readonly NewRetailProcurementIntent[],
): Promise<RetailProcurementIntentRecord[]> {
  if (intents.length === 0) return [];
  const rows = await db
    .insert(retailProcurementIntents)
    .values(
      intents.map((intent) => ({
        orderId: intent.orderId,
        checkoutGroupId: intent.checkoutGroupId,
        supplierId: intent.supplierId,
        supplierAccountId: intent.supplierAccountId,
        agreementId: intent.agreementId,
        supplierCostAmount: intent.supplierCost.amount,
        supplierCostCurrency: intent.supplierCost.currency,
        buyerLockedTotalAmount: intent.buyerLockedTotal.amount,
        buyerLockedTotalCurrency: intent.buyerLockedTotal.currency,
      })),
    )
    .returning();

  const lineValues = rows.flatMap((row, index) => {
    const intent = intents[index];
    if (!intent) {
      // Unreachable: `returning()` yields one row per value, in order. Stated
      // as a throw rather than a non-null assertion, which the house rules
      // forbid and which would hide the day it stops being unreachable.
      throw new Error('insertRetailProcurementIntents: returned rows do not match its input');
    }
    return intent.lines.map((line) => ({
      intentId: row.id,
      procurementOfferId: line.procurementOfferId,
      bindingId: line.bindingId,
      acceptanceId: line.acceptanceId,
      quoteId: line.quoteId,
      supplierQuoteRef: line.supplierQuoteRef ?? null,
      supplierSku: line.supplierSku,
      canonicalProductId: line.canonicalProductId ?? null,
      canonicalVariantId: line.canonicalVariantId ?? null,
      quantity: line.quantity,
      supplierUnitCostAmount: line.supplierUnitCost.amount,
      supplierUnitCostCurrency: line.supplierUnitCost.currency,
      supplierLineTotalAmount: line.supplierLineTotal.amount,
      supplierLineTotalCurrency: line.supplierLineTotal.currency,
      buyerAcceptedTotalAmount: line.buyerAcceptedTotal.amount,
      buyerAcceptedTotalCurrency: line.buyerAcceptedTotal.currency,
    }));
  });
  if (lineValues.length > 0) {
    await db.insert(retailProcurementIntentLines).values(lineValues);
  }
  return rows;
}

/** Every line of one intent, in insertion order. */
export async function listRetailProcurementIntentLines(
  intentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailProcurementIntentLineRecord[]> {
  return await db
    .select()
    .from(retailProcurementIntentLines)
    .where(eq(retailProcurementIntentLines.intentId, intentId))
    .orderBy(retailProcurementIntentLines.createdAt);
}

/** Every intent of one order, oldest first. */
export async function listRetailProcurementIntents(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailProcurementIntentRecord[]> {
  return await db
    .select()
    .from(retailProcurementIntents)
    .where(eq(retailProcurementIntents.orderId, orderId))
    .orderBy(retailProcurementIntents.createdAt);
}

/** One intent by its (order, supplier) identity — the outbox row's own key. */
export async function findRetailProcurementIntent(
  input: { orderId: string; supplierId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailProcurementIntentRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailProcurementIntents)
    .where(
      and(
        eq(retailProcurementIntents.orderId, input.orderId),
        eq(retailProcurementIntents.supplierId, input.supplierId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Mark an intent as requested — a CAS from `recorded`, so a redelivered
 * `paid` transition enqueues once and every later delivery is a no-op.
 */
export async function markRetailIntentRequested(
  input: { id: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(retailProcurementIntents)
    .set({ status: 'requested', requestedAt: input.at ?? new Date() })
    .where(
      and(eq(retailProcurementIntents.id, input.id), eq(retailProcurementIntents.status, 'recorded')),
    )
    .returning({ id: retailProcurementIntents.id });
  return rows.length > 0;
}

/**
 * Attach the purchase order #124 created.
 *
 * The predicate admits `recorded` AND `requested`, because the trigger path may
 * legitimately reach here from either: an operator driving a stuck intent by
 * hand starts from `recorded`. It does NOT admit `purchase_order_created` — a
 * second purchase order for one intent is the duplicate-supplier-order failure
 * the whole domain is shaped around, and the CAS refusing is what makes a
 * redelivered outbox row converge rather than place one.
 */
export async function attachRetailIntentPurchaseOrder(
  input: { id: string; purchaseOrderId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(retailProcurementIntents)
    .set({ status: 'purchase_order_created', purchaseOrderId: input.purchaseOrderId })
    .where(
      and(
        eq(retailProcurementIntents.id, input.id),
        sql`${retailProcurementIntents.status} in ('recorded', 'requested')`,
      ),
    )
    .returning({ id: retailProcurementIntents.id });
  return rows.length > 0;
}

/** Record that procurement could never be started for this intent. */
export async function markRetailIntentFailed(
  input: { id: string; kind: RetailProcurementFailureKind; detail: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(retailProcurementIntents)
    .set({ status: 'failed', failureKind: input.kind, failureDetail: input.detail })
    .where(
      and(
        eq(retailProcurementIntents.id, input.id),
        sql`${retailProcurementIntents.status} in ('recorded', 'requested')`,
      ),
    )
    .returning({ id: retailProcurementIntents.id });
  return rows.length > 0;
}

/**
 * Record one observed actual against one locked amount, once.
 *
 * `ON CONFLICT DO NOTHING` on both partial uniques, and the empty `RETURNING`
 * IS the "already recorded" answer — the moderation-outbox idiom. A second row
 * would make #128 recognize one surplus twice, which is one overpayment
 * refunded twice.
 */
export async function recordRetailCostVariance(
  input: {
    orderId: string;
    intentId: string;
    purchaseOrderId?: string;
    source: 'supplier_acceptance' | 'purchase_order_cancelled';
    lockedAmount: number;
    actualAmount: number;
    currency: CurrencyCode;
    observedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCostVarianceRecordRow | undefined> {
  const delta = input.lockedAmount - input.actualAmount;
  const [row] = await db
    .insert(retailCostVarianceRecords)
    .values({
      orderId: input.orderId,
      intentId: input.intentId,
      purchaseOrderId: input.purchaseOrderId ?? null,
      source: input.source,
      // Derived HERE, from the same subtraction the CHECK re-computes, so the
      // caller has no direction parameter it could get backwards. A caller able
      // to pass `absorbed` for a positive delta is a caller able to book a
      // surplus as a Mercaria loss (ADR 0004 D8.3).
      direction: delta > 0 ? 'customer_owed' : delta < 0 ? 'absorbed' : 'none',
      lockedAmount: input.lockedAmount,
      lockedCurrency: input.currency,
      actualAmount: input.actualAmount,
      deltaAmount: delta,
      observedAt: input.observedAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** Every variance record for one order, newest first — the operator trace. */
export async function listRetailCostVariance(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCostVarianceRecordRow[]> {
  return await db
    .select()
    .from(retailCostVarianceRecords)
    .where(eq(retailCostVarianceRecords.orderId, orderId))
    .orderBy(retailCostVarianceRecords.observedAt);
}
