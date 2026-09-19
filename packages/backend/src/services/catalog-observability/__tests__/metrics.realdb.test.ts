/**
 * The catalog metrics collector against a REAL PostgreSQL server (#367 W17).
 *
 * ## What a mocked suite would report here
 *
 * Thirty-eight green readings over statements the server never parsed. Every
 * producer in this domain is a `count(*) filter (where <enum> = …)`, a union over
 * four localization tables, a `bool_or` roll-up per distinct token or a recursive
 * facet plan — a stubbed `execute` evaluates none of them, and the shapes the
 * report is graded on (`ratio` absent at a zero denominator, `latency` absent at
 * zero observations) would be graded against numbers the test itself supplied.
 *
 * ## THE COLLECTOR IS PROVEN TO READ SOMETHING, TWICE
 *
 * Everything else in this file is satisfied by a collector that returns
 * constants, so there are two positive controls with nothing in common:
 *
 * - the **in-process** one feeds the route store two requests and asserts the
 *   three `route_observations` metrics move, which also exercises the `0 / 0`
 *   branch on the way in — those denominators are deterministically zero in a
 *   process that has served no HTTP;
 * - the **Postgres** one inserts one `catalog_proposals` row and asserts the
 *   proposal metrics move by exactly one.
 *
 * ## Scoping, because the database is SHARED with parallel files
 *
 * Every metric here is a global aggregate with no tenant predicate, so an
 * absolute count is a test of what every other file happened to be doing. The
 * Postgres control is therefore a DELTA measured inside one `repeatable read`
 * transaction that is rolled back: at the default `read committed` each statement
 * takes a fresh snapshot and a sibling's commit between the two collections lands
 * in the delta, which is the failure `integrity.realdb.test.ts` measured and
 * documented in this same directory. Rolling back also means no row this file
 * writes is ever visible to a sibling, and there is no teardown to get wrong —
 * which matters here because `catalog_proposals` is `restrict` from three
 * directions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  CATALOG_METRICS,
  CATALOG_METRIC_KEYS,
  CATALOG_UNMEASURED_REASONS,
  type CatalogMetricReading,
  type CatalogMetricsReport,
} from '@mercaria/shared-types';
import {
  closePostgres,
  connectPostgres,
  type Database,
  type Transaction,
} from '../../../db/postgres.js';
import { collectCatalogMetrics } from '../metrics.service.js';
import {
  readAuthoringPublicationCounters,
  recordPublicationAttempt,
  resetAuthoringPublicationCounters,
} from '../../catalog-authoring/publication-observation.js';
import {
  readLocalizationReadCounters,
  recordLocalizedResolution,
  resetLocalizationReadCounters,
} from '../../catalog-localization/read-observation.js';
import {
  observeCatalogRoute,
  resetCatalogRouteObservations,
} from '../route-observations.js';

const db: Database = await connectPostgres();

/**
 * How many category scopes the facet sweep draws in this file.
 *
 * Small deliberately: `facet_scope_empty_rate` is exercised as a SHAPE here, and
 * the sweep's own behaviour is `facet-scope-sweep.realdb.test.ts`'s subject. A
 * default-sized draw would make every collection in this file two hundred facet
 * plans and measure nothing extra.
 */
const FACET_SAMPLE_SIZE = 3;

/**
 * Zero for the fixture transaction.
 *
 * The Postgres control is about `catalog_proposals`; a facet sweep inside the
 * fixture transaction is planning work that says nothing about the delta under
 * test, and it is the slowest thing a collection does.
 */
const NO_FACET_SAMPLE = 0;

/** Every id this file mints, so a stray commit would be identifiable as ours. */
const FIXTURE_PREFIX = 'obs-metrics';

/** The properties an `unmeasured` reading may not carry, in any form. */
const QUANTITY_PROPERTIES: readonly string[] = [
  'numerator',
  'denominator',
  'ratio',
  'count',
  'latency',
  'ageSeconds',
  'by',
];

/** An observed route template with three metrics behind it. */
const SCHEMA_ROUTE = '/catalog-authoring/schemas/:productTypeKey';
const FACETS_ROUTE = '/facets';
const CATEGORIES_ROUTE = '/categories';
const SEARCH_ROUTE = '/search';

let baseline: CatalogMetricsReport;

beforeAll(async () => {
  // Reset FIRST, so the baseline's `mustStayZero` and its two zero-denominator
  // ratios are facts about this collection rather than about whatever ran before
  // it in this worker.
  resetCatalogRouteObservations();
  baseline = await collectCatalogMetrics({ facetSampleSize: FACET_SAMPLE_SIZE });
});

afterAll(async () => {
  await closePostgres();
});

/** Thrown to roll a fixture transaction back. Never escapes the helper. */
class RolledBack extends Error {}

/**
 * Run `work` inside a rolled-back `repeatable read` transaction.
 *
 * The isolation level is load-bearing and the reasoning is
 * `integrity.realdb.test.ts`'s, measured there: every assertion inside is a
 * delta, and at `read committed` a parallel file's commit between the two
 * readings is indistinguishable from this file's own insert. The callback
 * parameter is named `tx` deliberately — `advisory-lock-census.ts` classifies a
 * handle as transactional by name.
 */
