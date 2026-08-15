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

import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  SyncRecordSubjectType,
  SyncRunCounts,
  SyncRunKind,
  SyncRunStatus,
} from '@mercaria/shared-types';
import {
  boundMerchantFacingMessage,
  merchantFacingFailureMessage,
} from '../../lib/errors/merchant-facing.js';
import { getDb, type Database, type DatabaseOrTransaction } from '../postgres.js';
import { syncRuns } from '../schema/connectors.js';
import { replaceSyncRunRecordFailures } from './syncRunRecordFailureRepository.js';

/** One row of `sync_runs`. */
export type SyncRunRecord = InferSelectModel<typeof syncRuns>;

/**
 * How a run ended, as the caller reports it.
 *
 * `failure` is the THROWN VALUE, not a message, and that is the whole of #292's
 * second half. It used to be `error?: string`, which every one of the seven call
 * sites filled with `err instanceof Error ? err.message : '…'` — and for a drizzle
 * failure that message is the failing statement plus its bound parameters,
 * published verbatim onto the merchant's channel screen by `toSyncRunDTO`.
 * Measured on the #69 verification database: thirteen rows of 1065 characters
 * carrying a connection id, a provider, a SKU and a price, none of them naming the
 * constraint that refused the write.
 *
 * Taking the value rather than a string moves the classification INSIDE
 * {@link finishSyncRun}, the only writer of that column — so "check every writer"
 * is answered by there being one, and a caller cannot forget the step because
 * there is no longer a step for them to take. The RENAME is what makes that a
 * compile error rather than a convention: a call site still passing `error:` does
 * not build.
 */
export interface SyncRunOutcome {
  status: Extract<SyncRunStatus, 'completed' | 'failed'>;
  counts: SyncRunCounts;
  failure?: unknown;
  /**
   * The records this run could not process, when the run itself did not fail.
   *
   * `counts.failed` alone is a TALLY DELTA: on a 124-product catalogue a merchant
   * has to notice that 123 landed out of 124, and on a large one nothing is
   * visible at all. Measured on the #69 verification store, a variable product
   * with 110 variations was refused whole by `maxVariantsPerProduct` and the run
   * still read `completed`, `created=123`, `failed=1` — the product simply gone,
   * with the merchant's own site showing it perfectly (#294).
   *
   * Refusing that product is CORRECT — a silently truncated variant set is #259's
   * catalogue failure — so what is fixed is the report, not the ceiling.
   *
   * #303: this input now feeds TWO things — the elided summary on
   * `sync_runs.error` and the durable per-record rows — composed by one
   * classifier inside one transaction, so the at-a-glance line and the full list
   * cannot disagree.
   */
  recordFailures?: readonly SyncRunRecordFailure[];
}

/** One record a run could not process. */
export interface SyncRunRecordFailure {
  /**
   * What kind of record this was (#303).
   *
   * REQUIRED, so every call site states one and a new rail cannot acquire a
   * subject by default. It is not derivable from `sync_runs.kind`: that column
   * says `inventory_sync` for both the PULL (whose unit is a platform inventory
   * item id) and the PUSH (whose unit is the product external id it resolves a
   * listing by), so a derivation would be silently wrong on exactly one of them.
   */
  subjectType: SyncRecordSubjectType;
  /** The external platform's own id for the record — what a merchant searches by. */
  externalId: string;
  /**
   * The THROWN value, never a message: {@link finishSyncRun} classifies it, for
   * the reason {@link SyncRunOutcome.failure} gives. A caller that pre-formatted
   * one would be a second writer of that column.
   */
  failure: unknown;
}

/** How many DISTINCT reasons a summary names before reporting a residual. */
const SUMMARY_MAX_REASONS = 3;

/** How many records a summary names PER reason before reporting a residual. */
const SUMMARY_MAX_RECORDS_PER_REASON = 3;

/** Ceiling on ONE external id, so a pathological id cannot eat the whole budget. */
const SUMMARY_MAX_EXTERNAL_ID_LENGTH = 80;

