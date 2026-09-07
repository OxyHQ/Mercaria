/**
 * `discovery_signals` and its lease, `discovery_sweep_cursors` — the WRITE
 * side. Its only caller is the sweep.
 *
 * Split from the read repository because they share no statement and sit on
 * different paths: this one runs on a timer and rewrites the whole window, the
 * reader runs on every request and reads one indexed slice.
 *
 * The lease pair below is `analytics/rollupRepository.ts`'s
 * `claimRollupRun`/`completeRollupRun` shape, one domain over: an upsert whose
 * conflict branch takes the lease only when it is free or expired, and an
 * owner-checked release. What differs is there is no `lastCompletedDate` to
 * advance — the window is ROLLING, so a run recomputes the whole of it and a
 * failed run has nothing to resume.
 */

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { DiscoverySubjectType, DiscoveryWindow } from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { discoverySignals, discoverySweepCursors } from '../schema/discovery.js';

/** One counted subject in one scope. The window and timestamp are per run. */
export interface DiscoverySignalInput {
  subjectType: DiscoverySubjectType;
  subjectId: string;
  categoryId: string;
  unitsSold: number;
  orderCount: number;
  viewCount: number;
}

export interface ReplaceWindowInput {
  window: DiscoveryWindow;
  rows: DiscoverySignalInput[];
  computedAt: Date;
}

/**
 * Replace THE WHOLE WINDOW, atomically.
 *
 * DELETE + INSERT in one transaction rather than an upsert plus a cleanup:
 * Postgres MVCC makes the pair invisible to readers until it commits, so no
 * request ever sees a half-written window, and a subject that stopped selling
 * disappears instead of keeping last month's figure forever.
 *
 * ## The delete is not scoped, and that is the point
 *
 * It used to take a `scopeCategoryIds` list and delete only those scopes'
 * rows, which the sweep filled with the scopes it had TOUCHED. A category
 * whose every listing fell out of the rolling window contributes no key, so
 * nothing ever deleted its rows: its `best-selling` and `most-viewed` shelves
 * kept serving last month's counts indefinitely, past the `> 0` floors the
 * reads apply, with no `computed_at` check anywhere to notice. In a
 * marketplace with a long tail of quiet categories that is the ordinary case,
 * not the edge one — and it made this docblock's own promise false in exactly
 * the situation it was written for.
 *
 * A run recomputes the whole rolling window (there is no day cursor to
 * advance), so the window's rows ARE this run's output and anything else in it
 * is stale by construction. An EMPTY `rows` therefore clears the window rather
 * than being a no-op: nothing sold and nothing was viewed in the last N days
 * is a real answer, and the previous run's figures are not.
 *
 * @returns how many rows were inserted.
 */
export async function replaceWindow(input: ReplaceWindowInput): Promise<number> {
  const db = getDb();

  return db.transaction(async (tx) => {
    await tx.delete(discoverySignals).where(eq(discoverySignals.window, input.window));

    if (input.rows.length === 0) {
      return 0;
    }

    const inserted = await tx
      .insert(discoverySignals)
      .values(
        input.rows.map((row) => ({
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          categoryId: row.categoryId,
          window: input.window,
          unitsSold: row.unitsSold,
          orderCount: row.orderCount,
          viewCount: row.viewCount,
          computedAt: input.computedAt,
        })),
      )
      .returning({ id: discoverySignals.id });

    return inserted.length;
  });
}

/** The sweep's lease row, as `discovery_sweep_cursors` returns it. */
export interface DiscoverySweepCursorRow {
  readonly id: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
}

/**
 * Claim the sweep run, creating the cursor row on first use.
 *
 * One statement: an insert whose conflict branch takes the lease only when it
 * is free or expired, and whose `RETURNING` set is the answer — the empty vs
 * one-row result IS "another task holds it", so a real failure still
 * propagates instead of being read as a lost race.
 *
 * @returns The claimed cursor, or `undefined` when another task holds the lease.
 */
export async function claimDiscoverySweepRun(input: {
  job: string;
  leaseOwner: string;
  leaseMs: number;
  now: Date;
}): Promise<DiscoverySweepCursorRow | undefined> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const rows = await getDb()
    .insert(discoverySweepCursors)
    .values({
      id: input.job,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      lastRunAt: input.now,
    })
    .onConflictDoUpdate({
      target: discoverySweepCursors.id,
      set: { leaseOwner: input.leaseOwner, leaseExpiresAt, lastRunAt: input.now },
      // Only when the lease is free or a dead task's has expired. Without this
      // predicate the upsert would steal a live lease every tick.
      setWhere: or(
        isNull(discoverySweepCursors.leaseExpiresAt),
        lte(discoverySweepCursors.leaseExpiresAt, input.now),
      ),
    })
    .returning({
      id: discoverySweepCursors.id,
      leaseOwner: discoverySweepCursors.leaseOwner,
      leaseExpiresAt: discoverySweepCursors.leaseExpiresAt,
    });
  return rows[0];
}

/**
 * Release the lease, stamping `lastRunAt` and, on failure, `lastError`.
 *
 * There is no completed-date to advance: the window is rolling, so the next
 * tick recomputes it whole regardless of how this run ended. The owner check
 * is what makes the lease a lease — a task whose lease expired mid-run and was
 * reclaimed writes nothing here, so it cannot clobber the task that took over.
 */
export async function completeDiscoverySweepRun(input: {
  job: string;
  leaseOwner: string;
  error?: string;
  now: Date;
}): Promise<boolean> {
  const rows = await getDb()
    .update(discoverySweepCursors)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
      lastRunAt: input.now,
      lastError: input.error ?? null,
    })
    .where(
      and(
        eq(discoverySweepCursors.id, input.job),
        eq(discoverySweepCursors.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: discoverySweepCursors.id });
  return rows.length === 1;
}
