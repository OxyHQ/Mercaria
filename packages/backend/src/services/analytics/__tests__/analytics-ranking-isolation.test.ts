/**
 * #77 merchant rule 6 ("a merchant plan or fee schedule cannot buy
 * analytics-derived organic rank"), asserted STRUCTURALLY.
 *
 * `fee-ranking-isolation.test.ts` is the precedent and this is the same shape
 * pointed at a different pair of domains. What it adds is a second wall, because
 * this domain can be abused from two directions and only one of them looks like
 * the fee case:
 *
 *  1. **Ranking must not read analytics.** A feed, search or catalogue module
 *     may reach the EMITTER and the shared-types contract — instrumentation has
 *     to live somewhere — and nothing else in the domain. A ranking function
 *     that could read a rollup, an aggregate or a metric is one line from
 *     ordering by measured popularity, and measured popularity is one join from
 *     "merchants who pay rank higher" (a paying merchant gets more impressions,
 *     which produces more clicks, which the rollup would then feed back into
 *     the ordering).
 *
 *  2. **Analytics must not read commercial standing.** No module of the domain
 *     touches the fee domain, the referral domain or any plan, so a metric
 *     cannot be weighted by what a merchant pays even if somebody wanted to. The
 *     ONE payment import the domain may make is the verified-conversion seam,
 *     which reads `payments`/`orders` for the conversion numerator — identity
 *     rule 8 requires exactly that, and it is named explicitly here so the
 *     exception is a decision rather than a hole.
 *
 * Both scanners carry the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor and a mutation self-test.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** What the derivations need of a directory entry — `Dirent`, structurally. */
interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * How a derivation reads a directory.
 *
 * Injectable for ONE reason: the direction a hand list is blind in is a module
 * that does not exist yet, and the only ways to test that are to seed a real
 * file — which mutates a tree shared with every parallel suite — or to hand the
 * derivation a reader that reports one. This is the second.
 */
type DirectoryReader = (relative: string) => DirectoryEntry[];

const readDirectory: DirectoryReader = (relative) =>
  readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

/** Every `.ts` under `relative`, recursively, excluding the test tree. */
function walk(relative: string, readDir: DirectoryReader = readDirectory): string[] {
  const found: string[] = [];
  for (const entry of readDir(relative)) {
    if (entry.name === '__tests__') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child, readDir));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/**
 * The OFFER read surface, which this gate scans in addition to the shared
 * ranking surface — and which no sibling gate scans.
 *
 * `/offers` (#57) is a plain cheapest-first SQL read under no ranking policy, so
 * it is not part of `ranking-surface.ts`. It is here because it is still a
 * surface that decides which offers a shopper is shown, and measured popularity
 * reaching it would be an ordering input by another name.
 *
 * Four hand-written paths before (#460); the two owned directories are now
 * WALKED, which is a strict superset — it went from `services/offers/offer.service.ts`
 * and `db/offers/offerRepository.ts` to all four and all three. The two flat
 * modules have no directory to walk and stay named, with an EXACT count.
 */
const OFFER_FLAT_MODULES = ['controllers/offers.controller.ts', 'routes/offers.ts'];
const OFFER_SURFACE_PATHS = [...walk('services/offers'), ...walk('db/offers'), ...OFFER_FLAT_MODULES];

/** Everything this gate scans: the shared ranking surface plus the offer read. */
const SCANNED_PATHS = [...RANKING_SURFACE_PATHS, ...OFFER_SURFACE_PATHS];

/**
 * The analytics modules a discovery surface may import — and ONLY these.
 *
 * The emitter and the search instrumentation are the instrumentation seam; the
 * shared-types contract is types. Everything else in the domain reads or
 * computes a measurement, and none of it may be reachable from a module that
 * decides an order.
 */
const ALLOWED_ANALYTICS_IMPORTS = ['analytics/emit', 'analytics/search-instrumentation'];

