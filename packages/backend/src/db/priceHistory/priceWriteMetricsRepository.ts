/**
 * `offer_price_write_metrics` — the counters the rows cannot show (#78
 * operations 1).
 *
 * This is the one place in the domain where something INCREMENTS, and the
 * reason is that the quantity being counted leaves no other trace: a
 * deduplicated observation writes no row, so counting rows answers "how much did
 * we keep" and never "how much did we suppress". A domain whose dedup interval
 * was accidentally zero would write ten times the observations and report a
 * perfectly healthy write volume; only this counter tells the two apart.
 *
 * `catalog_source_rejections`' residual lesson, as counters rather than rows,
 * because a suppressed duplicate carries no information a row could hold — the
 * observation it duplicates is already stored.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { offerPriceWriteMetrics } from '../schema/priceHistory.js';

/** One write's outcome, as counted. */
export interface PriceWriteCounters {
  readonly written?: number;
  readonly deduplicated?: number;
  readonly refused?: number;
  readonly flaggedAnomalous?: number;
}

/** `YYYY-MM-DD` in UTC — the bucket key half the generated column reads. */
export function priceMetricsBucketDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Add to one day's counters for one source.
 *
 * `excluded.<column>` spelled out rather than interpolated from the drizzle
 * column object, which would emit the JavaScript property name and fail at
 * runtime with `42703` — and the SUM references the EXISTING row rather than
 * `excluded`, because `excluded` is what this statement proposed and two
 * concurrent writers would each set the counter to their own proposed delta.
 */
export async function recordPriceWriteOutcome(
  options: { day: string; sourceId?: string | null } & PriceWriteCounters,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const written = options.written ?? 0;
  const deduplicated = options.deduplicated ?? 0;
  const refused = options.refused ?? 0;
  const flaggedAnomalous = options.flaggedAnomalous ?? 0;
  if (written === 0 && deduplicated === 0 && refused === 0 && flaggedAnomalous === 0) return;

  await db
    .insert(offerPriceWriteMetrics)
    .values({
      bucketDay: options.day,
      sourceId: options.sourceId ?? null,
      written,
      deduplicated,
      refused,
      flaggedAnomalous,
    })
    .onConflictDoUpdate({
      target: offerPriceWriteMetrics.metricKey,
      set: {
        written: sql`${offerPriceWriteMetrics.written} + excluded.written`,
        deduplicated: sql`${offerPriceWriteMetrics.deduplicated} + excluded.deduplicated`,
        refused: sql`${offerPriceWriteMetrics.refused} + excluded.refused`,
        flaggedAnomalous: sql`${offerPriceWriteMetrics.flaggedAnomalous} + excluded.flagged_anomalous`,
      },
    });
}

/** The totals over a window — the operator metric's numerator and denominator. */
export async function sumPriceWriteMetrics(
  sinceDay: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  written: number;
  deduplicated: number;
  refused: number;
  flaggedAnomalous: number;
}> {
  const rows = await db
    .select({
      // `sum()` over an `integer` column decodes as a STRING through
      // postgres.js, so every one of these is cast in SQL rather than coerced
      // in JavaScript — an uncast sum reads as `number` to `tsc` and is
      // silently concatenated by the first addition anybody performs on it.
      written: sql<number>`coalesce(sum(${offerPriceWriteMetrics.written}), 0)::int`,
      deduplicated: sql<number>`coalesce(sum(${offerPriceWriteMetrics.deduplicated}), 0)::int`,
      refused: sql<number>`coalesce(sum(${offerPriceWriteMetrics.refused}), 0)::int`,
      flaggedAnomalous: sql<number>`coalesce(sum(${offerPriceWriteMetrics.flaggedAnomalous}), 0)::int`,
    })
    .from(offerPriceWriteMetrics)
    .where(gte(offerPriceWriteMetrics.bucketDay, sinceDay));

  const row = rows[0];
  return {
    written: row?.written ?? 0,
    deduplicated: row?.deduplicated ?? 0,
    refused: row?.refused ?? 0,
    flaggedAnomalous: row?.flaggedAnomalous ?? 0,
  };
}

/** One day and one source, for a test or a trace. */
export async function findPriceWriteMetrics(
  day: string,
  sourceId: string | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<typeof offerPriceWriteMetrics.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(offerPriceWriteMetrics)
    .where(
      and(
        eq(offerPriceWriteMetrics.bucketDay, day),
        sourceId === null
          ? sql`${offerPriceWriteMetrics.sourceId} is null`
          : eq(offerPriceWriteMetrics.sourceId, sourceId),
      ),
    )
    .limit(1);
  return rows[0];
}
