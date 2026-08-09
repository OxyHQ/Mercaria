/**
 * Purchase orders: creation that converges, transitions that CAS, and the
 * append-only trail beside them.
 *
 * ## Creation is a CLAIM on the deterministic idempotency key
 *
 * `createPurchaseOrder` inserts with `ON CONFLICT DO NOTHING` on
 * `purchase_orders_idempotency_key_key` and, when it lost, returns the row the
 * winner made — so a replayed checkout consequence, a redelivered supplier
 * callback or two concurrent outbox dispatchers all end holding the SAME
 * purchase order (#118 consistency rule 3, acceptance criterion 4). Under
 * concurrency the loser's insert blocks on the winner's speculative insertion
 * until it commits, then reads the survivor — the moderation-event claim
 * shape, one table over.
 *
 * ## A transition is ONE statement plus its history row
 *
 * `UPDATE … WHERE id = $1 AND status = $2 RETURNING` — the CAS the
 * CONVENTIONS concurrency rules require, so two concurrent transitions
 * produce exactly one winner. The append-only `purchase_order_transitions`
 * row commits in the same transaction, so the trail can never disagree with
 * the state that exists. LEGALITY (which edges the ADR 0004 D9.2 machine
 * allows) lives in `services/procurement/purchase-order.service.ts`; this
 * module enforces atomicity, not the map.
 */

import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  PurchaseOrderInitiator,
  PurchaseOrderReasonCode,
  PurchaseOrderStatus,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  purchaseOrderLines,
  purchaseOrderShipments,
  purchaseOrderTransitions,
  purchaseOrders,
} from '../schema/procurement.js';

/** One purchase order row, whole — the table has no protected columns. */
export type PurchaseOrderRecord = typeof purchaseOrders.$inferSelect;

/** One immutable line. */
export type PurchaseOrderLineRecord = typeof purchaseOrderLines.$inferSelect;

/** One transition event. */
export type PurchaseOrderTransitionRecord = typeof purchaseOrderTransitions.$inferSelect;

/** One parcel. */
export type PurchaseOrderShipmentRecord = typeof purchaseOrderShipments.$inferSelect;

/** Longest stored error — matches the column's CHECK. */
const MAX_NOTE_LENGTH = 2_000;

/** One line of a new PO — the quote snapshot, frozen at creation. */
export interface NewPurchaseOrderLine {
  supplierSku: string;
  canonicalProductId?: string;
  canonicalVariantId?: string;
  procurementOfferId?: string;
  description?: string;
  quantity: number;
  unitCostAmount: number;
  lineTotalAmount: number;
  quoteRef?: string;
}

/** The redacted fulfilment destination — ADR 0004 D2.7's projection, verbatim. */
export interface PurchaseOrderDestination {
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

/** What a new PO is created from. */
export interface NewPurchaseOrder {
  supplierId: string;
  supplierAccountId: string;
  agreementId: string;
  orderId: string;
  checkoutGroupId?: string;
  /** DETERMINISTIC (`po:<orderId>:<supplierId>`) — supplied, never generated. */
  idempotencyKey: string;
  currency: CurrencyCode;
  itemsAmount: number;
  shippingAmount?: number;
  taxAmount?: number;
  dutyAmount?: number;
  totalAmount: number;
  destination: PurchaseOrderDestination;
  quoteRef?: string;
  lines: NewPurchaseOrderLine[];
}

/** The claim's answer: the surviving row, and whether this call created it. */
export interface CreatePurchaseOrderResult {
  purchaseOrder: PurchaseOrderRecord;
  created: boolean;
}

/**
 * Create one DRAFT purchase order with its lines and its birth transition, or
 * converge on the one an earlier call already made.
 */
export async function createPurchaseOrder(
  input: NewPurchaseOrder,
  db: DatabaseOrTransaction = getDb(),
): Promise<CreatePurchaseOrderResult> {
  if (input.lines.length === 0) {
    throw new Error('createPurchaseOrder refuses a purchase order with no lines');
  }
  const at = new Date();
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(purchaseOrders)
      .values({
        supplierId: input.supplierId,
        supplierAccountId: input.supplierAccountId,
        agreementId: input.agreementId,
        orderId: input.orderId,
        checkoutGroupId: input.checkoutGroupId ?? null,
        idempotencyKey: input.idempotencyKey,
        currency: input.currency,
        itemsAmount: input.itemsAmount,
        shippingAmount: input.shippingAmount ?? 0,
        taxAmount: input.taxAmount ?? 0,
        dutyAmount: input.dutyAmount ?? 0,
        totalAmount: input.totalAmount,
        destinationRecipientName: input.destination.recipientName,
        destinationLine1: input.destination.line1,
        destinationLine2: input.destination.line2 ?? null,
        destinationCity: input.destination.city,
        destinationRegion: input.destination.region ?? null,
        destinationPostalCode: input.destination.postalCode,
        destinationCountry: input.destination.country,
        destinationPhone: input.destination.phone ?? null,
        quoteRef: input.quoteRef ?? null,
      })
      .onConflictDoNothing({ target: purchaseOrders.idempotencyKey })
      .returning();
    if (!row) return undefined;

    await tx.insert(purchaseOrderLines).values(
      input.lines.map((line, index) => ({
        purchaseOrderId: row.id,
        supplierSku: line.supplierSku,
        canonicalProductId: line.canonicalProductId ?? null,
        canonicalVariantId: line.canonicalVariantId ?? null,
        procurementOfferId: line.procurementOfferId ?? null,
        description: line.description ?? null,
        quantity: line.quantity,
        unitCostAmount: line.unitCostAmount,
        lineTotalAmount: line.lineTotalAmount,
        quoteRef: line.quoteRef ?? null,
        position: index,
      })),
    );
    await tx.insert(purchaseOrderTransitions).values({
      purchaseOrderId: row.id,
      status: 'draft',
      at,
      initiator: 'system',
    });
    return row;
  });

  if (claimed) return { purchaseOrder: claimed, created: true };

  const survivor = await findPurchaseOrderByIdempotencyKey(input.idempotencyKey, db);
  if (!survivor) {
    // The winner's transaction aborted after blocking ours — genuinely rare,
    // and retrying the claim is the correct answer, not an error.
    return await createPurchaseOrder(input, db);
  }
  return { purchaseOrder: survivor, created: false };
}

