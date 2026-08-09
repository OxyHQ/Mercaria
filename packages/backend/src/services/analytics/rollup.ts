/**
 * Computing one day's metric buckets (#77 metrics, dashboards, data-lifecycle
 * rule 2).
 *
 * ## Bounded, resumable, idempotent — the reconciliation-sweep shape
 *
 * ONE calendar day per tick, never a loop until done. The cursor advances only
 * after a day is fully written, so a task that dies mid-day leaves it where it
 * was and the next run replays that day. Every write is an upsert keyed on the
 * bucket, so a replay converges instead of doubling — resumability and
 * idempotency are the same property here approached from two sides, exactly as
 * `services/payments/reconciliation/runner.ts` records.
 *
 * What differs from that sweep is what a lease PROTECTS. Nothing here moves
 * money or state, so a lost lease costs a duplicate computation and no
 * duplicate effect. That is why the bucket write is an overwrite rather than an
 * increment — and why "we computed this day twice" is not an incident.
 *
 * ## Aggregate BEFORE delete, and the ordering is the whole point
 *
 * The rollup runs on a day, then the retention sweep deletes rows older than
 * their class allows. The rollup's window is always days behind the retention
 * horizon, so the numbers are written before the rows they came from leave —
 * which is what makes "raw events are deleted and the dashboard is unaffected"
 * true rather than hopeful. `retention.ts` states the same ordering from the
 * other side.
 *
 * ## What the rollup may NOT do
 *
 * It never reads the fee domain, the referral domain or any merchant plan, and
 * `analytics-ranking-isolation.test.ts` fails the build if it starts to. A
 * rollup that could read a plan would be one line away from producing a
 * plan-weighted popularity figure, and a popularity figure is one join away
 * from a ranking input — which is precisely the sale of organic rank #77
 * merchant rule 6 forbids.
 */

import { randomUUID } from 'node:crypto';
import type { AnalyticsMetricDefinition } from '@mercaria/shared-types';
import {
  ANALYTICS_METRICS,
  ANALYTICS_SEARCH_SUCCESS_WINDOW_SECONDS,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  countEventsByDimension,
  countSearchSuccesses,
} from '../../db/analytics/eventRepository.js';
import {
  aggregateSearchQueriesForDay,
  sumSearchQueryTotalsForDay,
  upsertQueryAggregates,
} from '../../db/analytics/searchQueryRepository.js';
import {
  ANALYTICS_ROLLUP_LEASE_MS,
  claimRollupRun,
  completeRollupRun,
  upsertRollups,
  type AnalyticsRollupUpsert,
} from '../../db/analytics/rollupRepository.js';
import { EVENT_METRIC_SPECS, SEARCH_SUCCESS_ACTIONS, metricByKey } from './metrics.js';
import { countVerifiedConversions } from './verified-conversion.js';

/** The single rollup job name — one row in `analytics_rollup_cursors`. */
export const ANALYTICS_ROLLUP_JOB = 'daily_metrics';

/** How long a rolled-up bucket and a query aggregate are retained. */
const ROLLUP_RETENTION_DAYS = 730;
const QUERY_AGGREGATE_RETENTION_DAYS = 365;

/** What one day's rollup did. */
export interface RollupDayOutcome {
  readonly bucketDate: string;
  readonly metricBuckets: number;
  readonly queryBuckets: number;
}

/** A UTC calendar day as `YYYY-MM-DD`. */
export function toBucketDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC at the start of a bucket date. */
function dayStart(bucketDate: string): Date {
  return new Date(`${bucketDate}T00:00:00.000Z`);
}

/** The day after a bucket date, as a Date. */
function dayEnd(bucketDate: string): Date {
  return new Date(dayStart(bucketDate).getTime() + 86_400_000);
}

/** The day after a bucket date, as a bucket date. */
function nextBucketDate(bucketDate: string): string {
  return toBucketDate(dayEnd(bucketDate));
}

/**
 * Compute and write every metric for one UTC day.
 *
 * Exported so a test and an operator can drive one day deterministically rather
 * than waiting for a tick — the `runReconciliationJob` rule, and for the same
 * reason: a failure scoped to one day is diagnosable and a failure attributed to
 * "the rollup" is not.
 */
