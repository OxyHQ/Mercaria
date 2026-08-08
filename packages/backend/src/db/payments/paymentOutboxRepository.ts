/**
 * Claiming, completing and failing `payment_outboxes` rows.
 *
 * The Postgres port of the moderation outbox's semantics, and deliberately the
 * same semantics rather than a similar-looking set: deterministic ids so a
 * repeat converges, the row IS the job, a claim is a lease with an owner check,
 * exponential backoff capped, and a failure that cannot succeed becomes a
 * visible `dead_letter` rather than an ever-growing attempt count.
 *
 * ## What Postgres does better than Mongo did here
 *
 * The claim is `SELECT … FOR UPDATE SKIP LOCKED` inside the update, so N tasks
 * draining concurrently never contend: each takes rows the others have not
 * locked, instead of racing on a `findOneAndUpdate` and losing. The Mongo
 * version's correctness came from the atomicity of a single-document update;
 * this one's comes from row locks, and it scales with tasks rather than against
 * them.
 *
 * `on conflict (id) do nothing` gives natively what the Mongo enqueue needed
 * `timestamps: false` to achieve: a repeat is a genuine no-op, not a write that
 * bumps `updated_at` and contends with a live lease. `do update` would
 * reintroduce exactly that bug.
 */

import { and, desc, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { PaymentOutboxEventType, PaymentOutboxStatus } from '@mercaria/shared-types';
import { paymentOutboxes } from '../schema/payments.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** An outbox row as the dispatcher reads it. */
export type PaymentOutboxRow = typeof paymentOutboxes.$inferSelect;

/** Longest error message kept — matches the column's CHECK. */
const MAX_LAST_ERROR_LENGTH = 2_000;

/** What a caller enqueues. The id is supplied, never generated. */
export interface EnqueuePaymentOutboxInput {
  /** DETERMINISTIC — see `services/payments/payment-outbox.service.ts`. */
  id: string;
  eventType: PaymentOutboxEventType;
  payload: Record<string, unknown>;
  expiresAt: Date;
  availableAt?: Date;
}

/**
 * Write the row with the CALLER's handle.
 *
 * `db` is a `DatabaseOrTransaction` and every real caller passes a TRANSACTION,
 * because that is the entire point of the table: the domain write and this row
 * commit together, or a payment succeeds and nothing downstream ever hears about
 * it. The moderation equivalent enforces that at runtime because a Mongo
 * `ClientSession` can be handed over without a transaction open on it; drizzle
 * has no such shape — a `Transaction` handle only exists inside `db.transaction`
 * — so the type is the whole guard here and there is nothing left to assert.
 *
 * @returns `true` when this call created the row, `false` when it already
 *   existed — which is the ordinary outcome of a retry and not a failure.
 */
export async function enqueuePaymentOutboxEvent(
  db: DatabaseOrTransaction,
  input: EnqueuePaymentOutboxInput,
): Promise<boolean> {
  const inserted = await db
    .insert(paymentOutboxes)
    .values({
      id: input.id,
      eventType: input.eventType,
      payload: input.payload,
      availableAt: input.availableAt ?? new Date(),
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: paymentOutboxes.id })
    .returning({ id: paymentOutboxes.id });
  return inserted.length === 1;
}

/** Options for a claim. */
export interface ClaimPaymentOutboxOptions {
  leaseOwner: string;
  leaseMs: number;
  /** Claim this ONE row if it is due, instead of the oldest — the inline drain. */
  eventId?: string;
  now?: Date;
}

/**
 * Atomically claim one due row.
 *
 * Two branches, matching the two partial indexes: work that is PENDING and due,
 * and work that is PROCESSING whose lease has expired — a dead task's, being
 * reclaimed. `for update skip locked` inside the subquery is what lets several
 * tasks drain at once without any of them waiting.
 */
export async function claimPaymentOutboxEvent(
  db: DatabaseOrTransaction,
  options: ClaimPaymentOutboxOptions,
): Promise<PaymentOutboxRow | undefined> {
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(1_000, options.leaseMs));

  const due = or(
    and(eq(paymentOutboxes.status, 'pending'), lte(paymentOutboxes.availableAt, now)),
    and(
      eq(paymentOutboxes.status, 'processing'),
      isNotNull(paymentOutboxes.leaseUntil),
      lte(paymentOutboxes.leaseUntil, now),
    ),
  );

  const candidate = db
    .select({ id: paymentOutboxes.id })
    .from(paymentOutboxes)
    .where(options.eventId ? and(eq(paymentOutboxes.id, options.eventId), due) : due)
    .orderBy(paymentOutboxes.createdAt)
    .limit(1)
    .for('update', { skipLocked: true });

  const [row] = await db
    .update(paymentOutboxes)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil,
      attempts: sql`${paymentOutboxes.attempts} + 1`,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(paymentOutboxes.id, sql`(${candidate})`))
    .returning();
  return row;
}

