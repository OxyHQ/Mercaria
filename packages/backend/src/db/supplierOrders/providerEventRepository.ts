/**
 * Storing an inbound supplier event before it is understood, and claiming it as
 * the job it is.
 *
 * `db/payments/paymentOutboxRepository.ts` for the claim shape and
 * `payment_provider_events` for the receipt/processing split: **a 200 means
 * stored, never processed**. The row IS the job, so a redelivered webhook and
 * the poll that observed the same thing converge on one row rather than
 * producing an envelope and an outbox row that can disagree about whether the
 * work was done.
 *
 * ## The dedupe claim is the `RETURNING` set, not an error to catch
 *
 * `insert … on conflict do nothing … returning` gives an empty set when the
 * event was already stored, and that emptiness IS the "already received"
 * answer. Catching a unique-violation instead would swallow a dropped
 * connection and pool exhaustion as duplicates — the `moderation_events`
 * reasoning, and the reason this is the third table in the repository to use
 * it.
 */

import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  SupplierEventDelivery,
  SupplierEventStatus,
  SupplierEventVerification,
  SupplierOrderNormalizedState,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { supplierProviderEvents } from '../schema/supplierOrders.js';

/**
 * One stored event, whole. Two columns are PROTECTED — see `protectedColumns.ts`.
 *
 * Nothing OUTSIDE this module ever holds one: every function below reads and
 * returns {@link PublicSupplierProviderEvent}, so neither the provider's own
 * event id (a live handle in their key space) nor the content digest (an oracle
 * over the tracking numbers the summary is redacted to withhold) can reach a
 * caller. The type exists because the projection is derived from the row's own
 * field types.
 */
export type SupplierProviderEventRow = typeof supplierProviderEvents.$inferSelect;

/**
 * The columns any surface outside this repository may read.
 *
 * `provider_event_id` and `content_hash` are absent: the first is a live handle
 * in the supplier's key space and the second is a digest over the tracking
 * numbers and provider order id the summary is redacted to withhold.
 */
export const PUBLIC_PROVIDER_EVENT_COLUMNS = {
  id: supplierProviderEvents.id,
  supplierAccountId: supplierProviderEvents.supplierAccountId,
  provider: supplierProviderEvents.provider,
  delivery: supplierProviderEvents.delivery,
  verification: supplierProviderEvents.verification,
  eventType: supplierProviderEvents.eventType,
  providerOrderId: supplierProviderEvents.providerOrderId,
  purchaseOrderId: supplierProviderEvents.purchaseOrderId,
  normalizedState: supplierProviderEvents.normalizedState,
  providerState: supplierProviderEvents.providerState,
  stateMappingVersion: supplierProviderEvents.stateMappingVersion,
  observedAt: supplierProviderEvents.observedAt,
  receivedAt: supplierProviderEvents.receivedAt,
  payloadSummary: supplierProviderEvents.payloadSummary,
  status: supplierProviderEvents.status,
  attempts: supplierProviderEvents.attempts,
  lastError: supplierProviderEvents.lastError,
  processedAt: supplierProviderEvents.processedAt,
  processingNote: supplierProviderEvents.processingNote,
} as const;

/** An event row without the two protected handles. */
export type PublicSupplierProviderEvent = {
  [K in keyof typeof PUBLIC_PROVIDER_EVENT_COLUMNS]: SupplierProviderEventRow[K];
};

/** What one inbound observation records. */
export interface RecordSupplierProviderEventInput {
  supplierAccountId: string;
  provider: string;
  delivery: SupplierEventDelivery;
  verification: SupplierEventVerification;
  /** The provider's own event id. Required for a webhook, absent for a poll. */
  providerEventId?: string;
  /** sha-256 hex over the normalized content — the poll path's identity. */
  contentHash: string;
  eventType: string;
  providerOrderId?: string;
  purchaseOrderId?: string;
  normalizedState: SupplierOrderNormalizedState;
  providerState?: string;
  stateMappingVersion: number;
  /** The PROVIDER's clock. The ordering key everything downstream uses. */
  observedAt: Date;
  receivedAt?: Date;
  /** Already ALLOW-LIST projected by `services/supplier-orders/redact.ts`. */
  payloadSummary: Record<string, unknown>;
  expiresAt: Date;
}

/** The claim's answer: the surviving row, and whether this call stored it. */
export interface RecordSupplierProviderEventResult {
  event: PublicSupplierProviderEvent;
  stored: boolean;
}

/**
 * Store one observation, or converge on the one already stored.
 *
 * The conflict target depends on which identity the delivery has: a webhook
 * dedupes on the provider's own event id, a poll on its content. They are two
 * partial unique indexes rather than one constraint, so the arbiter has to be
 * named per path — and both `ON CONFLICT` clauses repeat their index's
 * predicate, because Postgres refuses to infer a partial index's arbiter
 * without it.
 */
