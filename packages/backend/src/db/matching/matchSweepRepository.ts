/**
 * `match_sweep_cursors` — the lease and keyset cursor for a bulk enqueue
 * (#58 operations 3).
 *
 * The `reconciliation_cursors` repository, ported. Two properties carry over
 * unchanged because they are the reason that shape exists:
 *
 * - **The cursor is made durable BEFORE the lease is given up.** A pass is many
 *   bounded PAGES, and a crash between advancing and releasing must resume where
 *   it stopped rather than restart. `advanceSweepCursor` does not extend the
 *   lease, so a run is exactly one page and a stalled task's lease expires
 *   rather than pinning a whole pass.
 * - **The claim is `FOR UPDATE SKIP LOCKED` inside a transaction**, so a second
 *   ECS task finds the row locked, skips it, and returns "somebody else is
 *   sweeping" instead of blocking on a lock for five minutes.
 */

import { and, eq, lt, or, isNull } from 'drizzle-orm';
import type { MatchSweepJob } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { MATCH_MAX_TEXT_LENGTH, matchSweepCursors } from '../schema/matching.js';

export type MatchSweepCursorRow = typeof matchSweepCursors.$inferSelect;

/** Bounds ONE page, not a pass. The `reconciliation_cursors` value, for its reasons. */
export const MATCH_SWEEP_LEASE_MS = 5 * 60 * 1_000;

/**
 * Take the lease for one page, creating the cursor row on first use.
 *
 * The `INSERT ... ON CONFLICT DO NOTHING` is a separate statement from the
 * claim, deliberately: making the row exist and deciding who may work on it are
 * two questions, and folding them into one upsert makes "I created it, therefore
 * I hold it" an assumption two concurrent first-runs can both make.
 *
 * @returns The claimed row, or `undefined` when another task holds the lease.
 */
export async function claimSweepRun(
  db: DatabaseOrTransaction,
  input: { job: MatchSweepJob; leaseOwner: string; leaseMs: number; now?: Date },
): Promise<MatchSweepCursorRow | undefined> {
  const now = input.now ?? new Date();
  await db
    .insert(matchSweepCursors)
    .values({ id: input.job })
    .onConflictDoNothing({ target: matchSweepCursors.id });

  return db.transaction(async (tx) => {
    const claimable = await tx
      .select({ id: matchSweepCursors.id })
      .from(matchSweepCursors)
      .where(
        and(
          eq(matchSweepCursors.id, input.job),
          or(isNull(matchSweepCursors.leaseUntil), lt(matchSweepCursors.leaseUntil, now)),
        ),
      )
      .for('update', { skipLocked: true })
      .limit(1);
    if (claimable.length === 0) return undefined;

    const claimed = await tx
      .update(matchSweepCursors)
      .set({
        leaseOwner: input.leaseOwner,
        leaseUntil: new Date(now.getTime() + input.leaseMs),
        lastRunAt: now,
      })
      .where(eq(matchSweepCursors.id, input.job))
      .returning();
    return claimed[0];
  });
}

/**
 * Move the cursor forward, owner-checked. Does NOT extend the lease — a run is
 * one page, and the release that follows hands the next page to whoever claims.
 */
export async function advanceSweepCursor(
  db: DatabaseOrTransaction,
  input: {
    job: MatchSweepJob;
    leaseOwner: string;
    cursor: string | null;
    enqueued: number;
    policyVersionId: string;
    now?: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(matchSweepCursors)
    .set({
      cursor: input.cursor,
      policyVersionId: input.policyVersionId,
      enqueuedInPass: input.enqueued,
    })
    .where(
      and(eq(matchSweepCursors.id, input.job), eq(matchSweepCursors.leaseOwner, input.leaseOwner)),
    )
    .returning({ id: matchSweepCursors.id });
  return rows.length === 1;
}

/**
 * Give the lease back.
 *
 * Only a COMPLETED pass resets the cursor to NULL and the pass counter to zero.
 * An incomplete release keeps both, which is the whole of "resumable": the next
 * claim reads where this one stopped.
 */
export async function releaseSweepRun(
  db: DatabaseOrTransaction,
  input: {
    job: MatchSweepJob;
    leaseOwner: string;
    completed: boolean;
    error?: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(matchSweepCursors)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      lastError: input.error === undefined ? null : input.error.slice(0, MATCH_MAX_TEXT_LENGTH),
      ...(input.completed ? { cursor: null, enqueuedInPass: 0, lastCompletedAt: now } : {}),
    })
    .where(
      and(eq(matchSweepCursors.id, input.job), eq(matchSweepCursors.leaseOwner, input.leaseOwner)),
    )
    .returning({ id: matchSweepCursors.id });
  return rows.length === 1;
}

export async function listSweepCursors(
  db: DatabaseOrTransaction,
): Promise<MatchSweepCursorRow[]> {
  return db.select().from(matchSweepCursors).orderBy(matchSweepCursors.id);
}