/** Complete only the lease this dispatcher currently owns. */
export async function completePaymentOutboxEvent(
  db: DatabaseOrTransaction,
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(paymentOutboxes)
    .set({
      status: 'processed',
      processedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: now,
    })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: paymentOutboxes.id });
  return updated.length === 1;
}

/** Extend only a live lease still owned by this dispatcher. */
export async function renewPaymentOutboxEvent(
  db: DatabaseOrTransaction,
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(paymentOutboxes)
    .set({ leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)), updatedAt: now })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: paymentOutboxes.id });
  return updated.length === 1;
}

/** Release a failed claim with backoff, or dead-letter it. */
export async function failPaymentOutboxEvent(
  db: DatabaseOrTransaction,
  input: {
    eventId: string;
    leaseOwner: string;
    error: string;
    deadLetter: boolean;
    availableAt: Date;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const status: PaymentOutboxStatus = input.deadLetter ? 'dead_letter' : 'pending';
  const updated = await db
    .update(paymentOutboxes)
    .set({
      status,
      availableAt: input.deadLetter ? now : input.availableAt,
      lastError: input.error.slice(0, MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(ownedLease(input.eventId, input.leaseOwner, now))
    .returning({ id: paymentOutboxes.id });
  return updated.length === 1;
}

/** One outbox row, for a trace or a test. */
export async function findPaymentOutboxEvent(
  db: DatabaseOrTransaction,
  eventId: string,
): Promise<PaymentOutboxRow | undefined> {
  const [row] = await db
    .select()
    .from(paymentOutboxes)
    .where(eq(paymentOutboxes.id, eventId))
    .limit(1);
  return row;
}

/**
 * The exception queues, filtered — issue #50's operator surface 2.
 *
 * The four #47/#49 exception types plus anything dead-lettered are the whole of
 * what an operator queue means in this domain, and they are ALREADY rows in this
 * table: `transfer_withheld`, `refund_failed`, `reversal_failed`,
 * `refund_unmatched` and `payment_succeeded_after_release` are durable records
 * of conditions only a person can close.
 *
 * So #50 reads them here rather than copying them into `payment_discrepancies`.
 * Copying would have been the obvious move and is the wrong one: it would make
 * one condition two rows that can disagree about whether it is resolved, and the
 * outbox row is the one the dispatcher already reasons about.
 */
export async function listPaymentOutboxExceptions(
  db: DatabaseOrTransaction,
  input: {
    eventTypes: readonly PaymentOutboxEventType[];
    statuses?: readonly PaymentOutboxStatus[];
    limit: number;
  },
): Promise<PaymentOutboxRow[]> {
  if (input.eventTypes.length === 0) return [];
  return await db
    .select()
    .from(paymentOutboxes)
    .where(
      and(
        inArray(paymentOutboxes.eventType, [...input.eventTypes]),
        ...(input.statuses && input.statuses.length > 0
          ? [inArray(paymentOutboxes.status, [...input.statuses])]
          : []),
      ),
    )
    .orderBy(desc(paymentOutboxes.createdAt))
    .limit(input.limit);
}

/** Outbox counts by event type and status — issue #50's metrics 3 and 4. */
export async function paymentOutboxCounts(
  db: DatabaseOrTransaction,
): Promise<{ eventType: string; status: string; total: number }[]> {
  return await db
    .select({
      eventType: paymentOutboxes.eventType,
      status: paymentOutboxes.status,
      total: sql<number>`count(*)::int`,
    })
    .from(paymentOutboxes)
    .groupBy(paymentOutboxes.eventType, paymentOutboxes.status);
}

/**
 * "This row, in `processing`, leased by me, and the lease has not expired."
 *
 * Every terminal transition is guarded by it, so a dispatcher whose lease was
 * reclaimed mid-flight cannot complete work another task has already picked up —
 * the update matches nothing and the caller learns it lost the lease.
 */
function ownedLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(paymentOutboxes.id, eventId),
    eq(paymentOutboxes.status, 'processing'),
    eq(paymentOutboxes.leaseOwner, leaseOwner),
    gt(paymentOutboxes.leaseUntil, now),
  );
}
