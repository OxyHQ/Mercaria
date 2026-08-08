/**
 * Reads and writes for `payments`, `payment_attempts`,
 * `payment_provider_events`, `transfers` and `payouts`.
 *
 * Every function here takes a `DatabaseOrTransaction`, because almost none of
 * them is ever the whole of what has to happen: a status transition commits with
 * its ledger postings and its outbox row, or none of them commits. A helper
 * typed only as `Database` would silently run outside its caller's transaction,
 * which is how a payment succeeds with no accounting.
 *
 * The status TRANSITION rules are not here — they belong to
 * `services/payments/payment.service.ts`, which owns the state machine. This
 * module only offers the compare-and-swap primitive the service needs to apply
 * one safely.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type {
  CurrencyCode,
  FxRateSnapshot,
  Money,
  PaymentAttemptStatus,
  PaymentProviderId,
  PaymentStatus,
  PayoutStatus,
  ProviderEventStatus,
  TransferStatus,
} from '@mercaria/shared-types';
import {
  paymentAttempts,
  paymentProviderEvents,
  payments,
  payouts,
  transfers,
} from '../schema/payments.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A payment row as the service reads it back. */
export type PaymentRow = typeof payments.$inferSelect;
/** An attempt row. */
export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;
/** A stored provider event. */
export type PaymentProviderEventRow = typeof paymentProviderEvents.$inferSelect;
/** A transfer row. */
export type TransferRow = typeof transfers.$inferSelect;
/** A payout row. */
export type PayoutRow = typeof payouts.$inferSelect;

/** What a caller supplies to open a payment. */
export interface CreatePaymentInput {
  provider: PaymentProviderId;
  checkoutGroupId: string;
  presentment: Money;
  buyerOxyUserId?: string;
  /** Set for `external` payments only — the ONE order they stand for. */
  orderId?: string;
  status?: PaymentStatus;
  providerObjectId?: string;
}

/**
 * Open a payment, or return the one that already exists for this checkout group.
 *
 * Idempotent by INDEX, not by a read-then-write: `on conflict do nothing`
 * against the partial unique index, then a read. A check-then-insert has a
 * window between the two, and that window is exactly where a double-tapped
 * checkout button lands.
 *
 * The conflict target differs by provider, because the uniqueness does:
 * `external` payments are unique per ORDER (two connected shops can import
 * orders carrying the same external id, so their synthetic group ids collide),
 * every other provider is unique per checkout GROUP.
 */
export async function createOrGetPayment(
  db: DatabaseOrTransaction,
  input: CreatePaymentInput,
): Promise<PaymentRow> {
  const isExternal = input.provider === 'external';
  const values = {
    id: uuidv7(),
    checkoutGroupId: input.checkoutGroupId,
    provider: input.provider,
    presentmentAmount: input.presentment.amount,
    presentmentCurrency: input.presentment.currency,
    status: input.status ?? ('created' as const),
    ...(input.buyerOxyUserId ? { buyerOxyUserId: input.buyerOxyUserId } : {}),
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
  };

  await db
    .insert(payments)
    .values(values)
    // `where` is the INDEX PREDICATE, not a row filter: it is what names WHICH
    // partial unique index this conflict targets. Both indexes lead with a
    // different column, so the two branches are not interchangeable — see the
    // docblock for why external payments are unique per order and native ones
    // per checkout group.
    .onConflictDoNothing(
      isExternal
        ? { target: payments.orderId, where: eq(payments.provider, 'external') }
        : {
            target: payments.checkoutGroupId,
            where: sql`${payments.provider} <> 'external'`,
          },
    );

  const existing = isExternal
    ? await findExternalPaymentByOrderId(db, input.orderId ?? '')
    : await findNativePaymentByCheckoutGroupId(db, input.checkoutGroupId);
  if (!existing) {
    // Unreachable in practice: the insert either wrote the row or lost to one
    // that is still there. Reaching here means the row vanished between the two
    // statements, which is not a condition to paper over with a retry.
    throw new Error(
      `Payment for checkout group ${input.checkoutGroupId} could not be read back after insert.`,
    );
  }
  return existing;
}

