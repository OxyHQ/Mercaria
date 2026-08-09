/**
 * Reads and writes for `catalog_source_runs` — the row that IS the job (#62
 * §"Observability", §"PostgreSQL concurrency" 5).
 *
 * `payment_provider_events`' arrangement rather than an outbox pointing at a
 * run: there is nothing to deliver, only work to resume, so the lease columns,
 * the cursor and the counters live on one row. A task that dies mid-pass leaves
 * a reclaimable row saying exactly where it got to.
 *
 * ## Counters are incremented in SQL, never read-modify-written
 *
 * A pass is many bounded pages and each page adds to the same row. Reading the
 * totals into the service and writing them back would lose a page whenever two
 * of them overlapped — which they do the moment a lease expires and a second
 * task picks the run up. `sql\`col + n\`` is what makes the arithmetic the
 * database's, and it is also what keeps
 * `catalog_source_runs_intake_total_check` satisfiable: the four intake
 * counters move in ONE statement, so the partition is never briefly untrue.
 */

import { and, asc, desc, eq, gt, lte, or, sql } from 'drizzle-orm';
import type {
  CatalogSourceHealthState,
  CatalogSourceRunKind,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { CATALOG_SOURCE_MAX_TEXT_LENGTH, catalogSourceRuns } from '../schema/ingestion.js';

export type CatalogSourceRunRow = typeof catalogSourceRuns.$inferSelect;

/** The intake partition, as one page observed it. Every record is in exactly one. */
export interface RunIntakeDelta {
  readonly fetched: number;
  readonly stored: number;
  readonly unchanged: number;
  readonly rejected: number;
  readonly quarantined: number;
}

/** The downstream tallies, as one page produced them. */
export interface RunPipelineDelta {
  readonly matched: number;
  readonly reviewRequired: number;
  readonly unmatched: number;
  readonly offersUpserted: number;
}

/** What one provider call cost. */
export interface RunFetchDelta {
  readonly fetchCount: number;
  readonly fetchDurationMs: number;
  readonly rateLimitHits: number;
}

/**
 * Open a pass, or return the one already open.
 *
 * `catalog_source_runs_open_key` is a partial unique on the unfinished
 * statuses, so two dispatchers opening a pass for one source converge on the
 * first — `ON CONFLICT DO NOTHING` plus a read, the `ensureCatalogSource`
 * pattern, where an empty `RETURNING` IS the "already open" answer rather than
 * an error to catch.
 */
export async function openSourceRun(
  db: DatabaseOrTransaction,
  input: {
    sourceId: string;
    kind: CatalogSourceRunKind;
    since: Date | null;
    requestedByOxyUserId: string | null;
    now: Date;
  },
): Promise<CatalogSourceRunRow> {
  const inserted = await db
    .insert(catalogSourceRuns)
    .values({
      sourceId: input.sourceId,
      kind: input.kind,
      status: 'pending',
      since: input.since,
      availableAt: input.now,
      requestedByOxyUserId: input.requestedByOxyUserId,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row) return row;

  const existing = await db
    .select()
    .from(catalogSourceRuns)
    .where(
      and(
        eq(catalogSourceRuns.sourceId, input.sourceId),
        sql`${catalogSourceRuns.status} in ('pending', 'running')`,
      ),
    )
    .limit(1);
  const open = existing[0];
  if (!open) {
    // The insert conflicted, so a row existed — a read that then finds nothing
    // is a real failure, not a race to hide.
    throw new Error(`catalog_source_runs open row for ${input.sourceId} vanished between claim and read.`);
  }
  return open;
}

/**
 * Atomically claim due runs.
 *
 * Two branches — due PENDING work and PROCESSING work whose lease expired —
 * each served by its own partial index, the outbox shape. `lease_until <= now`
 * is NULL for a never-leased row, and a `WHERE` rejects only FALSE, so the
 * reclaim branch excludes them by the comparison itself.
 */
export async function claimSourceRuns(
  db: DatabaseOrTransaction,
  options: { leaseOwner: string; batchSize: number; leaseMs: number; now: Date },
): Promise<CatalogSourceRunRow[]> {
  const leaseUntil = new Date(options.now.getTime() + options.leaseMs);
  const due = or(
    and(eq(catalogSourceRuns.status, 'pending'), lte(catalogSourceRuns.availableAt, options.now)),
    and(eq(catalogSourceRuns.status, 'running'), lte(catalogSourceRuns.leaseUntil, options.now)),
  );

  return db
    .update(catalogSourceRuns)
    .set({
      status: 'running',
      leaseOwner: options.leaseOwner,
      leaseUntil,
      attempts: sql`${catalogSourceRuns.attempts} + 1`,
      startedAt: sql`coalesce(${catalogSourceRuns.startedAt}, ${options.now})`,
      lastError: null,
    })
    .where(
      sql`${catalogSourceRuns.id} in (
        select ${catalogSourceRuns.id} from ${catalogSourceRuns}
        where ${due}
        order by ${asc(catalogSourceRuns.availableAt)}
        limit ${Math.max(1, options.batchSize)}
        for update skip locked
      )`,
    )
    .returning();
}

/** Only the lease this task currently owns matches — every terminal write carries it. */
function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(catalogSourceRuns.id, id),
    eq(catalogSourceRuns.status, 'running'),
    eq(catalogSourceRuns.leaseOwner, leaseOwner),
    gt(catalogSourceRuns.leaseUntil, now),
  );
}

/**
 * Add one page's work to the run, and move the cursor.
 *
 * All eleven counters and the cursor move in ONE statement, which is what keeps
 * the intake partition true at every instant a reader could observe it. The
 * lease owner is checked, so a task whose lease was reclaimed cannot add its
 * page to a run another task is now driving.
 */