export async function recordSupplierProviderEvent(
  input: RecordSupplierProviderEventInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<RecordSupplierProviderEventResult> {
  const receivedAt = input.receivedAt ?? new Date();
  const values = {
    supplierAccountId: input.supplierAccountId,
    provider: input.provider,
    delivery: input.delivery,
    verification: input.verification,
    providerEventId: input.providerEventId ?? null,
    contentHash: input.contentHash,
    eventType: input.eventType,
    providerOrderId: input.providerOrderId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? null,
    normalizedState: input.normalizedState,
    providerState: input.providerState ?? null,
    stateMappingVersion: input.stateMappingVersion,
    observedAt: input.observedAt,
    receivedAt,
    payloadSummary: input.payloadSummary,
    nextAttemptAt: receivedAt,
    expiresAt: input.expiresAt,
  };

  const inserted = input.providerEventId
    ? await db
        .insert(supplierProviderEvents)
        .values(values)
        .onConflictDoNothing({
          target: [supplierProviderEvents.supplierAccountId, supplierProviderEvents.providerEventId],
          where: sql`${supplierProviderEvents.providerEventId} is not null`,
        })
        .returning(PUBLIC_PROVIDER_EVENT_COLUMNS)
    : await db
        .insert(supplierProviderEvents)
        .values(values)
        .onConflictDoNothing({
          target: [supplierProviderEvents.supplierAccountId, supplierProviderEvents.contentHash],
          where: sql`${supplierProviderEvents.providerEventId} is null`,
        })
        .returning(PUBLIC_PROVIDER_EVENT_COLUMNS);

  const [row] = inserted;
  if (row) return { event: row, stored: true };

  const survivor = input.providerEventId
    ? await findSupplierProviderEventByProviderEventId(
        { supplierAccountId: input.supplierAccountId, providerEventId: input.providerEventId },
        db,
      )
    : await findSupplierProviderEventByContentHash(
        { supplierAccountId: input.supplierAccountId, contentHash: input.contentHash },
        db,
      );
  if (!survivor) {
    // The winner's transaction aborted after blocking ours — rare, and
    // retrying the claim is the correct answer rather than an error.
    return await recordSupplierProviderEvent(input, db);
  }
  return { event: survivor, stored: false };
}

/** The webhook dedupe read. */
export async function findSupplierProviderEventByProviderEventId(
  input: { supplierAccountId: string; providerEventId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierProviderEvent | undefined> {
  const [row] = await db
    .select(PUBLIC_PROVIDER_EVENT_COLUMNS)
    .from(supplierProviderEvents)
    .where(
      and(
        eq(supplierProviderEvents.supplierAccountId, input.supplierAccountId),
        eq(supplierProviderEvents.providerEventId, input.providerEventId),
      ),
    )
    .limit(1);
  return row;
}

/** The poll dedupe read. */
export async function findSupplierProviderEventByContentHash(
  input: { supplierAccountId: string; contentHash: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierProviderEvent | undefined> {
  const [row] = await db
    .select(PUBLIC_PROVIDER_EVENT_COLUMNS)
    .from(supplierProviderEvents)
    .where(
      and(
        eq(supplierProviderEvents.supplierAccountId, input.supplierAccountId),
        eq(supplierProviderEvents.contentHash, input.contentHash),
        isNull(supplierProviderEvents.providerEventId),
      ),
    )
    .limit(1);
  return row;
}

/** One event by id, for a trace or a handler. */
export async function findSupplierProviderEventById(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierProviderEvent | undefined> {
  const [row] = await db
    .select(PUBLIC_PROVIDER_EVENT_COLUMNS)
    .from(supplierProviderEvents)
    .where(eq(supplierProviderEvents.id, eventId))
    .limit(1);
  return row;
}

/**
 * Atomically claim one due event for processing.
 *
 * The `payment_provider_events` claim, verbatim: two branches matching the two
 * partial indexes, oldest `received_at` first so an event stream cannot starve
 * its own head.
 */
export async function claimSupplierProviderEvent(
  db: DatabaseOrTransaction,
  options: { leaseOwner: string; leaseMs: number; eventId?: string; now?: Date },
): Promise<PublicSupplierProviderEvent | undefined> {
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(1_000, options.leaseMs));

  const due = or(
    and(
      sql`${supplierProviderEvents.status} in ('received', 'failed')`,
      or(
        isNull(supplierProviderEvents.nextAttemptAt),
        lte(supplierProviderEvents.nextAttemptAt, now),
      ),
    ),
    and(
      eq(supplierProviderEvents.status, 'processing'),
      isNotNull(supplierProviderEvents.leaseUntil),
      lte(supplierProviderEvents.leaseUntil, now),
    ),
  );

  const candidate = db
    .select({ id: supplierProviderEvents.id })
    .from(supplierProviderEvents)
    .where(options.eventId ? and(eq(supplierProviderEvents.id, options.eventId), due) : due)
    .orderBy(supplierProviderEvents.receivedAt)
    .limit(1)
    .for('update', { skipLocked: true });

  const [row] = await db
    .update(supplierProviderEvents)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil,
      attempts: sql`${supplierProviderEvents.attempts} + 1`,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(supplierProviderEvents.id, sql`(${candidate})`))
    .returning(PUBLIC_PROVIDER_EVENT_COLUMNS);
  return row;
}

/** Complete only the lease this worker owns, recording what it did. */
export async function completeSupplierProviderEvent(
  db: DatabaseOrTransaction,
  input: {
    eventId: string;
    leaseOwner: string;
    purchaseOrderId?: string;
    /** What this version DID, when what it did was not to apply the event. */
    processingNote?: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(supplierProviderEvents)
    .set({
      status: 'processed',
      processedAt: now,
      ...(input.purchaseOrderId !== undefined ? { purchaseOrderId: input.purchaseOrderId } : {}),
      processingNote: input.processingNote ?? null,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: now,
    })
    .where(ownedLease(input.eventId, input.leaseOwner, now))
    .returning({ id: supplierProviderEvents.id });
  return updated.length === 1;
}

/** Release a failed claim with backoff, or dead-letter it. */
export async function failSupplierProviderEvent(
  db: DatabaseOrTransaction,
  input: {
    eventId: string;
    leaseOwner: string;
    error: string;
    deadLetter: boolean;
    nextAttemptAt: Date;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const status: SupplierEventStatus = input.deadLetter ? 'dead_letter' : 'failed';
  const updated = await db
    .update(supplierProviderEvents)
    .set({
      status,
      nextAttemptAt: input.deadLetter ? null : input.nextAttemptAt,
      lastError: input.error.slice(0, 2_000),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(ownedLease(input.eventId, input.leaseOwner, now))
    .returning({ id: supplierProviderEvents.id });
  return updated.length === 1;
}

/** Extend only a live lease still owned by this worker. */
export async function renewSupplierProviderEvent(
  db: DatabaseOrTransaction,
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(supplierProviderEvents)
    .set({ leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)), updatedAt: now })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: supplierProviderEvents.id });
  return updated.length === 1;
}

/** One purchase order's event trail, oldest observation first. */
export async function listSupplierProviderEventsForPurchaseOrder(
  purchaseOrderId: string,
  limit = 200,
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierProviderEvent[]> {
  return await db
    .select(PUBLIC_PROVIDER_EVENT_COLUMNS)
    .from(supplierProviderEvents)
    .where(eq(supplierProviderEvents.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(supplierProviderEvents.observedAt), asc(supplierProviderEvents.receivedAt))
    .limit(limit);
}

/**
 * The newest event this account has delivered, per delivery kind.
 *
 * Feeds the SLA-lag check (#124 polling and webhooks 9). Both halves matter: a
 * webhook stream that stopped and a poll loop that stopped are different
 * incidents with different remedies, and one figure over both would hide either
 * behind the other.
 */
export async function supplierProviderEventLag(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ supplierAccountId: string; delivery: string; lastReceivedAt: Date }[]> {
  return await db
    .select({
      supplierAccountId: supplierProviderEvents.supplierAccountId,
      delivery: supplierProviderEvents.delivery,
      lastReceivedAt: sql<Date>`max(${supplierProviderEvents.receivedAt})`,
    })
    .from(supplierProviderEvents)
    .groupBy(supplierProviderEvents.supplierAccountId, supplierProviderEvents.delivery);
}

/** Event counts by status — #124 observability 5. */
export async function supplierProviderEventCounts(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ delivery: string; status: string; total: number }[]> {
  return await db
    .select({
      delivery: supplierProviderEvents.delivery,
      status: supplierProviderEvents.status,
      total: sql<number>`count(*)::int`,
    })
    .from(supplierProviderEvents)
    .groupBy(supplierProviderEvents.delivery, supplierProviderEvents.status);
}

/** Dead-lettered and failing events, newest first — the operator queue. */
export async function listSupplierProviderEventFailures(
  limit = 100,
  db: DatabaseOrTransaction = getDb(),
): Promise<PublicSupplierProviderEvent[]> {
  return await db
    .select(PUBLIC_PROVIDER_EVENT_COLUMNS)
    .from(supplierProviderEvents)
    .where(sql`${supplierProviderEvents.status} in ('failed', 'dead_letter')`)
    .orderBy(desc(supplierProviderEvents.receivedAt))
    .limit(limit);
}

/** "This row, in `processing`, leased by me, and the lease has not expired." */
function ownedLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(supplierProviderEvents.id, eventId),
    eq(supplierProviderEvents.status, 'processing'),
    eq(supplierProviderEvents.leaseOwner, leaseOwner),
    gt(supplierProviderEvents.leaseUntil, now),
  );
}