/**
 * Compose the merchant-facing summary of a run's per-record failures.
 *
 * Grouped by REASON rather than listed per record, because the shape this exists
 * for is systemic: every product one rule refuses fails the same way, so listing
 * them one per line spends the whole budget repeating a sentence instead of
 * naming the products it applies to. Groups keep INSERTION order, so one input
 * always composes one string — a summary that reordered between two runs over the
 * same failures would read as a change nobody made.
 *
 * The counts come first and every elision states its own RESIDUAL, so the
 * `boundMerchantFacingMessage` ceiling can only ever cut the tail: how many did
 * not land, and the first reason, survive any truncation.
 */
function summarizeRecordFailures(
  failures: readonly SyncRunRecordFailure[],
  totalFailed: number,
): string | null {
  if (failures.length === 0) return null;

  const byReason = new Map<string, string[]>();
  for (const failure of failures) {
    const reason = merchantFacingFailureMessage(failure.failure);
    const id =
      failure.externalId.length > SUMMARY_MAX_EXTERNAL_ID_LENGTH
        ? `${failure.externalId.slice(0, SUMMARY_MAX_EXTERNAL_ID_LENGTH - 1)}…`
        : failure.externalId;
    const named = byReason.get(reason);
    if (named) named.push(id);
    else byReason.set(reason, [id]);
  }

  const groups = [...byReason.entries()];
  const sentences = groups.slice(0, SUMMARY_MAX_REASONS).map(([reason, ids]) => {
    const shown = ids.slice(0, SUMMARY_MAX_RECORDS_PER_REASON);
    const unnamed = ids.length - shown.length;
    return `${shown.join(', ')}${unnamed > 0 ? ` and ${unnamed} more` : ''} — ${reason}`;
  });
  const unnamedReasons = groups.length - sentences.length;

  return boundMerchantFacingMessage(
    `${totalFailed} record${totalFailed === 1 ? '' : 's'} did not land. ` +
      sentences.join(' ') +
      (unnamedReasons > 0
        ? ` And ${unnamedReasons} further reason${unnamedReasons === 1 ? '' : 's'}.`
        : ''),
  );
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
 * The message is composed HERE from `outcome.failure` — see {@link SyncRunOutcome}
 * — and the bound is in CODE rather than in the schema, deliberately. `error` is a
 * plain unbounded `text()` and stays one, for three reasons. A length CHECK fails
 * by REFUSING the write, so a run that failed would then fail to record that it
 * failed — a worse outcome than the one the bound prevents. The truncation is a
 * composition decision (which end survives, what marks the cut) and so belongs
 * with the composition; a second bound in the schema would be a second
 * representation of one rule. And the property that actually matters is not length
 * — a 200-character fragment of raw SQL is exactly as wrong as a 1065-character
 * one — so a `varchar(n)` would read as though it enforced something it cannot
 * express.
 *
 * ## `error` is no longer only a `failed` run's field (#294)
 *
 * A run that processed most of its records and refused some is `completed` — the
 * products that DID land are real, and calling that a failed run would make a
 * transient one-product refusal indistinguishable from a credentials outage. But
 * `completed` with a `failed` tally and no message is exactly the report that says
 * it went fine: a merchant has to spot a count delta to learn a product is
 * missing, and nothing anywhere names which one or why. So a `completed` run now
 * carries the same field the failed one does, composed from
 * {@link SyncRunOutcome.recordFailures}.
 *
 * The whole-run `failure` still WINS when both are present: it is the reason the
 * run stopped, so the records it did not reach are its consequence rather than a
 * second finding.
 *
 * ## The summary and the per-record rows commit TOGETHER (#303)
 *
 * The summary above is deliberately elided — three reasons, three ids each — so
 * a run of `0/0/0/100` names nine products and loses ninety-one. #303's durable
 * answer is `sync_run_record_failures`, and it is written HERE, inside one
 * transaction with the close, from the SAME `recordFailures` input and through
 * the same classifier.
 *
 * One transaction rather than two statements, because the alternative state is a
 * run whose `error` names three products beside a table holding none, and the
 * merchant surface would then show "no per-record reasons" under a summary
 * naming products. The evidence cannot fail the close on its own account: the
 * writer normalizes every field to what its CHECK accepts (`''` becomes NULL, a
 * long id and a long detail are cut), so what is left is an infrastructure
 * failure — where the run genuinely did not close and retrying is right, and
 * where the UPDATE alone would already have thrown.
 *
 * A run that FAILED whole passes no `recordFailures` (see the call sites), so
 * this writes nothing on that branch, matching the `error` precedence above.
 *
 * @returns The stored row, so the caller can serialize what was actually
 *   persisted rather than the object it was holding — the two diverged silently
 *   under Mongoose whenever a `save()` was skipped on an error path.
 */
export async function finishSyncRun(
  runId: string,
  outcome: SyncRunOutcome,
  db: Database = getDb(),
): Promise<SyncRunRecord> {
  const now = new Date();
  const recordFailures = outcome.recordFailures ?? [];
  // The whole-run failure WINS over the summary, and it wins over the rows for
  // the same reason: the records this run never reached are its consequence, not
  // a hundred separate findings.
  const perRecord = outcome.failure !== undefined ? [] : recordFailures;

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .update(syncRuns)
      .set({
        status: outcome.status,
        countsCreated: outcome.counts.created,
        countsUpdated: outcome.counts.updated,
        countsSkipped: outcome.counts.skipped,
        countsFailed: outcome.counts.failed,
        finishedAt: now,
        // Explicitly `null` on success: a run that failed, was retried and then
        // succeeded must not keep the earlier message, which the Mongoose path's
        // "assign only when set" left standing on the reused document.
        //
        // `undefined` — not "falsy" — is what means "there was no failure". A caller
        // that legitimately caught a thrown `''`, `0` or `null` still gets a
        // classified message, because those are failures somebody threw and saying
        // so is the classifier's job.
        error:
          outcome.failure !== undefined
            ? merchantFacingFailureMessage(outcome.failure)
            : summarizeRecordFailures(recordFailures, outcome.counts.failed),
        updatedAt: now,
      })
      .where(eq(syncRuns.id, runId))
      .returning();
    // REPLACE, not append: `error` above is overwritten outright on a re-close
    // (explicitly to NULL when nothing was refused), and the rows have to follow
    // it exactly or a re-closed run carries a superseded attempt's refusals
    // beside a summary that no longer mentions them.
    await replaceSyncRunRecordFailures(tx, runId, perRecord, now);
    return row;
  });
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
 * ONE run, scoped to the connection it must belong to (#303).
 *
 * The scope is in the WHERE rather than checked after the read, and that is the
 * security property: the per-record failures hang off a run id a client
 * supplies, so a run belonging to another store's connection has to resolve to
 * nothing here rather than be fetched and then judged. Reading first and
 * comparing afterwards is the same rule spelled so that a later `return` before
 * the comparison is a cross-store disclosure.
 */
export async function findSyncRunForConnection(
  connectionId: string,
  runId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SyncRunRecord | undefined> {
  const [row] = await db
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.id, runId), eq(syncRuns.connectionId, connectionId)))
    .limit(1);
  return row;
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
  // The columns are SPREAD rather than nested under a `run:` key. Selecting a
  // whole TABLE into a field of a subquery and then re-selecting that subquery
  // throws at query-BUILD time — `Your "run->id" field references a column
  // "sync_runs"."id", but the table "sync_runs" is not part of the query` — for
  // every non-empty id list, so the early return above was the only path that
  // worked and both readers (`deriveChannelReadiness`, `channel-summary.service`)
  // failed on any store with a live connection. It survived because nothing ever
  // called this with rows: the empty-list branch answers before the builder runs,
  // which is exactly the shape of a test that proves nothing.
  const ranked = db
    .select({
      ...getTableColumns(syncRuns),
      rank: sql<number>`row_number() over (partition by ${syncRuns.connectionId} order by ${syncRuns.startedAt} desc, ${syncRuns.id} desc)`.as(
        'rank',
      ),
    })
    .from(syncRuns)
    .where(inArray(syncRuns.connectionId, [...connectionIds]))
    .as('ranked');

  const rows = await db.select().from(ranked).where(eq(ranked.rank, 1));
  return new Map(rows.map((row) => [row.connectionId, row]));
}