export async function rollupDay(bucketDate: string, now: Date): Promise<RollupDayOutcome> {
  const from = dayStart(bucketDate);
  const to = dayEnd(bucketDate);
  const expiresAt = new Date(now.getTime() + ROLLUP_RETENTION_DAYS * 86_400_000);
  const buckets: AnalyticsRollupUpsert[] = [];

  // 1. The event-sourced ratios. Each is a numerator event set over a
  //    denominator event set, sliced by every stored dimension.
  for (const spec of EVENT_METRIC_SPECS) {
    const definition = metricByKey(spec.metricKey);
    if (!definition) continue;
    const numerators = await countEventsByDimension({
      eventTypes: spec.numeratorTypes,
      from,
      to,
      humanOnly: definition.humanOnly,
    });
    const denominators = await countEventsByDimension({
      eventTypes: spec.denominatorTypes,
      from,
      to,
      humanOnly: definition.humanOnly,
    });
    buckets.push(
      ...combineSlices(definition, bucketDate, numerators, denominators, now, expiresAt),
    );
  }

  // 2. Search success — a windowed self-join the spec shape cannot express.
  buckets.push(...(await rollupSearchSuccess(bucketDate, from, to, now, expiresAt)));

  // 3. The two metrics sourced from `analytics_search_queries`.
  buckets.push(...(await rollupSearchQueryMetrics(bucketDate, from, to, now, expiresAt)));

  // 4. The conversion metrics — numerators from VERIFIED payments, never events.
  buckets.push(...(await rollupConversions(bucketDate, from, to, now, expiresAt)));

  const metricBuckets = await upsertRollups(buckets);

  // 5. The thresholded query aggregate, written BEFORE the raw rows are swept.
  const querySlices = await aggregateSearchQueriesForDay(from, to);
  const queryBuckets = await upsertQueryAggregates(
    querySlices.map((slice) => ({
      bucketDate,
      market: slice.market,
      normalizedQuery: slice.normalizedQuery,
      occurrences: slice.occurrences,
      zeroResultOccurrences: slice.zeroResultOccurrences,
      // Click attribution needs the event side and is left at zero rather than
      // guessed: a "clicks" column filled from the wrong join would be worse
      // than an empty one, because nobody checks a number that looks plausible.
      clickOccurrences: 0,
      expiresAt: new Date(now.getTime() + QUERY_AGGREGATE_RETENTION_DAYS * 86_400_000),
    })),
  );

  return { bucketDate, metricBuckets, queryBuckets };
}

/**
 * Key a dimension tuple so numerator and denominator slices can be paired.
 *
 * `|` is the separator, the `commerce_relationships.endpoint_key` device: every
 * dimension here is either a closed-tuple value, a two-letter market, `''`, or
 * an id from this schema's uuid-v7/24-hex key space, and none of them can
 * contain a pipe — so two different tuples cannot collide into one key. A
 * plainer separator like a space would collide the moment an id space widened.
 */
function sliceKey(slice: {
  market: string;
  clientSurface: string;
  actorKind: string;
  buyerOrigin: string;
  storeId: string;
  merchantId: string;
}): string {
  return [
    slice.market,
    slice.clientSurface,
    slice.actorKind,
    slice.buyerOrigin,
    slice.storeId,
    slice.merchantId,
  ].join('|');
}

/**
 * Pair numerator and denominator slices into buckets.
 *
 * A denominator slice with no numerator becomes a bucket with `numerator: 0` —
 * a real, storable fact (nobody clicked). A NUMERATOR slice with no denominator
 * is dropped, deliberately: it would be a ratio above 1, which is always a
 * dimension mismatch rather than a discovery, and storing it would put an
 * impossible number on a chart.
 */
function combineSlices(
  definition: AnalyticsMetricDefinition,
  bucketDate: string,
  numerators: readonly {
    market: string;
    clientSurface: string;
    actorKind: string;
    buyerOrigin: string;
    storeId: string;
    merchantId: string;
    total: number;
  }[],
  denominators: readonly {
    market: string;
    clientSurface: string;
    actorKind: string;
    buyerOrigin: string;
    storeId: string;
    merchantId: string;
    total: number;
  }[],
  computedAt: Date,
  expiresAt: Date,
): readonly AnalyticsRollupUpsert[] {
  const numeratorByKey = new Map(numerators.map((slice) => [sliceKey(slice), slice.total]));
  return denominators.map((slice) => ({
    metricKey: definition.key,
    bucketDate,
    market: slice.market,
    clientSurface: slice.clientSurface,
    actorKind: slice.actorKind,
    buyerOrigin: slice.buyerOrigin,
    storeId: slice.storeId,
    merchantId: slice.merchantId,
    numerator: numeratorByKey.get(sliceKey(slice)) ?? 0,
    denominator: slice.total,
    source: definition.source,
    computedAt,
    expiresAt,
  }));
}

