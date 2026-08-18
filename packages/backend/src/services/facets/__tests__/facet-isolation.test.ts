/**
 * The two walls around the facet domain (#367 Workstream 10).
 *
 * 1. **A commercial payment may never influence facet ordering or relevance.**
 *    No module on the facet path may reach a fee, a commission, a referral
 *    reward, a merchant plan, a sponsored placement, a retail margin or a
 *    payment rail — nor `services/ranking/`, which is where the ONE legitimate
 *    ordering authority lives and where a facet module reaching in would become
 *    a second one. `search-relevance-isolation.test.ts` is the precedent and
 *    this file mirrors it deliberately.
 *
 * 2. **No hard-coded per-category filter set, in EITHER package.** This is the
 *    thing the workstream exists to remove, and the place it comes back is a
 *    frontend constant — which is why the scan covers `packages/frontend`, which
 *    has no test runner of its own (#92's precedent, `seller-identity-isolation`).
 *
 * ## Scanner defences
 *
 * Every rule in `~/Oxy/AGENTS.md` §Gates applies and each is implemented rather
 * than mentioned:
 *
 * - a **vacuity floor PER SCANNED SET**, not one total — a total floor stays
 *   satisfied while one half of the walk finds nothing, which is exactly the
 *   failure a cross-package scan is prone to;
 * - a per-file size floor, so a moved or emptied module fails loudly;
 * - **comments stripped** before matching, because this domain documents what it
 *   refuses to do in the same vocabulary the detectors look for;
 * - a **mutation self-test per detector**, with a positive fixture and a shared
 *   negative, so a rotted regex cannot pass by matching nothing;
 * - a control on the comment stripper itself.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import {
  FACET_COMMERCE_DIMENSIONS,
  FACET_FORBIDDEN_EQUIVALENCES,
  FACET_FORBIDDEN_ORDERING_INPUTS,
  FACET_ORDERING_INPUTS,
  COMMERCE_FACETS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FRONTEND_ROOT = join(SRC_ROOT, '..', '..', 'frontend');

/** The backend half of the domain, walked whole. */
const BACKEND_DIRECTORIES = ['services/facets', 'db/facets'];

/** The flat directories every domain's HTTP surface shares. */
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware'] as const;

/** Frontend directories a filter rail would live in. */
const FRONTEND_DIRECTORIES = ['app', 'components', 'lib'];

/**
 * Vacuity floors PER WALKED SET, each today's count.
 *
 * Never one total, and never a number below what the walk finds. A single
 * backend floor of 10 was already met by `services/facets/` alone, so the
 * repository walk and the whole HTTP surface could each have collapsed to
 * nothing behind it; a single frontend floor of 40 was met almost five times
 * over by `lib` alone, so `app` and `components` — the two directories a
 * hard-coded filter rail would actually live in — were effectively unfloored.
 *
 * Set to the count on the day it was derived, so a module REMOVED goes red
 * rather than quietly narrowing every wall in this file (#460).
 */
const MINIMUM_FACET_SERVICES = 9;
const MINIMUM_FACET_REPOSITORIES = 2;
const MINIMUM_FACET_HTTP_MODULES = 3;
const MINIMUM_FRONTEND_FILES: Readonly<Record<string, number>> = {
  app: 37,
  components: 58,
  lib: 93,
};

/**
 * Reaching a commercial signal, from any direction.
 *
 * `fees/` and `referrals/` are unanchored so a RELATIVE import (`../fees/…`)
 * matches — the hole `search-relevance-isolation.test.ts` records finding in its
 * own first draft.
 */
