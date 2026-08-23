/**
 * `catalog_backfill_runs` — opening, claiming, checkpointing and closing one
 * staged migration pass (#60 job behaviour 2).
 *
 * The `match_sweep_cursors` repository, ported, with the same two properties
 * carried over unchanged because they are why that shape exists:
 *
 * - **The cursor and the counters are made durable BEFORE the lease is given
 *   up.** A pass is many bounded PAGES, and a crash between advancing and
 *   releasing must resume where it stopped rather than repeat the page it just
 *   finished — which for this domain would mean double-enqueueing a catalogue.
 * - **The claim is `FOR UPDATE SKIP LOCKED` inside a transaction**, so a second
 *   ECS task finds the row locked, skips it, and answers "somebody else is
 *   running this" instead of blocking on a lock.
 *
 * And one property that is this domain's own: **counters are added to, never
 * assigned.** Every advance is `scanned = scanned + $n`, and
 * `mercaria_backfill_run_counters_monotonic` refuses an UPDATE that lowers one.
 * A migration report that can be rewritten downwards is a migration report
 * nobody can trust after the fact.
 */

import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  CatalogBackfillCohortKind,
  CatalogBackfillMode,
  CatalogBackfillStage,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { CATALOG_BACKFILL_MAX_TEXT_LENGTH, catalogBackfillRuns } from '../schema/backfill.js';

export type CatalogBackfillRunRow = typeof catalogBackfillRuns.$inferSelect;

/** Bounds ONE page, not a pass — the `match_sweep_cursors` value, for its reasons. */
export const CATALOG_BACKFILL_LEASE_MS = 5 * 60 * 1_000;

/** The statuses a run may still be resumed from. */
const RESUMABLE = ['pending', 'paused'] as const;

export interface OpenBackfillRunInput {
  readonly stage: CatalogBackfillStage;
  readonly mode: CatalogBackfillMode;
  readonly mappingVersion: number;
  readonly cohortKind: CatalogBackfillCohortKind;
  readonly cohortValue: string | null;
  readonly requestedByOxyUserId: string;
}

/**
 * Open a run, or return the OPEN one that already covers this
 * (stage, mode, mapping version, cohort).
 *
 * Converging rather than throwing is deliberate and is the same decision
 * `createVariant` makes: an operator pressing the button twice, and a dispatcher
 * resuming after a restart, both mean "make progress on this pass", and two
 * cursors over one catalogue is the one outcome that would double the work.
 * `catalog_backfill_runs_open_key` is the arbiter and it is PARTIAL, so the
 * conflict target repeats its predicate — Postgres refuses to infer an arbiter
 * from a partial index otherwise (the `carts` lesson, #104).
 */
export async function openBackfillRun(
  input: OpenBackfillRunInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ run: CatalogBackfillRunRow; created: boolean }> {
  const inserted = await db
    .insert(catalogBackfillRuns)
    .values({
      stage: input.stage,
      mode: input.mode,
      mappingVersion: input.mappingVersion,
      cohortKind: input.cohortKind,
      cohortValue: input.cohortValue,
      requestedByOxyUserId: input.requestedByOxyUserId,
    })
    .onConflictDoNothing({
      target: [
        catalogBackfillRuns.stage,
        catalogBackfillRuns.mode,
        catalogBackfillRuns.mappingVersion,
        catalogBackfillRuns.cohortKind,
        catalogBackfillRuns.cohortValue,
      ],
      where: sql`${catalogBackfillRuns.status} in ('pending', 'running', 'paused')`,
    })
    .returning();

  const created = inserted[0];
  if (created) return { run: created, created: true };

  const existing = await findOpenBackfillRun(input, db);
  if (!existing) {
    // The open run was closed between the refused insert and this read. A retry
    // is the honest answer — inventing a row here would race the closer.
    throw new Error(
      `Backfill run for ${input.stage}/${input.mode} raced a concurrent close; retry.`,
    );
  }
  return { run: existing, created: false };
}

