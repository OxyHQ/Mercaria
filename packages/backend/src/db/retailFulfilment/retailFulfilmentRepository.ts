/**
 * The four retail-fulfilment tables, read and written (#126).
 *
 * ONE repository for all four, the `retailCheckoutRepository` arrangement and
 * for its reason: they are one lifecycle rather than four. A role snapshot and
 * a set of fulfilment intents are written in the order's own transaction, the
 * intents carry allocations, and the allocations plus the promises are what a
 * customer projection is built from.
 *
 * ## The over-allocation guard lives HERE, and it has to
 *
 * #126 fulfilment mapping 8 is *"reconciliation preventing duplicate or lost
 * line allocation"*. The invariant — the sum of ORIGINAL allocations against
 * one order item, over intents that are neither cancelled nor superseded, never
 * exceeds that item's quantity — is cross-row, so no CHECK can hold it. This
 * module is the single writer and refuses before issuing SQL, with the order
 * items locked `FOR UPDATE` first so two concurrent allocations serialize
 * rather than both reading the same pre-insert sum.
 *
 * The lock is on `order_items` rather than on the allocations, deliberately: a
 * lock on rows that do not exist yet prevents nothing, and the item IS the
 * resource being consumed. It is the same reasoning `#104`'s cart merge uses
 * for locking the session and the guest cart rather than the lines.
 *
 * A REPLACEMENT allocation is outside the cap by construction — the sum is
 * taken over `intent_kind = 'original'` — because a replacement re-ships goods
 * that were already allocated. See the schema docblock for why folding them
 * together is worse than it looks.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  RetailDeliveryObservationOutcome,
  RetailDeliveryPromiseBasis,
  RetailDeliveryPromiseKind,
  RetailDeliveryPromiseSource,
  RetailFulfilmentIntentStatus,
  RetailFulfilmentMode,
  RetailPermittedFulfilmentMode,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { orderItems } from '../schema/orders.js';
import {
  retailDeliveryPromises,
  retailFulfilmentIntents,
  retailFulfilmentLineAllocations,
  retailOrderRoleSnapshots,
} from '../schema/retailFulfilment.js';

/** The immutable order-role snapshot, as stored. */
export type RetailOrderRoleSnapshotRow = typeof retailOrderRoleSnapshots.$inferSelect;
/** One supplier's fulfilment intent for one retail order. */
export type RetailFulfilmentIntentRow = typeof retailFulfilmentIntents.$inferSelect;
/** Which units of which customer line one intent covers. */
export type RetailFulfilmentLineAllocationRow =
  typeof retailFulfilmentLineAllocations.$inferSelect;
/** One delivery-promise observation. */
export type RetailDeliveryPromiseRow = typeof retailDeliveryPromises.$inferSelect;

/**
 * Every column of a fulfilment intent, NAMED.
 *
 * `retail_fulfilment_intents` has two columns in `PROTECTED_COLUMNS`
 * (`moovo_source_reference` and `moovo_transport_request_id`), so a plain
 * `.select()` is refused by `schema-conventions.test.ts` — deliberately, because
 * a whole-row read is how a cross-service correlation key reaches a buyer-facing
 * DTO. This repository legitimately needs both: the reference IS the inbound
 * resolution key and the transport id is what the write-once CAS reads back.
 * Naming them is the sanctioned opt-in, and it reads differently from an
 * ordinary select, which is the point. The PROJECTION that reaches a client is
 * where they must be dropped, and there is no such projection yet (#162).
 */
const FULFILMENT_INTENT_COLUMNS = {
  id: retailFulfilmentIntents.id,
  orderId: retailFulfilmentIntents.orderId,
  procurementIntentId: retailFulfilmentIntents.procurementIntentId,
  intentKind: retailFulfilmentIntents.intentKind,
  supersedesIntentId: retailFulfilmentIntents.supersedesIntentId,
  status: retailFulfilmentIntents.status,
  statusReason: retailFulfilmentIntents.statusReason,
  permittedFulfilmentMode: retailFulfilmentIntents.permittedFulfilmentMode,
  fulfilmentMode: retailFulfilmentIntents.fulfilmentMode,
  moovoSourceReference: retailFulfilmentIntents.moovoSourceReference,
  moovoTransportRequestId: retailFulfilmentIntents.moovoTransportRequestId,
  moovoTransportRegisteredAt: retailFulfilmentIntents.moovoTransportRegisteredAt,
  createdAt: retailFulfilmentIntents.createdAt,
  updatedAt: retailFulfilmentIntents.updatedAt,
} as const;