export async function recordSourceRunPage(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    leaseOwner: string;
    cursor: string | null;
    enumerationComplete: boolean;
    intake: RunIntakeDelta;
    pipeline: RunPipelineDelta;
    fetch: RunFetchDelta;
    leaseUntil: Date;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(catalogSourceRuns)
    .set({
      cursor: input.cursor,
      // Once true it stays true: a run's completeness is established by the page
      // that finished the enumeration, and a later bookkeeping write must not
      // withdraw the fact that authorises retirement.
      enumerationComplete: sql`${catalogSourceRuns.enumerationComplete} or ${input.enumerationComplete}`,
      fetched: sql`${catalogSourceRuns.fetched} + ${input.intake.fetched}`,
      stored: sql`${catalogSourceRuns.stored} + ${input.intake.stored}`,
      unchanged: sql`${catalogSourceRuns.unchanged} + ${input.intake.unchanged}`,
      rejected: sql`${catalogSourceRuns.rejected} + ${input.intake.rejected}`,
      quarantined: sql`${catalogSourceRuns.quarantined} + ${input.intake.quarantined}`,
      matched: sql`${catalogSourceRuns.matched} + ${input.pipeline.matched}`,
      reviewRequired: sql`${catalogSourceRuns.reviewRequired} + ${input.pipeline.reviewRequired}`,
      unmatched: sql`${catalogSourceRuns.unmatched} + ${input.pipeline.unmatched}`,
      offersUpserted: sql`${catalogSourceRuns.offersUpserted} + ${input.pipeline.offersUpserted}`,
      fetchCount: sql`${catalogSourceRuns.fetchCount} + ${input.fetch.fetchCount}`,
      fetchDurationMs: sql`${catalogSourceRuns.fetchDurationMs} + ${input.fetch.fetchDurationMs}`,
      rateLimitHits: sql`${catalogSourceRuns.rateLimitHits} + ${input.fetch.rateLimitHits}`,
      leaseUntil: input.leaseUntil,
    })
    .where(ownedLease(input.id, input.leaseOwner, input.now))
    .returning({ id: catalogSourceRuns.id });
  return rows.length === 1;
}

/**
 * Add the retirement count, separately from a page.
 *
 * Its own statement because `catalog_source_runs_retirement_check` bites here
 * and nowhere else: writing a non-zero count against a run that did not
 * complete a full enumeration, or whose outcome is not in the retiring set, is
 * refused by the row. Keeping it out of the page write means a legitimate page
 * can never be rejected by a rule about a later step.
 */
export async function recordSourceRunRetirement(
  db: DatabaseOrTransaction,
  input: { id: string; retired: number },
): Promise<void> {
  if (input.retired === 0) return;
  await db
    .update(catalogSourceRuns)
    .set({ offersRetired: sql`${catalogSourceRuns.offersRetired} + ${input.retired}` })
    .where(eq(catalogSourceRuns.id, input.id));
}

/**
 * Finish a run with its health outcome.
 *
 * The outcome must be set before any retirement count is written — the CHECK
 * reads both — which is why `ingest.service` classifies, closes, and only then
 * retires. Ordering stated once, here and in the service's own docblock,
 * because a constraint whose satisfaction depends on statement order deserves
 * to be documented on both sides of it.
 */
export async function finishSourceRun(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    leaseOwner: string;
    outcome: CatalogSourceHealthState;
    failed: boolean;
    error: string | null;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(catalogSourceRuns)
    .set({
      status: input.failed ? 'failed' : 'completed',
      outcome: input.outcome,
      finishedAt: input.now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: input.error === null ? null : input.error.slice(0, CATALOG_SOURCE_MAX_TEXT_LENGTH),
    })
    .where(ownedLease(input.id, input.leaseOwner, input.now))
    .returning({ id: catalogSourceRuns.id });
  return rows.length === 1;
}

/**
 * Release a claim without finishing it — the retry path.
 *
 * The run stays `pending` with its cursor intact, so the next claim resumes
 * from the page that failed rather than from the top. There is deliberately no
 * `dead_letter` STATUS: a run that keeps failing is visible as a climbing
 * `attempts` beside a `failed` health state on its source, and a status that
 * took it out of the queue would need a person to notice and re-open it. The
 * bound on retrying is the source's own backoff.
 */
export async function releaseSourceRun(
  db: DatabaseOrTransaction,
  input: { id: string; leaseOwner: string; availableAt: Date; error: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(catalogSourceRuns)
    .set({
      status: 'pending',
      availableAt: input.availableAt,
      leaseOwner: null,
      leaseUntil: null,
      lastError: input.error.slice(0, CATALOG_SOURCE_MAX_TEXT_LENGTH),
    })
    .where(ownedLease(input.id, input.leaseOwner, input.now))
    .returning({ id: catalogSourceRuns.id });
  return rows.length === 1;
}

export async function findSourceRun(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogSourceRunRow | undefined> {
  const rows = await db.select().from(catalogSourceRuns).where(eq(catalogSourceRuns.id, id)).limit(1);
  return rows[0];
}

/** One source's runs, newest first — the observability read. */
export async function listSourceRuns(
  db: DatabaseOrTransaction = getDb(),
  sourceId: string,
  limit = 25,
): Promise<CatalogSourceRunRow[]> {
  return db
    .select()
    .from(catalogSourceRuns)
    .where(eq(catalogSourceRuns.sourceId, sourceId))
    .orderBy(desc(catalogSourceRuns.createdAt))
    .limit(limit);
}
