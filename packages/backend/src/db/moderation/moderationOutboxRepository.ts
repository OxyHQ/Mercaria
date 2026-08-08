/**
 * `moderation_outboxes` — the durable promise that moderation work will happen.
 *
 * The at-least-once contract is unchanged from the Mongo original: an expired
 * lease is reclaimable and a worker can die mid-delivery, so every handler MUST
 * make its downstream effect idempotent using the event id.
 *
 * ## The claim is `FOR UPDATE SKIP LOCKED`, not a `findOneAndUpdate`
 *
 * Mongo claimed with an atomic `findOneAndUpdate` over a disjunctive filter.
 * Postgres has a better primitive for exactly this shape: the `SELECT … ORDER BY
 * created_at LIMIT 1 FOR UPDATE SKIP LOCKED` lives INSIDE the `UPDATE`, so N
 * dispatchers draining the queue never hand each other the same row and never
 * block on one another either — `SKIP LOCKED` steps over a row another task is
 * already claiming instead of waiting for it. Mercaria runs several ECS tasks and
 * every one of them starts a dispatcher, so that is the normal case rather than an
 * edge one. The predicate is otherwise identical: a `pending` row that is due, or
 * a `processing` row whose lease has expired.
 *
 * `lease_until` is nullable and `NULL <= now` is NULL, so a row that has never
 * been leased is excluded from the reclaim branch by the comparison itself —
 * matching Mongo, where a missing field did not match `{$lte: now}` either.
 *
 * ## The Mongo `timestamps: false` hazard has no counterpart here, and that is the point
 *
 * The Mongo enqueue carried a long comment about writing `createdAt`/`updatedAt`
 * explicitly under `timestamps: false`, because Mongoose otherwise named
 * `updatedAt` in two operators of one update document and the server rejected the
 * WHOLE write — which, inside the intake transaction, took the `AbuseReport` with
 * it. The fix it settled on was not interchangeable with the obvious one: letting
 * Mongoose own the timestamps also cleared the server error but left a
 * `$set: { updatedAt }` on the update, turning a repeated enqueue into a real
 * write that contends with the dispatcher's live lease on that same row.
 *
 * `ON CONFLICT (id) DO NOTHING` writes nothing at all — no tuple version, no
 * timestamp, no lock — so a repeat is a genuine no-op for a STRUCTURAL reason
 * rather than by matching a spelling.
 *
 * `DO UPDATE` reintroduces precisely the bug the Mongo flag existed to fix, and
 * measurably so: mutating this call to `onConflictDoUpdate` with the SAME values
 * moved `updated_at` by the 25 ms the test waits (drizzle applies the column's
 * `$onUpdate` to a conflict branch's `set`, so "write the same data back" is not
 * even a quiet write) and moved the row's `xmin`. Both are asserted in
 * `moderation-writes.realdb.test.ts`; the `xmin` one is what would still catch a
 * `DO UPDATE` careful enough to leave every column alone.
 */

import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { RETENTION_SECONDS } from '../expiryTargets.js';
import { MODERATION_OUTBOX_KINDS, moderationOutboxes } from '../schema/moderation.js';
import { requireTransaction } from './transactionGuard.js';

/** What kind of work an event represents. */
export type ModerationOutboxKind = (typeof MODERATION_OUTBOX_KINDS)[number];

/**
 * The job payload, keyed by `kind`.
 *
 * ONE `jsonb` column rather than flat columns, and legitimately so: for
 * `decision.apply` it holds the entire verified `WebhookEventEnvelope` exactly as
 * CrowdSource delivered it, and a published decision is deliberately LOOSE —
 * projecting it into columns would silently drop whatever a newer CrowdSource
 * version added.
 *
 * Deliberately minimal for `report.submit`: an ID, not a snapshot. The row says
 * WHICH report to deliver and the worker rebuilds the material from the live
 * tables at send time; a composed envelope stored here would freeze a copy of the
 * listing in the queue and make the outbox a second, drifting source of truth.
 *
 * A flat optional shape rather than a discriminated union, matching what the
 * workers read: each already knows its own `kind` from the row it claimed, and a
 * union would force a narrowing step at every call site that adds nothing.
 */
export interface ModerationOutboxPayload {
  /** `report.submit` — the local `abuse_reports` id. */
  reportId?: string;
  /** `decision.apply` — the verified webhook event, as delivered. */
  event?: Record<string, unknown>;
}

