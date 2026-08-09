/**
 * The operator dashboards (#77 "Dashboards").
 *
 * ## What an operator gets that a merchant does not
 *
 * Cross-store totals, the zero-result query list, the funnel by client platform
 * and safe actor KIND, source coverage, experiment guardrails, and the health
 * counters that say whether retention is actually happening.
 *
 * ## What an operator does NOT get, and why each is refused
 *
 *  - **Raw guest contact.** There is no column anywhere in this domain that
 *    holds any, so no endpoint can serve one.
 *  - **Low-frequency behaviour.** `readTopQueries` applies
 *    `ANALYTICS_QUERY_MIN_OCCURRENCES` unconditionally and is the only query
 *    reader in the backend, so an operator sees exactly what a merchant sees on
 *    that surface. A rare query is a near-identifier whoever is reading it, and
 *    an operator allow-list is a list of people, not a licence.
 *  - **Cross-checkout identity correlation.** The trace opens from a query
 *    event id or a checkout group and returns a projection with NEITHER
 *    identity column. There is no endpoint that takes a pseudonym, and none
 *    that returns one — so "show me everything this session did" is not a
 *    question this surface can be asked, which is the strongest form of
 *    refusing it.
 *
 * The last one is the interesting decision, because a funnel debugger genuinely
 * wants it. The answer is that the operator trace already answers the question
 * a debugger actually has ("what happened to THIS search / THIS checkout") and
 * the pseudonym-keyed version answers a different one ("what has THIS PERSON
 * been doing"), which no operational need justifies and which the rotating
 * pseudonym exists to make impossible anyway.
 */

import type {
  AnalyticsMetricPoint,
  AnalyticsMetricSeries,
  AnalyticsQueryAggregate,
} from '@mercaria/shared-types';
import { readRollups } from '../../db/analytics/rollupRepository.js';
import { readTopQueries } from '../../db/analytics/searchQueryRepository.js';
import { traceEventsByQuery, type AnalyticsEventTraceRow } from '../../db/analytics/eventRepository.js';
import {
  countExposuresByVariant,
  readActiveExperiments,
  readExperimentVersions,
} from '../../db/analytics/experimentRepository.js';
import { metricByKey } from './metrics.js';
import { metricsWithoutRollup } from './rollup.js';
import { readAnalyticsRetentionHealth, type AnalyticsRetentionHealth } from './retention.js';
import { analyticsSinkStats, type AnalyticsSinkStats } from './sink.js';
import { checkoutGroupConverted } from './verified-conversion.js';
import { ANALYTICS_SEAMS, metricsAwaitingSeams } from './seams.js';

/** How many buckets one metric read returns at most. */
const MAX_SERIES_ROWS = 400;

/**
 * A metric series with its definition attached.
 *
 * The definition is not optional and is not looked up by the client: acceptance
 * 6 says every dashboard metric names its denominator, time window and
 * freshness, and the only reliable way to make that true is to make the number
 * arrive WITH them. A response of bare points would be one client refactor away
 * from a chart with no context.
 *
 * @returns The series, or `undefined` when no definition explains the key.
 */
export async function readMetricSeries(input: {
  metricKey: string;
  from: string;
  to: string;
  storeId?: string;
  market?: string;
}): Promise<AnalyticsMetricSeries | undefined> {
  const definition = metricByKey(input.metricKey);
  if (!definition) return undefined;

  const rows = await readRollups({
    metricKeys: [input.metricKey],
    from: input.from,
    to: input.to,
    // `''` is the platform-wide bucket, and it is the DEFAULT for an operator.
    // A merchant path passes its own store; this one has to opt in.
    storeId: input.storeId ?? '',
    ...(input.market === undefined ? {} : { market: input.market }),
  });

  const points: AnalyticsMetricPoint[] = rows.slice(0, MAX_SERIES_ROWS).map((row) => ({
    metricKey: row.metricKey,
    bucketDate: row.bucketDate,
    numerator: row.numerator,
    denominator: row.denominator,
    // `null`, never 0. A metric with nothing underneath it has no value, and
    // rendering 0% for "nobody searched" is the single most common way a
    // dashboard lies.
    value: row.denominator === 0 ? null : row.numerator / row.denominator,
    computedAt: row.computedAt,
    ...(row.market === '' ? {} : { market: row.market }),
    ...(row.actorKind === ''
      ? {}
      : { actorKind: row.actorKind as AnalyticsMetricPoint['actorKind'] }),
    ...(row.clientSurface === ''
      ? {}
      : { clientSurface: row.clientSurface as AnalyticsMetricPoint['clientSurface'] }),
    ...(row.buyerOrigin === ''
      ? {}
      : { buyerOrigin: row.buyerOrigin as AnalyticsMetricPoint['buyerOrigin'] }),
  }));

  return { definition, points };
}

