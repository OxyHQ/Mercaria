/**
 * ONE derivation of the organic discovery and ranking surface, for the eleven
 * isolation gates that each assert some domain cannot influence what a buyer
 * sees or in what order.
 *
 * ## Why this file exists
 *
 * Eleven gates carried a `RANKING_PATHS` array — copied, then drifted. Measured
 * on `origin/main` before this file existed:
 *
 * | gate | entries | covered `services/ranking/` | covered `services/search/` |
 * |---|---|---|---|
 * | `fee-ranking` | 19 | 5 of 10 | 3 of 7 |
 * | `analytics-ranking` | 26 | 5 of 10 | 3 of 7 |
 * | `price-alert`, `product-save`, `retail-eligibility`, `retail-ranking`, `sell-yours`, `relationship-ranking` | 15 | 5 of 10 | 0 of 7 |
 * | `matching`, `curation` | 14 | 5 of 10 | 0 of 7 |
 * | `price-history` | 8 | **0 of 10** | 0 of 7 |
 *
 * So `price-history`'s "the OTHER direction of the ranking wall" was computed
 * over a population containing no ranking module at all, `db/ranking/` was in no
 * copy whatsoever, and nine of the eleven had never heard of #70's canonical
 * search. Each gate still passed, which is the defect: a copied list is complete
 * on the day it is written and silently incomplete the day somebody adds a
 * module, and what it then skips is exactly the module nobody has reviewed
 * (#460).
 *
 * Six copies would have been stale the moment a ranking module was added — and
 * five already were, because five modules of `services/ranking/`
 * (`dominance.ts`, `money.ts`, `policy.service.ts`, `policy.ts`, `seams.ts`)
 * and the whole of `db/ranking/` had been added since the list was written.
 *
 * ## What the population is
 *
 * Three sources, and each is derived rather than listed wherever a derivation
 * exists, because that is the difference between a wall that covers modules
 * nobody has written yet and one that covers the modules somebody remembered:
 *
 * 1. **The ordering ENGINES with a directory of their own**, walked recursively:
 *    `services/ranking/` (#74's policy, scoring and labels), `db/ranking/`,
 *    `services/search/` (#70's canonical retrieval and relevance) and
 *    `db/search/`.
 *
 * 2. **The listing-first ordering engines, which have no directory** — the one
 *    hand list left, kept deliberately and with an EXACT count rather than a
 *    floor. They sit flat among ~150 unrelated modules in `services/` and
 *    `db/catalog/`, and every rule that would derive them derives something
 *    false: a `feed` rule takes `services/feedback.service.ts`, a `catalog` rule
 *    takes `services/catalog-write.service.ts`, and walking `db/catalog/` whole
 *    takes `inventoryLevelRepository.ts` and `pinReleaseRepository.ts`, which
 *    are inventory WRITES rather than anything that decides an order. The
 *    comment above the list therefore claims exactly what the list is — four
 *    named legacy engines — and nothing about completeness.
 *
 * 3. **The HTTP surface, derived from the IMPORT GRAPH rather than from
 *    names.** A controller is in the population when it imports an engine; a
 *    route is in it when it mounts such a controller. This is what the copied
 *    lists could not do: it found `controllers/ranking-operator.controller.ts`
 *    and `controllers/search-operator.controller.ts` (#74's and #70's operator
 *    surfaces, in no copy), and `categories`, `collections`, `seller-listings`
 *    and `stores` — four catalogue-read controllers that order listings through
 *    `catalog-hydration.service` and were behind none of these walls.
 *    `AGENTS.md` puts a "catalogue module" inside this wall in as many words.
 *
 * A NAME-derived HTTP surface was written first and rejected: it is the same
 * hand-maintained map with an extra step, since a new discovery route called
 * something nobody predicted is invisible to it. The import graph is a fact.
 */

import { expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.ts` under `relative`, recursively, excluding the test tree. */
function walk(relative: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/** Every `.ts` directly in a flat directory. */
function flat(relative: string): string[] {
  return readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${relative}/${entry.name}`);
}