/** The native payment funding a checkout group, if one has been opened. */
export async function findNativePaymentByCheckoutGroupId(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
): Promise<PaymentRow | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(
      and(eq(payments.checkoutGroupId, checkoutGroupId), sql`${payments.provider} <> 'external'`),
    )
    .limit(1);
  return row;
}

/** The `external` payment recorded for one imported order, if any. */
export async function findExternalPaymentByOrderId(
  db: DatabaseOrTransaction,
  orderId: string,
): Promise<PaymentRow | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.provider, 'external'), eq(payments.orderId, orderId)))
    .limit(1);
  return row;
}

/** One payment by its Mercaria id. */
export async function findPaymentById(
  db: DatabaseOrTransaction,
  paymentId: string,
): Promise<PaymentRow | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  return row;
}

/** One payment by the provider's own object id — the reconciliation read. */
export async function findPaymentByProviderObjectId(
  db: DatabaseOrTransaction,
  provider: PaymentProviderId,
  providerObjectId: string,
): Promise<PaymentRow | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(
      and(eq(payments.provider, provider), eq(payments.providerObjectId, providerObjectId)),
    )
    .limit(1);
  return row;
}

/** What a status transition may write beside the status itself. */
export interface PaymentTransitionFields {
  providerObjectId?: string;
  platform?: { amount: Money; rate: FxRateSnapshot };
}

/**
 * Move a payment to `next`, but only from one of `allowedFrom`.
 *
 * A COMPARE-AND-SWAP, and it is the single mechanism that makes a duplicate
 * provider event harmless. The caller runs it inside a transaction and books the
 * ledger only when it returns a row: a redelivered `succeeded` matches nothing
 * (the payment is already `succeeded`, which is not in `allowedFrom`), so the
 * whole side-effecting branch is skipped rather than each of its steps having to
 * be individually idempotent.
 *
 * @returns The updated row, or `undefined` when the payment was not in an
 *   allowed source status — which is a duplicate or an out-of-order event, not
 *   an error.
 */
export async function transitionPaymentStatus(
  db: DatabaseOrTransaction,
  paymentId: string,
  allowedFrom: readonly PaymentStatus[],
  next: PaymentStatus,
  fields: PaymentTransitionFields = {},
): Promise<PaymentRow | undefined> {
  if (allowedFrom.length === 0) return undefined;
  const [row] = await db
    .update(payments)
    .set({
      status: next,
      updatedAt: new Date(),
      ...(fields.providerObjectId ? { providerObjectId: fields.providerObjectId } : {}),
      ...(fields.platform
        ? {
            platformAmount: fields.platform.amount.amount,
            platformCurrency: fields.platform.amount.currency,
            platformRateFrom: fields.platform.rate.from,
            platformRateTo: fields.platform.rate.to,
            platformRateRate: fields.platform.rate.rate,
            platformRateProvider: fields.platform.rate.provider,
            platformRateAsOf: fields.platform.rate.asOf,
          }
        : {}),
    })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, [...allowedFrom])))
    .returning();
  return row;
}

/** What one recorded provider call looked like. */
export interface RecordAttemptInput {
  paymentId: string;
  provider: PaymentProviderId;
  status: PaymentAttemptStatus;
  providerObjectId?: string;
  errorCode?: string;
  /** Already redacted by the caller — see `services/payments/redact.ts`. */
  errorMessage?: string;
  idempotencyKey?: string;
}

/**
 * Append an attempt, numbering it after the last one.
 *
 * The sequence is derived inside the same statement as the insert, so two
 * concurrent attempts cannot read the same maximum and then both write it — the
 * `UNIQUE(payment_id, sequence)` index turns the loser into a constraint error
 * rather than a silently duplicated number.
 */
export async function recordPaymentAttempt(
  db: DatabaseOrTransaction,
  input: RecordAttemptInput,
): Promise<PaymentAttemptRow> {
  const [row] = await db
    .insert(paymentAttempts)
    .values({
      id: uuidv7(),
      paymentId: input.paymentId,
      sequence: sql`(select coalesce(max(${paymentAttempts.sequence}), 0) + 1 from ${paymentAttempts} where ${paymentAttempts.paymentId} = ${input.paymentId})`,
      provider: input.provider,
      status: input.status,
      ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    })
    .returning();
  if (!row) {
    throw new Error(`Attempt for payment ${input.paymentId} was not written.`);
  }
  return row;
}

