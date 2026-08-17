/**
 * The walls around #68, asserted STRUCTURALLY rather than by fixture.
 *
 * Four properties, and each is a SCAN because "cannot" is a stronger statement
 * than "did not in this case":
 *
 * 1. **There is no global TTL, and the resolver cannot grow one.**
 *    `policy.ts` imports no configuration at all, and no module in the domain
 *    declares a module-level duration that could serve as a default lifetime.
 *    That is the shape a global TTL would actually take: not a column, but
 *    somebody reaching for `config.offerFreshness.defaultTtlSeconds` because a
 *    source had no policy row.
 * 2. **This domain does not do #37's job.** It decides whether an offer may be
 *    followed and never composes a tracked URL or performs a redirect.
 * 3. **Freshness is not a ranking input** (#74's), and it invents no popularity
 *    signal of its own (#77 measures that, #78/#79 own alerts) — this domain
 *    publishes the entry point and reads none of those domains.
 * 4. **It cannot reach the cart, the checkout or the payment path.** A
 *    catalogue deadline must never be one join from a charge.
 *
 * The scanner carries the metro-gate defences `~/Oxy/AGENTS.md` requires: a
 * vacuity floor so a moved file fails the gate instead of silently shrinking
 * it, an enumeration floor read off the real directory so a NEW module is
 * scanned without anybody remembering to list it, and a mutation self-test on
 * every detector so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The two directories this domain owns outright. */
const OWNED_DIRECTORIES = ['services/offer-freshness', 'db/offerFreshness'] as const;

/** The flat directories every domain's HTTP surface shares. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware'] as const;

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

/**
 * Every module of the domain, ENUMERATED FROM THE DIRECTORIES.
 *
 * A hand-written list is the version of this gate that silently stops covering
 * whatever somebody adds next — `ingestion-isolation.test.ts`'s reasoning, and
 * the reason the floors below are counted rather than assumed.
 *
 * It used to walk the two owned directories and stop there, which is the shape
 * #460 measured across the suite: complete exactly where modules rarely appear
 * and absent exactly where they do. The operator SURFACE — the route, the
 * operator controller and the request schemas — was behind no wall at all, and
 * the controller is the module in this domain with the most reach, since it
 * drains the dispatcher, runs the expiry sweep and reads four repositories.
 *
 * The shared flat directories have no directory of this domain's own to walk,
 * so the population is derived from the filename convention every file in them
 * already follows. `offer-freshness` is unambiguous — no other domain has taken
 * it — which is why this needs no exclusion list where `offer-isolation`, whose
 * bare `offer` token four issues share, needs one.
 */
