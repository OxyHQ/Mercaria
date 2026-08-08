/**
 * `sync_runs` — the append-only activity log behind the dashboard's connector
 * status feed.
 *
 * ## A run is opened and then closed, in two statements — never mutated in place
 *
 * The Mongoose path created a document, mutated `counts`/`status`/`finishedAt`
 * on the in-memory object as the run progressed, and called `save()` at the end.
 * That works here too and is deliberately not what this module offers: the
 * intermediate object was never persisted, so the only writes that ever reached
 * the database were the open and the close. {@link insertSyncRun} and
 * {@link finishSyncRun} say exactly that, and the tallies stay a plain JS object
 * in the caller until the run ends — which is also what the live Socket.IO
 * progress ticks read.
 *
 * `counts` is a fixed four-field tally, so it is four `integer` columns rather
 * than a jsonb blob; {@link SyncRunCounts} is the domain shape and this module
 * owns the flattening, matching `orderRepository`'s treatment of `Money`.
 *
 * ## `started_at desc` needs no `nulls last`
 *
 * `desc()` orders NULLS FIRST in Postgres, which silently reverses a Mongo sort
 * that put missing values last — the trap worth checking on every ported ORDER
 * BY. It does not apply here: `started_at` is `NOT NULL`, so a NULL is
 * unrepresentable and the two orderings cannot differ. `finished_at` IS nullable
 * and is deliberately never sorted on.
 *
 * ## Nothing reads a run back
 *
 * There is no list or find function, because no route or service reads
 * `sync_runs` today — `toSyncRunDTO` serializes the run the CALLER just wrote.
 * The dashboard's status feed is served by the live `sync:progress` Socket.IO
 * events. This module grows with its callers rather than shipping a reader
 * nothing calls, which is how a repository accumulates a second, subtly
 * different way to answer the same question.
 */

import { eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { SyncRunCounts, SyncRunKind, SyncRunStatus } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { syncRuns } from '../schema/connectors.js';

/** One row of `sync_runs`. */
export type SyncRunRecord = InferSelectModel<typeof syncRuns>;

/** How a run ended, as the caller reports it. */
export interface SyncRunOutcome {
  status: Extract<SyncRunStatus, 'completed' | 'failed'>;
  counts: SyncRunCounts;
  error?: string;
}

/**
 * Open a run.
 *
 * `startedAt` is supplied by the application rather than defaulted in the DDL:
 * the column is `NOT NULL` with no default, which is the schema stating that a
 * run without a start time is not a row worth having.
 */
export async function insertSyncRun(
  connectionId: string,
  kind: SyncRunKind,
  db: DatabaseOrTransaction = getDb(),
): Promise<SyncRunRecord> {
  const [row] = await db
    .insert(syncRuns)
    .values({ connectionId, kind, startedAt: new Date() })
    .returning();
  return row;
}

/**
 * Close a run with its final tallies.
 *
 * @returns The stored row, so the caller can serialize what was actually
 *   persisted rather than the object it was holding — the two diverged silently
 *   under Mongoose whenever a `save()` was skipped on an error path.
 */
export async function finishSyncRun(
  runId: string,
  outcome: SyncRunOutcome,
  db: DatabaseOrTransaction = getDb(),
): Promise<SyncRunRecord> {
  const [row] = await db
    .update(syncRuns)
    .set({
      status: outcome.status,
      countsCreated: outcome.counts.created,
      countsUpdated: outcome.counts.updated,
      countsSkipped: outcome.counts.skipped,
      countsFailed: outcome.counts.failed,
      finishedAt: new Date(),
      // Explicitly `null` on success: a run that failed, was retried and then
      // succeeded must not keep the earlier message, which the Mongoose path's
      // "assign only when set" left standing on the reused document.
      error: outcome.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(syncRuns.id, runId))
    .returning();
  return row;
}
