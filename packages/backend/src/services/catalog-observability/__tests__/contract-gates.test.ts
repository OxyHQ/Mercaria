/**
 * The catalog observability contract gates (#367 W16/W17).
 *
 * `services/analytics/__tests__/contract-gates.test.ts` is the precedent and this
 * is the same four-part shape applied to a different registry: the metric
 * definitions, the `unmeasured` biconditional, the producer census, and the
 * closed read surface. One file rather than four, because every one of them is a
 * scan over a closed vocabulary and splitting them would make the shared vacuity
 * discipline four copies of itself.
 *
 * ## What each gate would report if the thing it measures were absent
 *
 * That is the question every assertion here is written against
 * (`~/Oxy/AGENTS.md`), and it is why the file is mostly floors and identities
 * rather than `toBeDefined()`:
 *
 * - A traversal that walked NOTHING satisfies every per-metric assertion, so
 *   every loop is preceded by a floor on the population it is about to walk.
 * - A registry whose unmeasured set is DERIVED from the registry cannot notice a
 *   metric silently shipping unmeasured, so the expected set is written out by
 *   hand — #77's `ISSUED_WORKLOAD_ITEMS` reasoning. Closing a seam and shipping a
 *   new gap both go red here, and both are decisions.
 * - A census asserted only against a consistent pair of tables cannot fail, so
 *   the last describe MUTATES the live registry through the production
 *   comparison and asserts each direction fires — then restores it and
 *   re-asserts the clean answer, because a mutation that never applied and one
 *   that never reverted are the two ways a self-test lies.
 *
 * It reads no database. It does import the router, which loads `config`, and
 * `DATABASE_URL` is set for every file by the global setup — but no query is
 * issued and no connection is opened.
 */

import { describe, expect, it } from 'vitest';
import {
  CATALOG_INTEGRITY_CHECK_KINDS,
  CATALOG_LATENCY_BUDGETS,
  CATALOG_METRICS,
  CATALOG_METRIC_KEYS,
  CATALOG_METRIC_KINDS,
  CATALOG_METRIC_SOURCES,
  CATALOG_METRIC_WINDOWS,
  CATALOG_PROPOSAL_AGE_BANDS,
  CATALOG_PROPOSAL_SLA_STATES,
  CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION,
  CATALOG_PROPOSAL_WAIT_AGE_PERCENTILES,
  CATALOG_UNMEASURED_REASONS,
  type CatalogMetricDefinition,
  type CatalogMetricKind,
  type CatalogProposalAgeBand,
  describeCatalogProposalSla,
} from '@mercaria/shared-types';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import catalogAuthoringRouter from '../../../routes/catalog-authoring.js';
import categoriesRouter from '../../../routes/categories.js';
import facetsRouter from '../../../routes/facets.js';
import catalogMetricsRouter from '../../../routes/internal-catalog-metrics.js';
import searchRouter from '../../../routes/search.js';
import { censusProducers } from '../metrics.service.js';
import { CATALOG_OBSERVED_ROUTES, routeObservationKey } from '../route-observations.js';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The metrics this deployment cannot produce today, WRITTEN OUT.
 *
 * Deriving this list from the registry is the vacuity: `CATALOG_METRICS.filter(
 * (m) => m.unmeasured)` agrees with itself whatever the registry says, so a
 * metric that shipped `unmeasured` because nobody finished its producer would
 * pass, and closing a seam would pass too. Written by hand, both directions are
 * a build failure and a decision — a removal here is somebody stating that the
 * seam named in `docs/catalog-observability.md` is closed.
 *
 * Eight, one per gap, each with its own reason and seam in the registry.
 *
 * `proposal_sla_breach_count` is the one whose gap is NOT code. Its input — the
 * queue's depth, per-state oldest age, five-band waiting-age distribution and
 * nearest-rank percentiles — is measured and served; what is missing is a
 * review-time TARGET, which is a policy decision nobody has taken. It carries
 * `policy_target_undefined` for exactly that reason, and reporting zero instead
 * would say "nothing has breached a target that does not exist".
 */
const EXPECTED_UNMEASURED_METRIC_KEYS: readonly string[] = [
  'authoring_schema_memo_hit_rate',
  'backfill_dead_letter_count',
  'draft_validation_failure_rate',
  'facet_usage_rate',
  'proposal_sla_breach_count',
  'reindex_throughput',
  'search_zero_result_rate_by_locale',
  'translation_fallback_use_rate',
];

/**
 * The five GETs `internal-catalog-metrics.ts` promises in its own docblock.
 *
 * Asserted as an EXACT set, never by containment: the router's header says the
 * set is closed and read-only, and the route that matters is the NEXT one —
 * "recompute this", "clear this counter", "resolve this finding" are each one
 * handler away and each would make this surface a way to make the catalogue
 * agree with a dashboard.
 */
const EXPECTED_ROUTES: readonly string[] = [
  'GET /',
  'GET /integrity',
  'GET /latency',
  'GET /proposal-queue',
  'GET /trace/:handleKind/:handle',
];

/** Every `<METHOD> <path>` the router actually registered, as express holds them. */
function registeredRoutes(router: { stack: unknown[] }): string[] {
  const found: string[] = [];
  for (const layer of router.stack) {
    const entry = layer as { route?: { path?: string; methods?: Record<string, boolean> } };
    const route = entry.route;
    if (!route || typeof route.path !== 'string') continue;
    for (const [method, enabled] of Object.entries(route.methods ?? {})) {
      if (enabled) found.push(`${method.toUpperCase()} ${route.path}`);
    }
  }
  return found.sort();
}

/**
 * The two modules that decide what the proposal queue may say about an SLA.
 *
 * Paths relative to `packages/backend/src`, so the second reaches across into
 * shared-types — which is where the TYPE lives, and a type carrying a threshold
 * field is how one would arrive with no backend change at all.
 *
 * Each entry names an anchor the stripped source must still contain, because a
 * renamed or moved file reads as one with no threshold in it for entirely the
 * wrong reason.
 */