/** Search success: a windowed self-join numerator over a plain denominator. */
async function rollupSearchSuccess(
  bucketDate: string,
  from: Date,
  to: Date,
  computedAt: Date,
  expiresAt: Date,
): Promise<readonly AnalyticsRollupUpsert[]> {
  const definition = metricByKey('search_success_rate');
  if (!definition) return [];

  const successes = await countSearchSuccesses({
    successTypes: SEARCH_SUCCESS_ACTIONS,
    from,
    to,
    windowSeconds: ANALYTICS_SEARCH_SUCCESS_WINDOW_SECONDS,
  });
  const denominatorSlices = await countEventsByDimension({
    eventTypes: ['search_results_returned'],
    from,
    to,
    humanOnly: definition.humanOnly,
  });
  const denominator = denominatorSlices.reduce((sum, slice) => sum + slice.total, 0);

  // Platform-wide only: the numerator is a distinct count over query event ids,
  // which cannot be split across dimension buckets without re-running the
  // self-join per bucket. Storing it undimensioned is honest; storing a
  // dimensioned copy of one number would be a lie in six columns.
  return [
    {
      metricKey: definition.key,
      bucketDate,
      market: '',
      clientSurface: '',
      actorKind: '',
      buyerOrigin: '',
      storeId: '',
      merchantId: '',
      numerator: successes,
      denominator,
      source: definition.source,
      computedAt,
      expiresAt,
    },
  ];
}

/** The two metrics whose source is `analytics_search_queries`. */
async function rollupSearchQueryMetrics(
  bucketDate: string,
  from: Date,
  to: Date,
  computedAt: Date,
  expiresAt: Date,
): Promise<readonly AnalyticsRollupUpsert[]> {
  const totals = await sumSearchQueryTotalsForDay(from, to);
  const buckets: AnalyticsRollupUpsert[] = [];

  const duplicates = metricByKey('duplicate_product_rate');
  if (duplicates) {
    buckets.push({
      metricKey: duplicates.key,
      bucketDate,
      market: '',
      clientSurface: '',
      actorKind: '',
      buyerOrigin: '',
      storeId: '',
      merchantId: '',
      numerator: totals.duplicateRows,
      denominator: totals.resultRows,
      source: duplicates.source,
      computedAt,
      expiresAt,
    });
  }

  const latency = metricByKey('query_latency_and_freshness');
  if (latency) {
    buckets.push({
      metricKey: latency.key,
      bucketDate,
      market: '',
      clientSurface: '',
      actorKind: '',
      buyerOrigin: '',
      storeId: '',
      merchantId: '',
      // The numerator is total milliseconds and the denominator is searches, so
      // the ratio IS the mean. Storing the mean instead would make two days
      // unaddable, which is the thing a rollup exists to avoid.
      numerator: totals.latencyMsTotal,
      denominator: totals.searches,
      source: latency.source,
      computedAt,
      expiresAt,
    });
  }

  return buckets;
}

/**
 * The conversion metrics.
 *
 * Numerators from `payments`/`orders` through the ONE seam
 * (`verified-conversion.ts`); denominators from the checkout-start EVENTS. The
 * asymmetry is deliberate and each definition's `attributionLimit` states it:
 * a checkout that started while collection was off is invisible below the line
 * and visible above it, so the ratio is a FLOOR.
 */
async function rollupConversions(
  bucketDate: string,
  from: Date,
  to: Date,
  computedAt: Date,
  expiresAt: Date,
): Promise<readonly AnalyticsRollupUpsert[]> {
  const conversions = await countVerifiedConversions({ from, to });
  const byOrigin = new Map(conversions.map((slice) => [slice.buyerOrigin, slice.checkoutGroups]));
  const buckets: AnalyticsRollupUpsert[] = [];

  const pairs: readonly {
    metricKey: string;
    denominatorTypes: readonly ['checkout_started' | 'guest_checkout_started'];
    origin: string;
    buyerOrigin: string;
  }[] = [
    {
      metricKey: 'native_checkout_conversion',
      denominatorTypes: ['checkout_started'],
      origin: 'authenticated',
      buyerOrigin: '',
    },
    {
      metricKey: 'authenticated_checkout_funnel',
      denominatorTypes: ['checkout_started'],
      origin: 'authenticated',
      buyerOrigin: 'authenticated',
    },
    {
      metricKey: 'guest_checkout_funnel',
      denominatorTypes: ['guest_checkout_started'],
      origin: 'guest',
      buyerOrigin: 'guest',
    },
    {
      metricKey: 'guest_verified_payment_conversion',
      denominatorTypes: ['guest_checkout_started'],
      origin: 'guest',
      buyerOrigin: '',
    },
  ];

  for (const pair of pairs) {
    const definition = metricByKey(pair.metricKey);
    if (!definition) continue;
    const denominatorSlices = await countEventsByDimension({
      eventTypes: [...pair.denominatorTypes],
      from,
      to,
      humanOnly: definition.humanOnly,
    });
    const denominator = denominatorSlices.reduce((sum, slice) => sum + slice.total, 0);
    buckets.push({
      metricKey: definition.key,
      bucketDate,
      market: '',
      clientSurface: '',
      actorKind: '',
      buyerOrigin: pair.buyerOrigin,
      storeId: '',
      merchantId: '',
      numerator: byOrigin.get(pair.origin) ?? 0,
      denominator,
      source: definition.source,
      computedAt,
      expiresAt,
    });
  }

  return buckets;
}