/** Every attempt on a payment, oldest first. */
export async function listPaymentAttempts(
  db: DatabaseOrTransaction,
  paymentId: string,
): Promise<PaymentAttemptRow[]> {
  return await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.paymentId, paymentId))
    .orderBy(paymentAttempts.sequence);
}

/** A verified inbound event, ready to be stored. */
export interface RecordProviderEventInput {
  provider: PaymentProviderId;
  providerEventId: string;
  providerAccountId?: string;
  type: string;
  livemode: boolean;
  apiVersion?: string;
  objectIds: Record<string, string>;
  /** Already redacted by the caller — never the wholesale payload. */
  payloadSummary: Record<string, unknown>;
  expiresAt: Date;
  receivedAt?: Date;
}

/** The outcome of storing an inbound event. */
export interface RecordedProviderEvent {
  row: PaymentProviderEventRow;
  /** `true` when this exact event was already stored — a redelivery. */
  duplicate: boolean;
}

/**
 * Store a verified event exactly once.
 *
 * The INSERT is the dedupe claim (#45 invariant 3). `on conflict do nothing`
 * followed by a read, rather than a read followed by an insert: a provider
 * retrying into two tasks behind the same load balancer is the ordinary case,
 * and a read-then-write leaves both of them believing they are first.
 */
export async function recordProviderEvent(
  db: DatabaseOrTransaction,
  input: RecordProviderEventInput,
): Promise<RecordedProviderEvent> {
  const inserted = await db
    .insert(paymentProviderEvents)
    .values({
      id: uuidv7(),
      provider: input.provider,
      providerEventId: input.providerEventId,
      type: input.type,
      livemode: input.livemode,
      objectIds: input.objectIds,
      payloadSummary: input.payloadSummary,
      receivedAt: input.receivedAt ?? new Date(),
      expiresAt: input.expiresAt,
      ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
      ...(input.apiVersion ? { apiVersion: input.apiVersion } : {}),
    })
    .onConflictDoNothing()
    .returning();

  const [row] = inserted;
  if (row) return { row, duplicate: false };

  const existing = await findProviderEvent(db, input.provider, input.providerEventId, input.providerAccountId);
  if (!existing) {
    throw new Error(
      `Provider event ${input.provider}/${input.providerEventId} could not be read back after ` +
        'a conflicting insert.',
    );
  }
  return { row: existing, duplicate: true };
}