const FORBIDDEN_COMMERCIAL_REFERENCES: readonly { signal: string; pattern: RegExp }[] = [
  {
    signal: 'marketplace_fee',
    pattern: /fees\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee/i,
  },
  {
    signal: 'affiliate_commission',
    pattern: /commission|affiliate_reports|affiliateReport|awin_transactions|awinTransaction/i,
  },
  { signal: 'referral_reward', pattern: /referrals\/|referral_|referralReward|referralAttribution/i },
  {
    signal: 'merchant_plan_tier',
    pattern: /proPlan|pro_plan|merchantPlan|subscriptionTier|billingPlan|merchant_plans/i,
  },
  { signal: 'sponsored_placement', pattern: /sponsor|promotedPlacement|paidPlacement|adSlot|boostScore/i },
  {
    // Its own detector rather than a share of `sponsored_placement`'s: the
    // census below demanded one, which is the census working. A paid SLOT and a
    // sponsored PLACEMENT are the same money and different code — a slot is a
    // reserved position in an ordering, which is what a facet rail has and an
    // ad unit does not.
    signal: 'paid_ranking_slot',
    pattern: /rankingSlot|ranking_slot|paidSlot|slotAuction|placementBid|pinnedFor(?:Fee|Payment)/i,
  },
  {
    signal: 'retail_margin',
    pattern: /retail-pricing\/|retail_cost|retailCost|absorption_cap|retailMargin/i,
  },
  { signal: 'payment_rail_preference', pattern: /faircoin|oxypay|oxy_pay|acceptsFair|stripe/i },
  {
    // #74 is the ONE ordering authority. A facet module importing it would make
    // this one a second, and a facet rail is where that would be least visible.
    signal: 'ranking_authority',
    pattern: /services\/ranking\/|rankOfferComparison|rankOffers|rankingPolicyVersion/i,
  },
];

/**
 * A hard-coded per-category filter set, in either package.
 *
 * Two shapes, because they fail differently: a MAP keyed on a category, and a
 * FUNCTION that takes a category and returns filters. Both are the thing ADR
 * 0007 D13 retires; neither is expressible as a metadata read.
 */
const FORBIDDEN_HARDCODED_FILTERS: readonly { signal: string; pattern: RegExp }[] = [
  {
    signal: 'category_keyed_filter_map',
    pattern:
      /\b(?:CATEGORY_FILTERS|FILTERS_BY_CATEGORY|CATEGORY_FACETS|FACETS_BY_CATEGORY|FILTERS_FOR_CATEGORY|categoryFilterMap)\b/,
  },
  {
    signal: 'category_keyed_filter_function',
    pattern: /\bfunction\s+(?:filters|facets)For(?:Category|Slug|Key)\b|\b(?:filters|facets)For(?:Category|Slug|Key)\s*[:=]\s*(?:\(|function)/,
  },
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(directory: string, extensions: readonly string[]): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      // The domain's own tests NAME the prohibitions in order to test for them.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...walk(full, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) files.push(full);
  }
  return files;
}

/**
 * Every facet-NAMED module in the shared flat directories. DERIVED, never
 * listed.
 *
 * This was three hand-written paths — the controller, the route and the request
 * schemas — which is exactly the population that was complete on the day it was
 * written. A fourth facet surface (an operator controller, an internal route,
 * a second schema module) lands outside both walls with nothing saying so, and
 * the wall it lands outside of is the one this workstream exists to hold (#460).
 *
 * The two owned directories above are walked whole; these three have no
 * directory of their own, so the population is the filename convention every
 * surface in this tree already follows.
 */
const FACET_NAME_PATTERN = /facet/i;

/**
 * `db/schema` joins the three shared directories. It contributes NOTHING today —
 * this domain owns no table — and is here so one added later is covered on the
 * day it lands rather than on the day somebody remembers this file.
 */
const SHARED_DIRECTORIES_WITH_SCHEMA = [...SHARED_DIRECTORIES, 'db/schema'] as const;

function facetNamedRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  // RECURSIVE and matching the PATH, where this was one level deep beside a
  // recursive walk (#460).
  return namedInSharedDirectories(SHARED_DIRECTORIES_WITH_SCHEMA, FACET_NAME_PATTERN, readDir);
}

function facetNamedHttpModules(): string[] {
  return facetNamedRelativePaths().map((relative) => join(SRC_ROOT, relative));
}

function backendPaths(): string[] {
  return [
    ...BACKEND_DIRECTORIES.flatMap((relative) => walk(join(SRC_ROOT, relative), ['.ts'])),
    ...facetNamedHttpModules(),
  ];
}

/**
 * The backend floor, PER SOURCE. Called by every backend scan, so no wall in
 * this file can run against a walk that found nothing.
 */