const SLA_SCANNED_MODULES: readonly { readonly path: string; readonly anchor: string }[] = [
  {
    path: 'services/catalog-observability/proposal-queue.ts',
    anchor: 'deriveProposalQueueAging',
  },
  {
    path: join('..', '..', 'shared-types', 'src', 'catalog-proposal-queue.ts'),
    anchor: 'CatalogProposalSlaVisibility',
  },
];

/** Strip comments: both scanned modules document at length what they refuse to do. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Strip string and template literals.
 *
 * The comment strip alone is not enough here, and that is the whole reason this
 * exists: `describeCatalogProposalSla`'s own `statement` and `seam` are STRING
 * LITERALS that name the missing target and the breach metric on purpose. A
 * detector that could not tell a sentence explaining the gap from a field
 * implementing one would fire on the explanation, and would be disabled the first
 * time somebody read it.
 */
function stripStringLiterals(source: string): string {
  return source
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Identifiers that would hold a review-time threshold, or a verdict against one.
 *
 * Takes RAW source and does the whole pipeline itself — comments out, string
 * literals out, then scan — so the mutation self-test drives exactly the
 * pipeline the scan does rather than a shorter one that happens to agree.
 *
 * snake_case tokens are excluded: `undefined_target` and `policy_target_undefined`
 * are members of the two closed vocabularies that STATE the gap, and the union
 * having exactly one member is separately gated above. Only a camelCase or bare
 * identifier could be a field carrying a number.
 */
function thresholdIdentifiers(source: string): string[] {
  const code = stripStringLiterals(stripComments(source));
  const found = new Set<string>();
  for (const match of code.matchAll(/\b[A-Za-z_$][\w$]*\b/gu)) {
    const token = match[0];
    if (token.includes('_')) continue;
    if (!/target|deadline|threshold|breach|within/iu.test(token)) continue;
    found.add(token);
  }
  return [...found].sort();
}

/**
 * Every way an age-band tuple can stop being a contiguous partition from zero,
 * as a list of sentences.
 *
 * Returned rather than asserted so the detector itself can be driven against a
 * broken tuple — `toEqual([])` is what a detector that always answers `[]`
 * reports.
 */
function bandContiguityFaults(bands: readonly CatalogProposalAgeBand[]): string[] {
  const faults: string[] = [];
  bands.forEach((band, index) => {
    const previous = bands[index - 1];
    if (index === 0) {
      if (band.fromSeconds !== 0) faults.push(`${band.key} does not start at zero`);
    } else if (previous && band.fromSeconds !== previous.toSeconds) {
      faults.push(`${band.key} does not begin where ${previous.key} ends`);
    }
    const isLast = index === bands.length - 1;
    if (isLast && band.toSeconds !== null) {
      faults.push(`${band.key} is the last band and is not open-ended`);
    }
    if (!isLast && band.toSeconds === null) {
      faults.push(`${band.key} is not the last band and is open-ended`);
    }
    if (band.toSeconds !== null && band.toSeconds <= band.fromSeconds) {
      faults.push(`${band.key} ends before it begins`);
    }
  });
  return faults;
}

/** The keys of every metric carrying a seam, sorted. */
function unmeasuredKeys(): string[] {
  return CATALOG_METRICS.filter((metric) => metric.unmeasured !== undefined)
    .map((metric) => metric.key)
    .sort();
}

/* -------------------------------------------------------------------------- */

describe('#367 W17 — every metric states its numerator, denominator, window and limit', () => {
  it('no definition has a blank field', () => {
    // The vacuity floor. `tsc` refuses a MISSING field — `unmeasured` is the one
    // optional member — so only a blank one can slip past, and a blank
    // `attributionLimit` is exactly what a hurried addition produces. A
    // traversal over an empty registry would satisfy every assertion below.
    expect(CATALOG_METRICS.length).toBeGreaterThanOrEqual(30);

    for (const metric of CATALOG_METRICS) {
      expect(metric.key, 'a metric has no key').not.toBe('');
      expect(metric.title.length, `${metric.key} has no title`).toBeGreaterThan(3);
      expect(metric.numerator.length, `${metric.key} has no numerator`).toBeGreaterThan(10);
      expect(metric.denominator.length, `${metric.key} has no denominator`).toBeGreaterThan(10);
      expect(metric.attributionLimit.length, `${metric.key} states no limit`).toBeGreaterThan(20);
      expect(CATALOG_METRIC_WINDOWS, `${metric.key} has an unknown window`).toContain(metric.window);
      expect(CATALOG_METRIC_SOURCES, `${metric.key} names an unknown source`).toContain(
        metric.source,
      );
      expect(CATALOG_METRIC_KINDS, `${metric.key} has an unknown kind`).toContain(metric.kind);
      // `>= 0` rather than `> 0`, because the in-process counters legitimately
      // declare zero staleness. The biconditional below is what stops that
      // relaxation admitting a database-sourced metric claiming the same.
      expect(
        metric.freshnessSeconds,
        `${metric.key} has no freshness`,
      ).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(metric.freshnessSeconds), `${metric.key} freshness is not a number`)
        .toBe(true);
    }
  });

  it('only an in-process counter may claim zero staleness', () => {
    // `freshnessSeconds === 0` ⟺ `source === 'route_observations'`. Both
    // directions: a Postgres aggregate declaring 0 would tell a dashboard its
    // number is never stale, and a route observation declaring 300 would suggest
    // there is a cache in front of a module-scope integer.
    const zeroFreshness = CATALOG_METRICS.filter((metric) => metric.freshnessSeconds === 0)
      .map((metric) => metric.key)
      .sort();
    const inProcess = CATALOG_METRICS.filter((metric) => metric.source === 'route_observations')
      .map((metric) => metric.key)
      .sort();
    // The floor: with neither set populated this would be `[] === []`.
    expect(inProcess.length).toBeGreaterThanOrEqual(3);
    expect(zeroFreshness).toEqual(inProcess);
  });

  it('every key is unique, and CATALOG_METRIC_KEYS is DERIVED rather than restated', () => {
    expect(new Set(CATALOG_METRIC_KEYS).size).toBe(CATALOG_METRIC_KEYS.length);
    // Same length AND same ORDER. Set equality would pass against a
    // hand-maintained second list that happened to agree today; element-wise
    // equality against the registry's own projection is what makes the
    // derivation the assertion, and the read surface resolves against these
    // keys.
    expect([...CATALOG_METRIC_KEYS]).toEqual(CATALOG_METRICS.map((metric) => metric.key));

    const byKey = new Map(CATALOG_METRICS.map((metric) => [metric.key, metric]));
    for (const key of CATALOG_METRIC_KEYS) {
      expect(byKey.get(key)?.key, `${key} resolves to no definition`).toBe(key);
    }
    expect(byKey.get('not_a_catalog_metric')).toBeUndefined();
  });

  it('every kind in the tuple has at least one metric, and the shapes are populated', () => {
    // A `Record` over the union, so adding a kind to `CATALOG_METRIC_KINDS`
    // fails `tsc` here until somebody states how many carry it. An array of
    // pairs would silently omit the new member and keep passing.
    const tally: Record<CatalogMetricKind, number> = {
      ratio: 0,
      count: 0,
      latency: 0,
      age_seconds: 0,
    };
    for (const metric of CATALOG_METRICS) tally[metric.kind] += 1;

    // Floors on the two shapes the read surface renders differently. Without
    // them a registry of thirty-eight counts would satisfy "every metric has a
    // kind" and there would be no percentage and no percentile anywhere.
    expect(tally.ratio, 'no ratio metrics — a percentage cannot be rendered').toBeGreaterThanOrEqual(
      5,
    );
    expect(tally.latency, 'no latency metrics — no budget has a numerator').toBeGreaterThanOrEqual(
      2,
    );
    for (const kind of CATALOG_METRIC_KINDS) {
      expect(tally[kind], `${kind} is in the tuple and no metric carries it`).toBeGreaterThan(0);
    }

    process.stdout.write(
      `\ncatalog metric registry: ${String(CATALOG_METRICS.length)} definitions `
        + `(${Object.entries(tally)
          .map(([kind, total]) => `${kind} ${String(total)}`)
          .join(', ')}), `
        + `${String(EXPECTED_UNMEASURED_METRIC_KEYS.length)} unmeasured, `
        + `${String(CATALOG_METRIC_SOURCES.length)} sources declared\n`,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('#367 W17 — `unmeasured` carries BOTH halves, and the set is a decision', () => {
  it('every unmeasured metric names a closed reason and an owning seam', () => {
    const unmeasured = CATALOG_METRICS.filter((metric) => metric.unmeasured !== undefined);
    // The floor. An empty set passes the loop for the best possible reason and
    // the worst possible cause — #367 names gaps that exist, so zero of them
    // would mean the registry had lost its own seams.
    expect(unmeasured.length).toBeGreaterThanOrEqual(5);
    // And every REASON in the closed tuple that a definition claims is really in
    // the tuple, checked from the definition side as well as the vocabulary
    // side — a reason added to the tuple and used by nothing is a member the
    // gate below would still count.
    expect(new Set(unmeasured.map((metric) => metric.unmeasured?.reason)).size).toBeGreaterThan(1);

    for (const metric of unmeasured) {
      const gap = metric.unmeasured;
      // Written out rather than asserted away: the backend compiles with
      // `strict: false`, so the filter above is the only narrowing available.
      expect(gap, `${metric.key} lost its unmeasured field`).toBeDefined();
      if (!gap) continue;
      expect(CATALOG_UNMEASURED_REASONS, `${metric.key} has an unknown reason`).toContain(
        gap.reason,
      );
      // A seam long enough to name a module or an issue. "Not built" is not a
      // seam, and the difference between a gap and an apology is whether
      // somebody can act on the sentence.
      expect(gap.seam.length, `${metric.key}'s seam names no owner`).toBeGreaterThan(40);
    }
  });

  it('the unmeasured set is EXACTLY the eight this deployment has', () => {
    // Both directions, against a hand-written list. Closing a seam is a
    // deliberate edit here; a new metric shipping `unmeasured` because nobody
    // finished its producer is a build failure rather than a permanently grey
    // tile.
    expect(unmeasuredKeys()).toEqual([...EXPECTED_UNMEASURED_METRIC_KEYS].sort());
    // And the expected keys name metrics that EXIST, so a rename reads as a
    // rename rather than only as a set mismatch.
    for (const key of EXPECTED_UNMEASURED_METRIC_KEYS) {
      expect(CATALOG_METRIC_KEYS, `${key} is expected unmeasured and is not defined`).toContain(key);
    }
  });

  it('a measured metric carries no seam — the other half of the biconditional', () => {
    const measured = CATALOG_METRICS.filter((metric) => metric.unmeasured === undefined);
    expect(measured.length).toBeGreaterThanOrEqual(20);
    expect(measured.length + EXPECTED_UNMEASURED_METRIC_KEYS.length).toBe(CATALOG_METRICS.length);
    for (const metric of measured) {
      expect(
        EXPECTED_UNMEASURED_METRIC_KEYS,
        `${metric.key} is produced and is on the unmeasured list`,
      ).not.toContain(metric.key);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('#367 W17 — the producer census, both directions', () => {
  it('the registry and the producer table agree, and the census walked everything', () => {
    const census = censusProducers();

    // Asserted BEFORE the counts, because these are the messages worth reading:
    // each names the exact keys that drifted.
    expect(census.missingProducers, 'defined, expected to be produced, and unproduced').toEqual([]);
    expect(census.unexpectedProducers, 'declared unmeasured and produced anyway').toEqual([]);
    expect(census.orphanedProducers, 'a producer for a key no definition declares').toEqual([]);

    // The vacuity floors. Three empty lists are also what a census over an
    // empty registry and an empty producer table returns, so the counts are the
    // only thing that says this one walked anything.
    expect(census.definitions).toBe(CATALOG_METRICS.length);
    expect(census.definitions).toBeGreaterThanOrEqual(30);
    expect(census.producers).toBeGreaterThanOrEqual(20);

    // THE ARITHMETIC IDENTITY, and the reason it is here rather than a second
    // pass over the same two tables: `definitions` is counted from
    // `CATALOG_METRICS` and `producers` from `Object.keys(PRODUCERS)` — two
    // sources this file cannot see the inside of — while the seven is written
    // out by hand above. So it fails on a producer added without a definition,
    // a definition added without a producer, a seam closed in the registry with
    // no producer behind it, and a producer deleted while its definition stays
    // measured. The three empty lists cannot express the last of those without
    // it.
    expect(census.definitions - census.producers).toBe(EXPECTED_UNMEASURED_METRIC_KEYS.length);

    process.stdout.write(
      `catalog producer census: ${String(census.definitions)} definitions / `
        + `${String(census.producers)} producers / `
        + `${String(EXPECTED_UNMEASURED_METRIC_KEYS.length)} seams\n`,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('#367 W16 — the latency budgets and the observed routes are ONE list', () => {
  it('every budget is complete and reasoned', () => {
    // FOUR, not five. The floor came DOWN deliberately when the phantom
    // `/categories/autocomplete` budget was removed — there is no such route, and
    // W1's own checkbox for it is open. A floor that could never drop would
    // forbid exactly that correction and would be satisfied by padding the list
    // with a budget nobody can observe, which is the state this gate found.
    expect(CATALOG_LATENCY_BUDGETS.length).toBeGreaterThanOrEqual(4);
    const seen = new Set<string>();
    for (const budget of CATALOG_LATENCY_BUDGETS) {
      expect(budget.route.startsWith('/'), `${budget.route} is not a path`).toBe(true);
      // A TEMPLATE, never a concrete path: `/categories/electronics` would be
      // one budget per category and would additionally put shopper-visible slugs
      // into a metrics surface.
      expect(budget.route, `${budget.route} looks like a concrete path`).not.toMatch(/\s/);
      expect(['GET', 'POST'], `${budget.route} uses an unexpected method`).toContain(budget.method);
      expect(budget.title.length, `${budget.route} has no title`).toBeGreaterThan(3);
      expect(budget.p95BudgetMs, `${budget.route} has no budget`).toBeGreaterThan(0);
      expect(Number.isInteger(budget.p95BudgetMs), `${budget.route}'s budget is not whole`).toBe(
        true,
      );
      // A budget with no reasoning is a number the next person on call raises
      // until it stops firing.
      expect(budget.rationale.length, `${budget.route} has no rationale`).toBeGreaterThan(40);
      const key = `${budget.method} ${budget.route}`;
      expect(seen.has(key), `${key} has two budgets`).toBe(false);
      seen.add(key);
    }
  });

  it('CATALOG_OBSERVED_ROUTES is derived from the budgets, element for element', () => {
    // Element-wise and in order, not set equality: a budget for a route nobody
    // observes is a threshold that can never fire, an observed route with no
    // budget is a number with no threshold, and a hand-written second list that
    // happens to agree today is exactly what the derivation exists to prevent.
    expect([...CATALOG_OBSERVED_ROUTES]).toEqual(
      CATALOG_LATENCY_BUDGETS.map((budget) => `${budget.method} ${budget.route}`),
    );
    // And the store's own key function agrees with the list it gates on. Two
    // spellings of one key would drop every observation on the floor while
    // `unobservedRouteReports` climbed.
    for (const budget of CATALOG_LATENCY_BUDGETS) {
      expect(
        CATALOG_OBSERVED_ROUTES,
        `${budget.method} ${budget.route} has a budget and is not observable`,
      ).toContain(routeObservationKey(budget.method, budget.route));
    }
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Every observed template resolved against the routers that would serve it.
 *
 * THIS IS THE ONE GATE THAT FOUND SOMETHING. A budget naming a path or a method
 * the API does not serve is not merely inert — it is invisible, and it is
 * invisible through exactly the machinery this domain built to prevent invisible
 * gaps:
 *
 * - `readCatalogLatencyReport` omits `observed` and `withinBudget` when there is
 *   no sample, which is correct and makes an unservable budget look like a cold
 *   task;
 * - the latency metric reports `measured, numerator 0`, which is correct and
 *   makes it look like a task that has served none of those requests;
 * - `unobservedRouteReports` cannot see it either, because
 *   `middleware/catalog-observability.ts` resolves the template FIRST and drops
 *   an unresolvable path before calling the store — deliberately, so that
 *   counter is not a traffic meter for the whole API. So the one counter that
 *   could have caught a bad template is bypassed precisely for bad templates.
 *
 * The set below is asserted EXACTLY, never as a ceiling: the
 * `WOOCOMMERCE_OPEN_DEFECTS` rule, because a list of known-broken things that
 * only grows is a warning about problems somebody has already solved. Fixing one
 * is an edit here, and a FOURTH one is a build failure.
 *
 * The mount prefixes are not a hand-written map that could silently omit a
 * template: a template whose prefix matches no mount FAILS rather than being
 * skipped, which is the difference between a gate and a to-do list.
 */
describe('#367 W16 — a budget names a route the API actually serves', () => {
  /** Where each observed prefix is mounted. The claim is checked against `app.ts`. */
  const MOUNTS: readonly {
    readonly prefix: string;
    readonly identifier: string;
    readonly router: { stack: unknown[] };
  }[] = [
    {
      prefix: '/categories',
      identifier: 'categoriesRouter',
      router: categoriesRouter as unknown as { stack: unknown[] },
    },
    {
      prefix: '/catalog-authoring',
      identifier: 'catalogAuthoringRouter',
      router: catalogAuthoringRouter as unknown as { stack: unknown[] },
    },
    {
      prefix: '/search',
      identifier: 'searchRouter',
      router: searchRouter as unknown as { stack: unknown[] },
    },
    {
      prefix: '/facets',
      identifier: 'facetsRouter',
      router: facetsRouter as unknown as { stack: unknown[] },
    },
  ];

  /**
   * The templates no route answers. **EMPTY, and it must stay empty.**
   *
   * This gate was written while three of the five budgets named nothing, and it
   * is the reason they were found — no other mechanism could have. The
   * consequence of a wrong template is invisible everywhere else:
   * `readCatalogLatencyReport` omits its verdict (which looks exactly like a cold
   * task), the metric reads `measured, numerator: 0` (which looks exactly like a
   * task that served none of those requests), and `unobservedRouteReports` cannot
   * see it because the middleware resolves the template FIRST and drops an
   * unresolvable path before the store is called.
   *
   * What was wrong, kept as the record of why this list exists:
   *
   * 1. `GET /catalog-authoring/schema` — the router serves
   *    `GET /catalog-authoring/schemas/:productTypeKey` (plural, parameterised).
   *    Three of W17 item 1's four metrics hang off it, and the fourth
   *    (`authoring_schema_memo_hit_rate`) is a declared seam, so the whole of
   *    item 1 measured nothing. Fixed on the budget side; the middleware's
   *    `:param` matching already handles the parameterised form.
   * 2. `GET /categories/autocomplete` — no such route exists anywhere. Removed
   *    rather than repointed: `GET /catalog-authoring/categories` is a localized
   *    BROWSE (`parentId`, `roots`, `locale`, `limit`) with no text parameter, so
   *    budgeting it as autocomplete would put a UX floor on a different
   *    operation. W1's "APIs for localized category search/autocomplete" is an
   *    open checkbox and the budget is owed by whoever ships the route.
   * 3. `GET /facets` — `routes/facets.ts` registers `POST /` only, so the METHOD
   *    was what did not match. Fixed on the budget side.
   *
   * A future breakage does NOT get added here. This list is empty because every
   * budget names a real route, and the honest fix for a red is the template or
   * the route — never an exemption, which is how a gate ends up excusing the
   * thing it exists to catch.
   */
  const UNSERVED_TEMPLATES: readonly string[] = [];

  /** `METHOD path` for every route these routers register, prefixed as mounted. */
  function servedRoutes(): string[] {
    const served: string[] = [];
    for (const mount of MOUNTS) {
      for (const entry of registeredRoutes(mount.router)) {
        const separator = entry.indexOf(' ');
        const method = entry.slice(0, separator);
        const path = entry.slice(separator + 1);
        served.push(`${method} ${mount.prefix}${path === '/' ? '' : path}`);
      }
    }
    return served;
  }

  /** Two route templates describing the same shape, `:param` matching `:param`. */
  function sameShape(left: string, right: string): boolean {
    const leftSegments = left.split('/').filter((segment) => segment.length > 0);
    const rightSegments = right.split('/').filter((segment) => segment.length > 0);
    if (leftSegments.length !== rightSegments.length) return false;
    return leftSegments.every(
      (segment, index) =>
        segment === rightSegments[index]
        || (segment.startsWith(':') && rightSegments[index].startsWith(':')),
    );
  }

  it('every mount prefix this gate assumes is the prefix `app.ts` actually uses', () => {
    // The map above is only trustworthy because this reads it back off `app.ts`.
    // A router remounted somewhere else would otherwise make every assertion
    // below a statement about a prefix nobody serves.
    const app = readFileSync(join(SRC_ROOT, 'app.ts'), 'utf8');
    expect(app.length).toBeGreaterThan(10_000);
    for (const mount of MOUNTS) {
      expect(app, `${mount.identifier} is not mounted at ${mount.prefix}`).toContain(
        `app.use('${mount.prefix}', ${mount.identifier})`,
      );
      expect(
        registeredRoutes(mount.router).length,
        `${mount.identifier} registers no routes — did the import break?`,
      ).toBeGreaterThan(0);
    }
  });

  it('the templates that NO route answers are exactly the three known ones', () => {
    const served = servedRoutes();
    // The vacuity floor: an empty served list would report every template as
    // unserved, and a served list built from nothing would report none.
    expect(served.length).toBeGreaterThanOrEqual(5);

    const unserved: string[] = [];
    for (const key of CATALOG_OBSERVED_ROUTES) {
      const separator = key.indexOf(' ');
      const method = key.slice(0, separator);
      const template = key.slice(separator + 1);
      const mount = MOUNTS.find(
        (candidate) =>
          template === candidate.prefix || template.startsWith(`${candidate.prefix}/`),
      );
      // A template whose prefix nothing in this map covers FAILS here rather
      // than being skipped — a gate that silently ignores what its map omits is
      // not a gate.
      expect(mount, `${key} is observed and this gate knows no mount for it`).toBeDefined();
      if (
        !served.some(
          (candidate) =>
            candidate.startsWith(`${method} `)
            && sameShape(candidate.slice(candidate.indexOf(' ') + 1), template),
        )
      ) {
        unserved.push(key);
      }
    }

    // EXACT, both directions, against an EMPTY list: every budget must name a
    // route the API serves. A new broken template is a build failure, and the fix
    // is the template or the route — never an entry here.
    expect(
      [...unserved].sort(),
      'a latency budget names a route no router serves, so its metric is permanently blind '
        + '— see UNSERVED_TEMPLATES for the three that did this and how each was fixed',
    ).toEqual([...UNSERVED_TEMPLATES].sort());

    process.stdout.write(
      `catalog latency budgets: ${String(CATALOG_OBSERVED_ROUTES.length)} observed templates, `
        + `${String(CATALOG_OBSERVED_ROUTES.length - unserved.length)} served, `
        + `${String(unserved.length)} naming no route (${unserved.join('; ')})\n`,
    );
  });

  it('the shape matcher really distinguishes a template from a near miss', () => {
    // The mutation self-test. A `sameShape` that answered `true` for everything
    // would report zero unserved templates above and the whole gate would read
    // green forever.
    expect(sameShape('/categories', '/categories')).toBe(true);
    expect(sameShape('/catalog-authoring/schemas/:key', '/catalog-authoring/schemas/:other')).toBe(
      true,
    );
    expect(sameShape('/catalog-authoring/schema', '/catalog-authoring/schemas/:key')).toBe(false);
    expect(sameShape('/categories/autocomplete', '/categories/:slug/listings')).toBe(false);
    // A literal segment must not be absorbed by a parameter in the other
    // direction either: `/categories/autocomplete` and `/categories/:slug` are
    // the same LENGTH, and treating them as one shape is how a budget for a
    // route nobody serves reads as served.
    expect(sameShape('/categories/autocomplete', '/categories/:slug')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('#367 W17 — the integrity vocabulary', () => {
  it('the closed check set is populated and every kind is distinct', () => {
    expect(CATALOG_INTEGRITY_CHECK_KINDS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(CATALOG_INTEGRITY_CHECK_KINDS).size).toBe(CATALOG_INTEGRITY_CHECK_KINDS.length);
    for (const kind of CATALOG_INTEGRITY_CHECK_KINDS) {
      expect(kind, 'a check kind is blank').not.toBe('');
    }
  });

  it('the unmeasured reason vocabulary is closed and distinct', () => {
    expect(CATALOG_UNMEASURED_REASONS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(CATALOG_UNMEASURED_REASONS).size).toBe(CATALOG_UNMEASURED_REASONS.length);
    // `source_unavailable` is deliberately NOT used by any definition — it is
    // the reason the COLLECTOR substitutes when a reader throws, and a registry
    // entry claiming it would make an incident indistinguishable from a designed
    // gap.
    expect(unmeasuredKeys().length).toBeGreaterThan(0);
    for (const metric of CATALOG_METRICS) {
      expect(
        metric.unmeasured?.reason,
        `${metric.key} declares source_unavailable, which belongs to the collector`,
      ).not.toBe('source_unavailable');
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('#367 W6 — the proposal age bands are a PARTITION from zero', () => {
  it('the bands are contiguous, ordered, start at zero and end open', () => {
    // The floor. An empty tuple satisfies every pairwise assertion below for the
    // best possible reason and the worst possible cause.
    expect(CATALOG_PROPOSAL_AGE_BANDS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(CATALOG_PROPOSAL_AGE_BANDS.map((band) => band.key)).size).toBe(
      CATALOG_PROPOSAL_AGE_BANDS.length,
    );

    // Contiguity is what makes `unbandedOpenCount` mean "an age below zero" and
    // nothing else. A GAP between two bands would silently drop every open
    // proposal whose age fell in it, and the distribution would still look like
    // a distribution — the counts would simply be short, with the shortfall
    // landing in `unbandedOpenCount` only because it is derived by subtraction.
    expect(bandContiguityFaults(CATALOG_PROPOSAL_AGE_BANDS)).toEqual([]);
  });

  it('the contiguity detector really fires — the mutation self-test', () => {
    // `toEqual([])` above is what a detector that always returns `[]` reports,
    // so the detector is driven against each of the four ways a band tuple can
    // be wrong. Synthetic input, because the real tuple is correct and must
    // stay so.
    expect(bandContiguityFaults([{ key: 'a', fromSeconds: 60, toSeconds: null }])).toContain(
      'a does not start at zero',
    );
    expect(
      bandContiguityFaults([
        { key: 'a', fromSeconds: 0, toSeconds: 60 },
        { key: 'b', fromSeconds: 120, toSeconds: null },
      ]),
      'a gap between two bands went unreported',
    ).toContain('b does not begin where a ends');
    expect(
      bandContiguityFaults([
        { key: 'a', fromSeconds: 0, toSeconds: 60 },
        { key: 'b', fromSeconds: 60, toSeconds: 120 },
      ]),
      'a closed last band went unreported',
    ).toContain('b is the last band and is not open-ended');
    expect(
      bandContiguityFaults([
        { key: 'a', fromSeconds: 0, toSeconds: null },
        { key: 'b', fromSeconds: 0, toSeconds: null },
      ]),
      'an open-ended band in the middle went unreported',
    ).toContain('a is not the last band and is open-ended');
    // And the clean case, so the detector is not simply reporting everything.
    expect(
      bandContiguityFaults([
        { key: 'a', fromSeconds: 0, toSeconds: 60 },
        { key: 'b', fromSeconds: 60, toSeconds: null },
      ]),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('#367 W6 — the percentile floor is DERIVED, not chosen', () => {
  it('is exactly the population at which a nearest-rank p95 stops being the maximum', () => {
    // The whole claim in the constant's docblock, re-derived from the rank
    // formula rather than trusted. `percentile_disc(p)` over n samples returns
    // the element at rank ceil(p * n); when that equals n it IS the maximum, so
    // publishing it as a p95 restates the largest observed age under a name that
    // implies a distribution behind it.
    const highest = Math.max(...CATALOG_PROPOSAL_WAIT_AGE_PERCENTILES);
    const rankIsMax = (n: number): boolean => Math.ceil(highest * n) === n;

    // Below the floor, always the maximum. `assertEachOf` rather than a bare
    // loop: the population list is the thing under test and an empty one would
    // make this assert nothing.
    const below = Array.from({ length: CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION - 1 }, (_, i) => i + 1);
    assertEachOf(below, CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION - 1, (n) => {
      expect(rankIsMax(n), `p${String(highest)} over ${String(n)} samples is not the maximum`).toBe(
        true,
      );
    });
    // And AT the floor it stops. Both directions, or a floor of 1000 would pass
    // the half above.
    expect(
      rankIsMax(CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION),
      'the floor is higher than the crossover, so figures that would mean something are withheld',
    ).toBe(false);

    expect(CATALOG_PROPOSAL_WAIT_AGE_PERCENTILES.length).toBeGreaterThanOrEqual(3);
    for (const percentile of CATALOG_PROPOSAL_WAIT_AGE_PERCENTILES) {
      expect(percentile, 'a percentile is outside (0, 1)').toBeGreaterThan(0);
      expect(percentile).toBeLessThan(1);
    }
  });

  it('the tuple and the published field NAMES are the same three values', () => {
    // `tallyProposals` renders its three `percentile_disc` arguments from this
    // tuple BY POSITION, and `CatalogProposalWaitAge` names its fields
    // `p50Seconds`, `p90Seconds` and `p95Seconds`. So the tuple is the only
    // spelling of the numbers, and this is what stops it drifting away from the
    // names that publish them: changing a member without renaming its field
    // would serve a p99 under the name `p95Seconds`, and every gate above would
    // still pass because the arithmetic would still be correct.
    expect(
      [...CATALOG_PROPOSAL_WAIT_AGE_PERCENTILES],
      'the percentile tuple no longer matches the p50/p90/p95 field names it is published under',
    ).toEqual([0.5, 0.9, 0.95]);
  });
});

/* -------------------------------------------------------------------------- */

describe('#367 W6 — there is no SLA target, and none is representable', () => {
  it('the SLA union has ONE member and the published answer is it', () => {
    expect(CATALOG_PROPOSAL_SLA_STATES).toEqual(['undefined_target']);
    const answer = describeCatalogProposalSla();
    expect(answer.state).toBe('undefined_target');
    // Both halves, and both long enough to be read by a person rather than
    // rendered as a label. The seam floor matches the registry's own.
    expect(answer.statement.length, 'the SLA statement says nothing').toBeGreaterThan(40);
    expect(answer.seam.length, 'the SLA gap names no owner').toBeGreaterThan(40);
    // The shape is exactly these three keys. A fourth would be where a target
    // arrives without the second union member that is supposed to carry it.
    expect(Object.keys(answer).sort()).toEqual(['seam', 'state', 'statement']);
  });

  it('no module in the queue domain declares a threshold field', () => {
    // A scanned wall, over COMMENT-STRIPPED source, because both modules
    // document at length what they refuse to do and in the same vocabulary.
    // Keyed on camelCase IDENTIFIERS rather than on the word "sla": the metric
    // key `proposal_sla_breach_count` is a legitimate snake_case token that the
    // seam text names on purpose, and a detector that could not tell those apart
    // would fire on the very sentence explaining the gap.
    const sources = SLA_SCANNED_MODULES.map((module) => ({
      ...module,
      source: readFileSync(join(SRC_ROOT, module.path), 'utf8'),
    }));
    assertEachOf(sources, 2, ({ path, anchor, source }) => {
      // The vacuity floor for the SCAN rather than for the list: a moved,
      // renamed or comment-only file scans clean for entirely the wrong reason,
      // and the anchor is what tells that apart from a file that really carries
      // no threshold.
      expect(source, `${path} scanned without its anchor — is it still the right file?`).toContain(
        anchor,
      );
      expect(
        thresholdIdentifiers(source),
        `${path} declares a review-time threshold — that belongs in the same change as the `
          + 'policy decision and the second CatalogProposalSlaVisibility member',
      ).toEqual([]);
    });
  });

  it('the threshold detector really fires — the mutation self-test', () => {
    expect(thresholdIdentifiers('readonly targetSeconds: number;')).toContain('targetSeconds');
    expect(thresholdIdentifiers('const slaDeadlineSeconds = 3600;')).toContain(
      'slaDeadlineSeconds',
    );
    expect(thresholdIdentifiers('if (withinSla) return;')).toContain('withinSla');
    expect(thresholdIdentifiers('breachCount += 1;')).toContain('breachCount');
    // And the three things it must NOT fire on: the metric key, the word inside
    // a string literal, and the word inside a comment. Every one of them appears
    // in the two scanned files on purpose, and a detector that flagged any of
    // them would be one somebody disables.
    expect(thresholdIdentifiers("key: 'proposal_sla_breach_count',")).toEqual([]);
    expect(
      thresholdIdentifiers("statement: 'nothing has breached a target that does not exist',"),
    ).toEqual([]);
    expect(thresholdIdentifiers('/** The breach metric and its target. */')).toEqual([]);
    // The type and factory names really do contain "Sla", and must survive:
    // this gate is about a NUMBER, and refusing the vocabulary that states the
    // gap would make the gap unstateable.
    expect(
      thresholdIdentifiers('export function describeCatalogProposalSla(): CatalogProposalSlaVisibility {'),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('#367 — the operator surface is a CLOSED set of reads', () => {
  it('registers EXACTLY the five documented GETs', () => {
    expect(registeredRoutes(catalogMetricsRouter as unknown as { stack: unknown[] })).toEqual(
      [...EXPECTED_ROUTES].sort(),
    );
  });

  it('registers no route that could change anything', () => {
    // Named individually as well as covered by the exact set above, because
    // these are the four somebody will actually reach for, and each would be a
    // repair on a surface whose whole posture is detection.
    const routes = registeredRoutes(catalogMetricsRouter as unknown as { stack: unknown[] });
    expect(routes.length).toBe(EXPECTED_ROUTES.length);
    assertEachOf(['POST', 'PATCH', 'PUT', 'DELETE'], 4, (forbidden) => {
      expect(
        routes.some((route) => route.startsWith(`${forbidden} `)),
        `${forbidden} is registered on a read-only surface`,
      ).toBe(false);
    });
  });

  it('the route enumerator can actually see a route — the mutation self-test', () => {
    // The floor for the enumerator itself. A `registeredRoutes` that returned
    // `[]` for every router would make the exact-set assertion above fail
    // loudly today — but a `toEqual([])` written against a surface that has not
    // been built yet would pass, so the reader is proven against a synthetic
    // stack shaped exactly as express holds one.
    expect(
      registeredRoutes({
        stack: [
          { route: { path: '/invented', methods: { post: true } } },
          { name: 'middleware-with-no-route' },
        ],
      }),
    ).toEqual(['POST /invented']);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The census detector, driven against a registry this file breaks on purpose.
 *
 * The three empty lists above are what a census over two consistent tables
 * returns AND what a census whose comparison had rotted would return. There is
 * no seam for injecting a producer table — `PRODUCERS` is module-private, which
 * is correct — so the mutation goes in from the other side: the registry arrays
 * are ordinary runtime arrays that `metrics.service.ts` holds by reference, so
 * pushing a definition onto `CATALOG_METRICS` really does reach
 * `censusProducers`' own loop.
 *
 * Deliberately LAST in the file, and every helper restores in a `finally` and
 * re-asserts the clean answer afterwards: a mutation that never applied and one
 * that never reverted are the two ways a self-test reports coverage it does not
 * have.
 */
describe('#367 W17 — the census detects, in all three directions', () => {
  /** A definition shaped like a real one, so nothing but the census can refuse it. */
  function probeDefinition(
    key: string,
    unmeasured?: CatalogMetricDefinition['unmeasured'],
  ): CatalogMetricDefinition {
    return {
      key,
      title: 'A census probe',
      kind: 'count',
      numerator: 'Rows this synthetic probe pretends to count.',
      denominator: 'Not a ratio.',
      window: 'instant',
      source: 'route_observations',
      freshnessSeconds: 0,
      attributionLimit:
        'A probe that exists only inside one assertion in this file and is removed again.',
      ...(unmeasured === undefined ? {} : { unmeasured }),
    };
  }

  /** Append `definition` to the live registry, run `work`, then restore. */
  function withExtraDefinition<T>(definition: CatalogMetricDefinition, work: () => T): T {
    const registry = CATALOG_METRICS as CatalogMetricDefinition[];
    const originalLength = registry.length;
    registry.push(definition);
    // The mutation is asserted to have APPLIED before it is relied on: a `push`
    // onto a frozen array is a silent no-op under a non-strict module, and a
    // green assertion over an unmutated registry is the failure this whole
    // describe exists to rule out.
    expect(registry.length, 'the registry mutation did not apply').toBe(originalLength + 1);
    try {
      return work();
    } finally {
      registry.splice(originalLength, registry.length - originalLength);
    }
  }

  /** Hide `key` from the derived key list, run `work`, then restore. */
  function withKeyHidden<T>(key: string, work: () => T): T {
    const keys = CATALOG_METRIC_KEYS as string[];
    const index = keys.indexOf(key);
    expect(index, `${key} is not in the derived key list`).toBeGreaterThanOrEqual(0);
    const [removed] = keys.splice(index, 1);
    expect(keys.includes(key), 'the key-list mutation did not apply').toBe(false);
    try {
      return work();
    } finally {
      keys.splice(index, 0, removed);
    }
  }

  it('a definition with no producer is reported MISSING', () => {
    const census = withExtraDefinition(probeDefinition('census_probe_unproduced'), () =>
      censusProducers(),
    );
    expect(census.missingProducers).toEqual(['census_probe_unproduced']);
    expect(census.unexpectedProducers).toEqual([]);
    expect(census.definitions).toBe(CATALOG_METRICS.length + 1);
  });

  it('a definition declared unmeasured with a producer behind it is reported UNEXPECTED', () => {
    // `draft_open_count` is a real produced metric; the probe declares the same
    // key unmeasured, which is precisely the drift that would otherwise let a
    // metric report a number while the surface said it was a seam.
    const census = withExtraDefinition(
      probeDefinition('draft_open_count', {
        reason: 'not_instrumented',
        seam: 'A synthetic seam that exists for the length of one assertion in this file.',
      }),
      () => censusProducers(),
    );
    expect(census.unexpectedProducers).toEqual(['draft_open_count']);
    expect(census.missingProducers).toEqual([]);
  });

  it('a producer whose key no definition declares is reported ORPHANED', () => {
    const census = withKeyHidden('draft_open_count', () => censusProducers());
    expect(census.orphanedProducers).toEqual(['draft_open_count']);
  });

  it('the registry is back exactly as it was, and the census is clean again', () => {
    // The other half of the mutation discipline. Without this, a helper whose
    // `finally` restored the wrong slice would leave every later run of this
    // file — and every sibling in the same worker — measuring a registry three
    // probes wide, and the first symptom would be somebody else's red.
    expect(CATALOG_METRICS.length).toBe(CATALOG_METRIC_KEYS.length);
    expect([...CATALOG_METRIC_KEYS]).toEqual(CATALOG_METRICS.map((metric) => metric.key));
    expect(unmeasuredKeys()).toEqual([...EXPECTED_UNMEASURED_METRIC_KEYS].sort());
    const census = censusProducers();
    expect(census.missingProducers).toEqual([]);
    expect(census.unexpectedProducers).toEqual([]);
    expect(census.orphanedProducers).toEqual([]);
  });
});
