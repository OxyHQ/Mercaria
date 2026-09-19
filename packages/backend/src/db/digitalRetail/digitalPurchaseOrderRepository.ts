/**
 * The only writer of `digital_purchase_orders` and
 * `digital_purchase_order_attempts` — and the module the exactly-once property
 * of ADR 0011 D6 is implemented in.
 *
 * ## Three mechanisms, and this file relies on all three
 *
 * 1. **`UNIQUE(idempotency_key)`.** `openPurchaseOrder` is ONE statement —
 *    `INSERT … ON CONFLICT DO NOTHING RETURNING` — and when it returns nothing it
 *    READS the row the other caller wrote. A service-level "is there one already?
 *    then insert" has a window between the two statements, and a retried
 *    checkout is precisely a second caller inside it.
 * 2. **The partial unique over the non-terminal statuses.** A second attempt for
 *    an order line whose previous attempt is unresolved does not fail a check —
 *    it fails an INSERT. That is the epic's fallback rule 1 as a database
 *    property: an ambiguous attempt cannot be stepped over.
 * 3. **The compare-and-swap.** Every status move names the status the caller
 *    believed it was in, and answers three ways: `updated`, `stale`, `missing`.
 *    A caller that cannot name where it started cannot write.
 *
 * ## Why the transition table is read HERE and not in SQL
 *
 * `DIGITAL_PURCHASE_ORDER_TRANSITIONS` is the machine. Encoding it a second time
 * in a trigger would be two authorities over one fact, and they would disagree
 * exactly once — so the trigger freezes the identity and cost columns only, and
 * this module refuses an edge the map does not admit before it issues any SQL.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import {
  DIGITAL_PURCHASE_ORDER_LIVE_STATUSES,
  digitalPurchaseOrderTransitionAllowed,
  type DigitalFulfilmentCapability,
  type DigitalProcurementErrorKind,
  type DigitalPurchaseOrderStatus,
  type DigitalRetailProductClass,
  type DigitalSupplierApiCapability,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  digitalPurchaseOrderAttempts,
  digitalPurchaseOrders,
} from '../schema/digitalRetail.js';

export type DigitalPurchaseOrderRow = InferSelectModel<typeof digitalPurchaseOrders>;
export type DigitalPurchaseOrderAttemptRow = InferSelectModel<typeof digitalPurchaseOrderAttempts>;

/**
 * The idempotency key, DERIVED rather than generated.
 *
 * Deterministic on purpose: a retried orchestration for the same attempt
 * re-derives the same key and collides, where a random key would insert a second
 * purchase order and buy a second time. The shape is CHECKed by the column, so a
 * hand-typed value fails the write.
 */
export function purchaseOrderIdempotencyKey(orderItemId: string, attemptOrdinal: number): string {
  return `dpo:${orderItemId}:${attemptOrdinal}`;
}

export interface OpenPurchaseOrderInput {
  readonly orderId: string;
  readonly orderItemId: string;
  readonly attemptOrdinal: number;
  readonly previousPurchaseOrderId: string | null;
  readonly supplierId: string;
  readonly supplierAccountId: string;
  readonly digitalSupplyTermsId: string;
  readonly digitalProcurementOfferId: string | null;
  readonly canonicalVariantId: string | null;
  readonly supplierSku: string;
  readonly productClass: DigitalRetailProductClass;
  readonly fulfilmentCapability: DigitalFulfilmentCapability;
  readonly platform: string;
  readonly activationEcosystem: string;
  readonly edition: string;
  readonly quotedCostAmount: number;
  readonly quotedCostCurrency: string;
  readonly maxAcceptedCostAmount: number;
  readonly now: Date;
}

/** What `openPurchaseOrder` did, so a retry does not re-run the adapter. */
export interface OpenPurchaseOrderResult {
  readonly purchaseOrder: DigitalPurchaseOrderRow;
  readonly created: boolean;
}

/**
 * Open an attempt, converging on a replay.
 *
 * `onConflictDoNothing` with NO target, deliberately: two unique indexes are in
 * play — the idempotency key and the one-live-attempt-per-line partial — and
 * naming one would leave the other raising. Both encode "this attempt already
 * exists, in some form", and the read-back below tells the caller which.
 *
 * When the conflict was the LIVE-LINE index rather than the key, the row read
 * back is a DIFFERENT attempt for the same line — an in-flight or ambiguous one.
 * That is not an error and must not be treated as one: the caller gets the live
 * attempt and the orchestrator resolves THAT before opening anything new.
 */
