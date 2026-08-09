/**
 * `analytics_search_queries` and `analytics_query_aggregates` (#77 search
 * query privacy).
 *
 * ## The minimum-count threshold lives HERE and has no bypass
 *
 * Privacy rules 4 and 5 ask for restricted access to low-frequency queries and
 * a minimum count before merchant-facing reporting. Both are the same floor
 * applied to two audiences, and this module is the only place either audience
 * can read a query from — `readTopQueries` applies
 * `ANALYTICS_QUERY_MIN_OCCURRENCES` unconditionally and there is deliberately
 * no `includeRare` parameter, no second exported reader and no raw-text
 * accessor at all.
 *
 * That matters more than it looks: a rare query is a near-identifier. "the
 * green wedding dress my sister wore in Girona" occurring twice is a person,
 * whoever is reading it, so an operator floor and a merchant floor are the same
 * requirement and a parameter that relaxed one would relax both.
 */

import { and, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { AnalyticsQueryAggregate, AnalyticsTrafficClass } from '@mercaria/shared-types';
import {
  ANALYTICS_HUMAN_TRAFFIC_CLASSES,
  ANALYTICS_QUERY_MIN_OCCURRENCES,
} from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { analyticsQueryAggregates, analyticsSearchQueries } from '../schema/analytics.js';

/** One search record, in exactly the shape the column set accepts. */
export interface AnalyticsSearchQueryInsert {
  readonly queryEventId: string;
  readonly redactedText: string | null;
  readonly redactionKinds: readonly string[];
  readonly normalizedTokens: readonly string[];
  readonly resultCount: number;
  readonly duplicateResultCount: number;
  readonly latencyMs: number;
  readonly market: string | null;
  readonly categoryId: string | null;
  readonly searchPolicyVersion: string | null;
  readonly rankingPolicyVersion: string | null;
  readonly trafficClass: AnalyticsTrafficClass;
  readonly textExpiresAt: Date;
  readonly expiresAt: Date;
}

/**
 * Append search records.
 *
 * `onConflictDoNothing` on the unique `query_event_id`: two records of one
 * search is not two facts, and the sink may flush a batch twice if a retry
 * straddles a crash. A repeat writes nothing at all — no tuple version, no
 * timestamp — which is the `moderation_events` claim's structural no-op rather
 * than a comparison somebody has to keep correct.
 */
export async function insertSearchQueries(
  records: readonly AnalyticsSearchQueryInsert[],
): Promise<number> {
  if (records.length === 0) return 0;
  const rows = await getDb()
    .insert(analyticsSearchQueries)
    .values(
      records.map((record) => ({
        ...record,
        redactionKinds: [...record.redactionKinds],
        normalizedTokens: [...record.normalizedTokens],
      })),
    )
    .onConflictDoNothing({ target: analyticsSearchQueries.queryEventId })
    .returning({ id: analyticsSearchQueries.id });
  return rows.length;
}

/**
 * Null the redacted text of every record past its text deadline, leaving the
 * normalized tokens and the counts.
 *
 * This is a REDACTION, not a delete, which is why the shared expiry sweep
 * cannot perform it — `ExpirySweepTarget` deletes rows. Nulling `redacted_text`
 * while the row survives is the whole of "define whether raw query text is
 * retained at all and for how long" (privacy rule 1): it is not, and this is
 * where the answer is executed.
 *
 * @returns How many records were redacted.
 */
export async function redactExpiredQueryText(now: Date, limit: number): Promise<number> {
  // `now.toISOString()` with an explicit cast, never a raw `Date`: this is
  // hand-written SQL, so drizzle has no column to take a type from and
  // postgres.js refuses the `Date` outright (`ERR_INVALID_ARG_TYPE`) — the trap
  // `CONVENTIONS.md` records under "a Date is not a safe parameter against an
  // EXPRESSION". It type-checks perfectly and fails at query time.
  const rows = await getDb().execute<{ id: string }>(sql`
    update ${analyticsSearchQueries}
       set redacted_text = null
     where id in (
       select id
         from ${analyticsSearchQueries}
        where text_expires_at <= ${now.toISOString()}::timestamptz
          and redacted_text is not null
        order by text_expires_at
        limit ${limit}
     )
    returning id
  `);
  return rows.length;
}

/** One aggregation bucket, computed from a day's search records. */
export interface AnalyticsQueryAggregateUpsert {
  readonly bucketDate: string;
  readonly market: string;
  readonly normalizedQuery: string;
  readonly occurrences: number;
  readonly zeroResultOccurrences: number;
  readonly clickOccurrences: number;
  readonly expiresAt: Date;
}

/**
 * Write a day's query aggregates.
 *
 * `DO UPDATE` with the recomputed values, never an increment: the rollup is
 * resumable, so a page it already handled can be replayed, and adding to a
 * stored total would double whatever the replay re-read. Recomputing a bucket
 * from the source rows and overwriting it converges however many times it runs
 * — the same reasoning `analytics_rollups` follows.
 */
export async function upsertQueryAggregates(
  buckets: readonly AnalyticsQueryAggregateUpsert[],
): Promise<number> {
  if (buckets.length === 0) return 0;
  const rows = await getDb()
    .insert(analyticsQueryAggregates)
    .values(buckets.map((bucket) => ({ ...bucket })))
    .onConflictDoUpdate({
      target: [
        analyticsQueryAggregates.bucketDate,
        analyticsQueryAggregates.market,
        analyticsQueryAggregates.normalizedQuery,
      ],
      set: {
        occurrences: sql`excluded.occurrences`,
        zeroResultOccurrences: sql`excluded.zero_result_occurrences`,
        clickOccurrences: sql`excluded.click_occurrences`,
        expiresAt: sql`excluded.expires_at`,
      },
    })
    .returning({ id: analyticsQueryAggregates.id });
  return rows.length;
}

/**
 * The top queries of a period, ABOVE the reporting floor.
 *
 * The ONLY query-text read path in this backend. There is no parameter that
 * lowers the floor and no sibling function that skips it — see the module
 * docblock for why an operator and a merchant get the same threshold.
 */
export async function readTopQueries(input: {
  from: string;
  to: string;
  market?: string;
  zeroResultOnly?: boolean;
  limit: number;
}): Promise<readonly AnalyticsQueryAggregate[]> {
  const conditions = [
    gte(analyticsQueryAggregates.bucketDate, input.from),
    lte(analyticsQueryAggregates.bucketDate, input.to),
    // The floor. Unconditional, and the reason this module has one reader.
    gte(analyticsQueryAggregates.occurrences, ANALYTICS_QUERY_MIN_OCCURRENCES),
  ];
  if (input.market !== undefined) {
    conditions.push(eq(analyticsQueryAggregates.market, input.market));
  }
  if (input.zeroResultOnly === true) {
    conditions.push(gte(analyticsQueryAggregates.zeroResultOccurrences, 1));
  }

  const rows = await getDb()
    .select({
      normalizedQuery: analyticsQueryAggregates.normalizedQuery,
      market: analyticsQueryAggregates.market,
      occurrences: sql<number>`sum(${analyticsQueryAggregates.occurrences})::int`,
      zeroResultOccurrences: sql<number>`sum(${analyticsQueryAggregates.zeroResultOccurrences})::int`,
      clickOccurrences: sql<number>`sum(${analyticsQueryAggregates.clickOccurrences})::int`,
    })
    .from(analyticsQueryAggregates)
    .where(and(...conditions))
    .groupBy(analyticsQueryAggregates.normalizedQuery, analyticsQueryAggregates.market)
    // Re-applied after the SUM: a query below the floor on every single day can
    // still clear it across a range, and one ABOVE the floor on one day must not
    // be dropped by the range grouping. Both directions matter, so the floor is
    // stated on the row and on the group.
    .having(sql`sum(${analyticsQueryAggregates.occurrences}) >= ${ANALYTICS_QUERY_MIN_OCCURRENCES}`)
    .orderBy(desc(sql`sum(${analyticsQueryAggregates.occurrences})`))
    .limit(input.limit);

  return rows.map((row) => ({
    normalizedQuery: row.normalizedQuery,
    occurrences: Number(row.occurrences),
    zeroResultOccurrences: Number(row.zeroResultOccurrences),
    clickOccurrences: Number(row.clickOccurrences),
    ...(row.market === '' ? {} : { market: row.market }),
  }));
}

/** One day's search records, reduced to what the aggregation needs. */
export interface AnalyticsSearchQueryDaySlice {
  readonly market: string;
  readonly normalizedQuery: string;
  readonly occurrences: number;
  readonly zeroResultOccurrences: number;
}

/**
 * Group one day's HUMAN search records by normalized query.
 *
 * Bot and preview traffic is excluded at the aggregation, not at the report: a
 * crawler's queries must never reach a merchant-facing list, and filtering at
 * read time would leave them in the stored aggregate for the next reader to
 * forget about.
 */
export async function aggregateSearchQueriesForDay(
  from: Date,
  to: Date,
): Promise<readonly AnalyticsSearchQueryDaySlice[]> {
  const rows = await getDb()
    .select({
      market: sql<string>`coalesce(${analyticsSearchQueries.market}, '')`,
      normalizedQuery: sql<string>`array_to_string(${analyticsSearchQueries.normalizedTokens}, ' ')`,
      occurrences: sql<number>`count(*)::int`,
      zeroResultOccurrences: sql<number>`count(*) filter (where ${analyticsSearchQueries.resultCount} = 0)::int`,
    })
    .from(analyticsSearchQueries)
    .where(
      and(
        gte(analyticsSearchQueries.createdAt, from),
        lt(analyticsSearchQueries.createdAt, to),
        sql`${analyticsSearchQueries.trafficClass} = any(${ANALYTICS_HUMAN_TRAFFIC_CLASSES})`,
        // A query that normalized to nothing (punctuation, an emoji, a stray
        // quote) has no aggregate meaning and would collide every such search
        // into one bucket labelled with the empty string.
        sql`array_length(${analyticsSearchQueries.normalizedTokens}, 1) >= 1`,
      ),
    )
    .groupBy(
      sql`coalesce(${analyticsSearchQueries.market}, '')`,
      sql`array_to_string(${analyticsSearchQueries.normalizedTokens}, ' ')`,
    );

  return rows.map((row) => ({
    market: row.market,
    normalizedQuery: row.normalizedQuery,
    occurrences: Number(row.occurrences),
    zeroResultOccurrences: Number(row.zeroResultOccurrences),
  }));
}

/** Latency and duplication for one day — the two `analytics_search_queries` metrics. */
export interface AnalyticsSearchQueryDayTotals {
  readonly searches: number;
  readonly latencyMsTotal: number;
  readonly resultRows: number;
  readonly duplicateRows: number;
}

/** Sum a day's latency and duplication. Includes automated traffic deliberately: a
 *  crawler's query costs the same database time a shopper's does, and a latency
 *  metric that excluded it would understate the load the system is actually
 *  under. The metric definition sets `humanOnly: false` to say so. */
export async function sumSearchQueryTotalsForDay(
  from: Date,
  to: Date,
): Promise<AnalyticsSearchQueryDayTotals> {
  const rows = await getDb()
    .select({
      searches: sql<number>`count(*)::int`,
      latencyMsTotal: sql<number>`coalesce(sum(${analyticsSearchQueries.latencyMs}), 0)::int`,
      resultRows: sql<number>`coalesce(sum(${analyticsSearchQueries.resultCount}), 0)::int`,
      duplicateRows: sql<number>`coalesce(sum(${analyticsSearchQueries.duplicateResultCount}), 0)::int`,
    })
    .from(analyticsSearchQueries)
    .where(and(gte(analyticsSearchQueries.createdAt, from), lt(analyticsSearchQueries.createdAt, to)));

  const row = rows[0];
  return {
    searches: Number(row?.searches ?? 0),
    latencyMsTotal: Number(row?.latencyMsTotal ?? 0),
    resultRows: Number(row?.resultRows ?? 0),
    duplicateRows: Number(row?.duplicateRows ?? 0),
  };
}

/**
 * How many records still carry text past their deadline — the retention gate's
 * own alarm.
 *
 * A retention policy nobody measures is a retention policy nobody has. The
 * operator surface reads this, and it must be zero on a healthy deployment.
 */
export async function countUnredactedExpiredQueries(now: Date): Promise<number> {
  const rows = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(analyticsSearchQueries)
    .where(
      and(
        lt(analyticsSearchQueries.textExpiresAt, now),
        isNotNull(analyticsSearchQueries.redactedText),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}