function assertBackendPopulationIsWhole(paths: readonly string[]): void {
  const from = (relative: string) =>
    paths.filter((path) => path.startsWith(join(SRC_ROOT, relative))).length;
  expect(from('services/facets'), 'the facet service walk found too few files').toBeGreaterThanOrEqual(
    MINIMUM_FACET_SERVICES,
  );
  expect(from('db/facets'), 'the facet repository walk found too few files').toBeGreaterThanOrEqual(
    MINIMUM_FACET_REPOSITORIES,
  );
  expect(
    facetNamedHttpModules().length,
    'no facet-named controller, route or schema module was derived',
  ).toBeGreaterThanOrEqual(MINIMUM_FACET_HTTP_MODULES);
  // And the walk really reads the disk, rather than a `readdirSync` that has
  // silently started returning a cached or empty result.
  for (const path of paths) expect(statSync(path).isFile(), `${path} is not a file`).toBe(true);
}

function frontendPaths(): string[] {
  return FRONTEND_DIRECTORIES.flatMap((relative) =>
    walk(join(FRONTEND_ROOT, relative), ['.ts', '.tsx']),
  );
}

/**
 * The storefront floor, PER DIRECTORY.
 *
 * `lib` alone is over ninety files, so one total lets `app` and `components`
 * return nothing and still pass — and those two are where a filter rail lives.
 */
function assertFrontendPopulationIsWhole(paths: readonly string[]): void {
  for (const [directory, minimum] of Object.entries(MINIMUM_FRONTEND_FILES)) {
    expect(
      paths.filter((path) => path.startsWith(join(FRONTEND_ROOT, directory))).length,
      `the storefront ${directory} walk found too few files`,
    ).toBeGreaterThanOrEqual(minimum);
  }
}

