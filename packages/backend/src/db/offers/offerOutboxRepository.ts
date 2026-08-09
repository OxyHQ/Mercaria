/**
 * `offer_outboxes` — the durable promise that a listing's native offers will be
 * brought back into agreement with the listing (#57 native rule 4).
 *
 * ## Why the enqueue is `DO UPDATE` where the moderation outbox's is `DO NOTHING`
 *
 * `enqueueModerationOutboxEvent` must write NOTHING on a repeat: its row is one
 * DELIVERY of one event, and a second write would move `updated_at` and the
 * tuple version under a dispatcher holding a live lease on it. This queue's row
 * is not a delivery, it is a standing request for a FIXED POINT — "whatever this
 * listing looks like when you run, make its offers say that". Five writes in a
 * second owe one convergence, and a `DO NOTHING` would silently drop the four
 * that arrived while one was pending, including the one that mattered.
 *
 * So this enqueue bumps a REVISION, and the revision pair is what makes that
 * safe. {@link claimOfferOutbox} copies `requested_revision` into
 * `claimed_revision`; {@link completeOfferOutbox} compares the two and leaves
 * the row `pending` when a newer request arrived mid-run. Without it, a
 * moderation restriction landing one millisecond after a claim would sit
 * unconverged until the next unrelated write to that listing — which is exactly
 * the "buyable stale offer" acceptance 6 forbids.
 *
 * The `set` references the EXISTING row (`offer_outboxes.requested_revision + 1`)
 * and never `excluded`: `excluded` is the row this statement proposed, so two
 * concurrent enqueues would each set the revision to their own proposed 1
 * (CONVENTIONS.md, the three concurrency shapes a mocked test cannot see).
 */

import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { offerOutboxes, OFFER_OUTBOX_MAX_LAST_ERROR_LENGTH } from '../schema/offers.js';

export type OfferOutboxRow = typeof offerOutboxes.$inferSelect;

/**
 * Ask for a listing's native offers to be converged.
 *
 * Takes an optional transaction handle rather than requiring one, which is the
 * opposite of `enqueueModerationOutboxEvent` and for a stated reason: that row
 * must commit with the abuse report or the report is lost, while this row is a
 * request for a recomputation that reads live state when it runs. A caller
 * inside a transaction should pass it (so a rolled-back catalogue write does not
 * leave a job for a change that never happened); a caller outside one — the
 * moderation enforcement path, which commits its listing write through its own
 * repository — correctly has none to pass.
 */
export async function enqueueOfferConvergence(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(offerOutboxes)
    .values({
      listingId,
      requestedRevision: 1,
      status: 'pending',
      attempts: 0,
      availableAt: now,
    })
    .onConflictDoUpdate({
      target: offerOutboxes.listingId,
      set: {
        requestedRevision: sql`${offerOutboxes.requestedRevision} + 1`,
        /**
         * A new request revives a `dead_letter` and re-arms a `done` row — but
         * it must NOT touch a row a dispatcher is holding.
         *
         * Writing a flat `'pending'` here releases an in-flight lease from
         * OUTSIDE the worker: the owner check in `completeOfferOutbox` then
         * fails, the worker's own outcome is silently discarded, and a second
         * task can claim the row while the first is still converging. Measured,
         * not reasoned about — the realdb case "a request that arrives DURING a
         * run leaves the row pending, not done" fails on the flat form, and the
         * failure is a completion returning `false`, which reads as a reclaimed
         * lease rather than as this.
         *
         * A processing row needs nothing done to it anyway: the revision bump
         * above is the whole message, and the worker's completion CASE reads it.
         */
        status: sql`case when ${offerOutboxes.status} = 'processing' then 'processing' else 'pending' end`,
        attempts: 0,
        availableAt: now,
        lastError: null,
      },
    });
}

/**
 * Atomically claim due convergence jobs.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` inside the `UPDATE`, the moderation
 * outbox's shape: N tasks drain the queue without handing each other the same
 * row and without blocking on one another. An expired `processing` lease is
 * reclaimable, so a task that died mid-convergence cannot strand a listing.
 *
 * `lease_until <= now` is NULL for a row that has never been leased, and a CHECK
 * rejects only FALSE — so the reclaim branch excludes never-leased rows by the
 * comparison itself rather than by an extra predicate.
 */