export async function openPurchaseOrder(
  input: OpenPurchaseOrderInput,
  tx?: DatabaseOrTransaction,
): Promise<OpenPurchaseOrderResult> {
  const db = tx ?? getDb();
  const idempotencyKey = purchaseOrderIdempotencyKey(input.orderItemId, input.attemptOrdinal);
  const [inserted] = await db
    .insert(digitalPurchaseOrders)
    .values({
      idempotencyKey,
      attemptOrdinal: input.attemptOrdinal,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      supplierId: input.supplierId,
      supplierAccountId: input.supplierAccountId,
      digitalSupplyTermsId: input.digitalSupplyTermsId,
      digitalProcurementOfferId: input.digitalProcurementOfferId,
      canonicalVariantId: input.canonicalVariantId,
      supplierSku: input.supplierSku,
      productClass: input.productClass,
      fulfilmentCapability: input.fulfilmentCapability,
      platform: input.platform,
      activationEcosystem: input.activationEcosystem,
      edition: input.edition,
      quotedCostAmount: input.quotedCostAmount,
      quotedCostCurrency: input.quotedCostCurrency as DigitalPurchaseOrderRow['quotedCostCurrency'],
      maxAcceptedCostAmount: input.maxAcceptedCostAmount,
      maxAcceptedCostCurrency:
        input.quotedCostCurrency as DigitalPurchaseOrderRow['maxAcceptedCostCurrency'],
      previousPurchaseOrderId: input.previousPurchaseOrderId,
      statusChangedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) return { purchaseOrder: inserted, created: true };

  const existing =
    (await findPurchaseOrderByIdempotencyKey(idempotencyKey, db)) ??
    (await findLivePurchaseOrderForLine(input.orderItemId, db));
  if (!existing) {
    // The insert conflicted, so a row matching one of the two indexes exists.
    // Failing to find it means the reads and the indexes disagree, which is a bug
    // worth a loud error rather than a silent second procurement.
    throw new Error(
      `digital purchase order ${idempotencyKey} conflicted but could not be read back`,
    );
  }
  return { purchaseOrder: existing, created: false };
}

/** One attempt by its derived key. */
export async function findPurchaseOrderByIdempotencyKey(
  idempotencyKey: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalPurchaseOrders)
    .where(eq(digitalPurchaseOrders.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

/** One attempt by id. */
export async function findPurchaseOrder(
  id: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalPurchaseOrders)
    .where(eq(digitalPurchaseOrders.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The one unresolved attempt for an order line, if there is one.
 *
 * At most one can exist — the partial unique says so — which is why this returns
 * a row rather than a list. A caller finding one must resolve it before opening
 * anything: it may be in flight, and it may be `ambiguous`.
 */
export async function findLivePurchaseOrderForLine(
  orderItemId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalPurchaseOrders)
    .where(
      and(
        eq(digitalPurchaseOrders.orderItemId, orderItemId),
        inArray(digitalPurchaseOrders.status, [...DIGITAL_PURCHASE_ORDER_LIVE_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every attempt made for one order line, oldest first — the audit trail. */
export async function findPurchaseOrdersForLine(
  orderItemId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(digitalPurchaseOrders)
    .where(eq(digitalPurchaseOrders.orderItemId, orderItemId))
    .orderBy(asc(digitalPurchaseOrders.attemptOrdinal));
}

/**
 * The attempts stuck in `ambiguous` longer than `olderThan` — the recovery
 * sweeper's work list, oldest first.
 *
 * This exists because an ambiguous attempt blocks its order line by construction.
 * Nothing else can be tried for that buyer until provider truth resolves it, so
 * the sweep is the thing that keeps a timeout from becoming a stranded order.
 */
export async function findAmbiguousPurchaseOrders(
  olderThan: Date,
  limit: number,
  tx?: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(digitalPurchaseOrders)
    .where(
      and(
        eq(digitalPurchaseOrders.status, 'ambiguous'),
        sql`${digitalPurchaseOrders.ambiguousSince} <= ${olderThan}`,
      ),
    )
    .orderBy(asc(digitalPurchaseOrders.ambiguousSince))
    .limit(limit);
}

/** Why a transition did not happen, so a caller can tell a race from a bug. */
export type PurchaseOrderTransitionOutcome = 'updated' | 'stale' | 'missing' | 'forbidden';

export interface TransitionPurchaseOrderInput {
  readonly purchaseOrderId: string;
  /** The status the caller believed it was in — the compare half. */
  readonly from: DigitalPurchaseOrderStatus;
  readonly to: DigitalPurchaseOrderStatus;
  readonly now: Date;
  readonly providerOrderId?: string | null;
  readonly providerReference?: string | null;
  readonly errorKind?: DigitalProcurementErrorKind | null;
  readonly errorMessageRedacted?: string | null;
  readonly finalCostAmount?: number | null;
}

export interface TransitionPurchaseOrderResult {
  readonly outcome: PurchaseOrderTransitionOutcome;
  readonly purchaseOrder: DigitalPurchaseOrderRow | null;
}

/**
 * Move an attempt's status, as a compare-and-swap.
 *
 * FOUR outcomes rather than three, because this machine has one more way to fail
 * than a route does: `forbidden` means the edge is not in
 * `DIGITAL_PURCHASE_ORDER_TRANSITIONS` at all, which is a programming error and
 * must not be reported as a lost race. The SQL is never issued for one.
 *
 * The clock columns are set from the TARGET status rather than from a parameter,
 * so a caller cannot record a submission time on a preflight — and `ambiguousSince`
 * is written once and kept afterwards, because "this attempt was once ambiguous"
 * is exactly what a later audit needs and a recovered attempt would otherwise
 * look like one that never timed out.
 */
export async function transitionPurchaseOrder(
  input: TransitionPurchaseOrderInput,
  tx?: DatabaseOrTransaction,
): Promise<TransitionPurchaseOrderResult> {
  if (!digitalPurchaseOrderTransitionAllowed(input.from, input.to)) {
    return { outcome: 'forbidden', purchaseOrder: null };
  }
  const db = tx ?? getDb();
  const terminal =
    input.to === 'fulfilled' ||
    input.to === 'rejected' ||
    input.to === 'cancelled' ||
    input.to === 'credited' ||
    input.to === 'failed';

  const patch: Partial<typeof digitalPurchaseOrders.$inferInsert> = {
    status: input.to,
    statusChangedAt: input.now,
    updatedAt: input.now,
  };
  if (input.to === 'preflighted') patch.preflightedAt = input.now;
  if (input.to === 'submitting') patch.submittedAt = input.now;
  if (input.to === 'ambiguous') patch.ambiguousSince = input.now;
  if (terminal) patch.resolvedAt = input.now;
  if (input.providerOrderId !== undefined) patch.providerOrderId = input.providerOrderId;
  if (input.providerReference !== undefined) patch.providerReference = input.providerReference;
  if (input.errorKind !== undefined) patch.errorKind = input.errorKind;
  if (input.errorMessageRedacted !== undefined) {
    patch.errorMessageRedacted = input.errorMessageRedacted;
  }
  if (input.finalCostAmount !== undefined && input.finalCostAmount !== null) {
    patch.finalCostAmount = input.finalCostAmount;
  }

  const [updated] = await db
    .update(digitalPurchaseOrders)
    .set(patch)
    .where(
      and(
        eq(digitalPurchaseOrders.id, input.purchaseOrderId),
        eq(digitalPurchaseOrders.status, input.from),
      ),
    )
    .returning();
  if (updated) return { outcome: 'updated', purchaseOrder: updated };

  const current = await findPurchaseOrder(input.purchaseOrderId, db);
  return { outcome: current ? 'stale' : 'missing', purchaseOrder: current };
}

/**
 * Set the final cost and its currency together.
 *
 * Separate from a transition because the two are independent facts: a supplier
 * can confirm a cost on the acceptance, on the fulfilment, or on neither. The
 * CHECK pairs the columns and bounds the amount by `max_accepted_cost`, so an
 * over-bound cost fails the write rather than being absorbed silently.
 */
export async function recordFinalCost(
  purchaseOrderId: string,
  amount: number,
  currency: string,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .update(digitalPurchaseOrders)
    .set({
      finalCostAmount: amount,
      finalCostCurrency: currency as DigitalPurchaseOrderRow['finalCostCurrency'],
      updatedAt: now,
    })
    .where(eq(digitalPurchaseOrders.id, purchaseOrderId))
    .returning();
  return row ?? null;
}

export interface RecordAttemptInput {
  readonly purchaseOrderId: string;
  readonly operation: DigitalSupplierApiCapability;
  readonly outcome: 'succeeded' | 'failed' | 'ambiguous';
  readonly errorKind: DigitalProcurementErrorKind | null;
  readonly errorMessageRedacted: string | null;
  readonly providerRequestId: string | null;
  readonly providerReference: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

/**
 * Append one adapter call to the attempt log.
 *
 * The number is derived inside the INSERT from the rows already there, so two
 * concurrent appends cannot pick the same one — the unique index would refuse
 * the second, and a number computed in TypeScript would be the race that
 * produces it.
 */
export async function recordAttempt(
  input: RecordAttemptInput,
  tx?: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderAttemptRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(digitalPurchaseOrderAttempts)
    .values({
      purchaseOrderId: input.purchaseOrderId,
      attemptNumber: sql`(
        select coalesce(max(a.attempt_number), 0) + 1
        from digital_purchase_order_attempts a
        where a.purchase_order_id = ${input.purchaseOrderId}
      )`,
      operation: input.operation,
      outcome: input.outcome,
      errorKind: input.errorKind,
      errorMessageRedacted: input.errorMessageRedacted,
      providerRequestId: input.providerRequestId,
      providerReference: input.providerReference,
      durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    })
    .returning();
  if (!row) throw new Error(`attempt for purchase order ${input.purchaseOrderId} was not recorded`);
  return row;
}

/** Every adapter call made for one attempt, oldest first. */
export async function findAttempts(
  purchaseOrderId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderAttemptRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(digitalPurchaseOrderAttempts)
    .where(eq(digitalPurchaseOrderAttempts.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(digitalPurchaseOrderAttempts.attemptNumber));
}