/** One claimed event, in the shape the dispatcher and the workers consume. */
export interface ModerationOutboxEvent {
  id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

type OutboxRow = typeof moderationOutboxes.$inferSelect;

/**
 * Absent optionals come back as `undefined`, never `null`.
 *
 * A field Mongo left ABSENT is `NULL` in Postgres, and every caller here was
 * written against `undefined` — so the normalization happens once, at the edge of
 * the repository, rather than at each `if (event.leaseOwner)`.
 */
function toEvent(row: OutboxRow): ModerationOutboxEvent {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    attempts: row.attempts,
    availableAt: row.availableAt,
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseUntil === null ? {} : { leaseUntil: row.leaseUntil }),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Write the event with the CALLER's transaction.
 *
 * The transaction is required, not optional — this is the whole point of the
 * table: the domain write and this row commit together or not at all. See
 * `transactionGuard.ts` for why the TYPE alone cannot express that, and what a
 * caller passing `getDb()` would otherwise get away with. This function
 * deliberately does NOT default its `db` parameter, unlike every other repository
 * here, because the default is the mistake.
 *
 * It is also the ONLY writer of this table — the dispatcher claims existing rows
 * and never creates one — so no second queue can drift out of sync with the
 * outbox: the row IS the job.
 *
 * @returns The event id, so a caller can record what it queued.
 */
export async function enqueueModerationOutboxEvent(
  input: {
    eventId: string;
    kind: ModerationOutboxKind;
    payload: ModerationOutboxPayload;
  },
  db: DatabaseOrTransaction,
): Promise<string> {
  // The event id rides in the operation label so the refusal names WHICH enqueue
  // was misrouted. It is a programming error rather than a runtime condition, and
  // a message that only says "some enqueue" sends whoever hits it hunting.
  const tx = requireTransaction(db, `enqueueModerationOutboxEvent(${input.eventId})`);
  const now = new Date();

  await tx
    .insert(moderationOutboxes)
    .values({
      id: input.eventId,
      kind: input.kind,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      availableAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_SECONDS.moderationOutbox * 1_000),
    })
    // NEVER `onConflictDoUpdate`. See the module docblock: a repeat has to be a
    // genuine no-op, and a repeat is ordinary — a transaction retry, two
    // concurrent duplicate submissions, a reconciliation sweep re-deriving this
    // deterministic id — running while the dispatcher holds a lease on this row.
    .onConflictDoNothing({ target: moderationOutboxes.id });

  return input.eventId;
}

/**
 * Atomically claim one due event.
 *
 * An expired `processing` lease is reclaimable, so a dead task cannot strand
 * moderation work forever. `SKIP LOCKED` is what lets several dispatchers drain
 * the queue concurrently without handing each other the same row.
 */
export async function claimModerationOutboxEvent(
  options: {
    leaseOwner: string;
    eventId?: string;
    now?: Date;
    leaseMs?: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ModerationOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);

  const due = and(
    options.eventId ? eq(moderationOutboxes.id, options.eventId) : undefined,
    or(
      and(eq(moderationOutboxes.status, 'pending'), lte(moderationOutboxes.availableAt, now)),
      and(eq(moderationOutboxes.status, 'processing'), lte(moderationOutboxes.leaseUntil, now)),
    ),
  );

  const claimed = await db
    .update(moderationOutboxes)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${moderationOutboxes.attempts} + 1`,
      lastError: null,
    })
    // Both references name the SAME table, so the subquery's own range entry
    // shadows the outer one inside it — which is exactly what is wanted, and why
    // the correlated-subquery hazard in CONVENTIONS.md does not apply here.
    .where(
      sql`${moderationOutboxes.id} = (
        select ${moderationOutboxes.id} from ${moderationOutboxes}
        where ${due}
        order by ${asc(moderationOutboxes.createdAt)}
        limit 1
        for update skip locked
      )`,
    )
    .returning();

  return claimed[0] ? toEvent(claimed[0]) : null;
}

/**
 * Only the lease this dispatcher currently owns matches.
 *
 * Every terminal transition carries it, so a dispatcher whose lease expired and
 * was reclaimed by another task cannot complete, renew or fail work that is no
 * longer its own — which is what stops two tasks writing contradictory outcomes
 * for one row.
 */
function ownedLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(moderationOutboxes.id, eventId),
    eq(moderationOutboxes.status, 'processing'),
    eq(moderationOutboxes.leaseOwner, leaseOwner),
    gt(moderationOutboxes.leaseUntil, now),
  );
}

/** Complete only the lease this dispatcher currently owns. */
export async function completeModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const completed = await db
    .update(moderationOutboxes)
    .set({
      status: 'processed',
      processedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: moderationOutboxes.id });
  return completed.length === 1;
}

/** Extend only a live lease still owned by this dispatcher. */
export async function renewModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const renewed = await db
    .update(moderationOutboxes)
    .set({ leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)) })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: moderationOutboxes.id });
  return renewed.length === 1;
}

/** Bound on a stored dispatch error — `moderation_outboxes_last_error_length_check`. */
const MAX_LAST_ERROR_LENGTH = 2_000;

/**
 * Release a failed claim, with backoff — or stop.
 *
 * `deadLettered` is the CALLER's decision: only the service knows whether the
 * error was retryable and how many attempts have been spent. This writes it.
 */
export async function releaseModerationOutboxEvent(
  options: {
    eventId: string;
    leaseOwner: string;
    deadLettered: boolean;
    availableAt: Date;
    error: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const released = await db
    .update(moderationOutboxes)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.eventId, options.leaseOwner, now))
    .returning({ id: moderationOutboxes.id });
  return released.length === 1;
}

/** One event by id, whatever its state. */
export async function findModerationOutboxEvent(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ModerationOutboxEvent | undefined> {
  const [row] = await db
    .select()
    .from(moderationOutboxes)
    .where(eq(moderationOutboxes.id, eventId))
    .limit(1);
  return row ? toEvent(row) : undefined;
}
