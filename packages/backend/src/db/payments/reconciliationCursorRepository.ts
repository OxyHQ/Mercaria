/**
 * `reconciliation_cursors` — claiming a sweep, and remembering where it stopped.
 *
 * ## The claim is the same shape the outbox uses, on a singleton row
 *
 * `for update skip locked` inside a transaction, then an owner-checked UPDATE.
 * The outbox needs this because it has many rows and N tasks must not do the
 * same one twice; a sweep has ONE row and the property needed is the same, so
 * the mechanism is the same rather than a second one invented for the singleton
 * case.
 *
 * `skip locked` is what makes a second task's claim cost microseconds instead of
 * blocking behind the first one for the whole run: it sees the row is locked,
 * returns nothing, and that task simply does not sweep this tick.
 *
 * ## Why a sweep needs a lease at all, when #46's account sync does not
 *
 * A connected-account sync is an OBSERVATION — two tasks reading the same
 * account both write what the rail said and the compare-and-swap on
 * `last_synced_at` keeps the freshest, so concurrency costs a duplicate read and
 * nothing else.
 *
 * These sweeps are not observations. They page through a provider list with a
 * SHARED cursor, and two tasks advancing one cursor would each skip the pages
 * the other consumed — a gap that produces no error and is invisible until the
 * discrepancy nobody detected turns up in a month-end. So the run is leased.
 *
 * ## The cursor advances only after a page is FULLY handled
 *
 * That is what makes an interrupted run resumable without double-processing
 * (issue #50, jobs 7). A task that dies mid-page leaves the cursor where it was;
 * the next run replays that page, and every detection it re-derives lands on the
 * same `(kind, correlation_key)` upsert — so a replayed page bumps
 * `occurrences` and creates nothing. Resumability and idempotency are the same
 * property here, approached from two sides.
 */

import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { ReconciliationJob } from '@mercaria/shared-types';
import { reconciliationCursors } from '../schema/reconciliation.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `reconciliation_cursors`. */
export type ReconciliationCursorRow = typeof reconciliationCursors.$inferSelect;

/**
 * Take the run lease for one job, creating its cursor row on first sight.
 *
 * The insert is `on conflict do nothing` and is followed by the claim rather
 * than merged into it, because the two answer different questions: "does this
 * job have a cursor" is a one-time fact, and "may this task run it now" is asked
 * every tick. Merging them would make the first tick after a deploy take a
 * different code path from every tick after it, which is exactly the path least
 * likely to be exercised.
 *
 * @returns The claimed row, or `undefined` when another task holds a live lease.
 */
export async function claimReconciliationRun(
  db: DatabaseOrTransaction,
  input: { job: ReconciliationJob; leaseOwner: string; leaseMs: number; now?: Date },
): Promise<ReconciliationCursorRow | undefined> {
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + input.leaseMs);

  await db
    .insert(reconciliationCursors)
    .values({ id: input.job })
    .onConflictDoNothing({ target: reconciliationCursors.id });

  return await db.transaction(async (tx) => {
    const [claimable] = await tx
      .select({ id: reconciliationCursors.id })
      .from(reconciliationCursors)
      .where(
        and(
          eq(reconciliationCursors.id, input.job),
          // Free, or held by a task whose lease has expired — a dead one, whose
          // work is reclaimed rather than stranded.
          or(isNull(reconciliationCursors.leaseUntil), lt(reconciliationCursors.leaseUntil, now)),
        ),
      )
      .for('update', { skipLocked: true })
      .limit(1);
    if (!claimable) return undefined;

    const [claimed] = await tx
      .update(reconciliationCursors)
      .set({
        leaseOwner: input.leaseOwner,
        leaseUntil,
        lastRunAt: now,
        updatedAt: now,
      })
      .where(eq(reconciliationCursors.id, input.job))
      .returning();
    return claimed;
  });
}

/**
 * Record that a page has been fully handled and where the next one starts.
 *
 * Owner-checked, like every terminal write on a leased row: a task whose lease
 * expired mid-page has already lost the run to whoever reclaimed it, and writing
 * a cursor then would move a pointer another task is actively reading from.
 *
 * It does NOT extend the lease, because a run is exactly one page: the runner
 * releases immediately after this, so a task holds the lease across one page and
 * the next page is a fresh claim. An extension here would be a parameter that
 * never changes an outcome, which reads as load-bearing to whoever touches it
 * next.
 *
 * @returns Whether this task still owned the run.
 */
export async function advanceReconciliationCursor(
  db: DatabaseOrTransaction,
  input: {
    job: ReconciliationJob;
    leaseOwner: string;
    /** The provider's token for the NEXT page, or `null` at the end of a pass. */
    cursor: string | null;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(reconciliationCursors)
    .set({
      cursor: input.cursor,
      updatedAt: now,
    })
    .where(
      and(
        eq(reconciliationCursors.id, input.job),
        eq(reconciliationCursors.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: reconciliationCursors.id });
  return row !== undefined;
}

/**
 * Release the run lease, recording how the pass ended.
 *
 * A COMPLETED pass clears the cursor and moves `window_start_at` forward, so the
 * next pass is bounded by work already done rather than re-reading a fixed
 * lookback for ever. A FAILED one leaves both where they are — that is the whole
 * of resumability — and records the error for the operator surface.
 */
export async function releaseReconciliationRun(
  db: DatabaseOrTransaction,
  input: {
    job: ReconciliationJob;
    leaseOwner: string;
    completed: boolean;
    /** The instant the completed pass covered up to. Ignored unless `completed`. */
    windowStartAt?: Date;
    error?: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(reconciliationCursors)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      lastError: input.error ?? null,
      updatedAt: now,
      ...(input.completed
        ? {
            cursor: null,
            lastCompletedAt: now,
            ...(input.windowStartAt ? { windowStartAt: input.windowStartAt } : {}),
          }
        : {}),
    })
    .where(
      and(
        eq(reconciliationCursors.id, input.job),
        eq(reconciliationCursors.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: reconciliationCursors.id });
  return row !== undefined;
}

/** Every cursor, for the operator surface and the metrics endpoint. */
export async function listReconciliationCursors(
  db: DatabaseOrTransaction,
): Promise<ReconciliationCursorRow[]> {
  return await db.select().from(reconciliationCursors).orderBy(reconciliationCursors.id);
}

/**
 * Drop every cursor row. TEST SUPPORT ONLY.
 *
 * Exported so a suite exercising resumability can start from a known state
 * without reaching into the table itself. It is safe for a test to call because
 * a missing cursor is the same state as a never-run job — `claimReconciliationRun`
 * recreates it — which is also why nothing in production needs this.
 */
export async function deleteReconciliationCursor(
  db: DatabaseOrTransaction,
  job: ReconciliationJob,
): Promise<void> {
  await db.delete(reconciliationCursors).where(eq(reconciliationCursors.id, job));
}

/**
 * How long a run may hold its lease before another task may reclaim it.
 *
 * Generous relative to a sweep's expected duration, because the cost of the two
 * failure modes is asymmetric: a lease that expires too early lets a second task
 * start paging from a cursor the first is still advancing, while one that
 * expires too late merely delays recovery from a task that died. The pass
 * extends its own lease on every page (`advanceReconciliationCursor`), so this
 * bounds a single PAGE rather than a whole pass.
 */
export const RECONCILIATION_LEASE_MS = 5 * 60 * 1_000;
