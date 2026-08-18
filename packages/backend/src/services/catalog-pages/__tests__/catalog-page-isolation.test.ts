/**
 * The walls around the brand and family pages (#72 identity rules 1–5,
 * official-channel rule 5, acceptances 1 and 2).
 *
 * Four claims, each with its own mechanism, and every one of them is about a
 * failure that would look completely normal in production:
 *
 *  1. **An official channel comes from a verified relationship and from nothing
 *     else.** A page that inferred one from a matching name, a shared domain or
 *     a big catalogue would render a badge indistinguishable from a real one.
 *  2. **A page WRITES nothing to the catalogue.** #72 identity rule 1 says a
 *     brand page is not editable by a merchant who claims a storefront; the way
 *     to make that true is for the domain to have no write path at all, not for
 *     a permission check to be correct.
 *  3. **A page cannot rate a brand.** #76 makes a brand rating unrepresentable;
 *     this is the same prohibition seen from the surface that would render one.
 *  4. **A page cannot read a fee, a commission, a plan or a referral.** The
 *     `fee-ranking-isolation.test.ts` wall, applied to the two surfaces where a
 *     paid placement would be least visible — a brand's own product grid and
 *     its channel lists.
 *
 * Scanner defences follow the house shape: a vacuity floor on every scanned
 * file, a floor on the number of files scanned, and a mutation self-test on
 * every detector.
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
  sweepSrcTreeForDomain,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import {
  CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS,
  CATALOG_PAGE_OFFICIAL_EVIDENCE,
  CATALOG_PAGE_FORBIDDEN_FIELDS,
} from '@mercaria/shared-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..', '..');

/**
 * Every `.ts` under a directory, RECURSIVELY, excluding the test tree.
 *
 * The previous walk read `readdirSync(DOMAIN_DIR)` and took `.ts` names only, so
 * it stopped at the directory root. That is the shape #472 found hiding
 * `services/ingestion/adapters/` — five provider modules behind no wall at all.
 * This directory is flat today; the point is that a subdirectory added tomorrow
 * is covered without anybody remembering to come here.
 */
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

/** Every module in the domain, WALKED rather than listed (#460). */
function domainModules(): { relative: string; source: string }[] {
  return walk('services/catalog-pages').map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * The surfaces outside the service directory that serve these pages — DERIVED
 * from the filename convention plus the repository walk (#472's device), never
 * listed.
 *
 * The list this replaces named the same four and was complete on the day it was
 * written; a fifth catalog-page module in any of these roots was invisible to
 * every wall below.
 */
const CATALOG_PAGE_NAME_PATTERN = /catalog-?pages?/i;

/**
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * `db/schema` is listed and contributes NOTHING today — this domain owns no
 * table, it is a projection over the canonical graph. It is here so a table
 * added later is covered on the day it lands rather than on the day somebody
 * remembers this file, which is the same reason the walk above is recursive
 * over a directory that is flat.
 */
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

function surfaceRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // RECURSIVE and matching the PATH, where this was one level deep beside the
    // recursive walk above (#460). The pattern also allows an optional hyphen
    // and a plural, because `startsWith('catalog-page')` cannot match
    // `db/catalogPages/` — a widening that changes nothing looks exactly like a
    // fix, so it is measured: `/catalog-?pages?/i` over the whole of `src/`
    // selects 15 modules and every one is this domain's.
    ...namedInSharedDirectories(SHARED_DIRECTORIES, CATALOG_PAGE_NAME_PATTERN, readDir),
    ...walkOwnedDirectory('db/catalogPages', readDir),
  ];
}

function surfacePaths(): string[] {
  return surfaceRelativePaths();
}

/**
 * Reaching the DATA a resemblance would be inferred from.
 *
 * A regex cannot recognise "this comparison decides a badge", so the gate is on
 * the reads rather than on the expressions: name-similarity search, domain
 * matching and the brand's `observed_domains` are the three inputs every
 * plausible shortcut needs, and this domain has no legitimate use for any of
 * them.
 *
 * The issue's other two forbidden signals — catalogue VOLUME and a merchant
 * CLAIM — deliberately have no pattern here, and that is worth stating rather
 * than papering over: a product count is used legitimately three lines away
 * (thinness, `page-policy.ts`), so a count detector would fire on correct code
 * and get loosened by whoever hit it next. What makes those two unrepresentable
 * instead is structural — `BrandChannelEntry.evidence` has ONE member and both
 * lists come from #55's resolver, which reads neither — and
 * `CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS` names them as values so the
 * prohibition is still greppable.
 */