/** One PO, or `undefined`. */
export async function findPurchaseOrderById(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderRecord | undefined> {
  const [row] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, purchaseOrderId))
    .limit(1);
  return row;
}

/** The convergence read behind `createPurchaseOrder`. */
export async function findPurchaseOrderByIdempotencyKey(
  idempotencyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderRecord | undefined> {
  const [row] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.idempotencyKey, idempotencyKey))
    .limit(1);
  return row;
}

/** Every PO fulfilling one customer order — #118 indexes 5. */
export async function findPurchaseOrdersByOrderId(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderRecord[]> {
  return await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.orderId, orderId))
    .orderBy(purchaseOrders.createdAt);
}

/** The correlation every supplier callback starts from. */
export async function findPurchaseOrderBySupplierExternalOrderId(
  input: { supplierAccountId: string; supplierExternalOrderId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderRecord | undefined> {
  const [row] = await db
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.supplierAccountId, input.supplierAccountId),
        eq(purchaseOrders.supplierExternalOrderId, input.supplierExternalOrderId),
      ),
    )
    .limit(1);
  return row;
}

/** A PO's immutable lines, in order. */
export async function findPurchaseOrderLines(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderLineRecord[]> {
  return await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
    .orderBy(purchaseOrderLines.position);
}

/** A PO's transition trail, oldest first. */
export async function findPurchaseOrderTransitions(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderTransitionRecord[]> {
  return await db
    .select()
    .from(purchaseOrderTransitions)
    .where(eq(purchaseOrderTransitions.purchaseOrderId, purchaseOrderId))
    .orderBy(purchaseOrderTransitions.at, purchaseOrderTransitions.id);
}

/** The columns a transition may touch beside `status` — never money, never identity. */
export interface PurchaseOrderTransitionPatch {
  supplierExternalOrderId?: string;
  reasonCode?: PurchaseOrderReasonCode;
  acceptanceDeadlineAt?: Date;
  submittedAt?: Date;
  acceptedAt?: Date;
  allocatedAt?: Date;
  shippedAt?: Date;
  deliveredAt?: Date;
  cancelledAt?: Date;
  incrementSubmissionAttempts?: boolean;
  lastSubmissionError?: string | null;
  operatorInterventionRequired?: boolean;
  operatorNote?: string;
}

/**
 * CAS the status and append the matching transition row, in one transaction.
 * Returns `undefined` when `expected` no longer holds — the caller lost the
 * race or is replaying, and the trail says what actually happened.
 */
export async function transitionPurchaseOrder(
  input: {
    purchaseOrderId: string;
    expected: PurchaseOrderStatus;
    next: PurchaseOrderStatus;
    initiator: PurchaseOrderInitiator;
    reasonCode?: PurchaseOrderReasonCode;
    supplierNote?: string;
    byOxyUserId?: string;
    patch?: PurchaseOrderTransitionPatch;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderRecord | undefined> {
  const at = input.at ?? new Date();
  const patch = input.patch ?? {};
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .update(purchaseOrders)
      .set({
        status: input.next,
        ...(patch.supplierExternalOrderId !== undefined
          ? { supplierExternalOrderId: patch.supplierExternalOrderId }
          : {}),
        ...(patch.reasonCode !== undefined ? { reasonCode: patch.reasonCode } : {}),
        ...(patch.acceptanceDeadlineAt !== undefined
          ? { acceptanceDeadlineAt: patch.acceptanceDeadlineAt }
          : {}),
        ...(patch.submittedAt !== undefined ? { submittedAt: patch.submittedAt } : {}),
        ...(patch.acceptedAt !== undefined ? { acceptedAt: patch.acceptedAt } : {}),
        ...(patch.allocatedAt !== undefined ? { allocatedAt: patch.allocatedAt } : {}),
        ...(patch.shippedAt !== undefined ? { shippedAt: patch.shippedAt } : {}),
        ...(patch.deliveredAt !== undefined ? { deliveredAt: patch.deliveredAt } : {}),
        ...(patch.cancelledAt !== undefined ? { cancelledAt: patch.cancelledAt } : {}),
        ...(patch.incrementSubmissionAttempts
          ? { submissionAttempts: sql`${purchaseOrders.submissionAttempts} + 1` }
          : {}),
        ...(patch.lastSubmissionError !== undefined
          ? {
              lastSubmissionError:
                patch.lastSubmissionError === null
                  ? null
                  : patch.lastSubmissionError.slice(0, MAX_NOTE_LENGTH),
            }
          : {}),
        ...(patch.operatorInterventionRequired !== undefined
          ? { operatorInterventionRequired: patch.operatorInterventionRequired }
          : {}),
        ...(patch.operatorNote !== undefined ? { operatorNote: patch.operatorNote } : {}),
        updatedAt: at,
      })
      .where(
        and(eq(purchaseOrders.id, input.purchaseOrderId), eq(purchaseOrders.status, input.expected)),
      )
      .returning();
    if (!row) return undefined;

    await tx.insert(purchaseOrderTransitions).values({
      purchaseOrderId: row.id,
      status: input.next,
      at,
      initiator: input.initiator,
      reasonCode: input.reasonCode ?? null,
      supplierNote: input.supplierNote ? input.supplierNote.slice(0, MAX_NOTE_LENGTH) : null,
      byOxyUserId: input.byOxyUserId ?? null,
    });
    return row;
  });
}

/** Record one parcel — a redelivered callback updates the row it already made. */
export async function recordPurchaseOrderShipment(
  input: {
    purchaseOrderId: string;
    trackingNumber: string;
    carrier?: string;
    service?: string;
    shippedAt: Date;
    deliveredAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderShipmentRecord> {
  const [row] = await db
    .insert(purchaseOrderShipments)
    .values({
      purchaseOrderId: input.purchaseOrderId,
      trackingNumber: input.trackingNumber,
      carrier: input.carrier ?? null,
      service: input.service ?? null,
      shippedAt: input.shippedAt,
      deliveredAt: input.deliveredAt ?? null,
    })
    .onConflictDoUpdate({
      target: [purchaseOrderShipments.purchaseOrderId, purchaseOrderShipments.trackingNumber],
      set: {
        carrier: input.carrier ?? null,
        service: input.service ?? null,
        shippedAt: input.shippedAt,
        deliveredAt: input.deliveredAt ?? null,
      },
    })
    .returning();
  if (!row) throw new Error('recordPurchaseOrderShipment returned no row');
  return row;
}

/** A PO's parcels, in order. */
export async function findPurchaseOrderShipments(
  purchaseOrderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderShipmentRecord[]> {
  return await db
    .select()
    .from(purchaseOrderShipments)
    .where(eq(purchaseOrderShipments.purchaseOrderId, purchaseOrderId))
    .orderBy(purchaseOrderShipments.position, purchaseOrderShipments.createdAt);
}

/** Submitted POs whose acceptance deadline has passed — the timeout sweep (#124). */
export async function listSubmittedPastDeadline(
  now: Date = new Date(),
  limit = 100,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderRecord[]> {
  return await db
    .select()
    .from(purchaseOrders)
    .where(
      and(eq(purchaseOrders.status, 'submitted'), lte(purchaseOrders.acceptanceDeadlineAt, now)),
    )
    .orderBy(purchaseOrders.acceptanceDeadlineAt)
    .limit(limit);
}

/** Delivered POs #128 has not reconciled — "unreconciled" (#118 indexes 6). */
export async function listUnreconciledDelivered(
  limit = 100,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderRecord[]> {
  return await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.status, 'delivered'), isNull(purchaseOrders.reconciledAt)))
    .orderBy(purchaseOrders.createdAt)
    .limit(limit);
}

/** POs waiting on a person — the operator exception queue. */
export async function listPurchaseOrdersRequiringOperator(
  limit = 100,
  db: DatabaseOrTransaction = getDb(),
): Promise<PurchaseOrderRecord[]> {
  return await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.operatorInterventionRequired, true))
    .orderBy(purchaseOrders.createdAt)
    .limit(limit);
}
