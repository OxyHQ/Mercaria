/**
 * `match_benchmark_runs` and `match_benchmark_categories` — the measurement a
 * category gate cites (#58 evaluation, acceptance 5).
 *
 * ## The four rates are never written, and this module could not write them
 *
 * They are `GENERATED ALWAYS ... STORED` columns, so Postgres refuses an INSERT
 * that supplies one (SQLSTATE `428C9`). What a caller supplies is the confusion
 * matrix and the outcome counts, and the CHECKs on the table refuse a set whose
 * parts do not partition the total. A precision this repository could accept but
 * not have measured does not exist.
 *
 * ## A run and its slices commit together
 *
 * `recordBenchmarkRun` takes a transaction handle and writes both, because a run
 * with no slices is a measurement of nothing and a slice with no run is a number
 * with no dataset behind it. The append-only trigger then makes both permanent.
 */

import { desc, eq } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';
import { matchBenchmarkCategories, matchBenchmarkRuns } from '../schema/matching.js';

export type MatchBenchmarkRunRow = typeof matchBenchmarkRuns.$inferSelect;
export type MatchBenchmarkCategoryRow = typeof matchBenchmarkCategories.$inferSelect;

/** One measured slice. Counts only — every rate is the database's to derive. */
export interface BenchmarkSliceInput {
  readonly categoryKey: string;
  readonly sourceKey: string;
  readonly totalCases: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly automaticMatches: number;
  readonly manualReviews: number;
  readonly createNews: number;
}

export interface RecordBenchmarkRunInput {
  readonly policyVersionId: string;
  readonly datasetVersion: string;
  readonly datasetChecksum: string;
  readonly totalCases: number;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly startedByOxyUserId: string | null;
  readonly note: string | null;
  readonly slices: readonly BenchmarkSliceInput[];
}

/**
 * Write a completed run and every slice it measured, in ONE transaction.
 *
 * The run row is inserted already carrying `completed_at`, so the append-only
 * trigger's one permitted UPDATE — stamping a run finished — is never needed by
 * this path. It exists for a long-running operator run that opens a row first;
 * the benchmark runner writes its result whole because it holds every slice in
 * memory before it writes anything.
 */
export async function recordBenchmarkRun(
  db: DatabaseOrTransaction,
  input: RecordBenchmarkRunInput,
): Promise<MatchBenchmarkRunRow> {
  const runs = await db
    .insert(matchBenchmarkRuns)
    .values({
      policyVersionId: input.policyVersionId,
      datasetVersion: input.datasetVersion,
      datasetChecksum: input.datasetChecksum,
      totalCases: input.totalCases,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      startedByOxyUserId: input.startedByOxyUserId,
      note: input.note,
    })
    .returning();
  const run = runs[0];
  if (!run) throw new Error('recordBenchmarkRun returned no run row.');

  if (input.slices.length > 0) {
    await db.insert(matchBenchmarkCategories).values(
      input.slices.map((slice) => ({
        runId: run.id,
        policyVersionId: input.policyVersionId,
        categoryKey: slice.categoryKey,
        sourceKey: slice.sourceKey,
        totalCases: slice.totalCases,
        truePositives: slice.truePositives,
        falsePositives: slice.falsePositives,
        falseNegatives: slice.falseNegatives,
        trueNegatives: slice.trueNegatives,
        automaticMatches: slice.automaticMatches,
        manualReviews: slice.manualReviews,
        createNews: slice.createNews,
      })),
    );
  }

  return run;
}

export async function findBenchmarkRunById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MatchBenchmarkRunRow | undefined> {
  const rows = await db
    .select()
    .from(matchBenchmarkRuns)
    .where(eq(matchBenchmarkRuns.id, id))
    .limit(1);
  return rows[0];
}

export async function listBenchmarkRuns(
  db: DatabaseOrTransaction,
  limit = 25,
): Promise<MatchBenchmarkRunRow[]> {
  return db
    .select()
    .from(matchBenchmarkRuns)
    .orderBy(desc(matchBenchmarkRuns.startedAt))
    .limit(limit);
}

export async function listBenchmarkSlices(
  db: DatabaseOrTransaction,
  runId: string,
): Promise<MatchBenchmarkCategoryRow[]> {
  return db
    .select()
    .from(matchBenchmarkCategories)
    .where(eq(matchBenchmarkCategories.runId, runId))
    .orderBy(matchBenchmarkCategories.categoryKey, matchBenchmarkCategories.sourceKey);
}
