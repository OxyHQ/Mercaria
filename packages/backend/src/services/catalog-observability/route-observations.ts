/**
 * In-process observation of the catalog read surfaces (#367 W16 latency budgets,
 * W17 authoring-schema latency / error rate / cache hit rate).
 *
 * ## Why in-process, and what that costs
 *
 * This is the `ledgerImbalanceAttempts` decision applied to timings: the numbers
 * live in module scope beside the code that records them, they reset on restart,
 * and they are per ECS task. Stated rather than hidden, because it decides how
 * they may be read — a p95 here is "what this task has served since it started",
 * never a historical series, and a deploy zeroes it. The alternative was a table
 * written on every catalog read, which is a write in the hot path of the exact
 * surfaces whose latency is under budget.
 *
 * ## Percentiles come from a bounded reservoir, and it says so
 *
 * Counts (`requests`, `serverErrors`, `notModified`) are exact and cover every
 * request since the process started. Percentiles cannot be: keeping every sample
 * is an unbounded array on a long-lived task. `LATENCY_RESERVOIR_CAPACITY` is
 * the most recent N, `observations` reports how many samples the percentiles
 * were actually computed over, and the two numbers are deliberately different
 * fields so a reader cannot mistake the second for the first.
 *
 * A ring buffer of the most recent N, rather than a random reservoir: for an
 * incident signal "the last few thousand requests" is the question being asked,
 * and a uniform sample over all time would dilute a live regression with
 * yesterday's healthy traffic.
 *
 * ## Nearest-rank, so every figure was observed
 *
 * `summarizeLatency` in the #61 harness already made this choice and this reuses
 * it rather than interpolating: an interpolated p95 is a number no request ever
 * took, and the first thing anybody does with a latency figure is go looking for
 * the request that produced it.
 *
 * ## The route is a TEMPLATE, never a path
 *
 * `/categories/:id` and never `/categories/electronics`. A concrete path would
 * give one bucket per category, each with a handful of samples and no usable
 * percentile, and would additionally put shopper-visible slugs into a metrics
 * surface. `CATALOG_OBSERVED_ROUTES` is the closed set of templates observed at
 * all, so an unrecognised path is dropped rather than creating a bucket.
 */

import { summarizeLatency } from '../graph-benchmark/measure.js';
import type { CatalogLatencySample } from '@mercaria/shared-types';
import { CATALOG_LATENCY_BUDGETS } from '@mercaria/shared-types';

/**
 * How many recent latency samples back the percentiles, per route template.
 *
 * 4,096 is large enough that a p99 rests on ~41 samples rather than on one, and
 * small enough that the whole store is a few hundred kilobytes across every
 * observed route.
 */
export const LATENCY_RESERVOIR_CAPACITY = 4_096;

/**
 * The route templates this domain observes.
 *
 * Derived from `CATALOG_LATENCY_BUDGETS` rather than written a second time — a
 * budget for a route nobody observes is a budget that can never fire, and an
 * observed route with no budget is a number with no threshold. One list.
 */
export const CATALOG_OBSERVED_ROUTES: readonly string[] = CATALOG_LATENCY_BUDGETS.map(
  (budget) => `${budget.method} ${budget.route}`,
);

/** The key a bucket is stored under. `METHOD path-template`. */
export function routeObservationKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}

interface RouteBucket {
  requests: number;
  serverErrors: number;
  clientErrors: number;
  notModified: number;
  /** Ring buffer of the most recent samples. */
  samples: number[];
  writeCursor: number;
}

/** What one observed route has done since this process started. */
export interface RouteObservation {
  readonly key: string;
  /** Exact, since process start. */
  readonly requests: number;
  /** Exact. Status >= 500. */
  readonly serverErrors: number;
  /** Exact. Status 400-499, excluding 304 (which is not an error). */
  readonly clientErrors: number;
  /** Exact. Answered 304 against a matching ETag — the client-visible cache hit. */
  readonly notModified: number;
  /** Percentiles over the reservoir. Absent when nothing has been observed. */
  readonly latency?: CatalogLatencySample;
}

const buckets = new Map<string, RouteBucket>();

/**
 * Readings this process produced that should be impossible.
 *
 * The `ledgerImbalanceAttempts` shape: a number nobody expects to be non-zero,
 * exposed where somebody will see it. Both are incremented through one private
 * function each, so the counter cannot drift from the condition it measures the
 * way a `count++` beside each call site eventually would.
 */
let unobservedRouteReports = 0;
let metricCollectionFailures = 0;
let undefinedMetricEmissions = 0;