/** One stored event by its provider coordinates. */
export async function findProviderEvent(
  db: DatabaseOrTransaction,
  provider: PaymentProviderId,
  providerEventId: string,
  providerAccountId?: string,
): Promise<PaymentProviderEventRow | undefined> {
  const [row] = await db
    .select()
    .from(paymentProviderEvents)
    .where(
      and(
        eq(paymentProviderEvents.provider, provider),
        eq(paymentProviderEvents.providerEventId, providerEventId),
        providerAccountId === undefined
          ? isNull(paymentProviderEvents.providerAccountId)
          : eq(paymentProviderEvents.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);
  return row;
}

/** Record how far an event got, and what it resolved to. */
export async function markProviderEvent(
  db: DatabaseOrTransaction,
  eventId: string,
  update: { status: ProviderEventStatus; paymentId?: string; lastError?: string },
): Promise<void> {
  await db
    .update(paymentProviderEvents)
    .set({
      status: update.status,
      updatedAt: new Date(),
      ...(update.status === 'processed' ? { processedAt: new Date() } : {}),
      ...(update.paymentId ? { paymentId: update.paymentId } : {}),
      ...(update.lastError ? { lastError: update.lastError.slice(0, 2_000) } : {}),
    })
    .where(eq(paymentProviderEvents.id, eventId));
}

/** Every stored event that resolved to one payment, newest first. */
export async function listProviderEventsForPayment(
  db: DatabaseOrTransaction,
  paymentId: string,
): Promise<PaymentProviderEventRow[]> {
  return await db
    .select()
    .from(paymentProviderEvents)
    .where(eq(paymentProviderEvents.paymentId, paymentId))
    .orderBy(desc(paymentProviderEvents.receivedAt));
}

/** One seller order's settlement out of a payment (ADR 0001 D3). */
export interface UpsertTransferInput {
  paymentId: string;
  orderId: string;
  provider: PaymentProviderId;
  amount: Money;
  status?: TransferStatus;
  providerObjectId?: string;
}

/**
 * Create the transfer for a (payment, order), or return the existing one.
 *
 * The same insert-then-read shape as `createOrGetPayment`, against
 * `UNIQUE(payment_id, order_id)`. A retry of the transfer step must never make
 * a second one: two transfers for one order is money leaving twice.
 */
export async function createOrGetTransfer(
  db: DatabaseOrTransaction,
  input: UpsertTransferInput,
): Promise<TransferRow> {
  await db
    .insert(transfers)
    .values({
      id: uuidv7(),
      paymentId: input.paymentId,
      orderId: input.orderId,
      provider: input.provider,
      amountAmount: input.amount.amount,
      amountCurrency: input.amount.currency,
      status: input.status ?? ('pending' as const),
      ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
    })
    .onConflictDoNothing({ target: [transfers.paymentId, transfers.orderId] });

  const [row] = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.paymentId, input.paymentId), eq(transfers.orderId, input.orderId)))
    .limit(1);
  if (!row) {
    throw new Error(
      `Transfer for payment ${input.paymentId} order ${input.orderId} could not be read back.`,
    );
  }
  return row;
}

/** Every transfer belonging to a payment. */
export async function listTransfersForPayment(
  db: DatabaseOrTransaction,
  paymentId: string,
): Promise<TransferRow[]> {
  return await db
    .select()
    .from(transfers)
    .where(eq(transfers.paymentId, paymentId))
    .orderBy(transfers.createdAt);
}

/** A payout the provider reported. */
export interface UpsertPayoutInput {
  provider: PaymentProviderId;
  providerAccountRef: string;
  providerObjectId: string;
  amount: Money;
  status: PayoutStatus;
  arrivalAt?: Date;
  failureCode?: string;
}

/**
 * Record or refresh a payout.
 *
 * The one payment-domain table that legitimately UPDATES on conflict: a payout
 * moves `pending → in_transit → paid | failed` and each step arrives as its own
 * event about the SAME provider object. Nothing here is a ledger fact — the
 * receivable was settled at transfer time (ADR 0001 D6) — so refreshing it
 * destroys no accounting.
 */
export async function upsertPayout(
  db: DatabaseOrTransaction,
  input: UpsertPayoutInput,
): Promise<PayoutRow> {
  const [row] = await db
    .insert(payouts)
    .values({
      id: uuidv7(),
      provider: input.provider,
      providerAccountRef: input.providerAccountRef,
      providerObjectId: input.providerObjectId,
      amountAmount: input.amount.amount,
      amountCurrency: input.amount.currency,
      status: input.status,
      ...(input.arrivalAt ? { arrivalAt: input.arrivalAt } : {}),
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    })
    .onConflictDoUpdate({
      target: [payouts.provider, payouts.providerObjectId],
      set: {
        status: input.status,
        updatedAt: new Date(),
        ...(input.arrivalAt ? { arrivalAt: input.arrivalAt } : {}),
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      },
    })
    .returning();
  if (!row) {
    throw new Error(`Payout ${input.provider}/${input.providerObjectId} was not written.`);
  }
  return row;
}

/** Every payout for one provider account, newest first. */
export async function listPayoutsForAccount(
  db: DatabaseOrTransaction,
  provider: PaymentProviderId,
  providerAccountRef: string,
): Promise<PayoutRow[]> {
  return await db
    .select()
    .from(payouts)
    .where(and(eq(payouts.provider, provider), eq(payouts.providerAccountRef, providerAccountRef)))
    .orderBy(desc(payouts.createdAt));
}

/** A `Money` rebuilt from the two columns that store one. */
export function toMoney(amount: number, currency: string): Money {
  return { amount, currency: currency as CurrencyCode };
}