export async function claimOfferOutbox(
  options: { leaseOwner: string; batchSize: number; leaseMs?: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferOutboxRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
  const batchSize = Math.max(1, options.batchSize);

  const due = or(
    and(eq(offerOutboxes.status, 'pending'), lte(offerOutboxes.availableAt, now)),
    and(eq(offerOutboxes.status, 'processing'), lte(offerOutboxes.leaseUntil, now)),
  );

  return db
    .update(offerOutboxes)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      // The revision this claim answers. Completion compares it with whatever
      // `requested_revision` says by then, which is how a request that arrived
      // during the run survives the completion that follows it.
      claimedRevision: sql`${offerOutboxes.requestedRevision}`,
      attempts: sql`${offerOutboxes.attempts} + 1`,
      lastError: null,
    })
    // Both references name the SAME table, so the subquery's own range entry
    // shadows the outer one inside it — which is what is wanted here, and why
    // the correlated-subquery hazard in CONVENTIONS.md does not apply.
    .where(
      sql`${offerOutboxes.id} in (
        select ${offerOutboxes.id} from ${offerOutboxes}
        where ${due}
        order by ${asc(offerOutboxes.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

/**
 * Only the lease this dispatcher currently owns matches.
 *
 * Every terminal transition carries it, so a dispatcher whose lease expired and
 * was reclaimed cannot complete or fail work that is no longer its own.
 */
function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(offerOutboxes.id, id),
    eq(offerOutboxes.status, 'processing'),
    eq(offerOutboxes.leaseOwner, leaseOwner),
    gt(offerOutboxes.leaseUntil, now),
  );
}

/**
 * Finish a claim — and re-arm the row if a newer request arrived during it.
 *
 * The `status` is a CASE on the two revisions rather than a flat `'done'`,
 * evaluated inside the same statement that releases the lease. Reading the
 * revision first and then deciding would leave a gap in which the next enqueue
 * lands, which is precisely the race the pair exists to close.
 *
 * @returns `true` when this dispatcher still owned the lease; `false` means it
 * was reclaimed and another task is authoritative for that row.
 */
export async function completeOfferOutbox(
  id: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(offerOutboxes)
    .set({
      status: sql`case when ${offerOutboxes.requestedRevision} > coalesce(${offerOutboxes.claimedRevision}, 0)
                       then 'pending' else 'done' end`,
      processedAt: now,
      availableAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedLease(id, leaseOwner, now))
    .returning({ id: offerOutboxes.id });
  return rows.length === 1;
}

/**
 * Release a failed claim with backoff — or stop.
 *
 * `deadLettered` is the CALLER's decision, as in the moderation outbox: only the
 * service knows whether the failure was retryable and how many attempts have
 * been spent. A dead letter here is VISIBLE and not silent — the listing keeps
 * whatever offers it had, which may be stale, and the derived checkout gate is
 * what keeps a stale one from being buyable in the meantime.
 */
export async function releaseOfferOutbox(
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
    .update(offerOutboxes)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, OFFER_OUTBOX_MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.id, options.leaseOwner, now))
    .returning({ id: offerOutboxes.id });
  return rows.length === 1;
}

/** One job by listing, whatever its state — the operator trace's read. */
export async function findOfferOutboxForListing(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferOutboxRow | undefined> {
  const rows = await db
    .select()
    .from(offerOutboxes)
    .where(eq(offerOutboxes.listingId, listingId))
    .limit(1);
  return rows[0];
}

/** How much convergence work is outstanding, by state — the operator's summary. */
export async function summarizeOfferOutbox(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ pending: number; processing: number; done: number; deadLetter: number }> {
  const rows = await db
    .select({
      pending: sql<number>`count(*) filter (where ${offerOutboxes.status} = 'pending')::int`,
      processing: sql<number>`count(*) filter (where ${offerOutboxes.status} = 'processing')::int`,
      done: sql<number>`count(*) filter (where ${offerOutboxes.status} = 'done')::int`,
      deadLetter: sql<number>`count(*) filter (where ${offerOutboxes.status} = 'dead_letter')::int`,
    })
    .from(offerOutboxes);
  const row = rows[0];
  return {
    pending: row?.pending ?? 0,
    processing: row?.processing ?? 0,
    done: row?.done ?? 0,
    deadLetter: row?.deadLetter ?? 0,
  };
}
