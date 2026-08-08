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

import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
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

/** Longest stored processing note — matches the column's CHECK. */
const MAX_NOTE_LENGTH = 2_000;

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
  const receivedAt = input.receivedAt ?? new Date();
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
      receivedAt,
      // Due immediately. The row IS the job (#48), so a freshly stored event is
      // claimable the moment it commits — by the ingress, inline, or by any
      // task's poller if that one dies first.
      nextAttemptAt: receivedAt,
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
  update: {
    status: ProviderEventStatus;
    paymentId?: string;
    lastError?: string;
    /** What this version DID, when what it did was not to apply the event. */
    processingNote?: string;
  },
): Promise<void> {
  await db
    .update(paymentProviderEvents)
    .set({
      status: update.status,
      updatedAt: new Date(),
      ...(update.status === 'processed' ? { processedAt: new Date() } : {}),
      ...(update.paymentId ? { paymentId: update.paymentId } : {}),
      ...(update.lastError ? { lastError: update.lastError.slice(0, MAX_NOTE_LENGTH) } : {}),
      ...(update.processingNote
        ? { processingNote: update.processingNote.slice(0, MAX_NOTE_LENGTH) }
        : {}),
    })
    .where(eq(paymentProviderEvents.id, eventId));
}

/** One stored event by Mercaria's own id — the replay and trace read. */
export async function findProviderEventById(
  db: DatabaseOrTransaction,
  eventId: string,
): Promise<PaymentProviderEventRow | undefined> {
  const [row] = await db
    .select()
    .from(paymentProviderEvents)
    .where(eq(paymentProviderEvents.id, eventId))
    .limit(1);
  return row;
}

/** Options for claiming an inbound event to process. */
export interface ClaimProviderEventOptions {
  leaseOwner: string;
  leaseMs: number;
  /** Claim this ONE row if it is due, instead of the oldest — the inline path. */
  eventId?: string;
  now?: Date;
}

/**
 * Atomically claim one inbound event for processing.
 *
 * The same two-branch claim `claimPaymentOutboxEvent` uses, against the same
 * `for update skip locked` shape, so N tasks drain the event stream concurrently
 * without contending and a dead task's lease is reclaimed rather than stranding
 * an event nobody will ever interpret:
 *
 *  - work that has never been processed (`received`) or failed retryably
 *    (`failed`) and whose backoff has elapsed;
 *  - work stuck in `processing` whose lease has expired.
 *
 * `coalesce(next_attempt_at, received_at)` is what lets a row written before #48
 * added the column be claimed at all — a NULL there means "due since it
 * arrived", which is the honest reading of an event that was received and never
 * interpreted.
 *
 * Ordered by `received_at` so the oldest goes first: an event stream that
 * processed its newest arrivals first would starve its own head under load,
 * which for a payment stream means the oldest unfunded order waits longest.
 */
export async function claimProviderEvent(
  db: DatabaseOrTransaction,
  options: ClaimProviderEventOptions,
): Promise<PaymentProviderEventRow | undefined> {
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(1_000, options.leaseMs));

  const due = or(
    and(
      inArray(paymentProviderEvents.status, ['received', 'failed']),
      // The bound is an ISO STRING with an explicit cast, not a `Date`. A raw
      // `sql` fragment has no column to borrow a type mapper from, so a `Date`
      // interpolated here reaches postgres.js verbatim and the driver rejects
      // it ("The 'string' argument must be of type string … Received an
      // instance of Date") — a runtime failure of the claim query only, which
      // reads as "events are never processed" rather than as a type error.
      sql`coalesce(${paymentProviderEvents.nextAttemptAt}, ${paymentProviderEvents.receivedAt}) <= ${now.toISOString()}::timestamptz`,
    ),
    and(
      eq(paymentProviderEvents.status, 'processing'),
      isNotNull(paymentProviderEvents.leaseUntil),
      lte(paymentProviderEvents.leaseUntil, now),
    ),
  );

  const candidate = db
    .select({ id: paymentProviderEvents.id })
    .from(paymentProviderEvents)
    .where(options.eventId ? and(eq(paymentProviderEvents.id, options.eventId), due) : due)
    .orderBy(paymentProviderEvents.receivedAt)
    .limit(1)
    .for('update', { skipLocked: true });

  const [row] = await db
    .update(paymentProviderEvents)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil,
      attempts: sql`${paymentProviderEvents.attempts} + 1`,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(paymentProviderEvents.id, sql`(${candidate})`))
    .returning();
  return row;
}

