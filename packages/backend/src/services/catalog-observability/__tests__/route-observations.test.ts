/**
 * The in-process route observation store (#367 W16/W17).
 *
 * Everything here is module-scope arithmetic with no database and no clock, and
 * every case is written against the question "what would this report if the thing
 * it measures were absent". Four of them exist because the absent answer and the
 * healthy answer are the same number:
 *
 * - **A route that served nothing answers `undefined`, never a zeroed bucket.**
 *   A zeroed bucket has a p95 of 0 ms, and 0 ms clears every latency budget, so
 *   every cold task in the fleet would report as the fastest one — at exactly the
 *   moment after a deploy when somebody is watching.
 * - **A 304 is its own dimension.** Counted as a client error it would inflate
 *   the error rate and empty the cache-hit rate, two metrics moving in opposite
 *   wrong directions off one branch.
 * - **Counts are exact and percentiles are windowed**, and the two are separate
 *   fields precisely so neither can be read as the other. The ring-buffer case
 *   asserts both at once: `requests` counts everything ever fed, `observations`
 *   is capped, and the evicted head is genuinely gone.
 * - **A negative or non-finite duration is dropped from the reservoir while the
 *   request still counts.** One `NaN` sample makes every percentile for that
 *   route `NaN` forever, which renders as a broken tile rather than as a slow
 *   route, so the drop is the behaviour under test and the surviving count is the
 *   proof it was a drop and not a refusal.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_OBSERVED_ROUTES,
  LATENCY_RESERVOIR_CAPACITY,
  catalogObservabilityCounters,
  observeCatalogRoute,
  readRouteObservation,
  readRouteObservations,
  recordMetricCollectionFailure,
  recordUndefinedMetricEmission,
  resetCatalogRouteObservations,
  routeObservationKey,
} from '../route-observations.js';

/** Two observed templates, taken from the closed set rather than written out. */
const SCHEMA_ROUTE = '/catalog-authoring/schemas/:productTypeKey';
const SEARCH_ROUTE = '/search';

/** A path the budgets do not name, so the store must refuse it. */
const UNOBSERVED_ROUTE = '/catalog-authoring/schemas/:productTypeKey/history';

/** An ordinary duration, when the case is not about the number. */
const SOME_MS = 12;

beforeEach(() => {
  resetCatalogRouteObservations();
});

/** Feed one request at a status, with a duration the case does not care about. */
function observe(route: string, statusCode: number, durationMs = SOME_MS): void {
  observeCatalogRoute({ method: 'GET', route, statusCode, durationMs });
}

/* -------------------------------------------------------------------------- */