/** Every metric that has no rollup writer yet, and which issue owes it. */
export function metricsWithoutRollup(): readonly AnalyticsMetricDefinition[] {
  const written = new Set<string>([
    ...EVENT_METRIC_SPECS.map((spec) => spec.metricKey),
    'search_success_rate',
    'duplicate_product_rate',
    'query_latency_and_freshness',
    'native_checkout_conversion',
    'authenticated_checkout_funnel',
    'guest_checkout_funnel',
    'guest_verified_payment_conversion',
  ]);
  return ANALYTICS_METRICS.filter((metric) => !written.has(metric.key));
}

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Roll up the next day that needs it, if this task can take the lease.
 *
 * @returns What the day did, or `undefined` when another task holds the lease
 *   or there is nothing to compute.
 */
export async function runAnalyticsRollup(now = new Date()): Promise<RollupDayOutcome | undefined> {
  const leaseOwner = `analytics-rollup:${String(process.pid)}:${randomUUID()}`;
  const cursor = await claimRollupRun({
    job: ANALYTICS_ROLLUP_JOB,
    leaseOwner,
    leaseMs: ANALYTICS_ROLLUP_LEASE_MS,
    now,
  });
  if (!cursor) return undefined;

  // Only ever a COMPLETE day: rolling up today would write a partial figure that
  // the next run would overwrite with a different one, so a dashboard reading it
  // between the two sees a number that changes for no reason a viewer can see.
  const yesterday = toBucketDate(new Date(now.getTime() - 86_400_000));
  const target =
    cursor.lastCompletedDate === null
      ? toBucketDate(new Date(now.getTime() - config.analytics.rollupMaxBackfillDays * 86_400_000))
      : nextBucketDate(cursor.lastCompletedDate);

  if (target > yesterday) {
    await completeRollupRun({ job: ANALYTICS_ROLLUP_JOB, leaseOwner, completedDate: null, now });
    return undefined;
  }

  try {
    const outcome = await rollupDay(target, now);
    await completeRollupRun({
      job: ANALYTICS_ROLLUP_JOB,
      leaseOwner,
      completedDate: target,
      now,
    });
    return outcome;
  } catch (error: unknown) {
    // The lease is released and the CURSOR IS NOT MOVED — the whole of
    // resumability: the next run replays the day that threw, and every write it
    // re-derives is an upsert.
    await completeRollupRun({
      job: ANALYTICS_ROLLUP_JOB,
      leaseOwner,
      completedDate: null,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      now,
    });
    log.general.error({ err: error, bucketDate: target }, '[Analytics] rollup day failed');
    throw error;
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const outcome = await runAnalyticsRollup();
    if (outcome) {
      log.general.info({ ...outcome }, '[Analytics] rolled up a day');
    }
  } catch (error: unknown) {
    // Already logged with the day that failed; swallowed here so one bad day
    // does not stop the timer and strand every day after it.
    log.general.error({ err: error }, '[Analytics] rollup tick failed; continuing');
  } finally {
    running = false;
  }
}

/**
 * Start the rollup loop. Idempotent.
 *
 * Gated on the LOOP, never on the records: events keep being written while the
 * rollup is off, and switching it on computes the backlog rather than losing it
 * — the outbox rule, which applies here because the input is durable even
 * though the output is derived.
 */
export function startAnalyticsRollup(): void {
  if (timer !== undefined) return;
  if (!config.analytics.enabled || !config.analytics.rollupEnabled) return;

  timer = setInterval(() => {
    void tick();
  }, config.analytics.rollupIntervalMs);
  // Never hold the event loop open for a poll — `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    { intervalMs: config.analytics.rollupIntervalMs },
    '[Analytics] daily metric rollup started',
  );
}

/** Stop the rollup loop. The day already in flight finishes. */
export function stopAnalyticsRollup(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
