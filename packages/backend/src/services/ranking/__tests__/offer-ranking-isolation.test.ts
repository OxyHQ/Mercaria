/**
 * The walls around the ranking domain (#74 §"Prohibited ranking inputs"),
 * asserted STRUCTURALLY.
 *
 * Five properties, and each is a scan or a type rather than a fixture, because
 * "cannot" is a stronger statement than "did not in this case":
 *
 *  1. **No module in the domain can reach commercial standing.** Not the fee
 *     domain, not the referral domain, not retail pricing, not the ledger, not a
 *     plan or a subscription. A scorer that cannot READ what a merchant pays
 *     cannot rank by it, whatever any weight is set to.
 *  2. **The allowed and forbidden signal vocabularies are DISJOINT.** The
 *     `RetailCostComponentKind` device: a widening of the allowed set can never
 *     accidentally admit a prohibition, and the prohibition is a value a
 *     reviewer can read rather than an omission somebody quietly fills in.
 *  3. **No forbidden signal has a fact field or a policy COLUMN.** The absence
 *     is the enforcement — there is nothing for a query to fill and nothing for
 *     an operator to set.
 *  4. **The domain names no currency.** FAIR is Mercaria's display default and
 *     that is a product policy stated where the policy lives; a ranking module
 *     reaching for it would make the default a ranking fact.
 *  5. **The operator surface has no route that could sell a position.** No
 *     boost, no pin, no hide, no set-rank.
 *
 * Every scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor so a moved file fails the gate instead of silently shrinking it, and a
 * mutation self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import { getTableColumns } from 'drizzle-orm';
import {
  OFFER_FORBIDDEN_RANKING_SIGNALS,
  OFFER_RANKING_SIGNALS,
} from '@mercaria/shared-types';
import { rankingPolicyVersions } from '../../../db/schema/ranking.js';
import { buildFacts } from './offer-fixtures.js';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

/** What a module of this domain is called, wherever it lives. */
const RANKING_NAME_PATTERN = /ranking/i;

/**
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * `db/schema` joins the three that were copied from gate to gate, which lets
 * `db/schema/ranking.ts` be DERIVED below rather than named — a hand list of one
 * is still a hand list, and this one sat under a comment explaining why it had
 * to stay. It did not: the objection was to walking `db/schema/` WHOLE, which
 * would scan every table in the database from a gate about one domain, and
 * name-filtering the directory is not that.
 */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/** Every non-test module in the domain, read from the real directory. */
function domainSources(): { relative: string; source: string }[] {
  return walk('services/ranking').map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * The comparison SURFACE this domain serves under a different filename.
 *
 * `/offer-comparison` is #74's public read — `offer-comparison.controller.ts`
 * imports `services/ranking/comparison.service.js` and nothing from the offer
 * domain — but it is named after the endpoint rather than after the domain, so
 * no filename rule reaches it. EXACT, so a second differently-named surface is
 * a decision somebody takes rather than a file that quietly stays outside.
 *
 * The assertion below re-derives the claim from the imports instead of trusting
 * this sentence: each must still reach `services/ranking/`, directly or through
 * the controller beside it.
 */
const SURFACE_ALIASES = [
  { path: 'controllers/offer-comparison.controller.ts', reaches: 'services/ranking/' },
  { path: 'routes/offer-comparison.ts', reaches: 'controllers/offer-comparison.controller.js' },
] as const;

/**
 * The rest of the domain — the surfaces outside `services/ranking/`. WALKED and
 * FILTERED, never listed.
 *
 * This was seven hand-written paths under exactly that claim (#460). The two
 * owned directories are walked whole; the shared flat directories are derived
 * from the `ranking` filename convention plus the two comparison aliases above.
 * `db/schema/ranking.ts` stays named because a schema file is not part of any
 * domain directory and walking `db/schema/` whole would scan every table in the
 * database from a gate about one domain.
 */
function outerPaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...walkOwnedDirectory('db/ranking', readDir),
    // RECURSIVE and matching the PATH, where this was one level deep beside a
    // recursive `walk()` — so nothing under `routes/admin/` or
    // `controllers/admin/` could enter the population (#460). It also DERIVES
    // `db/schema/ranking.ts`, which was the one hand-written entry left.
    ...namedInSharedDirectories(SHARED_DIRECTORIES, RANKING_NAME_PATTERN, readDir),
    ...SURFACE_ALIASES.map((alias) => alias.path),
  ];
}