/** The open run for one (stage, mode, mapping version, cohort), if any. */
export async function findOpenBackfillRun(
  input: Omit<OpenBackfillRunInput, 'requestedByOxyUserId'>,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogBackfillRunRow | undefined> {
  const rows = await db
    .select()
    .from(catalogBackfillRuns)
    .where(
      and(
        eq(catalogBackfillRuns.stage, input.stage),
        eq(catalogBackfillRuns.mode, input.mode),
        eq(catalogBackfillRuns.mappingVersion, input.mappingVersion),
        eq(catalogBackfillRuns.cohortKind, input.cohortKind),
        input.cohortValue === null
          ? isNull(catalogBackfillRuns.cohortValue)
          : eq(catalogBackfillRuns.cohortValue, input.cohortValue),
        inArray(catalogBackfillRuns.status, ['pending', 'running', 'paused']),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function findBackfillRunById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogBackfillRunRow | undefined> {
  const rows = await db
    .select()
    .from(catalogBackfillRuns)
    .where(eq(catalogBackfillRuns.id, id))
    .limit(1);
  return rows[0];
}

/**
 * Take the page lease for one run.
 *
 * @returns The claimed row, or `undefined` when another task holds the lease.
 *   Deliberately distinguishable from "there was nothing left": a caller that
 *   collapsed the two would report a completed migration for a pass another task
 *   is halfway through.
 */
export async function claimBackfillRun(
  input: { runId: string; leaseOwner: string; leaseMs?: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogBackfillRunRow | undefined> {
  const now = input.now ?? new Date();
  const leaseMs = Math.max(1_000, input.leaseMs ?? CATALOG_BACKFILL_LEASE_MS);

  return db.transaction(async (tx) => {
    const claimable = await tx
      .select({ id: catalogBackfillRuns.id })
      .from(catalogBackfillRuns)
      .where(
        and(
          eq(catalogBackfillRuns.id, input.runId),
          or(
            inArray(catalogBackfillRuns.status, [...RESUMABLE]),
            // A `running` row whose lease expired: the task that held it died.
            and(
              eq(catalogBackfillRuns.status, 'running'),
              lt(catalogBackfillRuns.leaseUntil, now),
            ),
          ),
        ),
      )
      .for('update', { skipLocked: true })
      .limit(1);
    if (claimable.length === 0) return undefined;

    const claimed = await tx
      .update(catalogBackfillRuns)
      .set({
        status: 'running',
        leaseOwner: input.leaseOwner,
        leaseUntil: new Date(now.getTime() + leaseMs),
        lastRunAt: now,
        /**
         * A run that has never started gets its start stamp here, and only here,
         * so `started_at IS NULL` and `status = 'pending'` cannot disagree
         * (`catalog_backfill_runs_started_shape_check`).
         *
         * The timestamp is bound as an ISO STRING with an explicit cast, never as
         * a `Date`: postgres.js infers a parameter's wire type from ordinary
         * positional binding, and a parameter sitting inside a function call like
         * `coalesce(...)` is outside that inference — a bare `Date` there throws
         * in the DRIVER before the server ever sees the statement, with an error
         * that does not name the cause (`~/Oxy/AGENTS.md` §Drizzle `sql`
         * templates). Caught by `backfill.realdb.test.ts`; a mocked test cannot
         * see it at all.
         */
        startedAt: sql`coalesce(${catalogBackfillRuns.startedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(eq(catalogBackfillRuns.id, input.runId))
      .returning();
    return claimed[0];
  });
}

/** The per-outcome deltas one page produced. */
export interface BackfillCounterDelta {
  readonly scanned: number;
  readonly unchanged: number;
  readonly matched: number;
  readonly created: number;
  readonly enqueued: number;
  readonly reviewRequired: number;
  readonly unmatched: number;
  readonly skipped: number;
  readonly failed: number;
}

/** A page that classified nothing — the identity of {@link addCounters}. */
export const EMPTY_COUNTERS: BackfillCounterDelta = {
  scanned: 0,
  unchanged: 0,
  matched: 0,
  created: 0,
  enqueued: 0,
  reviewRequired: 0,
  unmatched: 0,
  skipped: 0,
  failed: 0,
};

/** Sum two deltas. Used by a stage assembling one page out of several loops. */
export function addCounters(
  left: BackfillCounterDelta,
  right: BackfillCounterDelta,
): BackfillCounterDelta {
  return {
    scanned: left.scanned + right.scanned,
    unchanged: left.unchanged + right.unchanged,
    matched: left.matched + right.matched,
    created: left.created + right.created,
    enqueued: left.enqueued + right.enqueued,
    reviewRequired: left.reviewRequired + right.reviewRequired,
    unmatched: left.unmatched + right.unmatched,
    skipped: left.skipped + right.skipped,
    failed: left.failed + right.failed,
  };
}

/**
 * Move the cursor and ADD the page's counters, owner-checked.
 *
 * Does NOT extend the lease: a run is one page at a time, and the release that
 * follows hands the next page to whoever claims it. `+` rather than `=` on every
 * counter — see the module docblock.
 *
 * @returns `false` when the lease had already been reclaimed, in which case the
 *   caller's page result is discarded rather than written over the new owner's.
 */
export async function advanceBackfillRun(
  input: {
    runId: string;
    leaseOwner: string;
    cursor: string | null;
    counters: BackfillCounterDelta;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const { counters } = input;
  const rows = await db
    .update(catalogBackfillRuns)
    .set({
      cursor: input.cursor,
      scanned: sql`${catalogBackfillRuns.scanned} + ${counters.scanned}`,
      unchanged: sql`${catalogBackfillRuns.unchanged} + ${counters.unchanged}`,
      matched: sql`${catalogBackfillRuns.matched} + ${counters.matched}`,
      created: sql`${catalogBackfillRuns.created} + ${counters.created}`,
      enqueued: sql`${catalogBackfillRuns.enqueued} + ${counters.enqueued}`,
      reviewRequired: sql`${catalogBackfillRuns.reviewRequired} + ${counters.reviewRequired}`,
      unmatched: sql`${catalogBackfillRuns.unmatched} + ${counters.unmatched}`,
      skipped: sql`${catalogBackfillRuns.skipped} + ${counters.skipped}`,
      failed: sql`${catalogBackfillRuns.failed} + ${counters.failed}`,
      // A page that advanced is a page that worked, so the consecutive-failure
      // budget starts over. This is what makes the count CONSECUTIVE rather
      // than a lifetime one, and it is the right shape for a pass whose cursor
      // survives every failure: a run that fails once, recovers and fails again
      // six pages later has not exhausted anything.
      consecutiveFailures: 0,
    })
    .where(
      and(
        eq(catalogBackfillRuns.id, input.runId),
        eq(catalogBackfillRuns.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: catalogBackfillRuns.id });
  return rows.length === 1;
}

/**
 * Record a page-level failure and say whether the run may be retried
 * (#367 W16 line 759).
 *
 * Increments `consecutive_failures` and releases the lease, choosing the status
 * from the incremented value against `maxAttempts`:
 *
 * - **below the ceiling** → `paused`, which IS in `RESUMABLE`, so the
 *   dispatcher picks the run up on its next tick and re-reads the same page.
 *   The cursor was never moved, so the retry is exact.
 *
 *   `paused` and NOT `pending`:
 *   `catalog_backfill_runs_started_shape_check` is the biconditional
 *   `(status = 'pending') = (started_at is null)`, so `pending` means NEVER
 *   STARTED rather than ready-to-run. A claimed run has a `started_at`, so
 *   `pending` is unrepresentable for it — the database refuses the write, and
 *   it is right to: `paused` already means started, holding a cursor, waiting
 *   for its next page, which is exactly what a retryable failure leaves
 *   behind. It is also the state a SUCCESSFUL non-final page releases to, so
 *   a retry and an ordinary pause are the same shape to every reader.
 * - **at or above it** → `failed`, which is NOT in `RESUMABLE` and therefore
 *   terminal. That is the dead-letter this domain already had; what it lacked
 *   was anything before it.
 *
 * ## Why this is not "make `failed` claimable"
 *
 * Because `failed` has a SECOND producer. `cancelCatalogBackfillRun` releases
 * to `failed` with the operator's reason in `last_error`, deliberately, since a
 * cancelled pass and a broken one are the same fact to every reader of this
 * table. Widening the claim predicate to include `failed` would make the
 * dispatcher restart a run an operator had just stopped — silently, within
 * fifteen seconds. So the retry happens BEFORE the terminal state, never out of
 * it, and cancellation keeps working unchanged because it does not come through
 * this function at all.
 *
 * The owner check is the same one `releaseBackfillRun` applies: a task whose
 * lease was reclaimed mid-page must not write its verdict over the new owner's.
 *
 * @returns The status it settled on, or `undefined` when the lease was gone.
 */
export async function recordBackfillPageFailure(
  input: {
    runId: string;
    leaseOwner: string;
    maxAttempts: number;
    error: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<'paused' | 'failed' | undefined> {
  const now = input.now ?? new Date();
  // ONE statement: the increment and the decision are the same write, so two
  // tasks cannot both read `consecutive_failures` and both decide to retry.
  //
  // `least(...)` is not defending against a race — the claim predicate already
  // makes one impossible, because a run that reached the ceiling is `failed`,
  // `failed` is not claimable, and no lease means no increment. What it defends
  // against is the CEILING MOVING: `maxAttempts` is an env var, so a run sitting
  // at 5 when somebody lowers it from 8 to 3 would otherwise store 6 — a count
  // above the ceiling it was judged by, which reads as having spent more budget
  // than exists. The clamp keeps the number meaning "how far into the budget"
  // under a ceiling that changed.
  const rows = await db
    .update(catalogBackfillRuns)
    .set({
      consecutiveFailures: sql`least(${catalogBackfillRuns.consecutiveFailures} + 1, ${input.maxAttempts})`,
      status: sql`case
        when ${catalogBackfillRuns.consecutiveFailures} + 1 >= ${input.maxAttempts} then 'failed'
        else 'paused'
      end`,
      leaseOwner: null,
      leaseUntil: null,
      lastError: input.error.slice(0, CATALOG_BACKFILL_MAX_TEXT_LENGTH),
      lastRunAt: now,
    })
    .where(
      and(
        eq(catalogBackfillRuns.id, input.runId),
        eq(catalogBackfillRuns.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ status: catalogBackfillRuns.status });
  const settled = rows[0];
  if (settled === undefined) return undefined;
  return settled.status === 'failed' ? 'failed' : 'paused';
}

/**
 * Give the lease back.
 *
 * Only a COMPLETED pass clears the cursor and stamps `completed_at`; an
 * incomplete release keeps the cursor, which is the whole of "resumable". A
 * FAILED release keeps it too — the page that raised is retried from where it
 * started, not skipped.
 *
 * A page-level FAILURE does not come through here any more: it goes to
 * {@link recordBackfillPageFailure}, which counts it first. This function still
 * accepts `failed` because operator CANCELLATION uses it, and a cancellation is
 * terminal on the first and only attempt.
 */
export async function releaseBackfillRun(
  input: {
    runId: string;
    leaseOwner: string;
    outcome: 'paused' | 'completed' | 'failed';
    error?: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(catalogBackfillRuns)
    .set({
      status: input.outcome,
      leaseOwner: null,
      leaseUntil: null,
      lastError:
        input.error === undefined ? null : input.error.slice(0, CATALOG_BACKFILL_MAX_TEXT_LENGTH),
      ...(input.outcome === 'completed' ? { cursor: null, completedAt: now } : {}),
    })
    .where(
      and(
        eq(catalogBackfillRuns.id, input.runId),
        eq(catalogBackfillRuns.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: catalogBackfillRuns.id });
  return rows.length === 1;
}

/**
 * Every run the dispatcher may resume, oldest first.
 *
 * Includes `running` rows whose lease has expired, which is how a task that died
 * mid-page hands its work on rather than stranding a pass — the `offer_outboxes`
 * two-branch claim, one table over.
 */
export async function listResumableBackfillRuns(
  options: { limit: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogBackfillRunRow[]> {
  const now = options.now ?? new Date();
  return db
    .select()
    .from(catalogBackfillRuns)
    .where(
      or(
        inArray(catalogBackfillRuns.status, [...RESUMABLE]),
        and(eq(catalogBackfillRuns.status, 'running'), lt(catalogBackfillRuns.leaseUntil, now)),
      ),
    )
    .orderBy(asc(catalogBackfillRuns.createdAt))
    .limit(Math.max(1, options.limit));
}

/** Every run of one mapping version, newest first — the metrics and report read. */
export async function listBackfillRuns(
  options: { mappingVersion?: number; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogBackfillRunRow[]> {
  const query = db.select().from(catalogBackfillRuns);
  const filtered =
    options.mappingVersion === undefined
      ? query
      : query.where(eq(catalogBackfillRuns.mappingVersion, options.mappingVersion));
  return filtered
    .orderBy(desc(catalogBackfillRuns.createdAt))
    .limit(Math.min(200, Math.max(1, options.limit)));
}
