/**
 * Claiming, completing and failing `procurement_outboxes` rows.
 *
 * `db/payments/paymentOutboxRepository.ts` transplanted, deliberately down to
 * the column names and the two claim branches, so a reader who understands one
 * understands the other and the two claim queries stay the same query.
 *
 * What differs is what a lost row costs. A payment outbox row that vanishes
 * loses an order transition that reconciliation can rebuild from the rail. A
 * procurement row that vanishes loses a SUPPLIER ORDER that a customer has
 * already been charged for, and nothing anywhere reports an error: the payment
 * succeeded, the provider was never called, and the order sits `paid` forever.
 * That is why the record is written whatever the configuration says and only
 * the LOOP is gated.
 */

import { and, desc, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { ProcurementOutboxEventType, ProcurementOutboxStatus } from '@mercaria/shared-types';
import { procurementOutboxes } from '../schema/supplierOrders.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One outbox row as the dispatcher reads it. */
export type ProcurementOutboxRow = typeof procurementOutboxes.$inferSelect;

/** Longest error message kept — matches the column's CHECK. */
const MAX_LAST_ERROR_LENGTH = 2_000;

/** What a caller enqueues. The id is supplied, never generated. */
export interface EnqueueProcurementOutboxInput {
  /** DETERMINISTIC — see `services/supplier-orders/procurement-outbox.service.ts`. */
  id: string;
  eventType: ProcurementOutboxEventType;
  payload: Record<string, unknown>;
  expiresAt: Date;
  availableAt?: Date;
}

/**
 * Write the row with the CALLER's handle.
 *
 * `on conflict (id) do nothing`, never `do update`: a repeat must be a genuine
 * no-op rather than a write that bumps `updated_at` and contends with a live
 * lease. That is the property that makes an operator's "submit again" converge
 * on the submission already in flight instead of queueing a second supplier
 * order — #124 idempotency item 6, held by the primary key.
 *
 * @returns `true` when this call created the row, `false` when it already
 *   existed — the ordinary outcome of a retry, not a failure.
 */
export async function enqueueProcurementOutboxEvent(
  db: DatabaseOrTransaction,
  input: EnqueueProcurementOutboxInput,
): Promise<boolean> {
  const inserted = await db
    .insert(procurementOutboxes)
    .values({
      id: input.id,
      eventType: input.eventType,
      payload: input.payload,
      availableAt: input.availableAt ?? new Date(),
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: procurementOutboxes.id })
    .returning({ id: procurementOutboxes.id });
  return inserted.length === 1;
}

/** Options for a claim. */
export interface ClaimProcurementOutboxOptions {
  leaseOwner: string;
  leaseMs: number;
  /** Claim this ONE row if it is due, instead of the oldest — the inline drain. */
  eventId?: string;
  /** Claim only these types — how the fetch and submission levers are separated. */
  eventTypes?: readonly ProcurementOutboxEventType[];
  now?: Date;
}

/**
 * Atomically claim one due row.
 *
 * Two branches, matching the two partial indexes: PENDING work that is due, and
 * PROCESSING work whose lease has expired because the task holding it died.
 * `for update skip locked` inside the subquery is what lets several tasks drain
 * at once without any of them waiting.
 *
 * The optional `eventTypes` filter is how the three independent levers of this
 * domain are expressed WITHOUT gating the record: a deployment with provider
 * fetch paused claims everything except the poll type, and the poll rows stay
 * pending until it is resumed.
 */
export async function claimProcurementOutboxEvent(
  db: DatabaseOrTransaction,
  options: ClaimProcurementOutboxOptions,
): Promise<ProcurementOutboxRow | undefined> {
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(1_000, options.leaseMs));

  const due = or(
    and(eq(procurementOutboxes.status, 'pending'), lte(procurementOutboxes.availableAt, now)),
    and(
      eq(procurementOutboxes.status, 'processing'),
      isNotNull(procurementOutboxes.leaseUntil),
      lte(procurementOutboxes.leaseUntil, now),
    ),
  );
  const filters = [
    due,
    ...(options.eventId ? [eq(procurementOutboxes.id, options.eventId)] : []),
    ...(options.eventTypes && options.eventTypes.length > 0
      ? [inArray(procurementOutboxes.eventType, [...options.eventTypes])]
      : []),
  ];

  const candidate = db
    .select({ id: procurementOutboxes.id })
    .from(procurementOutboxes)
    .where(and(...filters))
    .orderBy(procurementOutboxes.createdAt)
    .limit(1)
    .for('update', { skipLocked: true });

  const [row] = await db
    .update(procurementOutboxes)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil,
      attempts: sql`${procurementOutboxes.attempts} + 1`,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(procurementOutboxes.id, sql`(${candidate})`))
    .returning();
  return row;
}