/** The import specifiers of one module. */
function importSpecifiers(relative: string): string[] {
  return [...readFileSync(join(SRC_ROOT, relative), 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
    (match) => match[1] ?? '',
  );
}

/**
 * An import specifier RESOLVED against the importing module's own directory, as
 * a src-relative module path: `controllers/x.ts` importing
 * `'../services/feed.service.js'` gives `services/feed.service`. A package
 * import (`express`, `@mercaria/shared-types`) gives `null`.
 *
 * Resolved rather than string-trimmed, and that is load-bearing: the tree really
 * does contain same-directory imports (`controllers/*.ts` importing
 * `'./search.controller.js'`, `routes/*.ts` importing `'./buyer-requests.js'`),
 * and a matcher that stripped leading `./` and then compared suffixes would read
 * a route's own sibling as the controller of the same name. That is a false
 * positive in the direction that silently WIDENS the population, which is the
 * direction nobody investigates.
 */
function resolveSpecifier(fromRelative: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return join(dirname(fromRelative), specifier).replace(/\.js$/, '');
}

/** Does `relative` import any of `targets` (a module path, or a directory of them)? */
function imports(relative: string, targets: readonly string[]): boolean {
  return importSpecifiers(relative).some((specifier) => {
    const path = resolveSpecifier(relative, specifier);
    if (path === null) return false;
    return targets.some((target) => path === target || path.startsWith(`${target}/`));
  });
}

/** The ordering engines that own a directory. Walked whole, recursively. */
const ENGINE_DIRECTORIES = ['services/ranking', 'db/ranking', 'services/search', 'db/search'];

/**
 * The listing-first ordering engines. A HAND LIST, and the comment says only
 * what the list is: these four modules and no claim beyond them.
 *
 * `feed.service` builds the home feed, `search.service` is the legacy listing
 * search, `catalog-hydration.service` is the shared projection both of them
 * order through, and `listingRepository` is the query layer underneath. They are
 * flat among unrelated modules and no rule derives them without also deriving
 * something that is not an ordering engine — see the file docblock. The count is
 * asserted EXACTLY below, because an unbounded hand list is a predicate rather
 * than an identity (#448).
 */
const LEGACY_ENGINE_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/catalog-hydration.service.ts',
  'db/catalog/listingRepository.ts',
];

/**
 * Route files scoped OUT, with the assertion that justifies each rather than a
 * sentence — and an EXACT count, so a second aggregator cannot ride in behind
 * this one (#448).
 *
 * A route file decides no order. It is `router.get(path, rateLimit, auth,
 * validate(schema), controller)`, and its imports are the UNION of every surface
 * mounted on it. So a route that happens to mount a discovery endpoint beside
 * another domain's endpoint reads, to a domain wall, as that domain leaking into
 * ranking — when all that has happened is two surfaces sharing a router.
 *
 * `routes/seller.ts` is the one case in the tree: it mounts ONE discovery
 * controller (`seller-listings`, which reads `catalog-hydration`) beside SIX
 * belonging to other domains, `sell-yours.controller` among them. Scanning it as
 * a ranking module fails the sell-yours wall for a co-location, and the cheapest
 * way to green that is to weaken the sell-yours detector — a gate that pushes
 * you toward the hazard.
 *
 * The exclusion is safe by CONSTRUCTION rather than by assertion, and the third
 * clause below is the one that makes it so: this route may not import an ordering
 * engine ITSELF. The day it does, it stops being a mere mount point, stops being
 * excludable, and this gate names it.
 *
 * `routes/listings.ts` and `routes/stores.ts` also mount a second domain's
 * controller (`reviews`) and deliberately STAY: both are dominated by discovery
 * content, `listings` was in every copied list, and dropping either would narrow
 * a wall this file exists to widen.
 */
const AGGREGATOR_ROUTES = [
  {
    path: 'routes/seller.ts',
    /** Mounted discovery controllers — each scanned in its own right below. */
    mounts: ['controllers/seller-listings.controller'],
    /** Proof it is an aggregator rather than a discovery route. */
    alsoMounts: 'controllers/sell-yours.controller',
  },
] as const;

/** The engines: walked directories plus the four named legacy modules. */
function enginePaths(): string[] {
  return [...ENGINE_DIRECTORIES.flatMap(walk), ...LEGACY_ENGINE_PATHS];
}

/** Controllers that import an engine — the discovery surface, derived. */
function discoveryControllers(engines: readonly string[]): string[] {
  const targets = engines.map((path) => path.replace(/\.ts$/, ''));
  return flat('controllers').filter((controller) => imports(controller, targets));
}

