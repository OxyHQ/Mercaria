/**
 * Reads and writes for `offer_refresh_tasks` (#68 §"Scheduler and jobs" 1–4).
 *
 * ## A CONVERGENCE queue, and the enqueue is the interesting part
 *
 * `offer_outboxes`' shape rather than the moderation outbox's: five requests to
 * re-read one object owe ONE re-read, so the enqueue is an
 * `ON CONFLICT DO UPDATE` on `(source_id, mode, subject_key)` that RAISES the
 * priority, UNIONS the reasons and bumps `requested_revision`. A delivery queue
 * keyed on an event id would answer "five", with five calls against a
 * provider's quota to show for it.
 *
 * Three properties the `set` clause holds, none of them obvious:
 *
 * 1. **The priority only ever goes UP.** `least(existing, incoming)` on the
 *    RANK — a lower rank is more urgent — because an alerted refresh that
 *    arrives while a scheduled one is queued must not be demoted by the next
 *    scheduled tick. The class is recomputed from the resulting rank so the two
 *    cannot disagree.
 * 2. **A `processing` row is never written back to `pending`.** #57 measured
 *    this exact bug: a flat `status = 'pending'` in the conflict branch
 *    releases a live lease from outside the worker. The revision pair is what
 *    carries the new request instead — the worker compares them on completion
 *    and leaves the row pending when a newer request landed mid-run.
 * 3. **`available_at` is pulled EARLIER, never later.** `least(...)` again:
 *    a scheduled task due in an hour that somebody now wants immediately should
 *    move forward, and a scheduled tick must not push an urgent one back.
 */

import { and, asc, desc, eq, isNotNull, lte, or, sql } from 'drizzle-orm';
import {
  OFFER_REFRESH_PRIORITY_CLASSES,
  OFFER_REFRESH_PRIORITY_RANK,
  type CatalogRefreshMode,
  type OfferRefreshPriorityClass,
  type OfferRefreshRefusal,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  OFFER_FRESHNESS_MAX_TEXT_LENGTH,
  OFFER_REFRESH_SOURCE_SUBJECT_KEY,
  offerRefreshTasks,
} from '../schema/offerFreshness.js';

export type OfferRefreshTaskRow = typeof offerRefreshTasks.$inferSelect;

/** What the scheduler asks for. */
export interface EnqueueRefreshTaskInput {
  sourceId: string;
  mode: CatalogRefreshMode;
  /** Absent for a whole-source pass; the sentinel is supplied here, not by callers. */
  externalObjectKey?: string;
  offerId?: string;
  priorityReason: OfferRefreshPriorityClass;
  availableAt: Date;
  requestedByOxyUserId?: string;
  now: Date;
}

/**
 * `case` mapping a RANK back to its class, rendered from the one tuple.
 *
 * The conflict branch computes the winning rank with `least(...)` and then has
 * to store the class that rank belongs to. Deriving it in SQL keeps the two
 * columns consistent inside a single statement; deriving it in TypeScript would
 * need a read-modify-write and would race with a concurrent enqueue.
 */
const CLASS_FOR_RANK_SQL = [
  'case least(offer_refresh_tasks.priority_rank, excluded.priority_rank)',
  ...OFFER_REFRESH_PRIORITY_CLASSES.map(
    (value) => `when ${OFFER_REFRESH_PRIORITY_RANK[value]} then '${value}'`,
  ),
  `else offer_refresh_tasks.priority_class end`,
].join(' ');

/**
 * Ask for a refresh, converging on whatever is already queued.
 *
 * Returns the row so the caller can see whether its own reason won, which the
 * operator surface reports rather than re-deriving.
 */