describe('the facet domain cannot be bought', () => {
  it('no module on the facet path reaches a commercial signal', () => {
    const paths = backendPaths();
    // The vacuity floor for the gate itself: a walk that found nothing produces
    // zero violations, which is what a healthy run also produces.
    assertBackendPopulationIsWhole(paths);

    const violations: string[] = [];
    for (const path of paths) {
      const raw = readFileSync(path, 'utf8');
      expect(raw.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
      const source = stripComments(raw);
      for (const reference of FORBIDDEN_COMMERCIAL_REFERENCES) {
        const match = reference.pattern.exec(source);
        if (match !== null) violations.push(`${path} reaches ${reference.signal}: ${match[0]}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every commercial detector actually detects — the mutation self-test', () => {
    const positives: Readonly<Record<string, string>> = {
      marketplace_fee: "import { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';",
      affiliate_commission: 'const rate = await readAffiliateReport(offer).commission;',
      referral_reward: 'const boost = referralReward(candidate);',
      merchant_plan_tier: "if (merchant.subscriptionTier === 'pro') position -= 1;",
      sponsored_placement: 'const bid = await readSponsoredBid(productId);',
      paid_ranking_slot: 'const slot = await claimRankingSlot(merchantId, facetKey);',
      retail_margin: "import { readRetailCostQuote } from '../retail-pricing/quote.js';",
      payment_rail_preference: 'if (merchant.acceptsFair) position -= 1;',
      ranking_authority: "import { rankOffers } from '../ranking/ranking.js';",
    };
    // ONE shared negative that every detector must reject: an ordinary read of
    // the offer table, which every count in this domain performs.
    const negative = "import { countOfferAvailabilityBuckets } from '../../db/facets/facetRepository.js';";

    for (const reference of FORBIDDEN_COMMERCIAL_REFERENCES) {
      const seeded = positives[reference.signal];
      expect(seeded, `no positive fixture for ${reference.signal}`).toBeDefined();
      expect(
        reference.pattern.test(seeded ?? ''),
        `the ${reference.signal} detector no longer fires on a real reference`,
      ).toBe(true);
      expect(
        reference.pattern.test(negative),
        `the ${reference.signal} detector fires on an ordinary offer read`,
      ).toBe(false);
    }
  });
});

describe('no hard-coded per-category filter set exists in either package', () => {
  it('the backend carries none', () => {
    const paths = backendPaths();
    assertBackendPopulationIsWhole(paths);
    const violations = scanFor(paths, FORBIDDEN_HARDCODED_FILTERS);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the storefront carries none', () => {
    const paths = frontendPaths();
    // A SEPARATE floor per DIRECTORY, not a share of one total. One total stays
    // satisfied by the backend's own files while this walk returns nothing —
    // and, within this walk, by `lib` while `app` and `components` return
    // nothing, which is where a filter rail would actually be.
    assertFrontendPopulationIsWhole(paths);
    const violations = scanFor(paths, FORBIDDEN_HARDCODED_FILTERS);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every hard-coded-filter detector actually detects — the mutation self-test', () => {
    const positives: Readonly<Record<string, string>> = {
      category_keyed_filter_map:
        "const CATEGORY_FILTERS = { electronics: ['brand', 'storage'], shoes: ['size'] };",
      category_keyed_filter_function:
        "export function filtersForCategory(slug: string) { return slug === 'shoes' ? ['size'] : []; }",
    };
    // The negatives are REAL lines from this repository, not invented ones: a
    // detector that fired on either would fail the build on code that is
    // correct, and `CATEGORY_LABELS` in particular is an ABUSE-REPORT category
    // rather than a taxonomy one — exactly the false positive a looser pattern
    // would produce.
    const negatives = [
      'const CATEGORY_LABELS: Readonly<Record<AbuseReportCategory, string>> = Object.freeze({',
      'const categories = list(params.categories);',
      'const definitions = await resolveDefinitionsForCategory(db, categoryId);',
      "const facets = plan.filter((entry) => entry.suppression === undefined);",
    ];

    for (const reference of FORBIDDEN_HARDCODED_FILTERS) {
      const seeded = positives[reference.signal];
      expect(seeded, `no positive fixture for ${reference.signal}`).toBeDefined();
      expect(
        reference.pattern.test(seeded ?? ''),
        `the ${reference.signal} detector no longer fires on a real hard-coded set`,
      ).toBe(true);
      for (const negative of negatives) {
        expect(
          reference.pattern.test(negative),
          `the ${reference.signal} detector fires on: ${negative}`,
        ).toBe(false);
      }
    }
  });

  it('the comment stripper does not hide code from the scan', () => {
    expect(stripComments('const x = CATEGORY_FILTERS;')).toContain('CATEGORY_FILTERS');
    expect(stripComments('// no CATEGORY_FILTERS here\nconst x = 1;')).not.toContain(
      'CATEGORY_FILTERS',
    );
    expect(stripComments('/** reads no commission */\nconst x = 1;')).not.toContain('commission');
    // The `(^|[^:])` guard: a URL inside a string must not eat the rest of the line.
    expect(stripComments("const u = 'https://x/y'; const v = commission;")).toContain('commission');
  });
});

describe('the vocabularies are disjoint and non-empty', () => {
  it('an ordering input can never be a forbidden one', () => {
    const permitted = new Set<string>(FACET_ORDERING_INPUTS);
    const overlap = FACET_FORBIDDEN_ORDERING_INPUTS.filter((input) =>
      permitted.has(input as string),
    );
    expect(overlap, `inputs in both tuples: ${overlap.join(', ')}`).toEqual([]);
    // Neither is empty, so the disjointness above is not vacuous.
    expect(FACET_ORDERING_INPUTS.length).toBeGreaterThanOrEqual(7);
    expect(FACET_FORBIDDEN_ORDERING_INPUTS.length).toBe(8);
  });

  it('every forbidden ordering input has a detector of its own', () => {
    // The two lists are separate on purpose — a prohibition is a VALUE and a
    // detector is a regex — so this census is what keeps them in step. Without
    // it a signal could be named in the vocabulary and scanned for by nothing,
    // which is a prohibition that reads as enforced and is not. It fired on its
    // first run: `paid_ranking_slot` was in the vocabulary and had no detector.
    //
    // The direction is one-way. The detector list is a strict SUPERSET, because
    // `ranking_authority` guards something the vocabulary does not describe —
    // reaching #74 at all is forbidden here whether or not anybody paid for it.
    const detected = new Set(FORBIDDEN_COMMERCIAL_REFERENCES.map((reference) => reference.signal));
    for (const input of FACET_FORBIDDEN_ORDERING_INPUTS) {
      expect(detected.has(input), `${input} is prohibited and scanned for by nothing`).toBe(true);
    }
    expect(FORBIDDEN_COMMERCIAL_REFERENCES.length).toBeGreaterThan(
      FACET_FORBIDDEN_ORDERING_INPUTS.length,
    );
  });

  it('the commerce dimensions are a SUBSET of #94s, never a second list', () => {
    const known = new Set<string>(COMMERCE_FACETS);
    for (const dimension of FACET_COMMERCE_DIMENSIONS) {
      expect(known.has(dimension), `${dimension} is not a #94 commerce facet`).toBe(true);
    }
    expect(FACET_COMMERCE_DIMENSIONS.length).toBeGreaterThanOrEqual(5);
    expect(FACET_COMMERCE_DIMENSIONS.length).toBeLessThan(COMMERCE_FACETS.length);
  });

  it('the forbidden equivalences are named and non-empty', () => {
    expect(FACET_FORBIDDEN_EQUIVALENCES.length).toBe(5);
    expect(FACET_FORBIDDEN_EQUIVALENCES).toContain('size_system_conversion');
    expect(FACET_FORBIDDEN_EQUIVALENCES).toContain('colour_family_collapse');
  });
});

describe('no size-system conversion exists anywhere in the domain', () => {
  /**
   * A size system IS an attribute definition, so two systems are two keys and no
   * bucket of one can reach a bucket of the other. That is structural — but the
   * way it would be broken is a helper, so the helper's shapes are scanned for.
   */
  const CONVERSION_PATTERNS: readonly { signal: string; pattern: RegExp }[] = [
    { signal: 'size_conversion_helper', pattern: /\b(?:convertSize|toSizeSystem|sizeSystemMap|SIZE_CONVERSIONS?|euToUk|ukToEu)\b/i },
    { signal: 'cross_attribute_bucket_merge', pattern: /\bmergeBuckets(?:Across|Between)\b|\bequivalentAttributeKeys\b/ },
  ];

  it('the domain contains no size conversion', () => {
    const paths = backendPaths();
    assertBackendPopulationIsWhole(paths);
    const violations = scanFor(paths, CONVERSION_PATTERNS);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the conversion detectors actually detect', () => {
    expect(CONVERSION_PATTERNS[0]?.pattern.test('const uk = convertSize(eu, "uk");')).toBe(true);
    expect(CONVERSION_PATTERNS[1]?.pattern.test('mergeBucketsAcross(colourKeys);')).toBe(true);
    expect(CONVERSION_PATTERNS[0]?.pattern.test('const size = bucket.key;')).toBe(false);
    expect(CONVERSION_PATTERNS[1]?.pattern.test('const merged = new Map(buckets);')).toBe(false);
  });
});

/** Scan a path set with a pattern set, returning every violation found. */
function scanFor(
  paths: readonly string[],
  patterns: readonly { signal: string; pattern: RegExp }[],
): string[] {
  const violations: string[] = [];
  for (const path of paths) {
    const source = stripComments(readFileSync(path, 'utf8'));
    for (const reference of patterns) {
      const match = reference.pattern.exec(source);
      if (match !== null) violations.push(`${path} carries ${reference.signal}: ${match[0]}`);
    }
  }
  return violations;
}

/**
 * ADR 0007 D12: `FACETS_ENABLED` gates the MOUNT and never anything durable.
 *
 * The wall is BLANKET here — no configuration at all — and it can be, because the
 * facet domain reads none today. That is the stronger form
 * `services/__tests__/product-type-isolation.test.ts` uses, and it is available
 * here where it was not available to `catalog-proposal-isolation.test.ts`, whose
 * services legitimately read six bounds off their own config object.
 *
 * Scoped to the two OWNED directories and deliberately NOT to the shared
 * controller, route and schema modules `facetNamedHttpModules()` derives: those
 * are where a page bound or a cache TTL legitimately belongs, and the mount flag
 * itself is read in `app.ts`. A wall that covered them would be refused by the
 * first legitimate bound and then widened, taking the prohibition with it.
 *
 * This domain owns no table and writes no row, so what the lever protects is not
 * a record — it is the promise that nothing downstream of the flag CACHES a
 * verdict taken while it was on, or refuses a read that another surface still
 * serves.
 */
const FACET_LEVER_PATTERN = /from\s+['"][^'"]*\/config(?:\/[^'"]*)?['"]|process\s*\.\s*env\b/u;

/** Only the directories the facet domain owns — see the docblock above. */
function facetOwnedPaths(): string[] {
  return BACKEND_DIRECTORIES.flatMap((relative) => walk(join(SRC_ROOT, relative), ['.ts']));
}

describe('the rollout lever gates the MOUNT, and the domain reaches no configuration', () => {
  it('no module under services/facets or db/facets imports config or reads process.env', () => {
    const paths = facetOwnedPaths();
    // The vacuity floor, restated locally rather than borrowed: this wall runs
    // over a NARROWER population than every other wall in this file, so
    // `assertBackendPopulationIsWhole` would not notice this walk returning
    // nothing.
    expect(paths.length, 'the facet-owned walk found too few files').toBeGreaterThanOrEqual(
      MINIMUM_FACET_SERVICES + MINIMUM_FACET_REPOSITORIES,
    );
    const offenders = paths.filter((path) =>
      FACET_LEVER_PATTERN.test(stripComments(readFileSync(path, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('MUTATION SELF-TEST: the detector fires on both spellings, and not on a comment', () => {
    expect(FACET_LEVER_PATTERN.test(stripComments("import { config } from '../../config/index.js';"))).toBe(
      true,
    );
    expect(
      FACET_LEVER_PATTERN.test(stripComments('const on = process.env.FACETS_ENABLED;')),
    ).toBe(true);
    expect(
      FACET_LEVER_PATTERN.test(stripComments("// import { config } from '../../config/index.js';\n")),
    ).toBe(false);
  });

  it('MUTATION SELF-TEST: the REAL scan goes red on a mutated member of the population', () => {
    // The detector firing on a string is not the same as the scan firing on a
    // file. This swaps a mutated source into the population the assertion above
    // walks and asserts EXACTLY that file is named.
    const paths = facetOwnedPaths();
    const victim = paths[paths.length - 1];
    expect(victim, 'the walk found no file to mutate').toBeDefined();
    if (victim === undefined) return;
    const mutated = `${readFileSync(victim, 'utf8')}\nconst leaked = process.env.FACETS_ENABLED;\n`;
    const offenders = paths.filter((path) =>
      FACET_LEVER_PATTERN.test(
        stripComments(path === victim ? mutated : readFileSync(path, 'utf8')),
      ),
    );
    expect(offenders).toEqual([victim]);
  });
});

/**
 * The population's own defence.
 *
 * The DIRECTORY list above is the last hand list in this gate's backend half.
 * Sweep the whole of `src/` for paths NAMING this domain and require each to be
 * in the population or in a counted exclusion.
 *
 * The FRONTEND half is out of scope for a sweep of `src/`; it has its own
 * derivation and its own floors above.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  /**
   * The two facet-NAMED modules that are not facet-domain modules, EXACT.
   *
   * Neither fires a wall in this file today — measured before excluding them,
   * which is what makes this an exclusion rather than a repair. That is exactly
   * why they must NOT join the population: admitting another domain's module
   * because it happens to be harmless now is how a gate starts failing for
   * whoever edits #94 or the observability sweep later.
   */
  const NOT_THIS_DOMAIN = [
    {
      path: 'services/attributes/facets.service.ts',
      why: "#94's attribute registry projecting its own facets; covered by hard-constraint-isolation",
    },
    {
      path: 'services/catalog-observability/facet-scope-sweep.ts',
      why: "the catalogue-observability sweep that MEASURES facet scope; it observes, it does not serve",
    },
  ] as const;

  it('every facet-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: (readDir) => [
        ...BACKEND_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
        ...facetNamedRelativePaths(readDir),
      ],
      pattern: FACET_NAME_PATTERN,
      notThisDomain: NOT_THIS_DOMAIN,
      // Below today's 16 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 12,
      plantIn: 'lib',
      plantName: 'facet-cache.ts',
    });
    // The exclusion's own count, so a third entry is a decision (#448).
    expect(NOT_THIS_DOMAIN.length, 'the exclusion set changed').toBe(2);
  });
});