const OUTER_PATHS = outerPaths();

/**
 * The enumeration floor, per SHAPE.
 *
 * Each number is the count on the day it was written: these directories only
 * grow, and a SHRINK is the event that should stop the build rather than
 * quietly narrowing every wall in this file. Split by shape because the four
 * sources break independently, and one total would let a walk collapse to zero
 * while the others carried the number.
 */
function expectEveryShapeFoundSomething(): void {
  const from = (prefix: string) => OUTER_PATHS.filter((path) => path.startsWith(prefix)).length;
  expect(domainSources().length, 'the service walk found nothing').toBeGreaterThanOrEqual(10);
  expect(from('db/ranking/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(1);
  expect(from('routes/'), 'no ranking route was derived').toBeGreaterThanOrEqual(2);
  expect(from('controllers/'), 'no ranking controller was derived').toBeGreaterThanOrEqual(2);
  expect(from('middleware/'), 'no ranking request schema was derived').toBeGreaterThanOrEqual(1);
  expect(SURFACE_ALIASES.length, 'the surface-alias set changed').toBe(2);
  expect(OUTER_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
}

/**
 * Reaching anything that could price a position, from any direction.
 *
 * Matched on the bare `<domain>/` path segment as well as the `services/` form,
 * because an import from a sibling directory is written `../fees/…` and the
 * longer form alone would miss it — the mutation self-test below is what proves
 * both spellings are covered.
 */
const COMMERCIAL_REFERENCE =
  /\bfees\/|\breferrals\/|\bretail-pricing\/|\bledger|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|referralProgram|referral_programs|retailCostQuote|retail_cost_quotes|subscription|merchantPlan|commissionRate|affiliate_commission/;

/**
 * Naming a currency. FAIR is the one that matters — the display default a
 * ranking module must not reach for — and OxyPay is named for the same reason
 * the retail-pricing gate names it.
 */
const CURRENCY_NAME_REFERENCE = /\bFAIR\b|FairCoin|faircoin|OxyPay|oxy_pay|oxyPay/;

/** Comment-stripped source: these modules DOCUMENT what they refuse to do. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the ranking domain has real modules — the vacuity floor', () => {
  it('scans a domain that exists and is not empty', () => {
    const domain = domainSources();
    // A renamed directory or a moved module must fail here rather than make
    // every scan below pass against an empty list.
    expectEveryShapeFoundSomething();
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
    for (const relative of OUTER_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(statSync(join(SRC_ROOT, relative)).isFile(), `${relative} is not a file`).toBe(true);
    }
  });

  it('the comparison surface really is this domain’s, and still is', () => {
    // The two aliases are in scope because of what they IMPORT, not because of
    // what they are called — and the assertion is re-derived from the imports
    // so it fails if that stops being true, rather than resting on the sentence
    // above the list.
    for (const { path, reaches } of SURFACE_ALIASES) {
      const specifiers = [
        ...readFileSync(join(SRC_ROOT, path), 'utf8').matchAll(/from\s+'([^']+)'/g),
      ].map((match) => match[1]);
      expect(
        specifiers.some((specifier) => specifier.includes(reaches)),
        `${path} is scanned as a ranking surface but no longer imports ${reaches}`,
      ).toBe(true);
    }
  });
});

describe('WALL 1: ranking cannot read commercial standing', () => {
  it('no module in the domain references a fee, a referral, a plan or a margin', () => {
    let scanned = 0;
    for (const file of [
      ...domainSources(),
      ...OUTER_PATHS.map((relative) => ({
        relative,
        source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
      })),
    ]) {
      expect(
        COMMERCIAL_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches commercial standing; a position that can be priced is a ` +
          'position that will be sold',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(16);
  });

  it('the commercial detector actually detects — the mutation self-test', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { attribute } from '../referrals/attribution.service.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { quote } from '../retail-pricing/cost.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from order_fee_snapshots')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const commissionRate = 0.1;')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
    expect(COMMERCIAL_REFERENCE.test('const itemPrice = offer.price;')).toBe(false);
  });
});

describe('WALL 2: the two vocabularies are disjoint', () => {
  it('no forbidden signal is also an allowed one', () => {
    const allowed = new Set<string>(OFFER_RANKING_SIGNALS);
    const overlap = OFFER_FORBIDDEN_RANKING_SIGNALS.filter((signal) => allowed.has(signal));
    expect(overlap, 'a prohibition became a ranking input').toEqual([]);
    // Both floors: an empty tuple on either side would make the check vacuous.
    expect(OFFER_RANKING_SIGNALS.length).toBeGreaterThanOrEqual(10);
    expect(OFFER_FORBIDDEN_RANKING_SIGNALS.length).toBeGreaterThanOrEqual(7);
  });

  it('every prohibition the issue names is present as a VALUE', () => {
    // The issue's seven, by name. A prohibition dropped from the tuple would
    // make the disjointness check above pass while permitting the thing.
    assertEachOf([
      'affiliate_commission_rate',
      'commercial_agreement_margin',
      'fair_acceptance',
      'merchant_subscription_plan',
      'native_offer_preference',
      'brand_popularity',
      'sensitive_personal_attribute',
      'sponsored_placement',
    ], 8, (forbidden) => {
      expect(OFFER_FORBIDDEN_RANKING_SIGNALS).toContain(forbidden);
    });
  });
});

describe('WALL 3: a forbidden signal has nowhere to live', () => {
  it('the scorer input carries no field for one', () => {
    const fields = Object.keys(buildFacts());
    // The floor: a builder returning `{}` would pass every assertion below.
    expect(fields.length).toBeGreaterThanOrEqual(6);
    const suspicious = fields.filter((name) =>
      /commission|fee|plan|subscription|margin|profit|sponsor|boost|bid|popularity|fair/i.test(name),
    );
    expect(suspicious, 'a forbidden signal acquired a fact field').toEqual([]);
  });

  it('the policy row carries no COLUMN for one, and one weight per allowed signal', () => {
    const columns = Object.keys(getTableColumns(rankingPolicyVersions));
    expect(columns.length).toBeGreaterThanOrEqual(25);

    const weightColumns = columns.filter((name) => name.startsWith('weight'));
    // Exactly as many weights as there are allowed signals — no more, so a
    // forbidden one cannot be published, and no fewer, so a signal cannot be
    // silently unweighted.
    expect(weightColumns).toHaveLength(OFFER_RANKING_SIGNALS.length);

    const suspicious = columns.filter((name) =>
      /commission|fee|plan|subscription|margin|profit|sponsor|boost|bid|popularity/i.test(name),
    );
    expect(suspicious, 'a forbidden signal acquired a policy column').toEqual([]);
  });

  it('the column detector actually detects — the mutation self-test', () => {
    const detector = /commission|fee|plan|subscription|margin|profit|sponsor|boost|bid|popularity/i;
    expect(detector.test('weightAffiliateCommission')).toBe(true);
    expect(detector.test('sponsoredBoostBps')).toBe(true);
    expect(detector.test('merchantPlanTier')).toBe(true);
    expect(detector.test('weightItemPrice')).toBe(false);
    expect(detector.test('dominanceWindow')).toBe(false);
  });
});

describe('WALL 4: the domain names no currency', () => {
  it('no module in `services/ranking/` names FAIR, FairCoin or OxyPay', () => {
    // A comparison names ONE currency and the CALLER supplies it. The default
    // lives in `user-preference.service`, which is where the policy is stated.
    let scanned = 0;
    for (const file of domainSources()) {
      expect(
        CURRENCY_NAME_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} names a currency; the comparison currency is the caller's`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(9);
  });

  it('the currency detector actually detects — the mutation self-test', () => {
    expect(CURRENCY_NAME_REFERENCE.test("const fallback: CurrencyCode = 'FAIR';")).toBe(true);
    expect(CURRENCY_NAME_REFERENCE.test('import { oxyPayClient } from "./x.js";')).toBe(true);
    expect(CURRENCY_NAME_REFERENCE.test('const currency = request.comparisonCurrency;')).toBe(false);
  });
});

describe('WALL 5: the operator surface cannot sell a position', () => {
  const router = readFileSync(join(SRC_ROOT, 'routes/internal-ranking.ts'), 'utf8');

  it('registers exactly the routes it declares, and nothing that moves an offer', () => {
    const registered = [...router.matchAll(/router\.(get|post|delete|patch|put)\(\s*'([^']+)'/g)].map(
      (match) => `${match[1]} ${match[2]}`,
    );
    // The floor AND the enumeration: a route added without a reviewer noticing
    // fails here, and an empty match set fails here too.
    expect(registered.sort()).toEqual(
      [
        'delete /policies/:id/canary',
        'get /compare',
        'get /policies',
        'get /trace',
        'post /policies',
        'post /policies/:id/activate',
        'post /policies/:id/archive',
        'post /policies/:id/canary',
      ].sort(),
    );
  });

  it('has no boost, pin, hide or set-rank path anywhere in the domain', () => {
    const forbiddenPath = /['"][^'"]*(boost|pin|promote-offer|sponsor|hide|set-rank|rank-override)[^'"]*['"]/i;
    for (const file of [
      { relative: 'routes/internal-ranking.ts', source: router },
      {
        relative: 'controllers/ranking-operator.controller.ts',
        source: readFileSync(join(SRC_ROOT, 'controllers/ranking-operator.controller.ts'), 'utf8'),
      },
    ]) {
      expect(
        forbiddenPath.test(withoutComments(file.source)),
        `${file.relative} exposes a way to move one offer's position by hand`,
      ).toBe(false);
    }
  });

  it('the path detector actually detects — the mutation self-test', () => {
    const forbiddenPath = /['"][^'"]*(boost|pin|promote-offer|sponsor|hide|set-rank|rank-override)[^'"]*['"]/i;
    expect(forbiddenPath.test("router.post('/offers/:id/boost', handler);")).toBe(true);
    expect(forbiddenPath.test("router.post('/offers/:id/pin', handler);")).toBe(true);
    expect(forbiddenPath.test("router.post('/policies/:id/activate', handler);")).toBe(false);
  });
});

/**
 * The population's own defence.
 *
 * The DIRECTORY list above is the last hand list in this gate's derivation, and
 * hand lists fail silently. So: sweep the whole of `src/` for paths naming this
 * domain and require each to be in the population or in a counted exclusion. A
 * bag directory nobody has invented yet brings its modules under these walls
 * with no edit here.
 *
 * The population for the sweep is BOTH halves — `services/ranking/`, which the
 * detectors scan through `domainSources()`, and the outer paths — because a
 * module is covered if any wall in this file reaches it, and splitting the
 * comparison would report every module of the service directory as missing.
 *
 * `ranking` is an unambiguous token in this tree, so the exclusion set is EMPTY,
 * and it is empty because it was MEASURED rather than guessed: the sweep selects
 * 15 modules and every one is this domain's. `offer-comparison` — the surface
 * this domain serves under a different name — carries no `ranking` in its path,
 * which is why `SURFACE_ALIASES` above exists and is asserted from the imports.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every ranking-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: (readDir) => [
        ...walkOwnedDirectory('services/ranking', readDir),
        ...outerPaths(readDir),
      ],
      pattern: RANKING_NAME_PATTERN,
      notThisDomain: [],
      expectedExclusions: 0,
      // Below today's 15 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 11,
      plantIn: 'lib',
      plantName: 'ranking-cache.ts',
    });
  });
});