/** Complete only the lease this dispatcher currently owns. */
export async function completeProcurementOutboxEvent(
  db: DatabaseOrTransaction,
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(procurementOutboxes)
    .set({
      status: 'processed',
      processedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: now,
    })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: procurementOutboxes.id });
  return updated.length === 1;
}

/** Extend only a live lease still owned by this dispatcher. */
export async function renewProcurementOutboxEvent(
  db: DatabaseOrTransaction,
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(procurementOutboxes)
    .set({ leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)), updatedAt: now })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: procurementOutboxes.id });
  return updated.length === 1;
}

/** Release a failed claim with backoff, or dead-letter it. */
export async function failProcurementOutboxEvent(
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
  const status: ProcurementOutboxStatus = input.deadLetter ? 'dead_letter' : 'pending';
  const updated = await db
    .update(procurementOutboxes)
    .set({
      status,
      availableAt: input.deadLetter ? now : input.availableAt,
      lastError: input.error.slice(0, MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(ownedLease(input.eventId, input.leaseOwner, now))
    .returning({ id: procurementOutboxes.id });
  return updated.length === 1;
}

/**
 * Reschedule a claimed row for later WITHOUT counting it as a failure.
 *
 * The polling loop's release: a purchase order that is not yet terminal is
 * polled again after the provider's minimum interval, and doing that through
 * `failProcurementOutboxEvent` would grow `attempts` on every pass and
 * dead-letter a perfectly healthy order after twenty-five polls. A reschedule
 * resets the counter, because a poll that answered is a success.
 */
export async function rescheduleProcurementOutboxEvent(
  db: DatabaseOrTransaction,
  input: { eventId: string; leaseOwner: string; availableAt: Date; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(procurementOutboxes)
    .set({
      status: 'pending',
      availableAt: input.availableAt,
      attempts: 0,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(ownedLease(input.eventId, input.leaseOwner, now))
    .returning({ id: procurementOutboxes.id });
  return updated.length === 1;
}

/** One outbox row, for a trace or a test. */
export async function findProcurementOutboxEvent(
  db: DatabaseOrTransaction,
  eventId: string,
): Promise<ProcurementOutboxRow | undefined> {
  const [row] = await db
    .select()
    .from(procurementOutboxes)
    .where(eq(procurementOutboxes.id, eventId))
    .limit(1);
  return row;
}

/** The dead-letter queue and its neighbours — #124 observability 6 and 9. */
export async function listProcurementOutboxRows(
  db: DatabaseOrTransaction,
  input: {
    eventTypes?: readonly ProcurementOutboxEventType[];
    statuses?: readonly ProcurementOutboxStatus[];
    limit: number;
  },
): Promise<ProcurementOutboxRow[]> {
  return await db
    .select()
    .from(procurementOutboxes)
    .where(
      and(
        ...(input.eventTypes && input.eventTypes.length > 0
          ? [inArray(procurementOutboxes.eventType, [...input.eventTypes])]
          : []),
        ...(input.statuses && input.statuses.length > 0
          ? [inArray(procurementOutboxes.status, [...input.statuses])]
          : []),
      ),
    )
    .orderBy(desc(procurementOutboxes.createdAt))
    .limit(input.limit);
}

/** Outbox counts by event type and status — #124 observability 6. */
export async function procurementOutboxCounts(
  db: DatabaseOrTransaction,
): Promise<{ eventType: string; status: string; total: number }[]> {
  return await db
    .select({
      eventType: procurementOutboxes.eventType,
      status: procurementOutboxes.status,
      total: sql<number>`count(*)::int`,
    })
    .from(procurementOutboxes)
    .groupBy(procurementOutboxes.eventType, procurementOutboxes.status);
}

/**
 * "This row, in `processing`, leased by me, and the lease has not expired."
 *
 * Every terminal transition is guarded by it, so a dispatcher whose lease was
 * reclaimed mid-flight cannot complete work another task has already picked up.
 */
function ownedLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(procurementOutboxes.id, eventId),
    eq(procurementOutboxes.status, 'processing'),
    eq(procurementOutboxes.leaseOwner, leaseOwner),
    gt(procurementOutboxes.leaseUntil, now),
  );
}