function domainModules(): { path: string; source: string }[] {
  const relatives = [
    ...OWNED_DIRECTORIES.flatMap(walk),
    ...SHARED_DIRECTORIES.flatMap((directory) =>
      readdirSync(join(SRC_ROOT, directory), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .filter((entry) => /offer-freshness/i.test(entry.name))
        .map((entry) => `${directory}/${entry.name}`),
    ),
  ];
  return relatives.map((relative) => {
    const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
    // The vacuity floor, per file: an empty or moved module must fail here,
    // not pass the scan by having nothing to match.
    expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
    return { path: relative, source };
  });
}

/**
 * The enumeration floor, per SHAPE.
 *
 * Each number is the count on the day it was written, because these
 * directories only grow and a SHRINK is the event that should stop the build
 * rather than quietly narrowing every assertion in this file. Split by shape
 * rather than totalled: the three sources break independently — a renamed
 * directory, a moved repository, a changed filename convention — and one total
 * would let any of them collapse to zero while the other two carried the
 * number.
 */
function expectEveryShapeFoundSomething(modules: { path: string }[]): void {
  const from = (prefix: string) => modules.filter((module) => module.path.startsWith(prefix)).length;
  expect(from('services/offer-freshness/'), 'the service walk found nothing').toBeGreaterThanOrEqual(
    10,
  );
  expect(from('db/offerFreshness/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(5);
  expect(from('routes/'), 'no freshness route was derived').toBeGreaterThanOrEqual(1);
  expect(from('controllers/'), 'no freshness controller was derived').toBeGreaterThanOrEqual(1);
  expect(from('middleware/'), 'no freshness request schema was derived').toBeGreaterThanOrEqual(1);
  expect(modules.filter((module) => module.path.includes('__tests__'))).toEqual([]);
}

/**
 * Strip comments before a reachability scan.
 *
 * These modules DOCUMENT what they refuse to do, in the same vocabulary the
 * detectors search for — `outbound redirect`, `ranking`, `price alert` all
 * appear in prose above the code that refuses them. Scanning raw source would
 * make every gate fail on its own explanation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
}

/** Reading deployment configuration — the shape a global TTL would take. */
const CONFIG_IMPORT = /from\s+'\.\.\/\.\.\/config\/index\.js'|\bconfig\.offerFreshness\b/;

/**
 * A module-level constant that would be a default FRESHNESS LIFETIME.
 *
 * The prohibition is on a lifetime and not on every duration, and the
 * distinction is the one `config/index.ts` already draws: how hard Mercaria may
 * knock and how often it polls are properties of Mercaria's own politeness and
 * are legitimately deployment-wide (`WINDOW_MS` in the lease repository is the
 * per-MINUTE window a provider publishes its limit in). How long a source's
 * facts stay trustworthy is a property of that source's contract and may never
 * be one number for everybody.
 *
 * So the name must carry BOTH a freshness word and a time unit. A FRACTION or a
 * MULTIPLE is not matched either: `SOURCE_WARNING_FRACTION` is two thirds of a
 * different number for every source and `SOURCE_OUTAGE_GRACE_INTERVALS` is two
 * of that source's own intervals, so neither can become the value this gate
 * exists to prevent.
 */
const DURATION_CONSTANT =
  /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*(?:TTL|FRESHNESS|EXPIRY|EXPIRES|STALE|LIFETIME)[A-Z0-9_]*(?:SECONDS|MS|MILLIS|MINUTES|HOURS|DAYS))\b/gmu;

/**
 * A VALIDATION BOUND is not a lifetime, and the difference is a USE.
 *
 * Widening the population to the request-schema modules (#460) brought in
 * `middleware/offer-freshness-schemas.ts`, which declares
 * `MAX_FRESHNESS_SECONDS = 90 * 24 * 60 * 60` and spends it in four
 * `z.number().max(…)` calls. That is a ceiling on what an operator may publish
 * FOR ONE SOURCE, not a value any source is ever served: it makes nobody's
 * freshness anything, it only refuses an absurd row. Every sibling schema
 * module writes the same bound inline (`ingestion-schemas.ts:50`,
 * `awin-schemas.ts:71`, `feed-import-schemas.ts:80`); this one named it because
 * it uses it four times.
 *
 * So the carve-out is keyed on the USE and not on the NAME. A `MAX_`-prefixed
 * exemption would be pure theatre — `ttl ?? MAX_FRESHNESS_SECONDS` is exactly
 * how a bound becomes the default this gate exists to prevent, and renaming a
 * constant would be the cheapest way through. A constant is a bound only when
 * EVERY occurrence outside its own declaration is an argument to `.max(` or
 * `.min(`; one use anywhere else and it is read as a lifetime again.
 *
 * An EXPORTED constant is never a bound here, whatever this file does with it.
 * The use count is per file, so an exported one could be spent as a default in
 * a module this function never reads — the one way the carve-out could be
 * satisfied locally and false globally.
 */
function isValidationBoundOnly(source: string, name: string): boolean {
  if (new RegExp(`\\bexport\\s+const\\s+${name}\\b`, 'u').test(source)) return false;
  const uses = [...source.matchAll(new RegExp(`\\b${name}\\b`, 'gu'))];
  const declarations = [...source.matchAll(new RegExp(`\\bconst\\s+${name}\\b`, 'gu'))].length;
  const bounded = [...source.matchAll(new RegExp(`\\.(?:max|min)\\(\\s*${name}\\s*\\)`, 'gu'))]
    .length;
  return uses.length > declarations && uses.length === declarations + bounded;
}

/** The module-level duration constants a module declares that are NOT bounds. */
function durationConstants(source: string): string[] {
  return [...source.matchAll(DURATION_CONSTANT)]
    .map((match) => match[1])
    .filter((name) => !isValidationBoundOnly(source, name));
}

/** #37's outbound redirect. This domain DECIDES and never routes. */
const REDIRECT_COMPOSITION =
  /buildAffiliateUrl|composeTrackedUrl|res\.redirect|services\/outbound\/|trackingTemplate\s*\.replace/;

/** #74's ranking, and the signal domains whose entry points this one publishes. */
const RANKING_REFERENCE = /rankOffers|offerRanking|services\/ranking\//;
const SIGNAL_DOMAIN_REFERENCE = /services\/analytics\/|services\/referrals\/|priceAlertRepository/;

/** The cart, the checkout and the money path. */
const COMMERCE_REFERENCE = /services\/cart|services\/checkout|services\/payments\/|cartRepository/;

describe('there is no global TTL, and the resolver cannot grow one', () => {
  it('the policy resolver imports no configuration', () => {
    const raw = readFileSync(join(SRC_ROOT, 'services/offer-freshness/policy.ts'), 'utf8');
    expect(raw.length).toBeGreaterThan(1_000);
    // Comment-stripped, because the module NAMES the thing it refuses to do —
    // its docblock says `config.offerFreshness.defaultTtlSeconds` in as many
    // words, which is exactly the vocabulary the detector searches for.
    const policy = withoutComments(raw);
    expect(
      CONFIG_IMPORT.test(policy),
      'policy.ts reads configuration; every freshness duration must come from a row keyed on ONE source',
    ).toBe(false);
    // …and it demonstrably reads the two per-source tables instead.
    expect(policy).toContain('findCatalogSourceConfig');
    expect(policy).toContain('findActiveFreshnessPolicy');
  });

  it('the mutation self-test: a config import IS detected', () => {
    // Without this, a regex that stopped matching would pass the gate above by
    // matching nothing at all, which is the failure mode the gate exists for.
    expect(CONFIG_IMPORT.test("import { config } from '../../config/index.js';")).toBe(true);
    expect(CONFIG_IMPORT.test('const ttl = config.offerFreshness.refreshLeaseMs;')).toBe(true);
  });

  it('no module in the domain declares a module-level DURATION constant', () => {
    const modules = domainModules();
    // The enumeration floor, per shape: a traversal that found three modules
    // would pass this gate vacuously, and a total alone would let one of the
    // three sources collapse while the other two carried the number.
    expectEveryShapeFoundSomething(modules);

    const offenders = modules
      .filter((module) => durationConstants(module.source).length > 0)
      .map((module) => module.path);
    expect(
      offenders,
      'a module-level duration is how a per-source TTL becomes a global one',
    ).toEqual([]);
  });

  it('the mutation self-test: a duration constant IS detected, and a FRACTION is not', () => {
    expect(durationConstants('const DEFAULT_FRESHNESS_SECONDS = 86_400;')).toEqual([
      'DEFAULT_FRESHNESS_SECONDS',
    ]);
    expect(durationConstants('export const OFFER_TTL_MS = 3_600_000;')).toEqual(['OFFER_TTL_MS']);
    expect(durationConstants('const OFFER_STALE_AFTER_HOURS = 24;')).toEqual([
      'OFFER_STALE_AFTER_HOURS',
    ]);
    // A rate-limit window and a poll interval are NOT lifetimes: they are how
    // hard Mercaria knocks, which is Mercaria's own decision for every source.
    expect(durationConstants('const WINDOW_MS = 60_000;')).toEqual([]);
    expect(durationConstants('const DEFAULT_LEASE_MS = 30_000;')).toEqual([]);
    // The two shapes that are legitimate, because neither is itself a duration:
    // a fraction of a source's own number and a multiple of its own interval.
    expect(durationConstants('export const SOURCE_WARNING_FRACTION = 2 / 3;')).toEqual([]);
    expect(durationConstants('export const SOURCE_OUTAGE_GRACE_INTERVALS = 2;')).toEqual([]);
  });

  it('the bound carve-out is keyed on the USE, so it cannot be reached by renaming', () => {
    // A ceiling spent only in `.max(…)` is not a lifetime, and this is the
    // shape the request-schema module really has.
    const bound = [
      'const MAX_FRESHNESS_SECONDS = 90 * 24 * 60 * 60;',
      'const schema = z.object({',
      '  expiryAfterSeconds: z.number().int().min(60).max(MAX_FRESHNESS_SECONDS),',
      '  warningAfterSeconds: z.number().int().min(60).max(MAX_FRESHNESS_SECONDS),',
      '});',
    ].join('\n');
    expect(durationConstants(bound)).toEqual([]);

    // The same NAME, spent once as a fallback, is the global default this gate
    // exists to prevent — and it is still caught. Without this the carve-out
    // would be a `MAX_` exemption anybody could rename their way into.
    const fallback = `${bound}\nconst ttl = policy?.expiryAfterSeconds ?? MAX_FRESHNESS_SECONDS;`;
    expect(durationConstants(fallback)).toEqual(['MAX_FRESHNESS_SECONDS']);

    // And a bound that is never spent at all is not a bound: it is a value
    // waiting for a use, so it stays an offender.
    expect(durationConstants('const MAX_FRESHNESS_SECONDS = 90;')).toEqual([
      'MAX_FRESHNESS_SECONDS',
    ]);

    // An EXPORTED bound is never carved out, however this file spends it: the
    // use count is per file, so the fallback could live in a module this
    // function never reads. That is the one way the carve-out could be true
    // locally and false globally, and it is closed by the declaration rather
    // than by looking for the caller.
    expect(durationConstants(`export ${bound}`)).toEqual(['MAX_FRESHNESS_SECONDS']);
  });
});

describe('the domain decides, and does not do another issue’s job', () => {
  it('composes no tracked URL and performs no redirect (#37)', () => {
    const modules = domainModules();
    expectEveryShapeFoundSomething(modules);
    for (const module of modules) {
      expect(
        REDIRECT_COMPOSITION.test(withoutComments(module.source)),
        `${module.path} composes or performs an outbound redirect; #68 supplies the GATE and #37 owns the routing`,
      ).toBe(false);
    }
  });

  it('ranks nothing and invents no popularity signal (#74, #77, #78/#79)', () => {
    const modules = domainModules();
    for (const module of modules) {
      const source = withoutComments(module.source);
      expect(
        RANKING_REFERENCE.test(source),
        `${module.path} ranks offers; #74 owns ranking and a freshness deadline must not become an ordering input`,
      ).toBe(false);
      expect(
        SIGNAL_DOMAIN_REFERENCE.test(source),
        `${module.path} reads a signal domain; #68 publishes the refresh entry point and its owners supply the signal`,
      ).toBe(false);
    }
  });

  it('cannot reach the cart, the checkout or the payment path', () => {
    const modules = domainModules();
    for (const module of modules) {
      expect(
        COMMERCE_REFERENCE.test(withoutComments(module.source)),
        `${module.path} reaches the commerce path; a catalogue deadline must never be one join from a charge`,
      ).toBe(false);
    }
  });

  it('the mutation self-test: every detector IS able to fire', () => {
    expect(REDIRECT_COMPOSITION.test("res.redirect(302, destination);")).toBe(true);
    expect(REDIRECT_COMPOSITION.test("import { buildAffiliateUrl } from '../outbound/x.js';")).toBe(true);
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/x.js';")).toBe(true);
    expect(SIGNAL_DOMAIN_REFERENCE.test("import { x } from '../analytics/seams.js';")).toBe(false);
    expect(SIGNAL_DOMAIN_REFERENCE.test("import { x } from 'services/analytics/seams.js';")).toBe(true);
    expect(COMMERCE_REFERENCE.test("import { x } from '../../services/payments/y.js';")).toBe(true);
  });
});