export async function enqueueRefreshTask(
  db: DatabaseOrTransaction,
  input: EnqueueRefreshTaskInput,
): Promise<OfferRefreshTaskRow> {
  const subjectKey = input.externalObjectKey ?? OFFER_REFRESH_SOURCE_SUBJECT_KEY;
  const rows = await db
    .insert(offerRefreshTasks)
    .values({
      sourceId: input.sourceId,
      mode: input.mode,
      subjectKind: input.externalObjectKey === undefined ? 'source' : 'external_object',
      subjectKey,
      offerId: input.offerId ?? null,
      priorityClass: input.priorityReason,
      priorityReasons: [input.priorityReason],
      status: 'pending',
      availableAt: input.availableAt,
      requestedByOxyUserId: input.requestedByOxyUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [offerRefreshTasks.sourceId, offerRefreshTasks.mode, offerRefreshTasks.subjectKey],
      set: {
        // The reasons are a SET: `array_agg(distinct …)` is unavailable in an
        // `ON CONFLICT` branch, so the union is spelled with a subquery-free
        // `array(select distinct unnest(…))`, which is legal in an expression.
        priorityReasons: sql`array(
          select distinct unnest(${offerRefreshTasks.priorityReasons} || excluded.priority_reasons)
        )`,
        priorityClass: sql.raw(CLASS_FOR_RANK_SQL),
        availableAt: sql`least(${offerRefreshTasks.availableAt}, excluded.available_at)`,
        requestedRevision: sql`${offerRefreshTasks.requestedRevision} + 1`,
        // NOT `status`: writing `pending` over a `processing` row releases a
        // live lease from outside the worker (#57's measured bug). A row that
        // is done goes back to pending, which is what re-opens a converged
        // task for a new request.
        status: sql`case when ${offerRefreshTasks.status} in ('done', 'dead_letter')
                         then 'pending' else ${offerRefreshTasks.status} end`,
        offerId: sql`coalesce(excluded.offer_id, ${offerRefreshTasks.offerId})`,
        updatedAt: input.now,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error(`offer_refresh_tasks enqueue for ${input.sourceId} returned nothing.`);
  return row;
}

/**
 * Claim up to `batchSize` due tasks, most urgent first.
 *
 * `FOR UPDATE SKIP LOCKED` with an owner check on every terminal write, so N
 * ECS tasks drain one queue without handing each other a row and a dead task's
 * expired lease is reclaimable — the moderation outbox contract, verbatim.
 *
 * The two claimable branches are due PENDING work and PROCESSING work whose
 * lease has expired, and each has its own partial index so neither scans the
 * other's rows.
 */
export async function claimRefreshTasks(
  db: DatabaseOrTransaction,
  input: { leaseOwner: string; batchSize: number; leaseMs: number; now: Date },
): Promise<OfferRefreshTaskRow[]> {
  const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
  const due = or(
    and(eq(offerRefreshTasks.status, 'pending'), lte(offerRefreshTasks.availableAt, input.now)),
    and(
      eq(offerRefreshTasks.status, 'processing'),
      isNotNull(offerRefreshTasks.leaseUntil),
      lte(offerRefreshTasks.leaseUntil, input.now),
    ),
  );

  return db
    .update(offerRefreshTasks)
    .set({
      status: 'processing',
      leaseOwner: input.leaseOwner,
      leaseUntil,
      attempts: sql`${offerRefreshTasks.attempts} + 1`,
      claimedRevision: sql`${offerRefreshTasks.requestedRevision}`,
      updatedAt: input.now,
    })
    .where(
      sql`${offerRefreshTasks.id} in (
        select ${offerRefreshTasks.id} from ${offerRefreshTasks}
        where ${due}
        order by ${asc(offerRefreshTasks.priorityRank)}, ${asc(offerRefreshTasks.availableAt)},
                 ${asc(offerRefreshTasks.createdAt)}
        limit ${Math.max(1, input.batchSize)}
        for update skip locked
      )`,
    )
    .returning();
}

/**
 * Complete a task, leaving it PENDING when a newer request landed mid-run.
 *
 * The revision comparison is the whole point (#57's device): a priority
 * request that arrived while the worker was fetching would otherwise be
 * swallowed by this completion, and the offer would wait for the next unrelated
 * refresh of that source.
 *
 * @returns `true` when this caller still owned the lease.
 */
export async function completeRefreshTask(
  db: DatabaseOrTransaction,
  input: { id: string; leaseOwner: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(offerRefreshTasks)
    .set({
      status: sql`case when ${offerRefreshTasks.requestedRevision} > coalesce(${offerRefreshTasks.claimedRevision}, 0)
                       then 'pending' else 'done' end`,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      lastRefusal: null,
      processedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(eq(offerRefreshTasks.id, input.id), eq(offerRefreshTasks.leaseOwner, input.leaseOwner)),
    )
    .returning({ id: offerRefreshTasks.id });
  return rows.length === 1;
}

/**
 * Release a task for a later attempt, recording WHY.
 *
 * A refusal is not a failure to retry blindly: `unsupported_mode` and
 * `adapter_missing` will refuse identically forever, so they go to
 * `dead_letter` where an operator sees them, while `rate_limited` and
 * `all_slots_busy` are transient and go back to `pending` with a delay. The
 * caller decides which by passing `deadLetter`, because only it knows whether
 * the refusal is about this attempt or about the request.
 */
export async function releaseRefreshTask(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    leaseOwner: string;
    availableAt: Date;
    error: string | null;
    refusal: OfferRefreshRefusal | null;
    deadLetter: boolean;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(offerRefreshTasks)
    .set({
      status: input.deadLetter ? 'dead_letter' : 'pending',
      leaseOwner: null,
      leaseUntil: null,
      availableAt: input.availableAt,
      lastError:
        input.error === null ? null : input.error.slice(0, OFFER_FRESHNESS_MAX_TEXT_LENGTH),
      lastRefusal: input.refusal,
      updatedAt: input.now,
    })
    .where(
      and(eq(offerRefreshTasks.id, input.id), eq(offerRefreshTasks.leaseOwner, input.leaseOwner)),
    )
    .returning({ id: offerRefreshTasks.id });
  return rows.length === 1;
}

/** One source's queue picture — the health surface's own read (#68 source health 6). */
export interface RefreshQueueDepth {
  pending: number;
  processing: number;
  deadLettered: number;
  /** Seconds between `now` and the oldest pending task's due time, when it is due. */
  oldestPendingLagSeconds: number | null;
}

/**
 * How far behind one source's refresh queue is.
 *
 * The lag is measured from `available_at` and not from `created_at`, because a
 * task scheduled for tomorrow is not late today. `greatest(…, 0)` so a task due
 * in the future contributes zero rather than a negative lag that would read as
 * the queue being ahead of itself.
 */
export async function readRefreshQueueDepth(
  db: DatabaseOrTransaction,
  input: { sourceId: string; now: Date },
): Promise<RefreshQueueDepth> {
  const rows = await db
    .select({
      pending: sql<number>`count(*) filter (where ${offerRefreshTasks.status} = 'pending')::int`,
      processing: sql<number>`count(*) filter (where ${offerRefreshTasks.status} = 'processing')::int`,
      deadLettered: sql<number>`count(*) filter (where ${offerRefreshTasks.status} = 'dead_letter')::int`,
      oldestPendingAvailableAt: sql<Date | null>`min(${offerRefreshTasks.availableAt})
        filter (where ${offerRefreshTasks.status} = 'pending')`,
    })
    .from(offerRefreshTasks)
    .where(eq(offerRefreshTasks.sourceId, input.sourceId));

  const row = rows[0];
  const oldest = row?.oldestPendingAvailableAt ?? null;
  return {
    pending: row?.pending ?? 0,
    processing: row?.processing ?? 0,
    deadLettered: row?.deadLettered ?? 0,
    oldestPendingLagSeconds:
      oldest === null
        ? null
        : Math.max(0, Math.floor((input.now.getTime() - new Date(oldest).getTime()) / 1_000)),
  };
}

/** One source's tasks, most urgent first — the operator's queue read. */
export async function listRefreshTasks(
  db: DatabaseOrTransaction = getDb(),
  input: { sourceId: string; limit: number },
): Promise<OfferRefreshTaskRow[]> {
  return db
    .select()
    .from(offerRefreshTasks)
    .where(eq(offerRefreshTasks.sourceId, input.sourceId))
    .orderBy(asc(offerRefreshTasks.priorityRank), desc(offerRefreshTasks.updatedAt))
    .limit(input.limit);
}

/** One task by its convergence key — what an operator's trace opens from. */
export async function findRefreshTask(
  db: DatabaseOrTransaction,
  input: { sourceId: string; mode: CatalogRefreshMode; subjectKey: string },
): Promise<OfferRefreshTaskRow | undefined> {
  const rows = await db
    .select()
    .from(offerRefreshTasks)
    .where(
      and(
        eq(offerRefreshTasks.sourceId, input.sourceId),
        eq(offerRefreshTasks.mode, input.mode),
        eq(offerRefreshTasks.subjectKey, input.subjectKey),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Tasks that will not be attempted again without a person. */
export async function listDeadLetteredRefreshTasks(
  db: DatabaseOrTransaction,
  input: { limit: number },
): Promise<OfferRefreshTaskRow[]> {
  return db
    .select()
    .from(offerRefreshTasks)
    .where(eq(offerRefreshTasks.status, 'dead_letter'))
    .orderBy(desc(offerRefreshTasks.updatedAt))
    .limit(input.limit);
}