/**
 * Every column of a delivery promise, NAMED — `source_ref` is protected.
 *
 * A supplier quote handle or a Moovo transport id, in somebody else's key
 * space. The promise ITSELF is exactly what a buyer should see, which is why the
 * protection is on the one column and not on the row, and why this repository
 * reads the whole row while a buyer projection reads
 * `readRetailDeliveryPromiseView`'s output, which has no `sourceRef` member at
 * all.
 */
const DELIVERY_PROMISE_COLUMNS = {
  id: retailDeliveryPromises.id,
  orderId: retailDeliveryPromises.orderId,
  fulfilmentIntentId: retailDeliveryPromises.fulfilmentIntentId,
  promiseKind: retailDeliveryPromises.promiseKind,
  source: retailDeliveryPromises.source,
  sourceRef: retailDeliveryPromises.sourceRef,
  outcome: retailDeliveryPromises.outcome,
  basis: retailDeliveryPromises.basis,
  earliestAt: retailDeliveryPromises.earliestAt,
  latestAt: retailDeliveryPromises.latestAt,
  failureReason: retailDeliveryPromises.failureReason,
  observedAt: retailDeliveryPromises.observedAt,
  createdAt: retailDeliveryPromises.createdAt,
} as const;

/** What the order-role snapshot is composed from at checkout. */
export interface NewRetailOrderRoleSnapshot {
  orderId: string;
  sellerLegalEntityName: string;
  sellerLegalEntityCountry: string;
  supplierFulfilmentDisclosureKey: string;
  supplierFulfilmentDisclosureVersion: number;
  customerTermsVersion: string;
  cancellationWindowHours: number;
  withdrawalWindowDays: number;
  returnWindowDays: number;
  warrantyMonths: number;
}

/** What one fulfilment intent is composed from. */
export interface NewRetailFulfilmentIntent {
  orderId: string;
  procurementIntentId: string;
  permittedFulfilmentMode: RetailPermittedFulfilmentMode;
  /** Present only on a replacement — the CHECK refuses either half alone. */
  supersedesIntentId?: string;
  /** Which customer lines, and how many units of each. */
  allocations: readonly { orderItemId: string; quantity: number }[];
}

/** One delivery-promise observation, as a caller states it. */
export interface NewRetailDeliveryPromise {
  orderId: string;
  fulfilmentIntentId?: string;
  promiseKind: RetailDeliveryPromiseKind;
  source: RetailDeliveryPromiseSource;
  sourceRef?: string;
  outcome: RetailDeliveryObservationOutcome;
  basis?: RetailDeliveryPromiseBasis;
  earliestAt?: Date;
  latestAt?: Date;
  failureReason?: string;
  observedAt: Date;
}

/**
 * Thrown when an allocation would take more units of a customer line than were
 * ordered.
 *
 * A dedicated error rather than a generic conflict, because the two callers
 * want opposite things from it: checkout must never see one (its allocations
 * are composed from the order it is creating) and treats it as a defect, while
 * a replacement or split-dispatch path must be able to report exactly which
 * line was over-subscribed to an operator.
 */
export class RetailAllocationExceedsOrderedQuantity extends Error {
  constructor(
    readonly orderItemId: string,
    readonly ordered: number,
    readonly alreadyAllocated: number,
    readonly requested: number,
  ) {
    super(
      `Order item ${orderItemId} has ${ordered} unit(s) ordered and ${alreadyAllocated} already ` +
        `allocated; ${requested} more cannot be allocated.`,
    );
    this.name = 'RetailAllocationExceedsOrderedQuantity';
  }
}

