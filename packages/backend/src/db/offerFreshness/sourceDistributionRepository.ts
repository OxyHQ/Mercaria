/**
 * Reads and writes for `catalog_source_distributions` — the last SOUND
 * distribution one source published (#68 anomaly 3).
 *
 * ## The single writer refuses a baseline from a run nobody believed
 *
 * The baseline is what a suspicious run is judged against, so accepting one
 * from a quarantined run would let a broken feed re-base its own normal in two
 * passes and then look healthy for good. {@link recordSourceDistribution} takes
 * the run's quarantine verdict as an argument and does nothing when it is not
 * clean — a refusal at the one place a baseline can enter, rather than a rule
 * every caller has to remember.
 *
 * ## One CURRENT row per source, not a history
 *
 * The question is "does what arrived just now look like what this feed normally
 * looks like", which needs the baseline and not a time series of them. A
 * history would also make the comparison ambiguous — against which of the last
 * thirty? — and the runs themselves already carry their own counters for
 * anybody reconstructing a trend.
 */

import { eq } from 'drizzle-orm';
import type { SourceObservationDistribution } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { catalogSourceDistributions } from '../schema/offerFreshness.js';

export type CatalogSourceDistributionRow = typeof catalogSourceDistributions.$inferSelect;

/** The stored baseline of one source, or `undefined` on a source that has none. */
export async function findSourceDistribution(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<CatalogSourceDistributionRow | undefined> {
  const rows = await db
    .select()
    .from(catalogSourceDistributions)
    .where(eq(catalogSourceDistributions.sourceId, sourceId))
    .limit(1);
  return rows[0];
}

/**
 * Read a stored baseline as the pure detector's view of it.
 *
 * `dominantCurrencyShareBps` is stored as basis points and the detector reads a
 * 0–1 share, so the conversion lives HERE, at the boundary, rather than in the
 * detector — which would then have to know that one of its two arguments came
 * out of a column and the other did not.
 */
export function toObservationDistribution(
  row: CatalogSourceDistributionRow,
): SourceObservationDistribution {
  return {
    sampleSize: row.sampleSize,
    pricedCount: row.pricedCount,
    zeroPricedCount: row.zeroPricedCount,
    // `bigint({ mode: 'number' })` still decodes through postgres.js, and every
    // aggregate over such a column arrives as a STRING (`~/Oxy/AGENTS.md`).
    // Drizzle types this as `number | null`, which is exactly the case `tsc`
    // cannot catch, so the coercion is explicit at the boundary.
    medianPriceMinor: row.medianPriceMinor === null ? null : Number(row.medianPriceMinor),
    dominantCurrency: row.dominantCurrency,
    dominantCurrencyShare: row.dominantCurrencyShareBps / 10_000,
  };
}

/**
 * Replace one source's baseline, but only from a run whose output was CLEAN.
 *
 * `objectCount` is how many objects the source was known to publish when the
 * baseline was taken, and it is what the mass-disappearance detector divides
 * by — kept beside the distribution rather than counted live, so the comparison
 * is against the catalogue as it stood when this shape was believed rather than
 * against whatever a half-finished retirement sweep has left.
 */
export async function recordSourceDistribution(
  db: DatabaseOrTransaction,
  input: {
    sourceId: string;
    runId: string | null;
    distribution: SourceObservationDistribution;
    objectCount: number;
    quarantined: boolean;
    now: Date;
  },
): Promise<CatalogSourceDistributionRow | undefined> {
  if (input.quarantined) return undefined;

  const values = {
    sourceId: input.sourceId,
    capturedFromRunId: input.runId,
    sampleSize: input.distribution.sampleSize,
    pricedCount: input.distribution.pricedCount,
    zeroPricedCount: input.distribution.zeroPricedCount,
    medianPriceMinor: input.distribution.medianPriceMinor,
    dominantCurrency: input.distribution.dominantCurrency,
    dominantCurrencyShareBps: Math.round(input.distribution.dominantCurrencyShare * 10_000),
    objectCount: input.objectCount,
    capturedAt: input.now,
  };

  const rows = await db
    .insert(catalogSourceDistributions)
    .values(values)
    .onConflictDoUpdate({
      target: catalogSourceDistributions.sourceId,
      set: {
        capturedFromRunId: values.capturedFromRunId,
        sampleSize: values.sampleSize,
        pricedCount: values.pricedCount,
        zeroPricedCount: values.zeroPricedCount,
        medianPriceMinor: values.medianPriceMinor,
        dominantCurrency: values.dominantCurrency,
        dominantCurrencyShareBps: values.dominantCurrencyShareBps,
        objectCount: values.objectCount,
        capturedAt: values.capturedAt,
        updatedAt: input.now,
      },
    })
    .returning();

  return rows[0];
}