/** What finishing an event records beside its terminal status. */
export interface CompleteProviderEventInput {
  eventId: string;
  leaseOwner: string;
  /** The payment it resolved to, when it resolved to one. */
  paymentId?: string;
  /** Why it was not APPLIED, when it was not — the seam marker. */
  processingNote?: string;
  now?: Date;
}

/**
 * Mark a claimed event `processed`, if this caller still owns the lease.
 *
 * The owner check is not what makes processing safe — every effect an event
 * handler has is idempotent by compare-and-swap, so a second task reprocessing a
 * reclaimed row changes nothing. It is what stops a task whose lease expired
 * mid-handler from marking work done that another task is still doing, which
 * would leave the SECOND task's failure with no row to record itself against.
 */
export async function completeProviderEvent(
  db: DatabaseOrTransaction,
  input: CompleteProviderEventInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(paymentProviderEvents)
    .set({
      status: 'processed',
      processedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: now,
      ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      // Written unconditionally, NULL included: a replay that succeeds cleanly
      // must clear the note its dead-lettered attempt left, or the trace keeps
      // claiming a deferral that no longer describes what happened.
      processingNote: input.processingNote?.slice(0, MAX_NOTE_LENGTH) ?? null,
    })
    .where(ownedEventLease(input.eventId, input.leaseOwner, now))
    .returning({ id: paymentProviderEvents.id });
  return updated.length === 1;
}