/**
 * Write the order-role snapshot — IN the order's transaction.
 *
 * @param db MUST be the transaction the order row is written in. A snapshot
 *   that committed without its order would describe a sale that did not happen,
 *   and an order that committed without its snapshot would be a retail purchase
 *   with no record of who sold it or under what terms — and the row is
 *   append-only, so there is no later write that could repair it.
 */
export async function insertRetailOrderRoleSnapshot(
  db: DatabaseOrTransaction,
  input: NewRetailOrderRoleSnapshot,
): Promise<RetailOrderRoleSnapshotRow> {
  const [row] = await db
    .insert(retailOrderRoleSnapshots)
    .values({
      orderId: input.orderId,
      sellerLegalEntityName: input.sellerLegalEntityName,
      sellerLegalEntityCountry: input.sellerLegalEntityCountry,
      supplierFulfilmentDisclosureKey: input.supplierFulfilmentDisclosureKey,
      supplierFulfilmentDisclosureVersion: input.supplierFulfilmentDisclosureVersion,
      customerTermsVersion: input.customerTermsVersion,
      cancellationWindowHours: input.cancellationWindowHours,
      withdrawalWindowDays: input.withdrawalWindowDays,
      returnWindowDays: input.returnWindowDays,
      warrantyMonths: input.warrantyMonths,
    })
    .returning();
  if (!row) {
    throw new Error('insertRetailOrderRoleSnapshot: the insert returned no row');
  }
  return row;
}

/**
 * Write fulfilment intents and their line allocations — IN one transaction.
 *
 * The allocation cap is checked for the WHOLE batch before any of it is
 * written, so a two-supplier order whose second intent would over-allocate does
 * not leave the first one committed. Within one call the requested quantities
 * are accumulated as they are validated, which is what makes two intents in the
 * same batch claiming the same line fail here rather than passing two
 * independently-correct checks.
 */
export async function insertRetailFulfilmentIntents(
  db: DatabaseOrTransaction,
  intents: readonly NewRetailFulfilmentIntent[],
): Promise<RetailFulfilmentIntentRow[]> {
  if (intents.length === 0) return [];

  const requestedByItem = new Map<string, number>();
  for (const intent of intents) {
    // A REPLACEMENT is outside the cap in BOTH directions — it is excluded from
    // the committed sum below and it must not be counted as a new request
    // either. Counting it here refuses every replacement, because the units it
    // re-ships are by definition already allocated. Caught by
    // `retail-fulfilment.realdb.test.ts`, which is the only place the two
    // halves of this rule are exercised together.
    if (intent.supersedesIntentId) continue;
    for (const allocation of intent.allocations) {
      requestedByItem.set(
        allocation.orderItemId,
        (requestedByItem.get(allocation.orderItemId) ?? 0) + allocation.quantity,
      );
    }
  }
  await assertAllocationsFit(db, requestedByItem);

  const rows = await db
    .insert(retailFulfilmentIntents)
    .values(
      intents.map((intent) => ({
        orderId: intent.orderId,
        procurementIntentId: intent.procurementIntentId,
        permittedFulfilmentMode: intent.permittedFulfilmentMode,
        intentKind: intent.supersedesIntentId ? ('replacement' as const) : ('original' as const),
        ...(intent.supersedesIntentId ? { supersedesIntentId: intent.supersedesIntentId } : {}),
      })),
    )
    .returning();

  const allocations = rows.flatMap((row, index) => {
    const intent = intents[index];
    if (!intent) {
      // Unreachable: `returning()` yields one row per value, in order. A throw
      // rather than a non-null assertion, which the house rules forbid and
      // which would hide the day it stops being unreachable.
      throw new Error('insertRetailFulfilmentIntents: returned rows do not match its input');
    }
    return intent.allocations.map((allocation) => ({
      fulfilmentIntentId: row.id,
      orderItemId: allocation.orderItemId,
      quantity: allocation.quantity,
    }));
  });
  if (allocations.length > 0) {
    await db.insert(retailFulfilmentLineAllocations).values(allocations);
  }
  return rows;
}

