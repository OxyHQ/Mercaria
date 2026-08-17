/**
 * `match_queue` — the leased, bounded, resumable convergence queue.
 *
 * The `offer_outboxes` repository, ported, and it inherits both of that port's
 * inversions of the moderation outbox because it is the same KIND of queue:
 * one row per SUBJECT, delivering a FIXED POINT rather than an event.
 *
 * - The enqueue is `ON CONFLICT DO UPDATE`, not `DO NOTHING`. Five writes to a
 *   listing in a second owe ONE evaluation, and a `DO NOTHING` would drop the
 *   four that arrived while one was pending — including the one that mattered.
 * - It must NOT write a flat `'pending'` over a `processing` row. That releases
 *   a live lease from outside the worker, and the completion that follows then
 *   fails its owner check and discards its own outcome. Measured in the offer
 *   domain; the realdb case here fails on the flat form too.
 * - `requested_revision` increments off the EXISTING row, never `excluded` —
 *   CONVENTIONS.md's third concurrency shape.
 */

import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import type { MatchQueueTrigger, MatchSubjectKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { MATCH_MAX_TEXT_LENGTH, matchQueue } from '../schema/matching.js';

export type MatchQueueRow = typeof matchQueue.$inferSelect;

export interface EnqueueMatchInput {
  readonly subjectKind: MatchSubjectKind;
  readonly subjectKey: string;
  readonly sourceRecordId: string | null;
  readonly productVariantId: string | null;
  readonly trigger: MatchQueueTrigger;
}

/**
 * Ask for a subject to be matched.
 *
 * The handle is REQUIRED (#584) — `enqueueOfferConvergence`'s ruling, for the
 * same reason and with one thing more. A catalogue write enqueues inside its own
 * transaction so a rolled-back write leaves no request for a change that never
 * happened, and forgetting to thread `tx` used to compile: the root `Database`
 * and a transaction share the `DatabaseOrTransaction` type.
 *
 * The extra reason is that NOTHING here would have been loud about it. Both
 * subject shapes carry a foreign key (`source_records` RESTRICT, `product_variants`
 * CASCADE, exactly one non-null by `match_queue_subject_shape_check`), so an
 * enqueue on the root connection inside the transaction that CREATES the subject
 * raises `23503` — and `requestMatch`, this function's only wrapper, catches and
 * logs by design so a catalogue write cannot fail because a matcher could not be
 * QUEUED (#58 operations 4). So the loud failure is swallowed into a WARN and a
 * lost match request, while an enqueue for an already-committed subject satisfies
 * the key and leaves a row outside the caller's transaction. Neither shape
 * reaches anybody, which is why the compile error is the whole fix.
 */
export async function enqueueMatch(
  input: EnqueueMatchInput,
  db: DatabaseOrTransaction,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(matchQueue)
    .values({
      subjectKind: input.subjectKind,
      subjectKey: input.subjectKey,
      sourceRecordId: input.sourceRecordId,
      productVariantId: input.productVariantId,
      trigger: input.trigger,
      availableAt: now,
    })
    .onConflictDoUpdate({
      target: matchQueue.subjectKey,
      set: {
        requestedRevision: sql`${matchQueue.requestedRevision} + 1`,
        // A processing row keeps its status so the worker's lease survives; a
        // pending, done or dead-lettered one becomes claimable again. Writing a
        // flat 'pending' here would release a live lease from outside the worker.
        status: sql`case when ${matchQueue.status} = 'processing' then 'processing' else 'pending' end`,
        attempts: 0,
        availableAt: now,
        lastError: null,
        // The trigger of the LATEST request, so "why is this queued" answers
        // about the request that is actually outstanding.
        trigger: input.trigger,
      },
    });
}

export interface ClaimMatchQueueOptions {
  readonly leaseOwner: string;
  readonly batchSize: number;
  readonly leaseMs?: number;
  readonly now?: Date;
}

/**
 * Claim a bounded batch.
 *
 * `FOR UPDATE SKIP LOCKED` inside the subquery, so N dispatchers on N ECS tasks
 * drain one queue without handing each other the same row. The `or` has two
 * branches — due PENDING work and PROCESSING work whose lease expired — and each
 * has its own partial index so neither scans the other's rows. `lease_until` is
 * NULL on a never-leased row, so the reclaim branch excludes them by the
 * comparison itself rather than by a second predicate.
 */
export async function claimMatchQueue(
  options: ClaimMatchQueueOptions,
  db: DatabaseOrTransaction = getDb(),
): Promise<MatchQueueRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
  const batchSize = Math.max(1, options.batchSize);
  const due = or(
    and(eq(matchQueue.status, 'pending'), lte(matchQueue.availableAt, now)),
    and(eq(matchQueue.status, 'processing'), lte(matchQueue.leaseUntil, now)),
  );

  return db
    .update(matchQueue)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      claimedRevision: sql`${matchQueue.requestedRevision}`,
      attempts: sql`${matchQueue.attempts} + 1`,
      lastError: null,
    })
    .where(
      sql`${matchQueue.id} in (
        select ${matchQueue.id} from ${matchQueue}
        where ${due}
        order by ${asc(matchQueue.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

/** The owner check both terminal transitions share. */
function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(matchQueue.id, id),
    eq(matchQueue.status, 'processing'),
    eq(matchQueue.leaseOwner, leaseOwner),
    gt(matchQueue.leaseUntil, now),
  );
}

/**
 * Mark a job done.
 *
 * @returns `false` when the lease had already been reclaimed — the worker's
 *   outcome is then discarded rather than written over somebody else's run.
 *
 * A request that arrived DURING the run left `requested_revision` ahead of
 * `claimed_revision`, so the row goes back to `pending` instead of `done`. That
 * pair is the whole reason a write landing one millisecond after a claim is not
 * swallowed by the completion that follows it.
 */
export async function completeMatchQueue(
  id: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(matchQueue)
    .set({
      status: sql`case when ${matchQueue.requestedRevision} > coalesce(${matchQueue.claimedRevision}, 0)
                       then 'pending' else 'done' end`,
      processedAt: now,
      availableAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedLease(id, leaseOwner, now))
    .returning({ id: matchQueue.id });
  return rows.length === 1;
}

/** Give a lease back after a failure. `deadLettered` is the CALLER's decision. */
export async function releaseMatchQueue(
  options: {
    id: string;
    leaseOwner: string;
    deadLettered: boolean;
    availableAt: Date;
    error: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(matchQueue)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, MATCH_MAX_TEXT_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.id, options.leaseOwner, now))
    .returning({ id: matchQueue.id });
  return rows.length === 1;
}

export async function findMatchQueueRow(
  db: DatabaseOrTransaction,
  subjectKey: string,
): Promise<MatchQueueRow | undefined> {
  const rows = await db
    .select()
    .from(matchQueue)
    .where(eq(matchQueue.subjectKey, subjectKey))
    .limit(1);
  return rows[0];
}

/** The queue-health numbers (#58 operations 5). */
export interface MatchQueueSummary {
  readonly pending: number;
  readonly processing: number;
  readonly done: number;
  readonly deadLetter: number;
  /** Seconds since the OLDEST pending row arrived. `null` when nothing pends. */
  readonly oldestPendingAgeSeconds: number | null;
}

/**
 * Counts and queue AGE in one round trip.
 *
 * Age rather than depth is the number that distinguishes "a bulk sweep is
 * running" from "the dispatcher stopped an hour ago" — two situations with the
 * same depth and opposite urgency. `match_queue_age_idx` serves the `min` from a
 * partial index over pending rows alone.
 */
export async function summarizeMatchQueue(
  db: DatabaseOrTransaction = getDb(),
): Promise<MatchQueueSummary> {
  const rows = await db
    .select({
      pending: sql<number>`count(*) filter (where ${matchQueue.status} = 'pending')::int`,
      processing: sql<number>`count(*) filter (where ${matchQueue.status} = 'processing')::int`,
      done: sql<number>`count(*) filter (where ${matchQueue.status} = 'done')::int`,
      deadLetter: sql<number>`count(*) filter (where ${matchQueue.status} = 'dead_letter')::int`,
      oldestPendingAgeSeconds: sql<
        number | null
      >`extract(epoch from (now() - min(${matchQueue.createdAt}) filter (where ${matchQueue.status} = 'pending')))::double precision`,
    })
    .from(matchQueue);
  const row = rows[0];
  if (!row) {
    return { pending: 0, processing: 0, done: 0, deadLetter: 0, oldestPendingAgeSeconds: null };
  }
  return row;
}
