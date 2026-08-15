/**
 * Reads and writes for `sync_run_record_failures` — WHICH record a connector run
 * refused, and why (#303).
 *
 * `catalog_source_rejections` (#62) is the precedent and the argument is the
 * same one domain over: a `failed` counter says a run dropped eleven products;
 * only these rows say all eleven broke the same rule, which is what tells a
 * systemic refusal from a bad afternoon.
 *
 * The whole module exists so that "a raw driver statement can never reach a
 * merchant" (#292) holds for this table by CONSTRUCTION rather than by review:
 * the writer takes the THROWN value, never a message, and the only thing that
 * turns one into a string is `classifyMerchantFacingFailure` — the same door
 * `sync_runs.error` goes through. A caller that pre-formatted a detail would be
 * a second composer, and the signature gives it nowhere to pass one.
 */

import { asc, eq } from 'drizzle-orm';
import type { SyncRecordSubjectType } from '@mercaria/shared-types';
import { classifyMerchantFacingFailure } from '../../lib/errors/merchant-facing.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { RETENTION_SECONDS } from '../expiryTargets.js';
import {
  SYNC_RECORD_FAILURE_DETAIL_MAX_LENGTH,
  SYNC_RECORD_FAILURE_EXTERNAL_ID_MAX_LENGTH,
  syncRunRecordFailures,
} from '../schema/connectors.js';

/** One row of `sync_run_record_failures`. */
export type SyncRunRecordFailureRow = typeof syncRunRecordFailures.$inferSelect;

/**
 * How many records ONE run stores a reason for.
 *
 * A run that refuses fifty thousand products would otherwise insert fifty
 * thousand rows inside the statement that closes it. The cap keeps the FIRST N
 * in the order they were met — the order the platform paginated — because that
 * is the only ordering the loop actually has, and it is stated rather than
 * dressed up as a sample.
 *
 * The elision is VISIBLE: `SyncRunRecordFailurePage` reports the run's own
 * `failedCount` beside the list, so a merchant with two hundred stored reasons
 * and a tally of five hundred can see both numbers. And two hundred samples over
 * however many distinct reasons is more than enough to tell a systemic refusal
 * from noise, which is the question these rows exist to answer.
 */
export const SYNC_RUN_RECORD_FAILURE_MAX_ROWS = 200;

/** One record a run could not process, as the CALLER reports it. */
export interface RecordFailureInput {
  subjectType: SyncRecordSubjectType;
  /** The platform's own id for the record, when it published one. */
  externalId: string | null | undefined;
  /** The THROWN value, never a message — see the module docblock. */
  failure: unknown;
}

/**
 * Normalize an external id to what the column accepts.
 *
 * `''` maps to NULL rather than being stored, so "the platform published no id"
 * has ONE spelling. A pathological id is cut to the column's ceiling. Between
 * them these two make a CHECK violation a shape a Mercaria write cannot
 * produce — which is what lets the run's close and its evidence share a
 * transaction without the evidence being able to fail the close.
 */
function normalizeExternalId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, SYNC_RECORD_FAILURE_EXTERNAL_ID_MAX_LENGTH);
}

/**
 * REPLACE the reasons for one run's refused records.
 *
 * Called by `finishSyncRun` and by nothing else, INSIDE the transaction that
 * closes the run: the summary on `sync_runs.error` and these rows are composed
 * from one input by one classifier, so a run whose summary names three products
 * while this table holds none is not a state the database can be left in.
 *
 * REPLACE, not append, and the delete runs even when there is nothing to insert.
 * Closing a run is not once-only — a re-close is what the "clears a previous
 * error" case does, and `finishSyncRun` overwrites `error` outright on it,
 * explicitly writing NULL when nothing was refused. The rows have to follow that
 * exactly: appending would leave a run whose summary names one reason beside
 * rows from a superseded attempt, and skipping the delete on an empty list would
 * leave a `completed`, error-free run still carrying refusals. It also makes the
 * `(run_id, ordinal)` unique a convergence rather than a collision.
 *
 * `expires_at` is stamped from `RETENTION_SECONDS`, so the sweep needs no filter
 * — the registry has no way to express one — and the writer and
 * `expiryTargets.ts` read one constant instead of two copies of thirty days.
 */
export async function replaceSyncRunRecordFailures(
  db: DatabaseOrTransaction,
  runId: string,
  failures: readonly RecordFailureInput[],
  now: Date,
): Promise<number> {
  await db.delete(syncRunRecordFailures).where(eq(syncRunRecordFailures.runId, runId));

  const kept = failures.slice(0, SYNC_RUN_RECORD_FAILURE_MAX_ROWS);
  if (kept.length === 0) return 0;

  const expiresAt = new Date(now.getTime() + RETENTION_SECONDS.syncRunRecordFailure * 1_000);
  const values = kept.map((failure, ordinal) => {
    const classified = classifyMerchantFacingFailure(failure.failure);
    return {
      runId,
      // The position this record was MET at, stored rather than inferred. See
      // the column's own docblock: every row here shares one `created_at` and a
      // uuid v7 is not monotonic within a millisecond, so nothing about the row
      // itself can carry this.
      ordinal,
      subjectType: failure.subjectType,
      externalId: normalizeExternalId(failure.externalId),
      reasonCode: classified.reasonCode,
      detail: classified.message.slice(0, SYNC_RECORD_FAILURE_DETAIL_MAX_LENGTH),
      expiresAt,
    };
  });

  await db.insert(syncRunRecordFailures).values(values);
  return values.length;
}

/**
 * One run's stored reasons, oldest first — the merchant read.
 *
 * `limit` is the CALLER's page bound and is deliberately separate from the write
 * cap: a page cut by its own limit and a run whose reasons were cut when they
 * were stored are different elisions with different remedies, and the DTO
 * reports the first as `limitReached` while the second shows as a list shorter
 * than the run's own tally.
 *
 * Ordered by the stored `ordinal` and by nothing else, which is the whole reason
 * that column exists. `(created_at, id)` was the obvious spelling and it is
 * WRONG here in a way that looks right: one multi-row insert gives every row of
 * a run the same `created_at`, and `@oxyhq/db`'s uuid v7 is not monotonic within
 * a millisecond, so the tiebreak is a coin toss and a run's refusals come back
 * shuffled — measured on this table's own first run, where the third record
 * arrived second and the write cap's "first 200" started at record 79.
 */
export async function listSyncRunRecordFailures(
  runId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<SyncRunRecordFailureRow[]> {
  return await db
    .select()
    .from(syncRunRecordFailures)
    .where(eq(syncRunRecordFailures.runId, runId))
    .orderBy(asc(syncRunRecordFailures.ordinal))
    .limit(limit);
}