/**
 * Lock the customer lines and refuse a batch that would over-allocate any.
 *
 * `FOR UPDATE` on `order_items` is what makes this safe under concurrency: two
 * transactions allocating against one line serialize on the item row, so the
 * second reads the first's committed sum instead of the pre-insert one. Reading
 * without the lock passes every single-threaded test and fails exactly when two
 * operators split a dispatch at the same moment.
 */
async function assertAllocationsFit(
  db: DatabaseOrTransaction,
  requestedByItem: ReadonlyMap<string, number>,
): Promise<void> {
  const itemIds = [...requestedByItem.keys()];
  if (itemIds.length === 0) return;

  const items = await db
    .select({ id: orderItems.id, quantity: orderItems.quantity })
    .from(orderItems)
    .where(inArray(orderItems.id, itemIds))
    .for('update');
  const orderedByItem = new Map(items.map((item) => [item.id, item.quantity]));
  for (const itemId of itemIds) {
    if (!orderedByItem.has(itemId)) {
      throw new Error(
        `Order item ${itemId} does not exist; a fulfilment allocation cannot name it.`,
      );
    }
  }

  const allocated = await db
    .select({
      orderItemId: retailFulfilmentLineAllocations.orderItemId,
      // `sum` over an integer column decodes as a STRING through postgres.js
      // (`bigint` on the wire), so it is coerced in SQL rather than in JS —
      // `Number(...)` at the boundary would work too, but a comparison against
      // a string that silently concatenates is the failure this repository is
      // least able to detect.
      allocated: sql<number>`coalesce(sum(${retailFulfilmentLineAllocations.quantity}), 0)::int`,
    })
    .from(retailFulfilmentLineAllocations)
    .innerJoin(
      retailFulfilmentIntents,
      eq(retailFulfilmentIntents.id, retailFulfilmentLineAllocations.fulfilmentIntentId),
    )
    .where(
      and(
        inArray(retailFulfilmentLineAllocations.orderItemId, itemIds),
        eq(retailFulfilmentIntents.intentKind, 'original'),
        // A cancelled or superseded intent has released its claim on these
        // units — that is what those statuses MEAN, and excluding them is what
        // lets a re-allocation after a cancellation succeed.
        sql`${retailFulfilmentIntents.status} not in ('cancelled', 'superseded')`,
      ),
    )
    .groupBy(retailFulfilmentLineAllocations.orderItemId);
  const allocatedByItem = new Map(allocated.map((row) => [row.orderItemId, Number(row.allocated)]));

  for (const [itemId, requested] of requestedByItem) {
    const ordered = orderedByItem.get(itemId) ?? 0;
    const already = allocatedByItem.get(itemId) ?? 0;
    if (already + requested > ordered) {
      throw new RetailAllocationExceedsOrderedQuantity(itemId, ordered, already, requested);
    }
  }
}

/** Record one delivery-promise observation. Append-only by trigger. */
export async function insertRetailDeliveryPromise(
  db: DatabaseOrTransaction,
  input: NewRetailDeliveryPromise,
): Promise<RetailDeliveryPromiseRow> {
  const [row] = await db
    .insert(retailDeliveryPromises)
    .values({
      orderId: input.orderId,
      ...(input.fulfilmentIntentId ? { fulfilmentIntentId: input.fulfilmentIntentId } : {}),
      promiseKind: input.promiseKind,
      source: input.source,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      outcome: input.outcome,
      ...(input.basis ? { basis: input.basis } : {}),
      ...(input.earliestAt ? { earliestAt: input.earliestAt } : {}),
      ...(input.latestAt ? { latestAt: input.latestAt } : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      observedAt: input.observedAt,
    })
    .returning();
  if (!row) {
    throw new Error('insertRetailDeliveryPromise: the insert returned no row');
  }
  return row;
}

/** The order-role snapshot for one retail order, if it has one. */
export async function findRetailOrderRoleSnapshot(
  orderId: string,
): Promise<RetailOrderRoleSnapshotRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(retailOrderRoleSnapshots)
    .where(eq(retailOrderRoleSnapshots.orderId, orderId))
    .limit(1);
  return row;
}

