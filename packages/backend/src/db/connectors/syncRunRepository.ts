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
 * ## The readers arrived with #87, and both share ONE ordering
 *
 * For a long time nothing read a run back: `toSyncRunDTO` serialized the run the
 * CALLER had just written, and the dashboard's feed was the live `sync:progress`
 * Socket.IO events alone. #87 is the caller that changed it, because a socket
 * only tells a merchant what happened while they were watching.
 *
 * {@link listSyncRunsForConnection} and {@link findLatestSyncRunPerConnection}
 * order identically, deliberately: the "last run" on the channel list is the
 * first row of that channel's history, and two orderings would let those two
 * screens disagree about which run was last.
 */

import { desc, eq, inArray, sql } from 'drizzle-orm';
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

/**
 * One connection's runs, newest first (#87 management 1 and 8).
 *
 * The module header above says no reader exists because nothing read a run
 * back — the dashboard's feed was the live `sync:progress` socket alone. #87 is
 * the caller that changes it: a socket delivers what happens while somebody is
 * watching, and the channel screen has to answer "what happened overnight" to a
 * merchant who was not.
 *
 * `started_at desc` is safe without `nulls last` for the reason the header
 * gives: the column is `NOT NULL`, so no NULL can sort first. The tiebreak on
 * `id` makes the order TOTAL — two runs opened in the same millisecond would
 * otherwise page unstably, and a uuid v7 is not monotonic within one.
 */
export async function listSyncRunsForConnection(
  connectionId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<SyncRunRecord[]> {
  return await db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.connectionId, connectionId))
    .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
    .limit(limit);
}

/**
 * The newest run per connection, for a set of connections.
 *
 * One statement rather than N: the channel list renders every connection with
 * its last run, and a per-row query there is the N+1 #70 made unrepresentable in
 * its own domain. `row_number()` over the same ordering
 * {@link listSyncRunsForConnection} uses, so the "last run" on the list and the
 * first row of the history cannot disagree.
 */
export async function findLatestSyncRunPerConnection(
  connectionIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, SyncRunRecord>> {
  if (connectionIds.length === 0) return new Map();
  const ranked = db
    .select({
      run: syncRuns,
      rank: sql<number>`row_number() over (partition by ${syncRuns.connectionId} order by ${syncRuns.startedAt} desc, ${syncRuns.id} desc)`.as(
        'rank',
      ),
    })
    .from(syncRuns)
    .where(inArray(syncRuns.connectionId, [...connectionIds]))
    .as('ranked');

  const rows = await db.select().from(ranked).where(eq(ranked.rank, 1));
  return new Map(rows.map((row) => [row.run.connectionId, row.run]));
}