const RESEMBLANCE_INFERENCE =
  /normalizedName\s*===|observedDomains|merchantDomains|findMerchantsByObservedDomain|findMerchantDomainsByDomain|searchBrandCandidates|searchBrandsByNameSimilarity|searchMerchantsByNameSimilarity|similarity\(/;

/** Writing to the canonical graph, a relationship, a listing or an offer. */
const CANONICAL_WRITE_REFERENCE =
  /catalog-write\.service|canonical\/(brand|canonical-product|canonical-variant|product-family|organization)\.service|relationship\.service|updateBrand|insertBrand|updateProductFamily|insertProductFamily|updateCanonicalProduct|insertRelationship|recordExternalOffer|requestNativeOfferSync/;

/** Reaching anything that could price a placement. */
const COMMERCIAL_REFERENCE =
  /\bfees\/|\bpayments\/|\breferrals\/|\bretail-pricing\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|ledgerRepository|referral_programs|commission/;

/** A rating that would be ABOUT a brand or a family rather than a product. */
const ENTITY_RATING_REFERENCE =
  /brandRating|brand_rating|familyRating|family_rating|rateBrand|brands\.rating|canonicalProductFamilies\.rating/;

/** A merchant's own commerce surface — what #73 owns and this domain must not. */
const STOREFRONT_REFERENCE =
  /listingRepository|inventory\.service|cart\.service|checkout\.service|draft-order|storefront\.service/;

describe('the scanned population is derived and whole', () => {
  it('walks a real domain, a real repository and a real HTTP surface', () => {
    // Vacuity floors PER SHAPE rather than one on the total. The three sources
    // break independently, and a single total would let the domain walk collapse
    // to zero while the others carried the number — which is the failure this
    // conversion exists to end. Each is today's count, compared with `>=`, so a
    // SHRINK stops the build; a floor carried over from the hand list would have
    // been inert on arrival, because the conversion is precisely what widens the
    // population.
    const domain = domainModules().map((module) => module.relative);
    const surfaces = surfacePaths();
    expect(domain.length, 'the domain walk found nothing').toBeGreaterThanOrEqual(11);
    expect(
      surfaces.filter((path) => !path.startsWith('db/')).length,
      'the HTTP surface derivation found nothing',
    ).toBeGreaterThanOrEqual(3);
    expect(
      surfaces.filter((path) => path.startsWith('db/catalogPages/')).length,
      'the repository walk found nothing',
    ).toBeGreaterThanOrEqual(1);

    // The walk really reads the disk rather than returning a cached or empty
    // result, and no test file enters the scanned set — a gate that scans its
    // own probes reports violations it wrote itself.
    for (const relative of [...domain, ...surfaces]) {
      expect(statSync(join(SRC_ROOT, relative)).isFile(), `${relative} is not a file`).toBe(true);
    }
    expect([...domain, ...surfaces].filter((path) => path.includes('__tests__'))).toEqual([]);
  });
});

describe('#72 the official-channel vocabularies are disjoint', () => {
  it('names no signal that is both evidence and a forbidden resemblance', () => {
    const evidence = new Set<string>(CATALOG_PAGE_OFFICIAL_EVIDENCE);
    // Vacuity floors: an emptied tuple would make the intersection trivially
    // empty and this assertion would pass while proving nothing.
    expect(evidence.size).toBeGreaterThan(0);
    expect(CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS.length).toBeGreaterThanOrEqual(10);
    const overlap = CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS.filter((signal) =>
      evidence.has(signal as string),
    );
    expect(overlap, 'a forbidden signal must never also be evidence').toEqual([]);
  });

  it('publishes exactly one way for a badge to exist', () => {
    // #72 official-channel rule 5 and #55's own design: the only thing that
    // produces a badge is a verified relationship inside its window. A second
    // member here would be a second route to a badge, which is the whole thing
    // both issues exist to prevent.
    expect([...CATALOG_PAGE_OFFICIAL_EVIDENCE]).toEqual(['verified_relationship']);
  });
});

describe('#72 a catalogue page infers nothing and writes nothing', () => {
  it('scans a real, non-trivial set of modules', () => {
    const modules = domainModules();
    // A floor on the SCAN itself: a renamed directory would otherwise walk an
    // empty list and every assertion below would pass vacuously.
    expect(modules.length, 'the catalog-pages domain looks empty — did it move?').toBeGreaterThan(8);
    for (const module of modules) {
      expect(module.source.length, `${module.relative} looks empty`).toBeGreaterThan(200);
    }
  });

  it('never infers an official relationship from a resemblance', () => {
    let scanned = 0;
    for (const module of [...domainModules(), ...surfaceModules()]) {
      expect(
        RESEMBLANCE_INFERENCE.test(module.source),
        `${module.relative} compares a name, a domain or a volume; ` +
          'an official channel comes from a verified relationship and nothing else',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThan(12);
  });

  it('never writes to the canonical graph', () => {
    for (const module of [...domainModules(), ...surfaceModules()]) {
      expect(
        CANONICAL_WRITE_REFERENCE.test(module.source),
        `${module.relative} reaches a canonical write path; a page composes and owns nothing`,
      ).toBe(false);
    }
  });

  it('never reads a fee, a commission, a plan or a referral', () => {
    for (const module of [...domainModules(), ...surfaceModules()]) {
      expect(
        COMMERCIAL_REFERENCE.test(module.source),
        `${module.relative} reaches a commercial domain; a brand page must not be purchasable`,
      ).toBe(false);
    }
  });

  it('never rates a brand or a family', () => {
    for (const module of [...domainModules(), ...surfaceModules()]) {
      expect(
        ENTITY_RATING_REFERENCE.test(module.source),
        `${module.relative} reaches a brand- or family-level rating; #76 makes one unrepresentable`,
      ).toBe(false);
    }
  });

  it('never becomes a merchant storefront', () => {
    for (const module of [...domainModules(), ...surfaceModules()]) {
      expect(
        STOREFRONT_REFERENCE.test(module.source),
        `${module.relative} reaches a merchant's own commerce surface; #73 owns those pages`,
      ).toBe(false);
    }
  });

  it('names the forbidden DTO fields as values a runtime walk can look for', () => {
    // The static half. The RUNTIME half — a walk of a real emitted page — is in
    // `catalog-pages.realdb.test.ts`, because a field can only be proven absent
    // from a response by looking at one.
    expect(CATALOG_PAGE_FORBIDDEN_FIELDS.length).toBeGreaterThanOrEqual(5);
    expect([...CATALOG_PAGE_FORBIDDEN_FIELDS]).toContain('brandRating');
    expect([...CATALOG_PAGE_FORBIDDEN_FIELDS]).toContain('sponsoredPlacement');
  });
});

describe('#72 every detector actually detects — the mutation self-tests', () => {
  it('catches a resemblance inference', () => {
    expect(RESEMBLANCE_INFERENCE.test('if (brand.normalizedName === merchant.normalizedName) {')).toBe(
      true,
    );
    expect(RESEMBLANCE_INFERENCE.test('if (brand.observedDomains.includes(host)) badge = true;')).toBe(
      true,
    );
    expect(
      RESEMBLANCE_INFERENCE.test(
        "import { findMerchantDomainsByDomain } from '../../db/commerce-graph/merchantRepository.js';",
      ),
    ).toBe(true);
    expect(RESEMBLANCE_INFERENCE.test('const channels = await listBrandChannels({ brandId });')).toBe(
      false,
    );
    // The negative that matters most: a product count is legitimate here and
    // must NOT fire, or the gate gets loosened by whoever hits it next.
    expect(
      RESEMBLANCE_INFERENCE.test('if (input.productCount < BRAND_INDEXABLE_MIN_PRODUCTS) return "thin";'),
    ).toBe(false);
  });

  it('catches a canonical write', () => {
    expect(
      CANONICAL_WRITE_REFERENCE.test(
        "import { updateBrand } from '../canonical/brand.service.js';",
      ),
    ).toBe(true);
    expect(
      CANONICAL_WRITE_REFERENCE.test(
        "import { syncListingFacets } from '../catalog-write.service.js';",
      ),
    ).toBe(true);
    expect(
      CANONICAL_WRITE_REFERENCE.test("import { findBrandById } from '../../db/canonical/brandRepository.js';"),
    ).toBe(false);
  });

  it('catches a commercial reference', () => {
    expect(COMMERCIAL_REFERENCE.test("import { planFee } from '../fees/order-fees.service.js';")).toBe(
      true,
    );
    expect(COMMERCIAL_REFERENCE.test('const rate = offer.commissionRate;')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

  it('catches an entity rating', () => {
    expect(ENTITY_RATING_REFERENCE.test('const stars = page.brandRating;')).toBe(true);
    expect(ENTITY_RATING_REFERENCE.test('select rating from brands')).toBe(false);
    expect(ENTITY_RATING_REFERENCE.test('rating: { value: row.rating, count: row.ratingCount }')).toBe(
      false,
    );
  });

  it('catches a storefront reference', () => {
    expect(STOREFRONT_REFERENCE.test("import { addToCart } from '../cart.service.js';")).toBe(true);
    expect(
      STOREFRONT_REFERENCE.test("import { listOffersForComparison } from '../../db/offers/offerRepository.js';"),
    ).toBe(false);
  });
});

/** The controller, router, schemas and repository, with the same floors. */
function surfaceModules(): { relative: string; source: string }[] {
  return surfacePaths().map((relative) => {
    const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
    expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
    return { relative, source };
  });
}

/**
 * The population's own defence.
 *
 * The DIRECTORY list above is the last hand list in this gate. Sweep the whole
 * of `src/` for paths NAMING this domain and require each to be in the
 * population or in a counted exclusion, so a bag directory nobody has invented
 * yet brings its modules under these walls with no edit here.
 *
 * The exclusion set is EMPTY because it was MEASURED — the sweep selects 15
 * modules and every one is this domain's.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every catalog-page-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: (readDir) => [
        ...walkOwnedDirectory('services/catalog-pages', readDir),
        ...surfaceRelativePaths(readDir),
      ],
      pattern: CATALOG_PAGE_NAME_PATTERN,
      notThisDomain: [],
      // Below today's 15 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 11,
      plantIn: 'lib',
      plantName: 'catalog-pages-cache.ts',
    });
  });

  /**
   * What the optional hyphen and plural actually buy — asserted, because the
   * first version of this conversion CLAIMED the widening reached
   * `db/catalogPages/` and that claim was false in the way that matters.
   *
   * `db/catalogPages/` is WALKED as an owned directory, so the pattern has
   * nothing to do with whether its modules are in the POPULATION. What the
   * pattern decides is what the SWEEP examines — and narrowing it back to
   * `/catalog-page/i` drops `db/catalogPages/catalogPageRepository.ts` from the
   * sweep silently: every module the sweep still finds is in the population, so
   * the wall stays empty, and the sweep floor of 11 is met by the remaining 14.
   *
   * So the widening needed its own assertion rather than a floor. Measured: 15
   * with the hyphen optional, 14 without, and the one that disappears is the
   * camelCase repository.
   */
  it('the sweep reaches the camelCase repository the pattern was widened for', () => {
    const swept = sweepSrcTreeForDomain(CATALOG_PAGE_NAME_PATTERN);
    expect(
      swept,
      'the name pattern no longer reaches db/catalogPages/ — the sweep is examining less than ' +
        'the domain while every floor and the wall stay green',
    ).toContain('db/catalogPages/catalogPageRepository.ts');
    // …and the narrow spelling really would miss it, so this measures the
    // widening rather than the tree happening to be convenient.
    expect(/catalog-page/i.test('db/catalogPages/catalogPageRepository.ts')).toBe(false);
  });
});
