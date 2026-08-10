/**
 * `price_signal_runs` and `price_signal_evaluations` — the measurement sweep and
 * what it found (#82 monitoring 1, 2, 3 and 6).
 *
 * The run is a LEASED job with an owner check, the shape every queue in this
 * codebase uses (`FOR UPDATE SKIP LOCKED`, an owner-checked release, capped
 * attempts). What is different is what it produces: the evaluations are EVIDENCE
 * and the repository offers no update and no delete for them, because a
 * measurement that can be rewritten measures nothing.
 */

import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { PriceSignalKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { canonicalProducts } from '../schema/canonicalCatalog.js';
import { priceSignalEvaluations, priceSignalRuns } from '../schema/priceSignals.js';

export type PriceSignalRunRow = typeof priceSignalRuns.$inferSelect;
export type InsertPriceSignalRun = typeof priceSignalRuns.$inferInsert;
export type PriceSignalEvaluationRow = typeof priceSignalEvaluations.$inferSelect;
export type InsertPriceSignalEvaluation = typeof priceSignalEvaluations.$inferInsert;

export async function insertPriceSignalRun(
  values: InsertPriceSignalRun,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalRunRow> {
  const rows = await db.insert(priceSignalRuns).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertPriceSignalRun returned no row.');
  return row;
}

export async function findPriceSignalRun(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalRunRow | undefined> {
  const rows = await db.select().from(priceSignalRuns).where(eq(priceSignalRuns.id, id)).limit(1);
  return rows[0];
}

/** Runs newest first — the operator list, and the mass-change detector's input. */
export async function listPriceSignalRuns(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalRunRow[]> {
  return db.select().from(priceSignalRuns).orderBy(desc(priceSignalRuns.createdAt)).limit(limit);
}

/**
 * The run immediately BEFORE this one, under the same cohort and mode.
 *
 * Same cohort and same mode, because "sudden mass signal changes" is a claim
 * about a comparable pair: diffing a candidate's dry run against the live
 * measurement would report the candidate's whole effect as an incident, which is
 * exactly what a candidate run is for.
 */
export async function findPreviousPriceSignalRun(
  run: PriceSignalRunRow,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalRunRow | undefined> {
  const rows = await db
    .select()
    .from(priceSignalRuns)
    .where(
      and(
        eq(priceSignalRuns.mode, run.mode),
        eq(priceSignalRuns.displayCurrency, run.displayCurrency),
        run.market === null
          ? isNull(priceSignalRuns.market)
          : eq(priceSignalRuns.market, run.market),
        eq(priceSignalRuns.status, 'done'),
        sql`${priceSignalRuns.createdAt} < ${run.createdAt.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(priceSignalRuns.createdAt))
    .limit(1);
  return rows[0];
}

/**
 * Claim one due run — pending, or processing with an expired lease.
 *
 * `FOR UPDATE SKIP LOCKED` so N dispatchers drain without handing each other the
 * same row, and the claim RETURNS the row it took rather than a count: the empty
 * set IS "somebody else has it", which is the only answer that cannot be
 * confused with a failure.
 */
export async function claimPriceSignalRun(
  leaseOwner: string,
  leaseUntil: Date,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalRunRow | undefined> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: priceSignalRuns.id })
      .from(priceSignalRuns)
      .where(
        or(
          eq(priceSignalRuns.status, 'pending'),
          and(eq(priceSignalRuns.status, 'processing'), lte(priceSignalRuns.leaseUntil, now)),
        ),
      )
      .orderBy(asc(priceSignalRuns.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });

    const target = due[0];
    if (target === undefined) return undefined;

    const rows = await tx
      .update(priceSignalRuns)
      .set({
        status: 'processing',
        leaseOwner,
        leaseUntil,
        startedAt: now,
        attempts: sql`${priceSignalRuns.attempts} + 1`,
      })
      .where(eq(priceSignalRuns.id, target.id))
      .returning();
    return rows[0];
  });
}

/**
 * Record a page's progress and, when it is the last one, finish the run.
 *
 * The owner check is in the WHERE: a dispatcher whose lease expired mid-page must
 * not write over the successor that reclaimed it, and the empty `RETURNING` set
 * is how it finds out.
 */
export async function advancePriceSignalRun(
  input: {
    readonly runId: string;
    readonly leaseOwner: string;
    readonly cursorCanonicalProductId?: string;
    readonly subjectsScanned: number;
    readonly subjectsMeasured: number;
    readonly subjectsUnmeasured: number;
    readonly subjectsFailed: number;
    readonly signalsEvaluated: number;
    readonly signalsMeasured: number;
    readonly signalsNotPresent: number;
    readonly signalsUnmeasured: number;
    readonly finished: boolean;
    readonly finishedAt?: Date;
    readonly leaseUntil?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalRunRow | undefined> {
  const rows = await db
    .update(priceSignalRuns)
    .set({
      ...(input.cursorCanonicalProductId === undefined
        ? {}
        : { cursorCanonicalProductId: input.cursorCanonicalProductId }),
      subjectsScanned: sql`${priceSignalRuns.subjectsScanned} + ${input.subjectsScanned}`,
      subjectsMeasured: sql`${priceSignalRuns.subjectsMeasured} + ${input.subjectsMeasured}`,
      subjectsUnmeasured: sql`${priceSignalRuns.subjectsUnmeasured} + ${input.subjectsUnmeasured}`,
      subjectsFailed: sql`${priceSignalRuns.subjectsFailed} + ${input.subjectsFailed}`,
      signalsEvaluated: sql`${priceSignalRuns.signalsEvaluated} + ${input.signalsEvaluated}`,
      signalsMeasured: sql`${priceSignalRuns.signalsMeasured} + ${input.signalsMeasured}`,
      signalsNotPresent: sql`${priceSignalRuns.signalsNotPresent} + ${input.signalsNotPresent}`,
      signalsUnmeasured: sql`${priceSignalRuns.signalsUnmeasured} + ${input.signalsUnmeasured}`,
      ...(input.finished
        ? { status: 'done' as const, finishedAt: input.finishedAt ?? new Date(), leaseOwner: null, leaseUntil: null }
        : input.leaseUntil === undefined
          ? {}
          : { leaseUntil: input.leaseUntil }),
    })
    .where(and(eq(priceSignalRuns.id, input.runId), eq(priceSignalRuns.leaseOwner, input.leaseOwner)))
    .returning();
  return rows[0];
}

/** Release a run that failed, so it is retried from its cursor rather than lost. */
export async function failPriceSignalRun(
  runId: string,
  leaseOwner: string,
  lastError: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(priceSignalRuns)
    .set({ status: 'failed', leaseOwner: null, leaseUntil: null, lastError: lastError.slice(0, 500) })
    .where(and(eq(priceSignalRuns.id, runId), eq(priceSignalRuns.leaseOwner, leaseOwner)));
}

/**
 * Write a page's evaluations.
 *
 * `ON CONFLICT DO NOTHING` on `(run_id, subject_key, signal_kind)`, so a run
 * resumed after a crash converges on the rows it already wrote instead of
 * failing on them — and converges to a genuine NO-OP rather than to a second
 * measurement of the same subject under the same policy.
 */
export async function insertPriceSignalEvaluations(
  values: readonly InsertPriceSignalEvaluation[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (values.length === 0) return 0;
  const rows = await db
    .insert(priceSignalEvaluations)
    .values([...values])
    .onConflictDoNothing()
    .returning({ id: priceSignalEvaluations.id });
  return rows.length;
}

/**
 * How many evaluations a run actually WROTE, counted from the evidence.
 *
 * #60's `scannedFromRecords` device: a sweep whose page swallowed a subject
 * reports perfectly healthy counters, and the only thing that can see it is a
 * second count taken from what landed. The metrics surface reports both and
 * whether they agree.
 */
export async function countPriceSignalEvaluations(
  runId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(priceSignalEvaluations)
    .where(eq(priceSignalEvaluations.runId, runId));
  return rows[0]?.total ?? 0;
}

/** The unmeasured reasons a run recorded, so a falling coverage rate is diagnosable. */
export async function summarizeUnmeasuredReasons(
  runId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Record<string, number>> {
  const rows = await db
    .select({ reason: priceSignalEvaluations.unmeasuredReason, total: count() })
    .from(priceSignalEvaluations)
    .where(
      and(eq(priceSignalEvaluations.runId, runId), eq(priceSignalEvaluations.state, 'unmeasured')),
    )
    .groupBy(priceSignalEvaluations.unmeasuredReason);

  const summary: Record<string, number> = {};
  for (const row of rows) {
    if (row.reason === null) continue;
    summary[row.reason] = row.total;
  }
  return summary;
}

/**
 * The label distribution of one run, broken down by market (issue monitoring 2).
 *
 * `source` and `category` are the other two dimensions the issue names and they
 * are answered by the caller joining what it already holds; the MARKET is the one
 * this table carries directly.
 */
export async function summarizeLabelsByMarket(
  runId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ market: string | null; label: string | null; total: number }[]> {
  return db
    .select({
      market: priceSignalEvaluations.market,
      label: priceSignalEvaluations.label,
      total: count(),
    })
    .from(priceSignalEvaluations)
    .where(
      and(
        eq(priceSignalEvaluations.runId, runId),
        eq(priceSignalEvaluations.signalKind, 'price_quality_label'),
      ),
    )
    .groupBy(priceSignalEvaluations.market, priceSignalEvaluations.label);
}

/**
 * Every `(subject, kind)` verdict of one run, for the mass-change diff.
 *
 * Bounded by `limit`, and the caller compares the INTERSECTION of two runs'
 * subjects: a subject present in one and absent from the other has not changed
 * its label, it has entered or left the cohort, and counting that as a change
 * would make every cohort growth look like an incident.
 */
export async function listRunVerdicts(
  runId: string,
  kinds: readonly PriceSignalKind[],
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ subjectKey: string; signalKind: string; state: string; label: string | null }[]> {
  if (kinds.length === 0) return [];
  return db
    .select({
      subjectKey: priceSignalEvaluations.subjectKey,
      signalKind: priceSignalEvaluations.signalKind,
      state: priceSignalEvaluations.state,
      label: priceSignalEvaluations.label,
    })
    .from(priceSignalEvaluations)
    .where(
      and(
        eq(priceSignalEvaluations.runId, runId),
        inArray(priceSignalEvaluations.signalKind, [...kinds]),
      ),
    )
    .orderBy(asc(priceSignalEvaluations.subjectKey))
    .limit(limit);
}

/** One subject's recorded history, for the operator trace. */
export async function listEvaluationsForSubject(
  subjectKey: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalEvaluationRow[]> {
  return db
    .select()
    .from(priceSignalEvaluations)
    .where(eq(priceSignalEvaluations.subjectKey, subjectKey))
    .orderBy(desc(priceSignalEvaluations.evaluatedAt))
    .limit(limit);
}

/**
 * The next page of canonical products a run examines.
 *
 * A keyset over the id, which is what makes a run RESUMABLE from its cursor
 * after a crash rather than restarting and double-counting into counters a CHECK
 * would then refuse.
 */
export async function listCohortProductIds(
  input: { readonly afterId?: string; readonly limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: canonicalProducts.id })
    .from(canonicalProducts)
    .where(
      and(
        eq(canonicalProducts.status, 'active'),
        input.afterId === undefined ? undefined : gt(canonicalProducts.id, input.afterId),
      ),
    )
    .orderBy(asc(canonicalProducts.id))
    .limit(input.limit);
  return rows.map((row) => row.id);
}