/** Release a failed claim with backoff, or dead-letter it. */
export async function failProviderEvent(
  db: DatabaseOrTransaction,
  input: {
    eventId: string;
    leaseOwner: string;
    error: string;
    deadLetter: boolean;
    nextAttemptAt: Date;
    paymentId?: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const status: ProviderEventStatus = input.deadLetter ? 'dead_letter' : 'failed';
  const updated = await db
    .update(paymentProviderEvents)
    .set({
      status,
      // A dead letter is not waiting for a clock, it is waiting for a person
      // (`replayProviderEvent`), so it carries no future attempt time — and
      // because the claim's `failed` branch never matches `dead_letter`, nothing
      // picks it up again on its own.
      nextAttemptAt: input.deadLetter ? null : input.nextAttemptAt,
      lastError: input.error.slice(0, MAX_NOTE_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
      ...(input.paymentId ? { paymentId: input.paymentId } : {}),
    })
    .where(ownedEventLease(input.eventId, input.leaseOwner, now))
    .returning({ id: paymentProviderEvents.id });
  return updated.length === 1;
}

/**
 * Make a dead-lettered or failed event claimable again, right now.
 *
 * The durable half of replay (#48 security and operations 9). It resets only
 * WHEN the row may be claimed — never `attempts`, and never the stored envelope
 * — so the trace still shows how many times it had already been tried and what
 * it failed with. A replay that erased that would let the same event be replayed
 * indefinitely with nothing recording that anyone had.
 *
 * @returns `false` when the event is not in a replayable state — `processing`
 *   (another task holds it) or already `processed` (there is nothing to redo).
 */
export async function reopenProviderEvent(
  db: DatabaseOrTransaction,
  eventId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(paymentProviderEvents)
    .set({ status: 'failed', nextAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(paymentProviderEvents.id, eventId),
        inArray(paymentProviderEvents.status, ['failed', 'dead_letter']),
      ),
    )
    .returning({ id: paymentProviderEvents.id });
  return updated.length === 1;
}

/** What the health surface reports about inbound event processing. */
export interface ProviderEventStats {
  /** Stored and not yet interpreted — `received`, `processing` or `failed`. */
  readonly pending: number;
  /** Retryable failures waiting on backoff. */
  readonly failed: number;
  /** Events that will not be processed without a person. */
  readonly deadLetter: number;
  /** When the oldest unprocessed event arrived; `null` when there is none. */
  readonly oldestUnprocessedAt: string | null;
  /** How far behind the stream is, in seconds. `0` when nothing is pending. */
  readonly lagSeconds: number;
}

/**
 * Count what is outstanding for one provider, in ONE query.
 *
 * One query rather than four, because these numbers are read together on every
 * health probe and four round trips against a table this size is three too many
 * — and because counts taken at four different instants can contradict each
 * other (a row moving between two of them is counted twice or not at all),
 * which reads as a bug in whatever is watching them.
 */
export async function providerEventStats(
  db: DatabaseOrTransaction,
  provider: PaymentProviderId,
  now: Date = new Date(),
): Promise<ProviderEventStats> {
  const [row] = await db
    .select({
      pending: sql<string>`count(*) filter (where ${paymentProviderEvents.status} in ('received', 'processing', 'failed'))`,
      failed: sql<string>`count(*) filter (where ${paymentProviderEvents.status} = 'failed')`,
      deadLetter: sql<string>`count(*) filter (where ${paymentProviderEvents.status} = 'dead_letter')`,
      oldest: sql<
        Date | null
      >`min(${paymentProviderEvents.receivedAt}) filter (where ${paymentProviderEvents.status} in ('received', 'processing', 'failed'))`,
    })
    .from(paymentProviderEvents)
    .where(eq(paymentProviderEvents.provider, provider));

  const oldest = row?.oldest ?? null;
  return {
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
    deadLetter: Number(row?.deadLetter ?? 0),
    oldestUnprocessedAt: oldest === null ? null : new Date(oldest).toISOString(),
    lagSeconds:
      oldest === null ? 0 : Math.max(0, Math.round((now.getTime() - new Date(oldest).getTime()) / 1_000)),
  };
}

/**
 * "This event, in `processing`, leased by me, and the lease has not expired."
 *
 * The same guard `payment_outboxes` uses, so a dispatcher whose lease was
 * reclaimed mid-flight cannot record an outcome for work another task now owns.
 */
function ownedEventLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(paymentProviderEvents.id, eventId),
    eq(paymentProviderEvents.status, 'processing'),
    eq(paymentProviderEvents.leaseOwner, leaseOwner),
    gt(paymentProviderEvents.leaseUntil, now),
  );
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

/**
 * The transfer a provider's own object id names, if Mercaria made one.
 *
 * `undefined` is an ORDINARY answer, not a failure: until #47 creates transfers,
 * every `transfer.*` event Stripe delivers is about a transfer no row exists
 * for, and the ingress records that as a deferral rather than as an error.
 */
export async function findTransferByProviderObjectId(
  db: DatabaseOrTransaction,
  provider: PaymentProviderId,
  providerObjectId: string,
): Promise<TransferRow | undefined> {
  const [row] = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.provider, provider), eq(transfers.providerObjectId, providerObjectId)))
    .limit(1);
  return row;
}

/**
 * Refresh a transfer's lifecycle state from what the provider now reports.
 *
 * Status and reversed amount only — never the amount, the payment or the order,
 * which are Mercaria's own decisions and not the provider's to restate. A
 * provider event is evidence about where a transfer GOT to, not about what it
 * was for.
 *
 * The reversed amount only ever moves FORWARD (`greatest(current, reported)`).
 * Reversals are cumulative and their events are not ordered, so a late
 * `transfer.updated` carrying an earlier total would otherwise walk the figure
 * backwards and make a fully-reversed transfer look partially reversed again.
 */
export async function updateTransferFromProvider(
  db: DatabaseOrTransaction,
  input: { transferId: string; status: TransferStatus; reversedAmount?: number },
): Promise<TransferRow | undefined> {
  const [row] = await db
    .update(transfers)
    .set({
      status: input.status,
      updatedAt: new Date(),
      ...(input.reversedAmount === undefined
        ? {}
        : { reversedAmount: sql`greatest(${transfers.reversedAmount}, ${input.reversedAmount})` }),
    })
    .where(eq(transfers.id, input.transferId))
    .returning();
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