/** Any import from the analytics domain. */
const ANALYTICS_IMPORT = /from\s+'([^']*analytics\/[^']*)'/g;

/** Reaching commercial standing, from any direction. */
const COMMERCIAL_REFERENCE =
  /\/fees\/|\/referrals\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|referralProgram|referral_programs/;

describe('organic ranking cannot read analytics', () => {
  it('no ranking module imports an analytics module other than the emitter seam', () => {
    let scanned = 0;
    assertRankingSurfaceIsWhole();

    // The offer read's own floors. Per SHAPE, for the reason the shared surface
    // gives: three sources break independently and one total would let a walk
    // collapse while the others carried the number.
    const fromOffers = (prefix: string) =>
      OFFER_SURFACE_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(fromOffers('services/offers/'), 'the offer service walk found nothing').toBeGreaterThanOrEqual(4);
    expect(fromOffers('db/offers/'), 'the offer repository walk found nothing').toBeGreaterThanOrEqual(3);
    // EXACT: a hand list with no count is a predicate, not an identity (#448).
    expect(OFFER_FLAT_MODULES.length).toBe(2);

    for (const relative of SCANNED_PATHS) {
      const source = readRankingSurfaceFile(relative);

      for (const match of source.matchAll(ANALYTICS_IMPORT)) {
        const specifier = match[1] ?? '';
        const permitted = ALLOWED_ANALYTICS_IMPORTS.some((allowed) => specifier.includes(allowed));
        expect(
          permitted,
          `${relative} imports ${specifier}; a ranking module may reach only the analytics ` +
            'emitter seam, or measured popularity becomes an ordering input',
        ).toBe(true);
      }
      scanned += 1;
    }
    expect(scanned).toBe(SCANNED_PATHS.length);
  });

  it('the import detector actually detects — the mutation self-test', () => {
    const forbidden = "import { readRollups } from '../services/analytics/rollup.js';";
    const permitted = "import { emitAnalyticsEvent } from '../services/analytics/emit.js';";
    const irrelevant = "import { getCart } from './cart.service.js';";

    const specifiers = (source: string): string[] =>
      [...source.matchAll(ANALYTICS_IMPORT)].map((m) => m[1] ?? '');

    expect(specifiers(forbidden)).toHaveLength(1);
    expect(
      ALLOWED_ANALYTICS_IMPORTS.some((a) => (specifiers(forbidden)[0] ?? '').includes(a)),
    ).toBe(false);
    expect(
      ALLOWED_ANALYTICS_IMPORTS.some((a) => (specifiers(permitted)[0] ?? '').includes(a)),
    ).toBe(true);
    expect(specifiers(irrelevant)).toHaveLength(0);
  });
});

/** What a module of this domain is called, wherever it lives. */
const ANALYTICS_NAME_PATTERN = /analytics/i;

/**
 * Every `.ts` in a shared flat directory whose NAME carries the domain.
 *
 * `controllers/`, `routes/` and `db/schema/` hold every domain at once, so the
 * population there cannot be the directory — it is the directory narrowed by
 * name, which is still a derivation rather than a list.
 */
function analyticsNamedIn(directory: string, readDir: DirectoryReader = readDirectory): string[] {
  return readDir(directory)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => ANALYTICS_NAME_PATTERN.test(entry.name))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

/** The two directories this domain OWNS outright, walked recursively. */
const ANALYTICS_OWNED_DIRECTORIES = ['services/analytics', 'db/analytics'] as const;

/** The shared directories a domain module lives in under a domain NAME. */
const ANALYTICS_SHARED_DIRECTORIES = [
  'controllers',
  'controllers/admin',
  'routes',
  'routes/admin',
  'middleware',
  'db/schema',
] as const;

/** Every directory the population is configured to draw from. */
const ANALYTICS_SCANNED_DIRECTORIES = [
  ...ANALYTICS_OWNED_DIRECTORIES,
  ...ANALYTICS_SHARED_DIRECTORIES,
] as const;

/**
 * The whole analytics domain, DERIVED — not the eight modules somebody
 * remembered.
 *
 * It was an eight-entry hand list called `MEASUREMENT_PATHS`, whose docblock
 * read *"Every module in the domain that COMPUTES or SERVES a number. The
 * emitter and the schema are excluded deliberately — they carry no
 * measurement."* Measured: the domain is **29** modules, so a stated exclusion
 * of TWO was doing the work of twenty-one — and four of the twenty-one are
 * hard to read as carrying no measurement at all, quoting their own headers:
 * `verified-conversion.ts` is *"the ONE seam through which analytics reads
 * financial truth"*, `search-instrumentation.ts` is *"instrumenting one
 * search"*, `db/analytics/experimentRepository.ts` owns the experiment tables,
 * and `retention.ts` performs the query redaction the shared sweep cannot.
 *
 * #535 asked which half was wrong, the sentence or the list, and said only
 * #77's owner could say. The answer measured here is that **the distinction
 * was unnecessary**: the wall is *"no analytics module references the fee or
 * referral domain"*, and it is TRUE of all 29. So the population needs no
 * notion of *"computes or serves a number"* — nothing has to be classified,
 * and **the exclusion set is EMPTY**. It is empty because it was measured, not
 * because it was guessed: a guessed exemption excuses what can never match,
 * and the two modules that DO look like exceptions turned out to mention
 * `fee_schedules` only in prose (see the comment-stripping test below).
 *
 * **#590 said 28 and that figure was one low**, which is worth leaving on the
 * record rather than quietly correcting: it came from `#593`, my own correction
 * of `scripts/isolation-gate-census.ts`'s hand-maintained bag-directory list —
 * and correcting a hand list BY HAND reproduces its failure mode. #600 found
 * two further gaps in the same list, one of which is `controllers/admin`, which
 * is how the wall shipped over 28 of 29. The count is not the lesson; the
 * lesson is that the whole-tree sweep below is now what establishes it, so no
 * future reader has to trust a number in a comment.
 */
function analyticsDomainModules(readDir: DirectoryReader = readDirectory): string[] {
  return [
    ...ANALYTICS_OWNED_DIRECTORIES.flatMap((directory) => walk(directory, readDir)),
    ...ANALYTICS_SHARED_DIRECTORIES.flatMap((directory) => analyticsNamedIn(directory, readDir)),
  ];
}

/**
 * MEASURED on this branch: 16 + 5 in the owned directories, 2 + 1 + 2 + 1 + 1 + 1
 * in the shared ones — 29 in total.
 *
 * Floors, never counts, and floors set BELOW the population rather than at it —
 * a floor at the population is a pin wearing a floor's name, and makes "bump the
 * number" the cheapest green for the legitimate case the derivation exists to
 * serve (a module ADDED tomorrow). They are placed where a traversal that found
 * NOTHING fails and a routine deletion does not.
 *
 * The three shared directories that hold exactly one analytics module get a
 * floor of 1, which is unavoidably both — one is what "found nothing" means when
 * there is one. That is the right failure anyway: `routes/admin/analytics.ts` is
 * the whole merchant analytics surface, and its disappearance is a decision
 * somebody should be made to take rather than a number to lower.
 */
const ANALYTICS_MODULE_FLOORS: ReadonlyArray<readonly [string, number]> = [
  ['services/analytics/', 12],
  ['db/analytics/', 3],
  ['controllers/', 1],
  ['controllers/admin/', 1],
  ['routes/', 1],
  ['routes/admin/', 1],
  ['middleware/', 1],
  ['db/schema/', 1],
];

/**
 * The derived population is only as honest as the assertion that it was really
 * traversed: per-SHAPE floors (never one total — the seven `readdirSync` calls
 * break independently, and a single number lets one collapse to zero while the
 * others carry it), plus a `statSync` on every member so a listing that has
 * started returning stale or cached names goes red instead of handing the scan
 * files that no longer exist.
 */
function assertAnalyticsDomainIsWhole(modules: readonly string[]): void {
  const prefixes = ANALYTICS_MODULE_FLOORS.map(([prefix]) => prefix);
  for (const [prefix, floor] of ANALYTICS_MODULE_FLOORS) {
    // `routes/` would otherwise swallow `routes/admin/`, and then the admin
    // floor could be met by a module that is not in that directory at all. The
    // subtraction is against the other SHAPES rather than against "has another
    // slash", so a future `services/analytics/rollups/` counts toward the
    // owned-directory floor it belongs to instead of falling out of every shape.
    const inShape = modules.filter(
      (relative) =>
        relative.startsWith(prefix) &&
        !prefixes.some(
          (other) => other !== prefix && other.startsWith(prefix) && relative.startsWith(other),
        ),
    );
    expect(
      inShape.length,
      `the walk of ${prefix} produced ${inShape.length} modules; a traversal that found ` +
        'nothing scans clean and reports the same green as a domain with no violations',
    ).toBeGreaterThanOrEqual(floor);
  }
  // No test file may enter the scanned set: a gate that scans its own probes
  // reports violations it wrote itself.
  expect(modules.filter((relative) => relative.includes('__tests__'))).toEqual([]);
  for (const relative of modules) {
    expect(
      statSync(join(SRC_ROOT, relative)).isFile(),
      `${relative} is not a file — did it move?`,
    ).toBe(true);
  }
}

/** Read a domain module, refusing an empty or moved file. */
function readDomainSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/** Comments removed — the house shape for a census over source. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The same source with comments removed — what the commercial detector scans.
 *
 * Not a convenience, and not a narrowing taken to make the widened population
 * fit. `db/schema/analytics.ts` explains that an active experiment's allocation
 * is frozen by trigger *"the `fee_schedules` shape, for the same reason"*, and
 * `db/analytics/experimentRepository.ts` says the same thing about the same
 * trigger. Both are the domain documenting a MECHANISM it borrows, in exactly
 * the vocabulary this detector looks for; scanning prose would make each honest
 * explanation a violation, and a gate with known false positives is one whoever
 * hits it next disables.
 */
function readDomainCode(relative: string): string {
  const stripped = stripComments(readDomainSource(relative));
  // A vacuity floor on the STRIPPED text too: a stripper that ate the file
  // would make every assertion below pass against nothing. Measured minimum
  // across the population: 332 non-whitespace characters.
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(100);
  return stripped;
}

describe('analytics cannot read commercial standing', () => {
  it('no analytics module references the fee or referral domain', () => {
    const modules = analyticsDomainModules();
    assertAnalyticsDomainIsWhole(modules);
    for (const relative of modules) {
      expect(
        COMMERCIAL_REFERENCE.test(readDomainCode(relative)),
        `${relative} references commercial standing; a metric weighted by what a merchant pays ` +
          'is the sale of organic rank one join away',
      ).toBe(false);
    }
  });

  it('the derivation covers what the hand list named, and only this domain', () => {
    // A derivation that replaced a list owes the proof that it still selects
    // everything the list named — anything it stopped selecting silently left
    // the scan, and a smaller population is indistinguishable from a cleaner
    // tree.
    const modules = analyticsDomainModules();
    for (const named of [
      'services/analytics/rollup.ts',
      'services/analytics/metrics.ts',
      'services/analytics/merchant-analytics.service.ts',
      'services/analytics/operator-analytics.service.ts',
      'services/analytics/experiments.ts',
      'db/analytics/rollupRepository.ts',
      'db/analytics/eventRepository.ts',
      'db/analytics/searchQueryRepository.ts',
    ]) {
      expect(modules, `the derivation stopped selecting ${named}`).toContain(named);
    }
    // …and the four #535 named as behind no wall, which is the point of the
    // conversion rather than a bonus.
    for (const widened of [
      'services/analytics/verified-conversion.ts',
      'services/analytics/search-instrumentation.ts',
      'services/analytics/retention.ts',
      'db/analytics/experimentRepository.ts',
    ]) {
      expect(modules, `${widened} is still outside the wall`).toContain(widened);
    }
    // …and the shared directories contribute their analytics modules and NOT
    // their neighbours', or this wall would fire at whoever edits an order.
    expect(modules).toContain('controllers/analytics-operator.controller.ts');
    expect(modules).toContain('routes/admin/analytics.ts');
    expect(modules).toContain('db/schema/analytics.ts');
    for (const foreign of [
      'controllers/orders.controller.ts',
      'routes/offers.ts',
      'db/schema/orders.ts',
      'middleware/auth.ts',
    ]) {
      expect(modules, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    }
  });

  it('no analytics-named module anywhere in src/ sits outside the population', () => {
    // The DIRECTORY list is the last hand list in this gate, and it failed
    // exactly as a hand list does. `controllers/admin` was missing while
    // `routes/admin` was present — an asymmetry inherited from
    // `scripts/isolation-gate-census.ts`, whose own bag-directory list was
    // hand-maintained and carried the same gap (#593, #600). So the wall was
    // landed over 28 of the domain's 29 modules, with
    // `controllers/admin/analytics-admin.controller.ts` — #77's merchant
    // analytics handler — behind nothing.
    //
    // A walked population whose DIRECTORY list is a hand list is a hand list,
    // and the remedy is the one this whole file is about: derive the exclusion
    // rather than the inclusion, one level up. Sweep the entire source tree for
    // modules NAMED for this domain and require each to be in the population or
    // in a counted, justified exclusion — so a new bag directory brings its
    // modules under the wall with no edit here, and a domain-named module that
    // genuinely belongs to somebody else forces a decision instead of a gap.
    const swept: string[] = [];
    const sweep = (relative: string): void => {
      for (const entry of readDirectory(relative)) {
        if (entry.name === '__tests__') continue;
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) sweep(child);
        // The PATH, not the filename. A module inside a directory named for
        // this domain is a module of it whatever the file is called —
        // `services/analytics/emit.ts` names the domain nowhere in its own
        // name. Matching the filename swept 10 of the 29 and the vacuity floor
        // below is what said so.
        else if (entry.name.endsWith('.ts') && ANALYTICS_NAME_PATTERN.test(child)) {
          swept.push(child);
        }
      }
    };
    sweep('');

    // A vacuity floor on the sweep itself: a traversal that found nothing would
    // report no modules outside the population, which is the answer a correct
    // tree gives. MEASURED at 29.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing; it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(20);

    const population = new Set(analyticsDomainModules());
    const outside = swept.filter((relative) => !population.has(relative));
    // EXACT and empty. An exclusion list needs its own count in both directions
    // (#448), and this one is empty because it was measured empty: every
    // analytics-named module in the tree is a module of this domain. A future
    // `search-analytics.ts` owned by discovery goes here WITH its reason, and
    // the count moves in the same edit.
    expect(
      outside,
      'an analytics-named module sits outside the scanned population, so the fee and referral ' +
        'wall does not cover it — add its directory to ANALYTICS_SHARED_DIRECTORIES, or excuse ' +
        'it here with a reason and move the count',
    ).toEqual([]);
  });

  it('a module ADDED to the domain is scanned — the direction a hand list is blind in', () => {
    // The probe that justifies the whole conversion, kept as a test rather than
    // as a claim that one was run once. A hand list that is COMPLETE today
    // passes every floor and every count it carries; the only way it fails is a
    // module nobody adds to it.
    //
    // Written against the DERIVATION rather than the filesystem: seeding a real
    // file would mutate a tree shared with every parallel suite. The derivation
    // takes its directory READER as a parameter, so a module that does not
    // exist can be reported to it and the question "would the scan get it?"
    // asked for real — of the actual `analyticsDomainModules`, not of a
    // re-spelling of it. (This replaced a `expect(reconstructed).toEqual(modules)`
    // that compared the derivation against the same two spreads inlined: one
    // computation against itself, which no edit to the name rule, the directory
    // lists or the filters could redden.)
    const seededWith = (directory: string, added: string): string[] =>
      analyticsDomainModules((requested) =>
        requested === directory
          ? [...readDirectory(requested), { name: added, isDirectory: () => false, isFile: () => true }]
          : readDirectory(requested),
      );

    // A SHARED directory admits a new module by NAME …
    expect(
      seededWith('controllers', 'analytics-demand.controller.ts'),
      'a new analytics controller does not enter the population; the shared-directory half of ' +
        'the derivation has stopped admitting one, and it would sit behind no wall',
    ).toContain('controllers/analytics-demand.controller.ts');
    // … and ONLY by name, or this wall would start firing at whoever edits an
    // order.
    expect(
      seededWith('controllers', 'orders.controller.ts'),
      'a foreign controller entered the population; the name rule has stopped narrowing',
    ).not.toContain('controllers/orders.controller.ts');
    // An OWNED directory admits ANY name — the case the hand list missed, and
    // the one where a name rule would be exactly wrong.
    expect(
      seededWith('services/analytics', 'demand.service.ts'),
      'a new module in an owned directory does not enter the population',
    ).toContain('services/analytics/demand.service.ts');

    // The control: none of the seeded modules exists, so the assertions above
    // are about the derivation and not about the tree. Without this, a file
    // that happened to be added under one of those names would make them pass
    // while proving nothing.
    const real = analyticsDomainModules();
    for (const seeded of [
      'controllers/analytics-demand.controller.ts',
      'services/analytics/demand.service.ts',
    ]) {
      expect(
        real,
        `${seeded} exists on disk, so the seeded assertions above prove nothing — rename the seed`,
      ).not.toContain(seeded);
    }
  });

  it('a violation planted in EVERY scanned directory is detected — one victim per directory', () => {
    // A self-test with ONE seeded victim proves the detector fires where that
    // victim sits and nothing about the rest of the population: a mutation
    // aimed at half the derivation leaves the other half green, and the single
    // red reads as proof. So the victims are DERIVED from the directories the
    // population actually draws from, one each — a subdirectory added tomorrow
    // is self-tested with no edit here, and the count is asserted so a
    // directory that silently leaves the population takes this test red with
    // it.
    const modules = analyticsDomainModules();
    const parentOf = (relative: string): string => relative.slice(0, relative.lastIndexOf('/'));
    const directories = [...new Set(modules.map(parentOf))].sort();

    // A CONFIGURED directory holding no `.ts` file must fail loudly rather than
    // be covered by nothing — the clause that keeps this honest as the tree
    // grows, and the one a population-derived victim list cannot state on its
    // own (a directory that contributes nothing simply never appears).
    for (const configured of ANALYTICS_SCANNED_DIRECTORIES) {
      expect(
        modules.some((relative) => relative.startsWith(`${configured}/`)),
        `${configured} contributed no module, so nothing in it is self-tested — a configured ` +
          'directory that holds no scanned file is a hole, not an empty set',
      ).toBe(true);
    }

    const victims = directories.map((directory) => {
      const inDirectory = modules.filter((relative) => parentOf(relative) === directory);
      expect(inDirectory.length, `${directory} produced no mutation victim`).toBeGreaterThan(0);
      return inDirectory[0] ?? '';
    });
    // NOT `toBe(directories.length)`: `directories.map(...)` makes that
    // identity hold for ANY list, so it is `expect(scanned).toBe(LIST.length)`
    // wearing a new costume — the defect this whole file exists to remove, and
    // it was in the first draft of this test. The count is compared against the
    // INDEPENDENT quantity instead: the configured directory list, which
    // nothing in the victim derivation reads.
    expect(
      victims.length,
      'the self-test covers fewer directories than are configured, so a configured directory ' +
        'is contributing nothing and is self-tested by nothing',
    ).toBeGreaterThanOrEqual(ANALYTICS_SCANNED_DIRECTORIES.length);

    for (const victim of victims) {
      const raw = readDomainSource(victim);
      // The control: the real file passes TODAY, so the red below comes from
      // the planted violation and not from the file it was planted in.
      expect(
        COMMERCIAL_REFERENCE.test(stripComments(raw)),
        `${victim} already fails the wall, so it cannot serve as a mutation control`,
      ).toBe(false);
      expect(modules, `${victim} is not in the scanned population`).toContain(victim);
      for (const violation of [
        "\nimport { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';\n",
        "\nimport { readReferralProgram } from '../referrals/program.service.js';\n",
      ]) {
        expect(
          COMMERCIAL_REFERENCE.test(stripComments(raw + violation)),
          `a violation planted in ${victim} is not detected, so ${parentOf(victim)} is scanned ` +
            'by a detector that cannot see a violation in it',
        ).toBe(true);
      }
    }
  });

  it('comment stripping removes prose and nothing else — and it is load-bearing here', () => {
    // The stripper is the one narrowing this gate makes, so it carries its own
    // self-test in BOTH directions: a mention in prose is removed, and a
    // mention in CODE survives — including on a line that also carries a
    // trailing comment, which is the shape a real violation would hide behind.
    expect(COMMERCIAL_REFERENCE.test(stripComments('/** the `fee_schedules` shape */'))).toBe(false);
    expect(COMMERCIAL_REFERENCE.test(stripComments('// mirrors fee_schedules'))).toBe(false);
    expect(
      COMMERCIAL_REFERENCE.test(stripComments("const t = 'fee_schedules';")),
      'the stripper ate real code; every wall above would then pass against nothing',
    ).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test(stripComments("import { x } from '../fees/y.js'; // seam")),
    ).toBe(true);
    // A URL is not a comment: `https://…` must survive, or the stripper is
    // eating the rest of every line that carries one.
    expect(stripComments("const u = 'https://example.test/a';")).toContain('example.test/a');

    // And the measurement that makes the narrowing a decision rather than a
    // convenience: at least one module of the population mentions the fee
    // domain in PROSE and not in code, so raw-scanning this population is not
    // available. If this ever reaches zero the stripping can be DROPPED and the
    // wall tightened — the failure is an invitation to make the gate stricter,
    // never to delete a line.
    const modules = analyticsDomainModules();
    const proseOnly = modules.filter(
      (relative) =>
        COMMERCIAL_REFERENCE.test(readDomainSource(relative)) &&
        !COMMERCIAL_REFERENCE.test(readDomainCode(relative)),
    );
    expect(
      proseOnly.length,
      'no module documents the fee domain any more; comment stripping has stopped being ' +
        'load-bearing here and this gate can scan raw source again',
    ).toBeGreaterThanOrEqual(1);
  });

  it('the commercial detector actually detects — the mutation self-test', () => {
    expect(
      COMMERCIAL_REFERENCE.test(
        "import { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';",
      ),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from order_fee_snapshots')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

  it('the ONE payment import is the verified-conversion seam, and it is named', () => {
    // Identity rule 8 REQUIRES this read: the conversion numerator comes from
    // `payments`/`orders` and never from telemetry. Naming the exception here
    // is what keeps it a decision — a second module quietly reaching into the
    // payment domain would fail the scan above without this being stated.
    const seam = readFileSync(
      join(SRC_ROOT, 'services/analytics/verified-conversion.ts'),
      'utf8',
    );
    expect(seam.length).toBeGreaterThan(200);
    expect(seam).toContain("from '../../db/schema/payments.js'");
    expect(seam).toContain("from '../../db/schema/orders.js'");
    // And it reads COUNTS, not money: recomputing an amount here would create a
    // second answer to a question the ledger already owns.
    expect(/amount|currency|minor/i.test(seam.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
  });
});