/**
 * The order-role snapshots for MANY retail orders, keyed by order id — the read
 * an order list makes (#129).
 *
 * A batch rather than a loop over {@link findRetailOrderRoleSnapshot}: a buyer
 * with twenty orders would otherwise cost twenty statements to answer one
 * question, and the natural fix at the call site is to skip the snapshot and
 * use today's terms, which is exactly the thing the snapshot exists to prevent.
 */
export async function findRetailOrderRoleSnapshots(
  orderIds: readonly string[],
): Promise<Map<string, RetailOrderRoleSnapshotRow>> {
  if (orderIds.length === 0) return new Map();
  const rows = await getDb()
    .select()
    .from(retailOrderRoleSnapshots)
    .where(inArray(retailOrderRoleSnapshots.orderId, [...new Set(orderIds)]));
  return new Map(rows.map((row) => [row.orderId, row]));
}

/** Every fulfilment intent on one order, oldest first. */
export async function listRetailFulfilmentIntents(
  orderId: string,
): Promise<RetailFulfilmentIntentRow[]> {
  return getDb()
    .select(FULFILMENT_INTENT_COLUMNS)
    .from(retailFulfilmentIntents)
    .where(eq(retailFulfilmentIntents.orderId, orderId))
    .orderBy(asc(retailFulfilmentIntents.createdAt), asc(retailFulfilmentIntents.id));
}

/**
 * Resolve an inbound Moovo reference to exactly ONE fulfilment intent.
 *
 * This is #126 privacy 9 — *"supplier and Moovo events cannot enumerate
 * unrelated orders"* — held by the SHAPE of the lookup. The function takes a
 * source reference and nothing else, returns one row or none, and has no
 * parameter that could widen it to an order, a supplier, a buyer or a list. An
 * inbound event carrying a reference Mercaria did not mint resolves to nothing
 * and can therefore reach nothing; there is no partial match and no prefix
 * search to fall back on.
 */
export async function findRetailFulfilmentIntentBySourceReference(
  sourceReference: string,
): Promise<RetailFulfilmentIntentRow | undefined> {
  const [row] = await getDb()
    .select(FULFILMENT_INTENT_COLUMNS)
    .from(retailFulfilmentIntents)
    .where(eq(retailFulfilmentIntents.moovoSourceReference, sourceReference))
    .limit(1);
  return row;
}

/** Every allocation belonging to the given intents. */
export async function listRetailFulfilmentLineAllocations(
  intentIds: readonly string[],
): Promise<RetailFulfilmentLineAllocationRow[]> {
  if (intentIds.length === 0) return [];
  return getDb()
    .select()
    .from(retailFulfilmentLineAllocations)
    .where(inArray(retailFulfilmentLineAllocations.fulfilmentIntentId, [...intentIds]))
    .orderBy(asc(retailFulfilmentLineAllocations.orderItemId), asc(retailFulfilmentLineAllocations.id));
}

/** One customer line, what was ordered, and what is allocated against it. */
export interface RetailLineAllocationReconciliationRow {
  orderItemId: string;
  ordered: number;
  allocated: number;
}

/**
 * The reconciliation read: ordered against allocated, per customer line.
 *
 * A LEFT join so a line with no allocation at all appears with zero — the
 * "lost" half of #126 mapping 8. An inner join would report the same tidy list
 * whether a line was fully allocated or entirely forgotten, which is the shape
 * of check that cannot distinguish success from failure.
 */
