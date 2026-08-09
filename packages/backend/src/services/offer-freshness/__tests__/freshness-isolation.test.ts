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
const SERVICE_DIR = join(SRC_ROOT, 'services', 'offer-freshness');
const REPOSITORY_DIR = join(SRC_ROOT, 'db', 'offerFreshness');

/**
 * Every module of the domain, ENUMERATED FROM THE DIRECTORY.
 *
 * A hand-written list is the version of this gate that silently stops covering
 * whatever somebody adds next — `ingestion-isolation.test.ts`'s reasoning, and
 * the reason the floors below are counted rather than assumed.
 */
function domainModules(): { path: string; source: string }[] {
  const modules: { path: string; source: string }[] = [];
  for (const dir of [SERVICE_DIR, REPOSITORY_DIR]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = join(dir, entry.name);
      const source = readFileSync(path, 'utf8');
      // The vacuity floor, per file: an empty or moved module must fail here,
      // not pass the scan by having nothing to match.
      expect(source.length, `${entry.name} looks empty — did it move?`).toBeGreaterThan(200);
      modules.push({ path: entry.name, source });
    }
  }
  return modules;
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
  /^\s*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*(?:TTL|FRESHNESS|EXPIRY|EXPIRES|STALE|LIFETIME)[A-Z0-9_]*(?:SECONDS|MS|MILLIS|MINUTES|HOURS|DAYS)\b/mu;

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
    const raw = readFileSync(join(SERVICE_DIR, 'policy.ts'), 'utf8');
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
    // The enumeration floor: the domain is fourteen modules today and a
    // traversal that found three would pass this gate vacuously.
    expect(modules.length).toBeGreaterThanOrEqual(12);

    const offenders = modules
      .filter((module) => DURATION_CONSTANT.test(module.source))
      .map((module) => module.path);
    expect(
      offenders,
      'a module-level duration is how a per-source TTL becomes a global one',
    ).toEqual([]);
  });

  it('the mutation self-test: a duration constant IS detected, and a FRACTION is not', () => {
    expect(DURATION_CONSTANT.test('const DEFAULT_FRESHNESS_SECONDS = 86_400;')).toBe(true);
    expect(DURATION_CONSTANT.test('export const OFFER_TTL_MS = 3_600_000;')).toBe(true);
    expect(DURATION_CONSTANT.test('const OFFER_STALE_AFTER_HOURS = 24;')).toBe(true);
    // A rate-limit window and a poll interval are NOT lifetimes: they are how
    // hard Mercaria knocks, which is Mercaria's own decision for every source.
    expect(DURATION_CONSTANT.test('const WINDOW_MS = 60_000;')).toBe(false);
    expect(DURATION_CONSTANT.test('const DEFAULT_LEASE_MS = 30_000;')).toBe(false);
    // The two shapes that are legitimate, because neither is itself a duration:
    // a fraction of a source's own number and a multiple of its own interval.
    expect(DURATION_CONSTANT.test('export const SOURCE_WARNING_FRACTION = 2 / 3;')).toBe(false);
    expect(DURATION_CONSTANT.test('export const SOURCE_OUTAGE_GRACE_INTERVALS = 2;')).toBe(false);
  });
});

describe('the domain decides, and does not do another issue’s job', () => {
  it('composes no tracked URL and performs no redirect (#37)', () => {
    const modules = domainModules();
    expect(modules.length).toBeGreaterThanOrEqual(12);
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
