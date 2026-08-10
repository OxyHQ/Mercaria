/**
 * `search_intent_benchmark_runs` and `search_intent_enablements` — the only
 * writer of either (#95 "Evaluation", acceptance 7).
 *
 * ## An enablement cannot exist without the measurement that justified it
 *
 * `benchmark_run_id` is NOT NULL and the pair `(benchmark_run_id,
 * dataset_digest)` is a composite foreign key onto the run's own
 * `(id, dataset_digest)`. So "benchmark thresholds are recorded before enabling
 * the parser by category and language" is a constraint rather than a process:
 * there is no INSERT that could enable a pair without naming a run, and a run
 * measured against a dataset somebody has since edited carries a different
 * digest, which the enable path compares against the live dataset before
 * writing.
 *
 * `restrict` on the foreign key, not `cascade`: deleting a run that an
 * enablement rests on would leave the parser enabled with its justification
 * gone, which is the one direction that must not be possible by accident.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  searchIntentBenchmarkRuns,
  searchIntentEnablements,
} from '../schema/searchIntent.js';

/** One row of `search_intent_benchmark_runs`. */
export type SearchIntentBenchmarkRunRow = InferSelectModel<typeof searchIntentBenchmarkRuns>;

/** One row of `search_intent_enablements`. */
export type SearchIntentEnablementRow = InferSelectModel<typeof searchIntentEnablements>;

/** Everything a recorded run carries. */
export interface NewBenchmarkRun {
  readonly datasetVersion: string;
  readonly datasetDigest: string;
  readonly caseCount: number;
  readonly provider: string;
  readonly model?: string;
  readonly promptVersion: string;
  readonly parserVersion: string;
  readonly language: string;
  readonly categoryId?: string;
  readonly schemaValidity: number;
  readonly categoryAccuracy: number;
  readonly hardConstraintRecall: number;
  readonly falseHardConstraintRate: number;
  readonly clarificationPrecision: number;
  readonly latencyP95Ms: number;
  readonly costUnits: number;
  readonly fallbackRate: number;
  readonly sampleSize: number;
  readonly ranByOxyUserId: string;
}

/** Record one measured pass. */
export async function insertBenchmarkRun(
  input: NewBenchmarkRun,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentBenchmarkRunRow> {
  const [row] = await db
    .insert(searchIntentBenchmarkRuns)
    .values({
      datasetVersion: input.datasetVersion,
      datasetDigest: input.datasetDigest,
      caseCount: input.caseCount,
      provider: input.provider,
      ...(input.model === undefined ? {} : { model: input.model }),
      promptVersion: input.promptVersion,
      parserVersion: input.parserVersion,
      language: input.language,
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      schemaValidity: input.schemaValidity,
      categoryAccuracy: input.categoryAccuracy,
      hardConstraintRecall: input.hardConstraintRecall,
      falseHardConstraintRate: input.falseHardConstraintRate,
      clarificationPrecision: input.clarificationPrecision,
      latencyP95Ms: input.latencyP95Ms,
      costUnits: input.costUnits,
      fallbackRate: input.fallbackRate,
      sampleSize: input.sampleSize,
      ranByOxyUserId: input.ranByOxyUserId,
    })
    .returning();
  if (row === undefined) throw new Error('Failed to record a search intent benchmark run.');
  return row;
}

/** One run by id, so the enable path can read the measurements it cites. */
export async function findBenchmarkRun(
  runId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentBenchmarkRunRow | undefined> {
  const [row] = await db
    .select()
    .from(searchIntentBenchmarkRuns)
    .where(eq(searchIntentBenchmarkRuns.id, runId))
    .limit(1);
  return row;
}

/** The most recent runs, newest first, for the operator surface. */
export async function listBenchmarkRuns(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentBenchmarkRunRow[]> {
  return db
    .select()
    .from(searchIntentBenchmarkRuns)
    .orderBy(desc(searchIntentBenchmarkRuns.createdAt))
    .limit(limit);
}

/** Everything an enablement carries. */
export interface UpsertEnablement {
  readonly categoryId?: string;
  readonly language: string;
  readonly enabled: boolean;
  readonly benchmarkRunId: string;
  readonly datasetDigest: string;
  readonly enabledByOxyUserId: string;
  readonly enabledAt: Date;
  readonly note: string;
}

/**
 * Publish one enablement.
 *
 * `ON CONFLICT DO UPDATE` on the matching PARTIAL unique — and the predicate is
 * repeated in the conflict target, because Postgres refuses to infer an arbiter
 * from a partial index without it and the insert would 500 rather than
 * converge. Two partial uniques rather than one plain one, because Postgres
 * treats NULLs as DISTINCT: a plain `unique(category_id, language)` admits any
 * number of language-wide rows for one language.
 */
export async function upsertEnablement(
  input: UpsertEnablement,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentEnablementRow> {
  const values = {
    ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
    language: input.language,
    enabled: input.enabled,
    benchmarkRunId: input.benchmarkRunId,
    datasetDigest: input.datasetDigest,
    enabledByOxyUserId: input.enabledByOxyUserId,
    enabledAt: input.enabledAt,
    note: input.note,
  };
  const set = {
    enabled: input.enabled,
    benchmarkRunId: input.benchmarkRunId,
    datasetDigest: input.datasetDigest,
    enabledByOxyUserId: input.enabledByOxyUserId,
    enabledAt: input.enabledAt,
    note: input.note,
  };
  const [row] =
    input.categoryId === undefined
      ? await db
          .insert(searchIntentEnablements)
          .values(values)
          .onConflictDoUpdate({
            target: searchIntentEnablements.language,
            targetWhere: sql`${searchIntentEnablements.categoryId} is null`,
            set,
          })
          .returning()
      : await db
          .insert(searchIntentEnablements)
          .values(values)
          .onConflictDoUpdate({
            target: [searchIntentEnablements.categoryId, searchIntentEnablements.language],
            targetWhere: sql`${searchIntentEnablements.categoryId} is not null`,
            set,
          })
          .returning();
  if (row === undefined) throw new Error('Failed to publish a search intent enablement.');
  return row;
}

/**
 * Whether the model parser is enabled for one (category, language) pair.
 *
 * TWO reads and both must say yes — the language-wide row and the category row.
 * A single combined query would need an `or` whose NULL semantics make "no
 * category row" and "a category row saying no" the same answer, and only one of
 * those should enable anything.
 */
export async function readEnablements(
  language: string,
  categoryId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  readonly languageRow?: SearchIntentEnablementRow;
  readonly categoryRow?: SearchIntentEnablementRow;
}> {
  const [languageRow] = await db
    .select()
    .from(searchIntentEnablements)
    .where(
      and(
        eq(searchIntentEnablements.language, language),
        isNull(searchIntentEnablements.categoryId),
      ),
    )
    .limit(1);
  if (categoryId === undefined) {
    return languageRow === undefined ? {} : { languageRow };
  }
  const [categoryRow] = await db
    .select()
    .from(searchIntentEnablements)
    .where(
      and(
        eq(searchIntentEnablements.language, language),
        eq(searchIntentEnablements.categoryId, categoryId),
      ),
    )
    .limit(1);
  return {
    ...(languageRow === undefined ? {} : { languageRow }),
    ...(categoryRow === undefined ? {} : { categoryRow }),
  };
}

/** Every enablement, for the operator surface. */
export async function listEnablements(
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentEnablementRow[]> {
  return db
    .select()
    .from(searchIntentEnablements)
    .orderBy(searchIntentEnablements.language, desc(searchIntentEnablements.enabledAt));
}