/** Routes that mount a discovery controller, minus the counted aggregators. */
function discoveryRoutes(controllers: readonly string[]): string[] {
  const targets = controllers.map((path) => path.replace(/\.ts$/, ''));
  return flat('routes')
    .filter((route) => imports(route, targets))
    .filter((route) => !AGGREGATOR_ROUTES.some((entry) => entry.path === route));
}

const ENGINES = enginePaths();
const CONTROLLERS = discoveryControllers(ENGINES);
const ROUTES = discoveryRoutes(CONTROLLERS);

/**
 * Everything that decides which listings or offers a buyer sees, and in what
 * order. WALKED and DERIVED, never listed.
 */
export const RANKING_SURFACE_PATHS: readonly string[] = [...ENGINES, ...CONTROLLERS, ...ROUTES];

/** Read one surface module, refusing an empty or moved file. */
export function readRankingSurfaceFile(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The vacuity floors, per SHAPE rather than one on the total.
 *
 * The five sources break independently, and a single total would let a directory
 * walk collapse to zero while the others carried the number — which is the exact
 * failure this file was written to end. Each floor is the count on the day it
 * was derived, because these directories only grow and a SHRINK is the event
 * that should stop the build rather than quietly narrowing every assertion in
 * eleven gates at once.
 *
 * Compared with `>=` against today's count, so removing a module goes red. A
 * floor set below today's count would be inert the moment the smallest shape
 * grew past it.
 */
export function assertRankingSurfaceIsWhole(): void {
  const from = (prefix: string) =>
    RANKING_SURFACE_PATHS.filter((path) => path.startsWith(prefix)).length;

  expect(from('services/ranking/'), "#74's ranking walk found nothing").toBeGreaterThanOrEqual(10);
  expect(from('db/ranking/'), "#74's policy repository walk found nothing").toBeGreaterThanOrEqual(
    1,
  );
  expect(from('services/search/'), "#70's search walk found nothing").toBeGreaterThanOrEqual(7);
  expect(from('db/search/'), "#70's repository walk found nothing").toBeGreaterThanOrEqual(2);
  expect(CONTROLLERS.length, 'no discovery controller was derived').toBeGreaterThanOrEqual(10);
  expect(ROUTES.length, 'no discovery route was derived').toBeGreaterThanOrEqual(8);

  // EXACT, not a floor: this is the one hand list left, and a hand list without
  // a count is a predicate that lets any number of modules ride in behind it.
  expect(LEGACY_ENGINE_PATHS.length, 'the legacy engine list changed size').toBe(4);
  expect(AGGREGATOR_ROUTES.length, 'a second aggregator route was excluded').toBe(1);

  // No test file may enter the scanned set: a gate that scans its own probes
  // reports violations it wrote itself.
  expect(RANKING_SURFACE_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);

  // And the walk really reads the disk, rather than a `readdirSync` that has
  // silently started returning a cached or empty result.
  for (const path of RANKING_SURFACE_PATHS) {
    expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
  }

  // Every excluded aggregator must still BE one, measured against real imports.
  // A stale exclusion excuses nothing while looking like a decision.
  const engineTargets = ENGINES.map((path) => path.replace(/\.ts$/, ''));
  for (const { path, mounts, alsoMounts } of AGGREGATOR_ROUTES) {
    const mounted$ = importSpecifiers(path).map((specifier) => resolveSpecifier(path, specifier));
    for (const mounted of mounts) {
      expect(
        mounted$.includes(mounted),
        `${path} was excluded as a mount point, and no longer mounts ${mounted}`,
      ).toBe(true);
      expect(
        RANKING_SURFACE_PATHS,
        `${path} was excluded because ${mounted} is scanned in its own right, and it is not`,
      ).toContain(`${mounted}.ts`);
    }
    expect(
      mounted$.includes(alsoMounts),
      `${path} was excluded as an aggregator, and no longer mounts ${alsoMounts}`,
    ).toBe(true);
    // The clause that makes the exclusion safe rather than merely justified.
    expect(
      imports(path, engineTargets),
      `${path} now imports an ordering engine itself — it is no longer a mount point and belongs behind this wall`,
    ).toBe(false);
  }
}