export async function readRetailLineAllocationReconciliation(
  orderId: string,
): Promise<RetailLineAllocationReconciliationRow[]> {
  const rows = await getDb()
    .select({
      orderItemId: orderItems.id,
      ordered: orderItems.quantity,
      allocated: sql<number>`coalesce(sum(
        case
          when ${retailFulfilmentIntents.intentKind} = 'original'
           and ${retailFulfilmentIntents.status} not in ('cancelled', 'superseded')
          then ${retailFulfilmentLineAllocations.quantity}
          else 0
        end
      ), 0)::int`,
    })
    .from(orderItems)
    .leftJoin(
      retailFulfilmentLineAllocations,
      eq(retailFulfilmentLineAllocations.orderItemId, orderItems.id),
    )
    .leftJoin(
      retailFulfilmentIntents,
      eq(retailFulfilmentIntents.id, retailFulfilmentLineAllocations.fulfilmentIntentId),
    )
    .where(eq(orderItems.orderId, orderId))
    .groupBy(orderItems.id, orderItems.quantity, orderItems.position)
    .orderBy(asc(orderItems.position), asc(orderItems.id));
  return rows.map((row) => ({
    orderItemId: row.orderItemId,
    ordered: row.ordered,
    allocated: Number(row.allocated),
  }));
}

/** Every promise observation on one order, newest first. */
export async function listRetailDeliveryPromises(
  orderId: string,
): Promise<RetailDeliveryPromiseRow[]> {
  return getDb()
    .select(DELIVERY_PROMISE_COLUMNS)
    .from(retailDeliveryPromises)
    .where(eq(retailDeliveryPromises.orderId, orderId))
    .orderBy(asc(retailDeliveryPromises.observedAt), asc(retailDeliveryPromises.id));
}

/**
 * Record which mode is actually used — a CAS from NULL, and never from a value.
 *
 * The predicate is what makes it write-once at the statement level; the trigger
 * states the same rule at the row so a second writer, a migration or `psql`
 * cannot move it either. Both exist because the failure they prevent is silent:
 * every event already projected under the first mode is reinterpreted by the
 * second, and nothing in the data says a reinterpretation happened.
 */
export async function chooseRetailFulfilmentMode(input: {
  id: string;
  mode: RetailFulfilmentMode;
}): Promise<RetailFulfilmentIntentRow | undefined> {
  const [row] = await getDb()
    .update(retailFulfilmentIntents)
    .set({ fulfilmentMode: input.mode })
    .where(
      and(
        eq(retailFulfilmentIntents.id, input.id),
        isNull(retailFulfilmentIntents.fulfilmentMode),
      ),
    )
    .returning();
  return row;
}

/**
 * Attach Moovo's own transport id — a CAS from NULL, for the reason above.
 *
 * This is the write #159 performs after a successful booking or tracking-only
 * registration. Nothing in Mercaria can perform it today; the port that will is
 * `services/retail-fulfilment/moovo.port.ts`, and it refuses.
 */
export async function attachMoovoTransport(input: {
  id: string;
  transportRequestId: string;
  registeredAt: Date;
}): Promise<RetailFulfilmentIntentRow | undefined> {
  const [row] = await getDb()
    .update(retailFulfilmentIntents)
    .set({
      moovoTransportRequestId: input.transportRequestId,
      moovoTransportRegisteredAt: input.registeredAt,
    })
    .where(
      and(
        eq(retailFulfilmentIntents.id, input.id),
        isNull(retailFulfilmentIntents.moovoTransportRequestId),
      ),
    )
    .returning();
  return row;
}

/** Move one intent's commercial status, recording why. */
export async function setRetailFulfilmentIntentStatus(input: {
  id: string;
  status: RetailFulfilmentIntentStatus;
  reason: string;
}): Promise<RetailFulfilmentIntentRow | undefined> {
  const [row] = await getDb()
    .update(retailFulfilmentIntents)
    .set({ status: input.status, statusReason: input.reason })
    .where(eq(retailFulfilmentIntents.id, input.id))
    .returning();
  return row;
}

/**
 * One retail order's customer lines, in the order checkout composed them.
 *
 * The POSITION is the join: `buildRetailOrder` maps the retail plan's lines to
 * order items one for one and in order, so the allocation composer can pair
 * `plan.lines[i]` with `items[i]` without inventing a second matching rule.
 * Matching on a money amount instead — which one pre-existing path does — pairs
 * two lines that happen to cost the same.
 */
export async function listOrderItemIdsInPosition(
  db: DatabaseOrTransaction,
  orderId: string,
): Promise<{ id: string; quantity: number }[]> {
  return db
    .select({ id: orderItems.id, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.position), asc(orderItems.id));
}