/**
 * A route reported an observation that is not in the closed template set.
 *
 * Impossible when the middleware is mounted correctly, because it resolves the
 * template from the same list. A non-zero value means a caller is composing a
 * key by hand.
 */
function refuseUnobservedRoute(): void {
  unobservedRouteReports += 1;
}

/** A domain reader threw while a metric was being collected. */
export function recordMetricCollectionFailure(): void {
  metricCollectionFailures += 1;
}

/**
 * The collector produced a reading for a key the registry does not define.
 *
 * Structurally impossible — `CATALOG_METRIC_KEYS` is derived from
 * `CATALOG_METRICS` and the collector is gated against it — so a non-zero value
 * means two lists have drifted, which is the failure the derivation exists to
 * prevent.
 */
export function recordUndefinedMetricEmission(): void {
  undefinedMetricEmissions += 1;
}

/** Counters that must stay zero, for the metrics report. */
export function catalogObservabilityCounters(): Readonly<Record<string, number>> {
  return {
    unobservedRouteReports,
    metricCollectionFailures,
    undefinedMetricEmissions,
  };
}

/**
 * Record one served request.
 *
 * `route` must be a template from `CATALOG_OBSERVED_ROUTES`; anything else is
 * counted as a refusal and dropped rather than creating a bucket. Returns
 * nothing and throws nothing: observation must never be able to fail a catalog
 * read, which is the `recordAnalyticsEvent` guarantee held by the signature.
 */
export function observeCatalogRoute(input: {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationMs: number;
}): void {
  const key = routeObservationKey(input.method, input.route);
  if (!CATALOG_OBSERVED_ROUTES.includes(key)) {
    refuseUnobservedRoute();
    return;
  }

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { requests: 0, serverErrors: 0, clientErrors: 0, notModified: 0, samples: [], writeCursor: 0 };
    buckets.set(key, bucket);
  }

  bucket.requests += 1;
  if (input.statusCode >= 500) {
    bucket.serverErrors += 1;
  } else if (input.statusCode === 304) {
    // Not an error and not a miss. The one status that is its own dimension.
    bucket.notModified += 1;
  } else if (input.statusCode >= 400) {
    bucket.clientErrors += 1;
  }

  // A negative or non-finite duration would poison the percentiles. It cannot
  // arise from a monotonic clock, so it is dropped from the reservoir while the
  // request still counts — the alternative is a p50 of NaN for the whole route.
  if (Number.isFinite(input.durationMs) && input.durationMs >= 0) {
    if (bucket.samples.length < LATENCY_RESERVOIR_CAPACITY) {
      bucket.samples.push(input.durationMs);
    } else {
      bucket.samples[bucket.writeCursor] = input.durationMs;
      bucket.writeCursor = (bucket.writeCursor + 1) % LATENCY_RESERVOIR_CAPACITY;
    }
  }
}

/** Read one route's observations, or `undefined` when it has served nothing. */
export function readRouteObservation(method: string, route: string): RouteObservation | undefined {
  const key = routeObservationKey(method, route);
  const bucket = buckets.get(key);
  if (!bucket) {
    // Absent, never a zeroed bucket. A route this task has not served has no
    // p95, and inventing 0 ms would report every cold task as the fastest.
    return undefined;
  }
  return {
    key,
    requests: bucket.requests,
    serverErrors: bucket.serverErrors,
    clientErrors: bucket.clientErrors,
    notModified: bucket.notModified,
    latency: bucket.samples.length === 0 ? undefined : toSample(bucket.samples),
  };
}

/** Every route this process has observed. */
export function readRouteObservations(): readonly RouteObservation[] {
  const out: RouteObservation[] = [];
  for (const key of CATALOG_OBSERVED_ROUTES) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    out.push({
      key,
      requests: bucket.requests,
      serverErrors: bucket.serverErrors,
      clientErrors: bucket.clientErrors,
      notModified: bucket.notModified,
      latency: bucket.samples.length === 0 ? undefined : toSample(bucket.samples),
    });
  }
  return out;
}

function toSample(samples: readonly number[]): CatalogLatencySample {
  const summary = summarizeLatency(samples);
  return {
    observations: samples.length,
    p50Ms: summary.p50Ms,
    p95Ms: summary.p95Ms,
    p99Ms: summary.p99Ms,
    maxMs: summary.maxMs,
  };
}

/**
 * Clear every observation and counter.
 *
 * The test seam, `resetAnalyticsSink`'s shape. Nothing in production calls it —
 * a process that could be asked to forget its own error count is one whose error
 * count means nothing.
 */
export function resetCatalogRouteObservations(): void {
  buckets.clear();
  unobservedRouteReports = 0;
  metricCollectionFailures = 0;
  undefinedMetricEmissions = 0;
}