describe('the closed template set', () => {
  it('the two routes these cases use are really observed ones', () => {
    // The floor for the whole file: every assertion below rests on these being
    // in the closed set, and a renamed budget would otherwise turn this file
    // into a test of the refusal path wearing the names of the happy path.
    // (It did exactly that — repointing the authoring-schema budget at the route
    // the router really serves turned eight cases in this file red, all of them
    // reading `undefined` from the store.)
    //
    // FOUR, not five: the floor came down with the removal of the phantom
    // `/categories/autocomplete` budget, which named no route. A floor that could
    // never drop would be satisfied by padding the list with a template nobody
    // can observe, which is the state that removal fixed.
    expect(CATALOG_OBSERVED_ROUTES.length).toBeGreaterThanOrEqual(4);
    expect(CATALOG_OBSERVED_ROUTES).toContain(routeObservationKey('GET', SCHEMA_ROUTE));
    expect(CATALOG_OBSERVED_ROUTES).toContain(routeObservationKey('GET', SEARCH_ROUTE));
    expect(CATALOG_OBSERVED_ROUTES).not.toContain(routeObservationKey('GET', UNOBSERVED_ROUTE));
  });

  it('starts clean, with exactly three must-stay-zero counters', () => {
    // Exactly three, not "at least": a fourth counter is a fourth thing somebody
    // decided must never happen, and it belongs in `mustStayZero` on the report
    // with a docblock rather than arriving unannounced.
    expect(Object.keys(catalogObservabilityCounters()).sort()).toEqual([
      'metricCollectionFailures',
      'undefinedMetricEmissions',
      'unobservedRouteReports',
    ]);
    expect(catalogObservabilityCounters()).toEqual({
      metricCollectionFailures: 0,
      undefinedMetricEmissions: 0,
      unobservedRouteReports: 0,
    });
    expect(readRouteObservations()).toEqual([]);
  });

  it('keys are METHOD-uppercased, so one route cannot become two buckets', () => {
    expect(routeObservationKey('get', SEARCH_ROUTE)).toBe(`GET ${SEARCH_ROUTE}`);
    observeCatalogRoute({ method: 'get', route: SEARCH_ROUTE, statusCode: 200, durationMs: SOME_MS });
    // Written lower-case and read upper-case: the same bucket, or a task serving
    // through one spelling would report nothing while the other read zero.
    expect(readRouteObservation('GET', SEARCH_ROUTE)?.requests).toBe(1);
    expect(readRouteObservation('get', SEARCH_ROUTE)?.key).toBe(`GET ${SEARCH_ROUTE}`);
    expect(catalogObservabilityCounters().unobservedRouteReports).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('recording and refusing', () => {
  it('a recorded request appears with exact counts', () => {
    observe(SCHEMA_ROUTE, 200, 5);
    observe(SCHEMA_ROUTE, 200, 7);
    observe(SCHEMA_ROUTE, 500, 9);

    const observed = readRouteObservation('GET', SCHEMA_ROUTE);
    expect(observed).toBeDefined();
    expect(observed?.key).toBe(`GET ${SCHEMA_ROUTE}`);
    expect(observed?.requests).toBe(3);
    expect(observed?.serverErrors).toBe(1);
    expect(observed?.clientErrors).toBe(0);
    expect(observed?.notModified).toBe(0);
    expect(observed?.latency?.observations).toBe(3);

    // And the whole-store read agrees with the single read, so a dashboard and a
    // metric producer cannot disagree about one route.
    const all = readRouteObservations();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(observed);
  });

  it('an unobserved template is DROPPED and counted, never given a bucket', () => {
    observe(UNOBSERVED_ROUTE, 200);
    observe(UNOBSERVED_ROUTE, 500);

    // The counter is the whole signal: a non-zero value means a caller is
    // composing a key by hand, and creating the bucket instead would turn this
    // store into a traffic meter for the entire API.
    expect(catalogObservabilityCounters().unobservedRouteReports).toBe(2);
    expect(readRouteObservation('GET', UNOBSERVED_ROUTE)).toBeUndefined();
    expect(readRouteObservations()).toEqual([]);
    // A refusal must not be recorded as a collection failure — those are
    // different facts on the same report, one a caller bug and one an incident.
    expect(catalogObservabilityCounters().metricCollectionFailures).toBe(0);
  });

  it('an observed route that served nothing answers `undefined`, not a zeroed bucket', () => {
    observe(SCHEMA_ROUTE, 200);
    // Explicitly `undefined` rather than "falsy" or "no requests": a bucket of
    // zeros carries a p95 of 0 ms, which is below every budget, so a cold task
    // would report five green ticks for five surfaces nobody has called.
    expect(readRouteObservation('GET', SEARCH_ROUTE)).toBeUndefined();
    expect(readRouteObservations().map((entry) => entry.key)).toEqual([`GET ${SCHEMA_ROUTE}`]);
  });

  it('the two must-stay-zero counters are each wired to their own condition', () => {
    // A `count++` beside each call site would eventually drift; these are the
    // two exported increments, and asserting each moves ONLY its own counter is
    // what says they have not been crossed.
    recordMetricCollectionFailure();
    expect(catalogObservabilityCounters()).toEqual({
      metricCollectionFailures: 1,
      undefinedMetricEmissions: 0,
      unobservedRouteReports: 0,
    });
    recordUndefinedMetricEmission();
    expect(catalogObservabilityCounters()).toEqual({
      metricCollectionFailures: 1,
      undefinedMetricEmissions: 1,
      unobservedRouteReports: 0,
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('status classification', () => {
  it('a 5xx is a server error and nothing else', () => {
    observe(SCHEMA_ROUTE, 500);
    observe(SCHEMA_ROUTE, 503);
    observe(SCHEMA_ROUTE, 599);
    const observed = readRouteObservation('GET', SCHEMA_ROUTE);
    expect(observed?.requests).toBe(3);
    expect(observed?.serverErrors).toBe(3);
    expect(observed?.clientErrors).toBe(0);
    expect(observed?.notModified).toBe(0);
  });

  it('a 304 is a cache hit and NOT a client error', () => {
    // The load-bearing one. `authoring_schema_error_rate` and
    // `authoring_schema_client_cache_hit_rate` share this bucket's denominator,
    // so a 304 counted as an error inflates the first and empties the second —
    // two metrics wrong in opposite directions from one misplaced branch, and
    // both of them plausible-looking numbers.
    observe(SCHEMA_ROUTE, 304);
    observe(SCHEMA_ROUTE, 304);
    const observed = readRouteObservation('GET', SCHEMA_ROUTE);
    expect(observed?.requests).toBe(2);
    expect(observed?.notModified).toBe(2);
    expect(observed?.clientErrors).toBe(0);
    expect(observed?.serverErrors).toBe(0);
  });

  it('a 4xx other than 304 is a client error', () => {
    observe(SCHEMA_ROUTE, 400);
    observe(SCHEMA_ROUTE, 404);
    observe(SCHEMA_ROUTE, 422);
    observe(SCHEMA_ROUTE, 499);
    const observed = readRouteObservation('GET', SCHEMA_ROUTE);
    expect(observed?.requests).toBe(4);
    expect(observed?.clientErrors).toBe(4);
    expect(observed?.serverErrors).toBe(0);
    expect(observed?.notModified).toBe(0);
  });

  it('a 2xx and a plain redirect are in no error bucket at all', () => {
    observe(SCHEMA_ROUTE, 200);
    observe(SCHEMA_ROUTE, 204);
    observe(SCHEMA_ROUTE, 302);
    const observed = readRouteObservation('GET', SCHEMA_ROUTE);
    expect(observed?.requests).toBe(3);
    expect(observed?.serverErrors).toBe(0);
    expect(observed?.clientErrors).toBe(0);
    expect(observed?.notModified).toBe(0);
  });

  it('the three dimensions partition the statuses they claim', () => {
    // One request per class, so the sum identity is checkable: an over-counting
    // branch (a 500 landing in two buckets) passes every case above and fails
    // here.
    observe(SCHEMA_ROUTE, 200);
    observe(SCHEMA_ROUTE, 304);
    observe(SCHEMA_ROUTE, 404);
    observe(SCHEMA_ROUTE, 500);
    const observed = readRouteObservation('GET', SCHEMA_ROUTE);
    expect(observed?.requests).toBe(4);
    expect(
      (observed?.serverErrors ?? 0) + (observed?.clientErrors ?? 0) + (observed?.notModified ?? 0),
    ).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */

describe('percentiles', () => {
  /** 1..100 ms, shuffled by a fixed stride so the store cannot be fed sorted input. */
  const SAMPLE_COUNT = 100;

  function feedKnownDistribution(): number[] {
    const fed: number[] = [];
    // A fixed stride co-prime with 100 visits every value exactly once in a
    // non-monotone order — deterministic, and not the order the summarizer
    // sorts into.
    for (let step = 0; step < SAMPLE_COUNT; step += 1) {
      const durationMs = ((step * 37) % SAMPLE_COUNT) + 1;
      fed.push(durationMs);
      observe(SEARCH_ROUTE, 200, durationMs);
    }
    return fed;
  }

  it('are nearest-rank over the reservoir, so every figure was actually observed', () => {
    const fed = feedKnownDistribution();
    expect(new Set(fed).size).toBe(SAMPLE_COUNT);

    const latency = readRouteObservation('GET', SEARCH_ROUTE)?.latency;
    expect(latency?.observations).toBe(SAMPLE_COUNT);
    // Nearest-rank: rank = ceil(q * n), so over 1..100 the figures are the
    // sorted values at 50, 95 and 99 — each a duration a request really took.
    // An interpolating definition would answer 50.5, 95.05 and 99.01, none of
    // which is a request anybody could go and look at.
    expect(latency?.p50Ms).toBe(50);
    expect(latency?.p95Ms).toBe(95);
    expect(latency?.p99Ms).toBe(99);
    expect(latency?.maxMs).toBe(100);
    for (const figure of [latency?.p50Ms, latency?.p95Ms, latency?.p99Ms, latency?.maxMs]) {
      expect(fed, `${String(figure)} was never observed`).toContain(figure);
    }
  });

  it('a single sample answers with that sample and not with a zero', () => {
    observe(SEARCH_ROUTE, 200, 41);
    const latency = readRouteObservation('GET', SEARCH_ROUTE)?.latency;
    expect(latency).toEqual({ observations: 1, p50Ms: 41, p95Ms: 41, p99Ms: 41, maxMs: 41 });
  });
});

/* -------------------------------------------------------------------------- */

describe('the ring buffer', () => {
  /**
   * How many samples are fed past the cap.
   *
   * Eight rather than one, so the eviction is visible as a WINDOW moving rather
   * than as a single overwritten slot — an off-by-one that overwrote index 0 on
   * every wrap would keep exactly one slow sample and pass a one-sample case.
   */
  const OVERFLOW = 8;
  /** Far above anything the fast tail feeds, so eviction is unambiguous. */
  const SLOW_MS = 99_000;
  const FAST_MS = 3;

  it('caps `observations` at the reservoir while `requests` stays exact', () => {
    // The head is slow and is fed FIRST, so it occupies the slots the wrap
    // overwrites: the store fills by `push` to the cap and then writes from
    // index 0, so after `cap + OVERFLOW` samples the first `OVERFLOW` are gone.
    for (let index = 0; index < OVERFLOW; index += 1) {
      observe(SEARCH_ROUTE, 200, SLOW_MS);
    }
    for (let index = 0; index < LATENCY_RESERVOIR_CAPACITY; index += 1) {
      observe(SEARCH_ROUTE, 200, FAST_MS);
    }

    const observed = readRouteObservation('GET', SEARCH_ROUTE);
    // Exact, and covering every request since the process started. Conflating
    // this with `observations` is the confusion the two fields exist to prevent.
    expect(observed?.requests).toBe(LATENCY_RESERVOIR_CAPACITY + OVERFLOW);
    expect(observed?.latency?.observations).toBe(LATENCY_RESERVOIR_CAPACITY);
    // The slow head has been evicted: `maxMs` is the recent window's worst, not
    // the worst ever. A reservoir that kept everything would answer SLOW_MS here
    // and would grow without bound on a long-lived task.
    expect(observed?.latency?.maxMs).toBe(FAST_MS);
    expect(observed?.latency?.p99Ms).toBe(FAST_MS);
  });

  it('holds every sample up to the cap, so the eviction above is not the only path', () => {
    // The control for the case above: at exactly the cap nothing is evicted, so
    // a store that dropped samples early would pass the eviction assertion for
    // the wrong reason.
    observe(SEARCH_ROUTE, 200, SLOW_MS);
    for (let index = 1; index < LATENCY_RESERVOIR_CAPACITY; index += 1) {
      observe(SEARCH_ROUTE, 200, FAST_MS);
    }
    const observed = readRouteObservation('GET', SEARCH_ROUTE);
    expect(observed?.requests).toBe(LATENCY_RESERVOIR_CAPACITY);
    expect(observed?.latency?.observations).toBe(LATENCY_RESERVOIR_CAPACITY);
    expect(observed?.latency?.maxMs).toBe(SLOW_MS);
  });
});

/* -------------------------------------------------------------------------- */

describe('unusable durations', () => {
  it('a negative or non-finite duration is dropped and the request still counts', () => {
    observe(SEARCH_ROUTE, 200, -1);
    observe(SEARCH_ROUTE, 200, Number.NaN);
    observe(SEARCH_ROUTE, 200, Number.POSITIVE_INFINITY);

    const refusedOnly = readRouteObservation('GET', SEARCH_ROUTE);
    // The request is real and is counted; only the reservoir refuses the sample.
    // Dropping the whole request would understate the error-rate denominator,
    // and keeping the sample would make every percentile for the route `NaN`.
    expect(refusedOnly?.requests).toBe(3);
    expect(refusedOnly?.latency).toBeUndefined();

    observe(SEARCH_ROUTE, 200, 8);
    const withOne = readRouteObservation('GET', SEARCH_ROUTE);
    expect(withOne?.requests).toBe(4);
    expect(withOne?.latency?.observations).toBe(1);
    expect(withOne?.latency?.maxMs).toBe(8);
    expect(Number.isFinite(withOne?.latency?.p95Ms)).toBe(true);
  });

  it('a zero duration is kept — it is a fast request, not a broken clock', () => {
    observe(SEARCH_ROUTE, 200, 0);
    const observed = readRouteObservation('GET', SEARCH_ROUTE);
    expect(observed?.latency?.observations).toBe(1);
    expect(observed?.latency?.p50Ms).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('the reset seam', () => {
  it('clears buckets and counters together', () => {
    observe(SCHEMA_ROUTE, 500, 4);
    observe(UNOBSERVED_ROUTE, 200);
    recordMetricCollectionFailure();
    recordUndefinedMetricEmission();
    expect(readRouteObservations()).toHaveLength(1);

    resetCatalogRouteObservations();

    // Both halves, because a reset that cleared the buckets and left the
    // counters would make every later assertion in every file that uses this
    // seam depend on what ran before it.
    expect(readRouteObservations()).toEqual([]);
    expect(readRouteObservation('GET', SCHEMA_ROUTE)).toBeUndefined();
    expect(catalogObservabilityCounters()).toEqual({
      metricCollectionFailures: 0,
      undefinedMetricEmissions: 0,
      unobservedRouteReports: 0,
    });
  });
});