/**
 * The top aggregate queries, after the privacy threshold.
 *
 * Dashboard 2 ("top aggregate zero-result queries after privacy thresholds").
 * `zeroResultOnly` narrows it; the threshold does not move either way.
 */
export async function readQueryReport(input: {
  from: string;
  to: string;
  market?: string;
  zeroResultOnly?: boolean;
  limit: number;
}): Promise<readonly AnalyticsQueryAggregate[]> {
  return readTopQueries(input);
}

/** What the funnel trace of one search returns. */
export interface AnalyticsQueryTrace {
  readonly queryEventId: string;
  readonly events: readonly AnalyticsEventTraceRow[];
}

/**
 * Trace one search's derived events, in order.
 *
 * Opens from the query event id and NOTHING else. There is deliberately no
 * "trace by actor" — see the module docblock.
 */
export async function traceQuery(
  queryEventId: string,
  limit: number,
): Promise<AnalyticsQueryTrace> {
  return { queryEventId, events: await traceEventsByQuery(queryEventId, limit) };
}

/** Whether one checkout group reached a verified payment. The conversion answer. */
export async function traceCheckoutConversion(
  checkoutGroupId: string,
): Promise<{ checkoutGroupId: string; converted: boolean }> {
  return { checkoutGroupId, converted: await checkoutGroupConverted(checkoutGroupId) };
}

/** One experiment version with its exposure counts — dashboard 12. */
export interface AnalyticsExperimentGuardrails {
  readonly experimentKey: string;
  readonly version: number;
  readonly status: string;
  readonly hypothesis: string;
  readonly primaryMetricKey: string;
  readonly guardrailMetricKeys: readonly string[];
  readonly stopConditions: readonly string[];
  readonly rankingPolicyVersion: string | null;
  readonly exposures: readonly { variant: string; units: number }[];
}

/**
 * Every ACTIVE experiment with its declared guardrails and its exposure counts.
 *
 * The guardrail METRIC KEYS travel with it rather than their current values:
 * an experiment's guardrails are a claim made in advance, and rendering them
 * beside live numbers is the dashboard's job. Resolving them here would let a
 * guardrail silently disappear from the display when its metric had no data,
 * which is exactly when somebody needs to see that it was declared.
 */
export async function readExperimentGuardrails(): Promise<
  readonly AnalyticsExperimentGuardrails[]
> {
  const active = await readActiveExperiments();
  const out: AnalyticsExperimentGuardrails[] = [];
  for (const experiment of active) {
    out.push({
      experimentKey: experiment.experimentKey,
      version: experiment.version,
      status: experiment.status,
      hypothesis: experiment.hypothesis,
      primaryMetricKey: experiment.primaryMetricKey,
      guardrailMetricKeys: experiment.guardrailMetricKeys,
      stopConditions: experiment.stopConditions,
      rankingPolicyVersion: experiment.rankingPolicyVersion,
      exposures: await countExposuresByVariant({
        experimentKey: experiment.experimentKey,
        experimentVersion: experiment.version,
      }),
    });
  }
  return out;
}

/** Every version of every experiment, for the operator list. */
export async function listExperiments(experimentKey?: string) {
  return readExperimentVersions(experimentKey);
}

/**
 * The operational health of the analytics domain itself.
 *
 * Four things a person needs to know and no dashboard would otherwise show:
 * whether the sink is dropping, whether retention is running, which metrics
 * have no rollup writer, and which are waiting on an unlanded issue. The
 * `ledgerImbalanceAttempts` precedent — a number that must be zero, exposed
 * where somebody will see it.
 */
export interface AnalyticsHealth {
  readonly sink: AnalyticsSinkStats;
  readonly retention: AnalyticsRetentionHealth;
  /** Metrics with a definition and no rollup writer. Should be explainable. */
  readonly metricsWithoutRollup: readonly string[];
  /** Metrics awaiting an unlanded issue, with the issue number. */
  readonly metricsAwaitingSeams: readonly { key: string; seam: string }[];
  /** The deferred capabilities and their contracts. */
  readonly seams: typeof ANALYTICS_SEAMS;
}

/** Read the health block. */
export async function readAnalyticsHealth(): Promise<AnalyticsHealth> {
  return {
    sink: analyticsSinkStats(),
    retention: await readAnalyticsRetentionHealth(),
    metricsWithoutRollup: metricsWithoutRollup().map((metric) => metric.key),
    metricsAwaitingSeams: metricsAwaitingSeams(),
    seams: ANALYTICS_SEAMS,
  };
}