async function rolledBack<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  let captured: T;
  try {
    await db.transaction(
      async (tx) => {
        captured = await work(tx);
        throw new RolledBack('fixture transaction rolled back deliberately');
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return captured;
}

/** One reading by key, or `undefined`. */
function reading(report: CatalogMetricsReport, key: string): CatalogMetricReading | undefined {
  return report.readings.find((entry) => entry.key === key);
}

/**
 * A reading's numerator, asserting it is MEASURED first.
 *
 * Returning `0` for an unmeasured reading is exactly the coercion this domain
 * exists to refuse, and in a delta assertion it would silently answer "nothing
 * moved" for a source that had failed.
 */
function measuredNumerator(report: CatalogMetricsReport, key: string): number {
  const entry = reading(report, key);
  expect(entry, `${key} is not in the report`).toBeDefined();
  expect(entry?.state, `${key} is not measured — see mustStayZero and the logged failure`).toBe(
    'measured',
  );
  if (!entry || entry.state !== 'measured') return Number.NaN;
  return entry.numerator;
}

/** A measured reading's denominator, asserting it is MEASURED first. */
function measuredDenominator(report: CatalogMetricsReport, key: string): number {
  const entry = reading(report, key);
  expect(entry?.state, `${key} is not measured`).toBe('measured');
  if (!entry || entry.state !== 'measured') return Number.NaN;
  expect(entry.denominator, `${key} is not a ratio`).toBeDefined();
  return entry.denominator ?? Number.NaN;
}

/**
 * Assert one reading's breakdown SUMS to the reading itself, and say how many
 * buckets it walked.
 *
 * The identity a producer whose totals and buckets came from two statements
 * fails: the two agree most of the time and disagree exactly when the catalogue
 * moved between them. The RETURN VALUE is the vacuity floor — over an empty
 * breakdown the identity is `0 === 0`, which is true and is a measurement of
 * nothing, so every caller has to state what it did about that.
 */
function expectBucketsSumToReading(entry: CatalogMetricReading | undefined): number {
  expect(entry, 'no such reading').toBeDefined();
  if (!entry || entry.state !== 'measured' || entry.by === undefined) return 0;
  let numerator = 0;
  let denominator = 0;
  for (const bucket of entry.by) {
    expect(bucket.key, `${entry.key} has a blank bucket key`).not.toBe('');
    // A closed-set dimension value — a locale, a market, a source id, a state.
    // Never a label somebody typed and never anything belonging to a person,
    // which is why a bucket key is checked for shape rather than rendered.
    expect(bucket.key.length, `${entry.key}'s bucket key looks like free text`).toBeLessThan(128);
    expect(bucket.numerator, `${entry.key}/${bucket.key} is negative`).toBeGreaterThanOrEqual(0);
    expect(
      bucket.denominator,
      `${entry.key}/${bucket.key} counts more than its population`,
    ).toBeGreaterThanOrEqual(bucket.numerator);
    expect(
      Object.keys(bucket).includes('ratio'),
      `${entry.key}/${bucket.key}: ratio vs denominator`,
    ).toBe(bucket.denominator > 0);
    numerator += bucket.numerator;
    denominator += bucket.denominator;
  }
  expect(numerator, `${entry.key}: buckets do not sum to the numerator`).toBe(entry.numerator);
  expect(denominator, `${entry.key}: buckets do not sum to the denominator`).toBe(entry.denominator);
  return entry.by.length;
}

/* -------------------------------------------------------------------------- */
/* The report's shape                                                          */
/* -------------------------------------------------------------------------- */

describe('collectCatalogMetrics', () => {
  it('answers exactly one reading per definition, in registry order', () => {
    expect(baseline.readings).toHaveLength(CATALOG_METRICS.length);
    // Element-wise, not set equality: the report is built by walking
    // `CATALOG_METRICS`, and asserting the ORDER is what says it walked the
    // registry rather than an internal list that happens to hold the same keys.
    expect(baseline.readings.map((entry) => entry.key)).toEqual(
      CATALOG_METRICS.map((definition) => definition.key),
    );
    for (const entry of baseline.readings) {
      expect(CATALOG_METRIC_KEYS, `${entry.key} resolves to no definition`).toContain(entry.key);
    }
    expect(Date.parse(baseline.collectedAt), 'collectedAt is not a timestamp').not.toBeNaN();

    // Printed on SUCCESS. `state: measured, numerator: 0` over an empty
    // catalogue and over a populated one are the same assertion and opposite
    // facts, and the run log is where a later reader sees which one this was.
    // `process.stdout.write` rather than `console`, which vitest intercepts.
    process.stdout.write(
      `\ncatalog metrics collection (${String(baseline.readings.length)} readings, `
        + `${String(baseline.awaitingSeams.length)} seams):\n`
        + `${baseline.readings
          .map((entry) =>
            entry.state === 'measured'
              ? `  ${entry.key.padEnd(42)} ${entry.kind.padEnd(12)} `
                + `${String(entry.numerator)}`
                + `${entry.denominator === undefined ? '' : ` / ${String(entry.denominator)}`}`
              : `  ${entry.key.padEnd(42)} ${entry.kind.padEnd(12)} unmeasured (${entry.reason})`,
          )
          .join('\n')}\n\n`,
    );
  });

  it('every definition carrying a seam reads back UNMEASURED, with that seam verbatim', () => {
    // The count of definitions actually checked is asserted against the registry
    // length, because a loop that ran zero times reports zero failures — which is
    // the whole failure mode of a per-metric assertion over a report that came
    // back short.
    let checked = 0;
    const unexpectedlyUnmeasured: string[] = [];
    /** Metrics whose route this deployment does not mount. Expected, and named. */
    const notMounted: string[] = [];

    for (const definition of CATALOG_METRICS) {
      const entry = reading(baseline, definition.key);
      expect(entry, `${definition.key} produced no reading`).toBeDefined();
      if (!entry) continue;
      checked += 1;
      expect(entry.kind, `${definition.key}'s reading has the wrong kind`).toBe(definition.kind);

      if (definition.unmeasured !== undefined) {
        expect(entry.state, `${definition.key} declares a seam and reads measured`).toBe(
          'unmeasured',
        );
        if (entry.state !== 'unmeasured') continue;
        // Verbatim, both halves: the collector reads the branch off this field,
        // so a report that invented its own reason or seam text would be a
        // second answer to a question the registry already answers.
        expect(entry.reason).toBe(definition.unmeasured.reason);
        expect(entry.seam).toBe(definition.unmeasured.seam);
        continue;
      }

      if (entry.state !== 'measured') {
        // A produced metric may degrade at RUNTIME for two reasons, and they are
        // not the same fact — which is the whole distinction this domain is built
        // on, so the gate keeps them apart rather than accepting "unmeasured
        // either way".
        //
        // `surface_not_mounted` is EXPECTED here and is a fact about the
        // deployment: three of the four budgeted routes sit behind a rollout flag
        // defaulting to false, so on this test deployment their metrics cannot
        // measure. It is collected and NAMED below rather than asserted empty.
        //
        // `source_unavailable` means a reader threw. That is an INCIDENT and must
        // be empty.
        if (entry.reason === 'surface_not_mounted') {
          notMounted.push(definition.key);
        } else {
          unexpectedlyUnmeasured.push(`${definition.key} (${entry.reason})`);
        }
      }
    }

    expect(checked, 'the report is shorter than the registry').toBe(CATALOG_METRICS.length);
    expect(
      unexpectedlyUnmeasured,
      'a produced metric degraded to source_unavailable — its reader threw',
    ).toEqual([]);

    // Not asserted empty, and not asserted at an exact count either: which
    // rollout flags a deployment has on is a deployment's business. What IS
    // asserted is that every one of them names the closed reason, and the list is
    // printed so a run's blind spots are visible rather than implied.
    process.stdout.write(
      `catalog metrics: ${String(notMounted.length)} metric(s) unmeasured because their route is `
        + `not mounted here${notMounted.length === 0 ? '' : ` (${notMounted.join(', ')})`}\n`,
    );
  });

  it('an unmeasured reading carries no quantity of ANY kind', () => {
    const unmeasured = baseline.readings.filter((entry) => entry.state === 'unmeasured');
    // The floor: with nothing unmeasured this case would pass by having nothing
    // to walk, and #367 has seven real gaps.
    expect(unmeasured.length).toBeGreaterThanOrEqual(5);

    for (const entry of unmeasured) {
      if (entry.state !== 'unmeasured') continue;
      expect(CATALOG_UNMEASURED_REASONS, `${entry.key} has an unknown reason`).toContain(
        entry.reason,
      );
      expect(entry.seam.length, `${entry.key} has no seam`).toBeGreaterThan(40);
      // `Object.keys`, never `=== undefined`: the type guarantee is about
      // ABSENCE, and a branch carrying `ratio: undefined` satisfies an
      // undefined check while `'ratio' in reading` — which is what a serializer
      // and `JSON.stringify` both see — stays true.
      const keys = Object.keys(entry);
      for (const property of QUANTITY_PROPERTIES) {
        expect(keys, `${entry.key} is unmeasured and carries ${property}`).not.toContain(property);
      }
      expect(keys.sort()).toEqual(['key', 'kind', 'reason', 'seam', 'state']);
    }
  });

  it('a measured reading carries a numerator, and the optional fields are biconditional', () => {
    const measured = baseline.readings.filter((entry) => entry.state === 'measured');
    expect(measured.length).toBeGreaterThanOrEqual(20);

    for (const entry of measured) {
      if (entry.state !== 'measured') continue;
      const keys = Object.keys(entry);
      expect(typeof entry.numerator, `${entry.key} has no numeric numerator`).toBe('number');
      expect(Number.isFinite(entry.numerator), `${entry.key}'s numerator is not finite`).toBe(true);
      expect(entry.numerator, `${entry.key} has a negative numerator`).toBeGreaterThanOrEqual(0);

      // `denominator` exists exactly for a ratio. A producer that reached for the
      // wrong builder — `count()` for a ratio definition, or `ratio()` for a
      // count — is a metric whose kind and shape disagree, and the read surface
      // renders on the kind.
      expect(keys.includes('denominator'), `${entry.key}: denominator vs kind`).toBe(
        entry.kind === 'ratio',
      );
      // `ratio` exactly when there is something to divide by. `0 / 0` is
      // MEASURED — the read ran and the population is empty — and is not 100%.
      expect(keys.includes('ratio'), `${entry.key}: ratio vs denominator`).toBe(
        entry.kind === 'ratio' && (entry.denominator ?? 0) > 0,
      );
      expect(keys.includes('latency'), `${entry.key}: latency vs observations`).toBe(
        entry.kind === 'latency' && entry.numerator > 0,
      );
      expect(keys.includes('ageSeconds'), `${entry.key}: ageSeconds vs rows`).toBe(
        entry.kind === 'age_seconds' && entry.numerator > 0,
      );
      if (keys.includes('by')) {
        expect(entry.kind, `${entry.key} has a breakdown and is not a ratio`).toBe('ratio');
      }

      if (entry.kind === 'ratio') {
        expect(entry.denominator, `${entry.key} has a negative denominator`).toBeGreaterThanOrEqual(
          0,
        );
        if (entry.ratio !== undefined) {
          expect(entry.ratio, `${entry.key}'s ratio is not a proportion`).toBe(
            entry.numerator / (entry.denominator ?? 1),
          );
        }
      }
      if (entry.latency !== undefined) {
        expect(entry.latency.observations).toBe(entry.numerator);
        expect(entry.latency.p50Ms).toBeLessThanOrEqual(entry.latency.p95Ms);
        expect(entry.latency.p95Ms).toBeLessThanOrEqual(entry.latency.p99Ms);
        expect(entry.latency.p99Ms).toBeLessThanOrEqual(entry.latency.maxMs);
      }
    }
  });

  it('every breakdown sums to its own reading, over whatever the database holds', () => {
    const withBreakdown = baseline.readings.filter(
      (entry) => entry.state === 'measured' && entry.by !== undefined,
    );
    let buckets = 0;
    for (const entry of withBreakdown) buckets += expectBucketsSumToReading(entry);

    // NO floor on `buckets` here, deliberately, and the honest reason is worth
    // stating: on a freshly migrated throwaway database every dimension is
    // legitimately empty, so this pass can and does run over zero buckets — the
    // identity is then `0 === 0` and measures nothing. What makes it a real
    // assertion is the Postgres control at the bottom of this file, which
    // INSERTS two markets and re-runs the same helper with a bucket floor. This
    // case covers every OTHER breakdown metric on whatever the shared database
    // happens to hold, which is a superset and not a substitute.
    process.stdout.write(
      `catalog metrics: ${String(withBreakdown.length)} readings carry a breakdown, `
        + `${String(buckets)} buckets in total\n`,
    );
    expect(withBreakdown.length, 'no metric carries a breakdown at all').toBeGreaterThanOrEqual(5);
  });

  it('`awaitingSeams` is exactly the unmeasured definitions, with their seams', () => {
    const declared = CATALOG_METRICS.filter((definition) => definition.unmeasured !== undefined);
    expect(baseline.awaitingSeams).toHaveLength(declared.length);
    expect(baseline.awaitingSeams.map((seam) => seam.key)).toEqual(
      declared.map((definition) => definition.key),
    );
    for (const seam of baseline.awaitingSeams) {
      // The empty-string fallback in the collector is unreachable while the
      // filter above is the narrowing; asserting a real sentence is what would
      // catch it becoming reachable.
      expect(seam.seam.length, `${seam.key} is awaiting an empty seam`).toBeGreaterThan(40);
    }
  });

  it('`mustStayZero` is zero after a clean collection', () => {
    // This domain's `ledgerImbalanceAttempts`. `metricCollectionFailures` counts
    // a domain reader that threw and `undefinedMetricEmissions` counts the
    // registry and the producer table having drifted across the `await` between
    // the census and the loop — neither is a condition anybody expects, so the
    // number is put where somebody sees it.
    expect(baseline.mustStayZero.metricCollectionFailures, 'a domain reader threw').toBe(0);
    expect(baseline.mustStayZero.undefinedMetricEmissions, 'the census drifted').toBe(0);
    expect(baseline.mustStayZero.unobservedRouteReports, 'a key was composed by hand').toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Positive control 1: the in-process source                                   */
/* -------------------------------------------------------------------------- */

describe('the collector really reads the route store', () => {
  it('reports `surface_not_mounted` when the route is behind an off rollout flag', async () => {
    resetCatalogRouteObservations();
    // The DEFAULT for this test deployment, and the point of the case: a route
    // that cannot be served must not report a population of zero, because that
    // asserts something about traffic. Both halves are driven here, so neither
    // branch is the one nobody exercises.
    const off = await collectCatalogMetrics({
      facetSampleSize: NO_FACET_SAMPLE,
      mounted: { catalogAuthoring: false, facets: false },
    });
    for (const key of [
      'authoring_schema_fetch_latency',
      'authoring_schema_error_rate',
      'authoring_schema_client_cache_hit_rate',
      'facet_generation_latency',
      'facet_generation_error_rate',
    ]) {
      const entry = reading(off, key);
      expect(entry?.state, `${key} reported a population instead of an unmounted surface`).toBe(
        'unmeasured',
      );
      if (entry?.state === 'unmeasured') {
        expect(entry.reason).toBe('surface_not_mounted');
        // The seam names the variable, so an operator is told what to set rather
        // than left to wonder why a surface looks idle.
        expect(entry.seam).toMatch(/CATALOG_AUTHORING_ENABLED|FACETS_ENABLED/);
        // And it carries no quantity, so it cannot be rendered as zero.
        expect(Object.keys(entry)).not.toContain('numerator');
      }
    }
  });

  it('the two unconditional routes report 5xx, exclude 4xx, and need no mount flag', async () => {
    // #913: four routes carry a latency budget and are therefore observed, and
    // two of them reached no metric at all — a 5xx on `/categories` or
    // `/search` was recorded by the middleware and read by nothing.
    resetCatalogRouteObservations();
    // BOTH flags OFF, deliberately. These two routes are mounted
    // unconditionally, so unlike the authoring and facet rates they must still
    // be MEASURED here. A producer that copied a `mounted` guard across would
    // answer `surface_not_mounted` and this case is what catches it.
    const collect = () =>
      collectCatalogMetrics({
        facetSampleSize: NO_FACET_SAMPLE,
        mounted: { catalogAuthoring: false, facets: false },
      });

    for (const key of ['taxonomy_read_error_rate', 'search_read_error_rate']) {
      const before = reading(await collect(), key);
      expect(before?.state, `${key} is gated on a flag it has no business reading`).toBe(
        'measured',
      );
      if (before?.state === 'measured') {
        expect(before.denominator).toBe(0);
        expect(Object.keys(before), `${key}: 0 / 0 was rendered as a ratio`).not.toContain('ratio');
      }
    }

    // `/categories`: one 500 and one 404 of four. The 404 is the load-bearing
    // one — a bad handle is a correct answer, and a producer counting every
    // non-2xx would report 2/4.
    observeCatalogRoute({ method: 'GET', route: CATEGORIES_ROUTE, statusCode: 200, durationMs: 5 });
    observeCatalogRoute({ method: 'GET', route: CATEGORIES_ROUTE, statusCode: 200, durationMs: 6 });
    observeCatalogRoute({ method: 'GET', route: CATEGORIES_ROUTE, statusCode: 404, durationMs: 2 });
    observeCatalogRoute({ method: 'GET', route: CATEGORIES_ROUTE, statusCode: 500, durationMs: 9 });
    // `/search`: TWO 404s and no 5xx — the shape a default deployment actually
    // has, because `CANONICAL_SEARCH` is `off` and every request is a 404. It
    // must read `0 / 2` and NOT an empty population: mounted and refusing is a
    // different state from not mounted.
    observeCatalogRoute({ method: 'GET', route: SEARCH_ROUTE, statusCode: 404, durationMs: 3 });
    observeCatalogRoute({ method: 'GET', route: SEARCH_ROUTE, statusCode: 404, durationMs: 4 });

    const after = await collect();

    const taxonomy = reading(after, 'taxonomy_read_error_rate');
    expect(taxonomy?.state).toBe('measured');
    if (taxonomy?.state === 'measured') {
      expect(taxonomy.numerator).toBe(1);
      expect(taxonomy.denominator).toBe(4);
      expect(taxonomy.ratio).toBe(0.25);
    }

    const search = reading(after, 'search_read_error_rate');
    expect(search?.state).toBe('measured');
    if (search?.state === 'measured') {
      expect(search.numerator).toBe(0);
      expect(search.denominator).toBe(2);
      // A ratio of exactly 0 over a REAL population, which is a different
      // reading from the no-ratio `0 / 0` above and is the whole point of
      // counting a refusing surface's requests.
      expect(search.ratio).toBe(0);
    }
  });

  it('counts a facet 5xx and NOT a facet 4xx, and answers `0 / 0` with no ratio', async () => {
    // The live half of W17's "invalid facet generation". The data was always
    // being collected — `POST /facets` is one of the four routes with a latency
    // budget, so `requests`/`serverErrors`/`clientErrors` were recorded for it
    // and only `latency` was ever read.
    resetCatalogRouteObservations();
    const collect = () =>
      collectCatalogMetrics({
        facetSampleSize: NO_FACET_SAMPLE,
        mounted: { catalogAuthoring: true, facets: true },
      });

    const before = reading(await collect(), 'facet_generation_error_rate');
    expect(before?.state).toBe('measured');
    if (before?.state === 'measured') {
      // A task that has served no facet request is MEASURED with an empty
      // population, not a confident zero error rate.
      expect(before.denominator).toBe(0);
      expect(before.numerator).toBe(0);
      expect(Object.keys(before), '0 / 0 was rendered as a ratio').not.toContain('ratio');
    }

    observeCatalogRoute({ method: 'POST', route: FACETS_ROUTE, statusCode: 200, durationMs: 7 });
    observeCatalogRoute({ method: 'POST', route: FACETS_ROUTE, statusCode: 400, durationMs: 3 });
    observeCatalogRoute({ method: 'POST', route: FACETS_ROUTE, statusCode: 500, durationMs: 31 });

    const after = reading(await collect(), 'facet_generation_error_rate');
    expect(after?.state).toBe('measured');
    if (after?.state === 'measured') {
      // 1 of 3, and the 400 is the load-bearing one. A refused sort key and a
      // malformed body are 4xx and are CORRECT answers; a producer counting
      // every non-2xx would report 2/3 here and make a stale client read as a
      // server fault. That is the whole content of this metric's attribution
      // limit, driven rather than described.
      expect(after.numerator).toBe(1);
      expect(after.denominator).toBe(3);
      expect(after.ratio).toBeCloseTo(1 / 3, 10);
    }
  });

  it('publishes the sweep failure count against `drawn`, beside the empty rate on `sampled`', async () => {
    // What this pins and what it does not, stated because the difference is not
    // visible from the assertions.
    //
    // PINS: the metric exists, is wired to the sweep, is MEASURED rather than a
    // seam, and its denominator is the one the empty rate EXCLUDES its failures
    // from — `drawn === sampled + failed`, expressed across the two published
    // numbers rather than re-read from the sweep.
    //
    // DOES NOT PIN: the field choice under a real failure. Mutating the producer's
    // denominator from `drawn` to `sampled` leaves this GREEN — measured, not
    // assumed — because no failing scope is reachable here and the two fields
    // are then equal.
    //
    // Closing it was ATTEMPTED and abandoned for a reason worth recording, since
    // the obvious next attempt runs into the same wall. The failing scope lives
    // in `facet-scope-sweep.realdb.test.ts`, whose fixture raises by pricing an
    // offer above `MAX_MONEY_MINOR_UNITS`; running `collectCatalogMetrics({ db: tx })`
    // inside that fixture's transaction draws the category and reports
    // `failed: 0` anyway, because that fixture's offers carry `stale_at` a day
    // after its frozen `NOW` and **`collectCatalogMetrics` takes no clock** — it
    // uses the real one, so every fixture offer is long stale, no price facet is
    // planned, and nothing raises. The two ways out are a `now` option on the
    // collector (a production seam existing only for a test) or real-future
    // dates in a fixture ten other cases depend on. Neither is worth it for a
    // two-line producer whose identity is already pinned on the sweep RESULT.
    const collected = await collectCatalogMetrics({ facetSampleSize: FACET_SAMPLE_SIZE });
    const failure = reading(collected, 'facet_scope_generation_failure_rate');
    const empty = reading(collected, 'facet_scope_empty_rate');
    expect(failure?.state, 'the sweep failure rate is not published').toBe('measured');
    expect(empty?.state).toBe('measured');
    if (failure?.state === 'measured' && empty?.state === 'measured') {
      expect(failure.denominator).toBe((empty.denominator ?? 0) + failure.numerator);
    }
  });

  it('answers `0 / 0` with no ratio, then moves when two requests are observed', async () => {
    resetCatalogRouteObservations();
    // `mounted` forced ON for this case: with the flag off these metrics answer
    // `surface_not_mounted` (asserted directly above) and there would be no
    // arithmetic to check. This is the deployment where the route IS served.
    const collect = () =>
      collectCatalogMetrics({
        facetSampleSize: NO_FACET_SAMPLE,
        mounted: { catalogAuthoring: true, facets: true },
      });
    const before = await collect();

    // Deterministically empty: this process serves no HTTP, so the two
    // authoring-schema ratios have a population of zero. That is the `0 / 0`
    // case, and it is MEASURED — the read ran, nothing has been served — with no
    // `ratio` property for a dashboard to render as a percentage.
    const emptyRate = reading(before, 'authoring_schema_error_rate');
    expect(emptyRate?.state).toBe('measured');
    if (emptyRate?.state === 'measured') {
      expect(emptyRate.denominator).toBe(0);
      expect(Object.keys(emptyRate), '0 / 0 was rendered as a ratio').not.toContain('ratio');
      expect(emptyRate.numerator).toBe(0);
    }
    // And the latency metric reports an empty population rather than a p95 of
    // 0 ms, which would clear every budget on a cold task.
    const emptyLatency = reading(before, 'authoring_schema_fetch_latency');
    expect(emptyLatency?.state).toBe('measured');
    expect(Object.keys(emptyLatency ?? {}), 'a cold task reported percentiles').not.toContain(
      'latency',
    );

    observeCatalogRoute({ method: 'GET', route: SCHEMA_ROUTE, statusCode: 304, durationMs: 11 });
    observeCatalogRoute({ method: 'GET', route: SCHEMA_ROUTE, statusCode: 500, durationMs: 23 });

    const after = await collect();

    // Three metrics off one source, each with a different arithmetic: a
    // collector returning constants passes every shape assertion above and
    // fails here.
    const errorRate = reading(after, 'authoring_schema_error_rate');
    expect(errorRate?.state).toBe('measured');
    if (errorRate?.state === 'measured') {
      expect(errorRate.numerator).toBe(1);
      expect(errorRate.denominator).toBe(2);
      expect(errorRate.ratio).toBe(0.5);
    }
    const cacheHitRate = reading(after, 'authoring_schema_client_cache_hit_rate');
    expect(cacheHitRate?.state).toBe('measured');
    if (cacheHitRate?.state === 'measured') {
      // The 304 is a cache HIT and not an error, which is the whole reason these
      // two metrics share a denominator and not a numerator.
      expect(cacheHitRate.numerator).toBe(1);
      expect(cacheHitRate.denominator).toBe(2);
    }
    const latency = reading(after, 'authoring_schema_fetch_latency');
    expect(latency?.state).toBe('measured');
    if (latency?.state === 'measured') {
      expect(latency.numerator).toBe(2);
      expect(latency.latency?.observations).toBe(2);
      expect(latency.latency?.maxMs).toBe(23);
    }

    expect(after.mustStayZero.metricCollectionFailures).toBe(0);
    expect(after.mustStayZero.unobservedRouteReports).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Positive control 2: Postgres                                                */
/* -------------------------------------------------------------------------- */

/**
 * The two in-process counters #367 W17 lines 768 and 771 closed.
 *
 * A THIRD positive control with nothing in common with the other two: the route
 * store is HTTP timings, the Postgres one is a row, and these are counters two
 * different services increment. All three would have to be broken at once for
 * the collector to be returning constants.
 *
 * Both are deterministically zero in a process that has published nothing and
 * resolved nothing, which is what makes the `0 / 0` branch assertable here
 * rather than hoped for.
 */
describe('the collector really reads the publication and localization counters', () => {
  beforeAll(() => {
    resetAuthoringPublicationCounters();
    resetLocalizationReadCounters();
  });

  async function collect() {
    return collectCatalogMetrics({ facetSampleSize: NO_FACET_SAMPLE });
  }

  it('reports 0 / 0 before anything happens — no ratio, and NOT a seam', () => {
    // The distinction the registry exists to keep: "nothing has been published
    // in this process" is MEASURED with an empty population, not unmeasured.
    // Reading it as a seam would tell an operator the metric was never built.
    const before = readAuthoringPublicationCounters();
    expect(before.attempts).toBe(0);
    expect(readLocalizationReadCounters().resolutions).toBe(0);
  });

  it('moves both by exactly what was recorded, and the buckets partition', async () => {
    const before = await collect();
    for (const key of [
      'draft_validation_failure_rate',
      'draft_validation_failure_code_share',
      'translation_fallback_use_rate',
    ]) {
      const entry = reading(before, key);
      expect(entry?.state, `${key} is not measured`).toBe('measured');
      // Through the file's own helper, which asserts MEASURED first: reading a
      // denominator off the union directly is a type error, which is the
      // `unmeasured` branch carrying no quantity doing its job.
      expect(
        measuredDenominator(before, key),
        `${key} reported a population before anything ran`,
      ).toBe(0);
      // `0 / 0` keeps `denominator: 0` in the measured branch and omits `ratio`.
      expect(Object.keys(entry ?? {}), `${key} rendered a ratio over nothing`).not.toContain(
        'ratio',
      );
    }

    // THREE publication attempts: one clean, two refused, the refusals carrying
    // FOUR error findings between them across two codes — so attempts, refusals
    // and findings are three different numbers and no assertion below can pass
    // by reading the wrong one.
    recordPublicationAttempt({ publishable: true, findings: [], schemaEtag: 'e' });
    recordPublicationAttempt({
      publishable: false,
      schemaEtag: 'e',
      findings: [
        { code: 'required_field_missing', severity: 'error', path: 'a' },
        { code: 'required_field_missing', severity: 'error', path: 'b' },
        // A WARNING, which refuses nothing and must not be counted — otherwise
        // the code shares describe advice nobody was blocked by.
        { code: 'value_implausible', severity: 'warning', path: 'c' },
      ],
    });
    recordPublicationAttempt({
      publishable: false,
      schemaEtag: 'e',
      findings: [
        { code: 'required_field_missing', severity: 'error', path: 'd' },
        { code: 'value_not_in_controlled_set', severity: 'error', path: 'e' },
      ],
    });

    // Localized reads: two exact, one language fallback, one base, one that
    // could not be answered at all.
    for (const step of ['exact', 'exact', 'language', 'base'] as const) {
      recordLocalizedResolution({
        outcome: 'resolved',
        basis: 'localization_row',
        value: 'x',
        requestedLocale: 'es-mx',
        effectiveLocale: 'es',
        step,
        status: 'approved',
        provenance: 'mercaria',
      } as never);
    }
    recordLocalizedResolution({
      outcome: 'unavailable',
      reason: 'no_text_in_locale',
      requestedLocale: 'es-mx',
    } as never);

    const after = await collect();

    // 768: two refusals out of three attempts.
    const failure = reading(after, 'draft_validation_failure_rate');
    expect(failure?.state).toBe('measured');
    if (failure?.state === 'measured') {
      expect(failure.numerator).toBe(2);
      expect(failure.denominator).toBe(3);
      expect(failure.ratio).toBeCloseTo(2 / 3);
      // NO breakdown, deliberately — a refusal carries several codes, so codes
      // do not partition attempts. Asserted rather than left to the docblock.
      expect(Object.keys(failure), 'the rate grew a breakdown it cannot partition').not.toContain(
        'by',
      );
    }

    // …and the codes, over FOUR error findings: three of one, one of another,
    // and the warning excluded. A producer counting findings-per-attempt or
    // including warnings gets a different number here.
    const shares = reading(after, 'draft_validation_failure_code_share');
    expect(shares?.state).toBe('measured');
    if (shares?.state === 'measured') {
      expect(shares.numerator).toBe(4);
      expect(shares.denominator).toBe(4);
      const by = new Map((shares.by ?? []).map((entry) => [entry.key, entry.numerator]));
      expect(by.get('required_field_missing')).toBe(3);
      expect(by.get('value_not_in_controlled_set')).toBe(1);
      expect(by.has('value_implausible'), 'a warning was counted as a refusal reason').toBe(false);
      // Only codes that OCCURRED get a bucket — thirty zeroes would bury these.
      expect(shares.by).toHaveLength(2);
    }

    // 771: two of five resolutions were fallbacks; `unavailable` is in the
    // denominator and in no fallback bucket.
    const fallback = reading(after, 'translation_fallback_use_rate');
    expect(fallback?.state).toBe('measured');
    if (fallback?.state === 'measured') {
      expect(fallback.numerator).toBe(2);
      expect(fallback.denominator).toBe(5);
      const by = new Map((fallback.by ?? []).map((entry) => [entry.key, entry]));
      expect(by.get('exact')?.numerator, 'an exact read was counted as a fallback').toBe(0);
      expect(by.get('exact')?.denominator).toBe(2);
      expect(by.get('language')?.numerator).toBe(1);
      expect(by.get('base')?.numerator).toBe(1);
      expect(by.get('unavailable')?.numerator, 'an unanswerable field read as a fallback').toBe(0);
      expect(by.get('unavailable')?.denominator).toBe(1);
      // THE IDENTITY: the buckets sum to the reading, both halves.
      expect(expectBucketsSumToReading(fallback), 'the step breakdown is empty').toBeGreaterThanOrEqual(
        4,
      );
    }

    expect(after.mustStayZero.metricCollectionFailures).toBe(
      before.mustStayZero.metricCollectionFailures,
    );
  });
});

describe('the collector really reads Postgres', () => {
  it('moves the proposal metrics by exactly the row this file inserted', async () => {
    await rolledBack(async (tx) => {
      const before = await collectCatalogMetrics({ db: tx, facetSampleSize: NO_FACET_SAMPLE });

      // `origin = 'operator'` so `catalog_proposals_origin_scope_check` permits a
      // NULL `store_id` — a store fixture would need a merchant, an owner and a
      // teardown, none of which this control is about. `type = 'brand'` keeps the
      // three context pins NULL, which
      // `catalog_proposals_controlled_value_subject_check` only demands for a
      // controlled value.
      await tx.execute(sql`
        insert into catalog_proposals
          (id, type, origin, state, submitted_by_oxy_user_id,
           proposed_label, source_locale, normalized_label, search_label)
        values (${`${FIXTURE_PREFIX}-proposal-1`}, 'brand', 'operator', 'submitted',
                ${`${FIXTURE_PREFIX}-operator`},
                ${'Obs Metrics Probe Brand'}, 'en',
                ${`${FIXTURE_PREFIX} probe brand`}, ${`${FIXTURE_PREFIX} probe brand`})
      `);

      // A DECIDED proposal, so `proposal_decision_count` has something to see and
      // the backlog metrics have something they must NOT see. `decided_at` is the
      // service rate against `proposal_creation_count`'s arrival rate, and a
      // decided row is created in the window too — which is why the creation
      // delta below is TWO while the backlog delta is one.
      await tx.execute(sql`
        insert into catalog_proposals
          (id, type, origin, state, submitted_by_oxy_user_id,
           proposed_label, source_locale, normalized_label, search_label,
           resolved_entity_id, decided_by_oxy_user_id, decided_at, decision_reason)
        values (${`${FIXTURE_PREFIX}-proposal-2`}, 'brand', 'operator', 'approved',
                ${`${FIXTURE_PREFIX}-operator`},
                ${'Obs Metrics Probe Brand Two'}, 'en',
                ${`${FIXTURE_PREFIX} probe brand two`}, ${`${FIXTURE_PREFIX} probe brand two`},
                ${`${FIXTURE_PREFIX}-entity`}, ${`${FIXTURE_PREFIX}-decider`},
                now(), ${'Obs metrics probe decision'})
      `);

      // Three searches across TWO markets, so the breakdown this metric carries
      // is genuinely non-empty and the bucket identity below has something to
      // sum. `analytics_search_queries` carries no actor column at all (#77 owns
      // it), so nothing here names anybody; `traffic_class = 'human'` is what the
      // producer narrows to, and a crawler row would be excluded.
      for (const [suffix, market, resultCount] of [
        ['es-zero', 'ES', 0],
        ['es-hit', 'ES', 5],
        ['fr-zero', 'FR', 0],
      ] as const) {
        await tx.execute(sql`
          insert into analytics_search_queries
            (id, query_event_id, result_count, latency_ms, market, traffic_class,
             text_expires_at, expires_at)
          values (${`${FIXTURE_PREFIX}-search-${suffix}`},
                  ${`${FIXTURE_PREFIX}-event-${suffix}`},
                  ${resultCount}, ${7}, ${market}, 'human',
                  now() + interval '30 days', now() + interval '30 days')
        `);
      }

      const after = await collectCatalogMetrics({ db: tx, facetSampleSize: NO_FACET_SAMPLE });

      // A DELTA of exactly one, never an absolute: these aggregates have no
      // tenant predicate and siblings hold proposals of their own.
      expect(
        measuredNumerator(after, 'proposal_creation_count')
          - measuredNumerator(before, 'proposal_creation_count'),
        'proposal_creation_count did not see the inserted rows',
      ).toBe(2);
      expect(
        measuredNumerator(after, 'proposal_backlog_count')
          - measuredNumerator(before, 'proposal_backlog_count'),
        'proposal_backlog_count did not see the inserted row',
      ).toBe(1);
      // The decided row moves the service rate and NOTHING in the backlog: a
      // metric that counted every row with a `decided_at` column rather than one
      // stamped in the window would move by whatever the database already held.
      expect(
        measuredNumerator(after, 'proposal_decision_count')
          - measuredNumerator(before, 'proposal_decision_count'),
        'proposal_decision_count did not see the decided row',
      ).toBe(1);
      // Only the open state the submitted row is in moves. The other two are the
      // control: a producer reading the wrong bucket, or the whole backlog into
      // each of them, fails exactly here.
      expect(
        measuredNumerator(after, 'proposal_backlog_awaiting_operator_count')
          - measuredNumerator(before, 'proposal_backlog_awaiting_operator_count'),
      ).toBe(1);
      expect(
        measuredNumerator(after, 'proposal_backlog_awaiting_submitter_count')
          - measuredNumerator(before, 'proposal_backlog_awaiting_submitter_count'),
        'a submitted proposal moved the needs_information count',
      ).toBe(0);
      expect(
        measuredNumerator(after, 'proposal_backlog_deferred_count')
          - measuredNumerator(before, 'proposal_backlog_deferred_count'),
        'a submitted proposal moved the deferred count',
      ).toBe(0);

      // THE CONSERVED TOTAL, asserted absolutely on both readings rather than as
      // a delta: the three open states partition the backlog, so this holds
      // whatever a parallel file is doing — and a floor ("at least N are
      // submitted") could not notice a fourth open state arriving, which is
      // precisely the change that would break it. All four numbers come out of
      // ONE statement, so it is an identity over one snapshot rather than four
      // reads that agree most of the time.
      //
      // On an EMPTY database the `before` half is `0 === 0 + 0 + 0`, which is
      // true and is a measurement of nothing — so the floor below asserts the
      // `after` half really had something to conserve, and the version over a
      // queue populated in all three open states at once lives in
      // `proposal-queue.realdb.test.ts`, which builds one.
      let conservationChecked = 0;
      for (const [label, report] of [
        ['before', before],
        ['after', after],
      ] as const) {
        expect(
          measuredNumerator(report, 'proposal_backlog_awaiting_operator_count')
            + measuredNumerator(report, 'proposal_backlog_awaiting_submitter_count')
            + measuredNumerator(report, 'proposal_backlog_deferred_count'),
          `${label}: the three open states do not account for the backlog`,
        ).toBe(measuredNumerator(report, 'proposal_backlog_count'));
        conservationChecked += 1;
      }
      expect(conservationChecked).toBe(2);
      expect(
        measuredNumerator(after, 'proposal_backlog_count'),
        'the backlog was empty after the insert, so the identity conserved nothing',
      ).toBeGreaterThan(0);

      // The submitted row is now the only thing this transaction can see in that
      // state, so the age exists and is a real one. `numerator` on an age reading
      // is the population it was taken over.
      const operatorAge = reading(after, 'proposal_awaiting_operator_oldest_age');
      expect(operatorAge?.state).toBe('measured');
      if (operatorAge?.state === 'measured') {
        expect(operatorAge.numerator).toBeGreaterThan(0);
        expect(operatorAge.ageSeconds, 'a non-empty submitted queue reported no age').toBeDefined();
        expect(operatorAge.ageSeconds).toBeGreaterThanOrEqual(0);
      }
      // `numerator` on an age reading is how many rows the age was taken over,
      // and the age itself must now exist: an open backlog with no age would be
      // the "healthy zero" the builder refuses.
      const age = reading(after, 'proposal_backlog_oldest_age');
      expect(age?.state).toBe('measured');
      if (age?.state === 'measured') {
        expect(age.numerator).toBeGreaterThan(0);
        expect(age.ageSeconds, 'an open backlog reported no age').toBeDefined();
        expect(age.ageSeconds).toBeGreaterThanOrEqual(0);
      }

      // The BREAKDOWN half, and this is where the bucket identity stops being
      // vacuous: two markets, three searches, two zero-result rows. The totals
      // move by exactly what was inserted AND the buckets sum to the totals, so a
      // producer building its `by` list from a second statement fails here.
      const zeroResults = reading(after, 'search_zero_result_rate_by_market');
      expect(
        measuredNumerator(after, 'search_zero_result_rate_by_market')
          - measuredNumerator(before, 'search_zero_result_rate_by_market'),
        'the zero-result numerator did not see the inserted searches',
      ).toBe(2);
      expect(
        measuredDenominator(after, 'search_zero_result_rate_by_market')
          - measuredDenominator(before, 'search_zero_result_rate_by_market'),
        'the zero-result denominator did not see the inserted searches',
      ).toBe(3);
      expect(
        expectBucketsSumToReading(zeroResults),
        'the market breakdown is empty, so the sum identity measured nothing',
      ).toBeGreaterThanOrEqual(2);
      if (zeroResults?.state === 'measured') {
        // And the ratio really is computed now that the denominator is non-zero,
        // which is the other side of the `0 / 0` case asserted above.
        expect(zeroResults.ratio).toBeDefined();
        const markets = (zeroResults.by ?? []).map((bucket) => bucket.key);
        expect(markets, 'the inserted markets are not bucketed').toContain('ES');
        expect(markets).toContain('FR');
      }

      // A swallowed read failure inside the transaction would abort it and make
      // every later statement fail, which the deltas above would report as
      // "nothing moved". The counter is what tells the two apart.
      expect(
        after.mustStayZero.metricCollectionFailures,
        'a reader threw inside the fixture transaction',
      ).toBe(before.mustStayZero.metricCollectionFailures);

      process.stdout.write(
        `catalog metrics Postgres control: proposals `
          + `${String(measuredNumerator(before, 'proposal_backlog_count'))} -> `
          + `${String(measuredNumerator(after, 'proposal_backlog_count'))} open\n`,
      );
    });
  });

  it('every fixture row is gone, so nothing this file wrote outlives it', async () => {
    // The other half of the rollback discipline: a transaction that committed
    // would leave a proposal and three searches in a shared database, and the
    // first symptom would be a sibling's backlog or zero-result assertion going
    // red for no reason it could name.
    const proposals = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from catalog_proposals where id like ${`${FIXTURE_PREFIX}-%`}
    `);
    const searches = await db.execute<{ total: number }>(sql`
      select count(*)::int as total
      from analytics_search_queries where id like ${`${FIXTURE_PREFIX}-%`}
    `);
    expect(Number(proposals[0]?.total ?? 0), 'the fixture transaction committed a proposal').toBe(0);
    expect(Number(searches[0]?.total ?? 0), 'the fixture transaction committed a search').toBe(0);
  });
});
