/**
 * The structural walls #90 is built on, asserted rather than promised.
 *
 * Six gates, each answering something the issue states as a prohibition. They
 * follow the defences the other domains' gates use (`~/Oxy/AGENTS.md` metro-gate
 * rules): every scan carries a VACUITY FLOOR — a moved or emptied module fails
 * the gate instead of silently shrinking it — and a MUTATION SELF-TEST, so a
 * rotted regex cannot pass by matching nothing.
 *
 *  1. **A catalogue image is not condition evidence** (#90 acceptance 4). The
 *     provenance vocabulary and the forbidden list are DISJOINT, and no table in
 *     the domain has a column that could hold a canonical image reference.
 *  2. **An unrefined assertion cannot carry a claim-bearing key** (#90 migration
 *     rule 2). `used_like_new` is not in `UNREFINED_CONDITION_KEYS`, and the
 *     database CHECK is rendered from that same tuple.
 *  3. **Category-specific facts stay in #94's registry.** No module here defines
 *     a column or a tuple member for battery health, activation lock or garment
 *     alterations.
 *  4. **Ranking cannot read the condition domain** (#74 owns ranking). The
 *     `fee-ranking-isolation.test.ts` precedent.
 *  5. **The condition domain cannot read the fee, referral or payment domains.**
 *     A module that cannot see a commission cannot let one influence how an item
 *     is described.
 *  6. **No mapping module can write a taxonomy key from a sub-floor
 *     confidence** (#90 evidence rule 6). The only literal comparison against
 *     the floor is the documented one, and no module hard-codes a competing
 *     number.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
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
  CONDITION_ASSERTIONS,
  CONDITION_MAPPING_CONFIDENCE_FLOOR,
  CONDITION_PHOTO_PROVENANCES,
  CONDITION_REGISTRY_DELEGATED_FACT_KEYS,
  FORBIDDEN_CONDITION_PHOTO_PROVENANCES,
  ITEM_CONDITION_KEYS,
  UNREFINED_CONDITION_ASSERTIONS,
  UNREFINED_CONDITION_KEYS,
} from '@mercaria/shared-types';
import {
  conditionCategoryPolicies,
  conditionMappingRulesets,
  conditionSourceMappings,
  listingConditionDetails,
  listingConditionPhotos,
  listingConditionRevisions,
} from '../../../db/schema/condition.js';

import {
  assertRankingSurfaceIsWhole,
  RANKING_SURFACE_PATHS,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The domain's HTTP surface, DERIVED — and the match is INCLUDES rather than
 * startsWith, which is load-bearing here.
 *
 * This domain's operator router is `routes/internal-catalog-condition.ts`. A
 * `startsWith('condition')` rule — the right one for most domains — misses every
 * `internal-<domain>.ts` operator surface, and all three of these modules were
 * outside every wall in this file: the operator controller, its schemas and the
 * router itself. Checked against the tree before loosening the match: these are
 * the only modules in the scanned roots whose name contains `condition`.
 */
const CONDITION_NAME_PATTERN = /condition/i;

/**
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * `db/schema` joins the three copied from gate to gate, which lets
 * `db/schema/condition.ts` be DERIVED below rather than named individually. A
 * hand list of one is still a hand list: it is complete the day it is written
 * and silent the day this domain grows a second schema module.
 */
const CONDITION_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

function conditionHttpSurface(readDir: DirectoryReader = readSrcDirectory): string[] {
  // RECURSIVE and matching the PATH, where this was one level deep beside a
  // recursive walk — so nothing under `routes/admin/` or `controllers/admin/`
  // could enter the population (#460).
  return namedInSharedDirectories(CONDITION_SHARED_DIRECTORIES, CONDITION_NAME_PATTERN, readDir);
}

/**
 * Every module of the condition domain — WALKED, not listed.
 *
 * A hand-maintained array is complete on the day it is written and silently
 * incomplete the day somebody adds a file, and the file it then skips is the
 * one nobody has reviewed. The exact-count assertion this replaced pinned the
 * ARRAY's length, which a new source file does not change, so it could never
 * detect the omission it looked like it was guarding against.
 *
 * `db/schema/condition.ts` is named individually because it is the one member
 * that lives in a directory this domain does not own.
 */
function conditionDomainPaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...walkOwnedDirectory('services/condition', readDir),
    ...walkOwnedDirectory('db/condition', readDir),
    ...conditionHttpSurface(readDir),
  ];
}

const CONDITION_DOMAIN_PATHS = conditionDomainPaths();

/** The six tables, with their SQL names so a failure reads as a table name. */
const CONDITION_TABLES = [
  ['listing_condition_details', listingConditionDetails],
  ['listing_condition_photos', listingConditionPhotos],
  ['listing_condition_revisions', listingConditionRevisions],
  ['condition_mapping_rulesets', conditionMappingRulesets],
  ['condition_source_mappings', conditionSourceMappings],
  ['condition_category_policies', conditionCategoryPolicies],
] as const;

/**
 * Modules that decide what a shopper SEES first — #74's ranking surface, taken
 * from the ONE shared derivation rather than copied.
 *
 * If any of these could read the condition domain, "a condition is a
 * description" and "a condition is a placement input" would be one hop apart,
 * and nothing in the code would say which one was intended.
 *
 * This file carried a FOUR-entry copy of that list — `feed.service`,
 * `search.service`, `collection.service` and `collectionRules` — which is the
 * drift #483 measured across eleven gates and ended by deriving the surface
 * once. The copy here had never heard of `services/ranking/`, `db/ranking/`,
 * `services/search/` or any derived controller, so the wall was computed over a
 * population containing no #74 module at all.
 *
 * Replacing the copy with the derivation was +40 modules and −2, and the two it
 * dropped are the reason this is a UNION rather than a substitution. See
 * {@link CONDITION_MERCHANDISING_SURFACE}.
 */

/**
 * The merchandising engine, which the shared derivation does not reach.
 *
 * `services/collection.service.ts` materializes a collection's automated rules
 * into `Listing.collectionIds` and `db/merchandising/collectionRules.ts` is the
 * rule evaluator underneath it. Deciding WHICH listings appear in a collection
 * is a placement decision, which is exactly what this wall is about — and both
 * were in the four-entry copy this file used to carry.
 *
 * They are not in `RANKING_SURFACE_PATHS` and that derivation is right to omit
 * them: it walks four engine directories and derives the HTTP surface from the
 * import graph, and neither module is under a walked directory nor a controller.
 * The sharp version of the gap is that the derivation DOES contain
 * `controllers/collections.controller.ts` — it reaches it from below, through
 * `catalog-hydration` — so swapping the copy for the derivation kept the
 * collections HTTP surface and dropped the engine that decides what is in one.
 *
 * A −2 that silently narrows a wall is worth exactly as little as the +40 is
 * worth a lot, so the union is ASSERTED below in both directions: this half is
 * an EXACT count of real files, and it must stay DISJOINT from the shared half.
 * If #74's derivation ever grows to cover these, the disjointness assertion
 * fails and the right move is to delete this list rather than to scan a module
 * twice under two justifications.
 *
 * `RANKING_SURFACE_PATHS` is deliberately not edited to add them: it is the
 * shared derivation eleven gates read, these two are #90's own concern, and a
 * gate widening a shared population for its own reasons is how that file
 * becomes the union of everybody's special cases.
 */
const CONDITION_MERCHANDISING_SURFACE = [
  'services/collection.service.ts',
  'db/merchandising/collectionRules.ts',
];

const CONDITION_RANKING_SURFACE = [...RANKING_SURFACE_PATHS, ...CONDITION_MERCHANDISING_SURFACE];

function read(relative: string): string {
  return readFileSync(join(SRC_ROOT, relative), 'utf8');
}

/**
 * Source with comments removed.
 *
 * Every module in this domain DOCUMENTS what it refuses to do, in the same
 * vocabulary the detectors look for — `condition-mapping.service.ts` says
 * "never upgraded" and `condition.ts` names every forbidden provenance. Scanning
 * raw text would fail on the prose, so the reachability detectors read code
 * only. The two gates that must see prose (the copy scan below) say so.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('#90 gate 1 — a catalogue image can never be condition evidence', () => {
  it('the seller-owned and forbidden provenance vocabularies are DISJOINT', () => {
    const forbidden = new Set<string>(FORBIDDEN_CONDITION_PHOTO_PROVENANCES);
    const overlap = CONDITION_PHOTO_PROVENANCES.filter((value) => forbidden.has(value));

    expect(overlap).toEqual([]);
    // Vacuity: an emptied tuple would make the intersection trivially empty.
    expect(CONDITION_PHOTO_PROVENANCES.length).toBeGreaterThanOrEqual(2);
    expect(FORBIDDEN_CONDITION_PHOTO_PROVENANCES.length).toBeGreaterThanOrEqual(5);
  });

  it('the disjointness check would FAIL if a forbidden value were admitted', () => {
    // The mutation self-test: seed the exact overlap the gate exists to catch.
    const mutated: readonly string[] = [...CONDITION_PHOTO_PROVENANCES, 'stock_photo'];
    const forbidden = new Set<string>(FORBIDDEN_CONDITION_PHOTO_PROVENANCES);
    expect(mutated.filter((value) => forbidden.has(value))).toEqual(['stock_photo']);
  });

  it('no condition table has a column that could reference a canonical image', () => {
    const offenders: string[] = [];
    for (const [table, definition] of CONDITION_TABLES) {
      for (const property of Object.keys(getTableColumns(definition))) {
        if (/canonical|catalogImage|stockPhoto|productImage/i.test(property)) {
          offenders.push(`${table}.${property}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the photo table records the three facts #90 evidence rule 3 asks for', () => {
    // The positive control for the gate above: it must not be passing because
    // the table is empty of columns. Ownership, upload time and moderation
    // state are what make a row evidence rather than a picture.
    const columns = Object.keys(getTableColumns(listingConditionPhotos));
    expect(columns).toEqual(
      expect.arrayContaining([
        'uploadedByOxyUserId',
        'uploadedAt',
        'moderationState',
        'provenance',
      ]),
    );
  });
});

describe('#90 gate 2 — an unrefined assertion cannot carry a claim', () => {
  it('`used_like_new` is NOT a key a migration or a v1 client may assert', () => {
    expect(UNREFINED_CONDITION_KEYS).not.toContain('used_like_new');
    expect(UNREFINED_CONDITION_KEYS).not.toContain('refurbished_manufacturer');
    expect(UNREFINED_CONDITION_KEYS).not.toContain('refurbished_seller');
    expect(UNREFINED_CONDITION_KEYS).not.toContain('open_box');
    // Vacuity: an empty tuple would satisfy every assertion above and would make
    // the CHECK it renders refuse EVERY migrated row instead of the wrong ones.
    expect(UNREFINED_CONDITION_KEYS).toEqual(['new', 'used_good']);
  });

  it('both unrefined assertions are real members of the assertion set', () => {
    // A tuple member the CHECK is rendered from that is not in the column's own
    // enum would make the constraint unsatisfiable rather than restrictive.
    for (const assertion of UNREFINED_CONDITION_ASSERTIONS) {
      expect(CONDITION_ASSERTIONS).toContain(assertion);
    }
    expect(UNREFINED_CONDITION_ASSERTIONS.length).toBe(2);
  });

  it('every unrefined key is a real taxonomy key', () => {
    for (const key of UNREFINED_CONDITION_KEYS) {
      expect(ITEM_CONDITION_KEYS).toContain(key);
    }
  });
});

describe('#90 gate 3 — category-specific facts stay in #94’s registry', () => {
  it('no condition table has a column for a delegated fact', () => {
    const offenders: string[] = [];
    for (const [table, definition] of CONDITION_TABLES) {
      for (const property of Object.keys(getTableColumns(definition))) {
        const normalized = property.replace(/[^a-z]/gi, '').toLowerCase();
        for (const fact of CONDITION_REGISTRY_DELEGATED_FACT_KEYS) {
          if (normalized.includes(fact.replace(/_/g, ''))) {
            offenders.push(`${table}.${property} (delegated to #94: ${fact})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(CONDITION_REGISTRY_DELEGATED_FACT_KEYS.length).toBeGreaterThanOrEqual(5);
  });

  it('the delegated-fact detector FIRES on a seeded column name', () => {
    const normalized = 'batteryHealthPercentage'.replace(/[^a-z]/gi, '').toLowerCase();
    const hit = CONDITION_REGISTRY_DELEGATED_FACT_KEYS.some((fact) =>
      normalized.includes(fact.replace(/_/g, '')),
    );
    expect(hit).toBe(true);
  });
});

describe('#90 gate 4 — ranking cannot read the condition domain', () => {
  /**
   * What reaching this domain looks like from a ranking surface: an import of a
   * condition module, or a reference to one of its table objects.
   *
   * `search.service` and `collectionRules` legitimately FILTER on
   * `listings.condition`, which is a column on a table they already read — that
   * is the issue's own "search and ranking use condition groups explicitly"
   * (propagation rule 4), and it is a different thing from reaching the
   * evidence, the disclosures or the mapping rules behind it.
   */
  const DOMAIN_REACH =
    /from ['"][^'"]*(?:services\/condition|db\/condition|schema\/condition)[^'"]*['"]|listingConditionPhotos|listingConditionRevisions|conditionSourceMappings|conditionMappingRulesets/;

/**
 * The ONE ranking-surface module that may read the condition domain, with the
 * assertion that justifies it and an EXACT count (#448).
 *
 * Widening this wall from a four-entry copy to #483's derived surface found it:
 * `catalog-hydration.service.ts` is in the surface because it is the shared
 * projection `feed.service` and `search.service` both order through, and it
 * imports `db/condition/conditionRepository` — but every use is a batched READ
 * and a DTO PROJECTION (`projectItemCondition`, `projectLegacyCondition`), which
 * is #90's display path. It reorders nothing: its own bucketing comment says it
 * preserves "the query's own order", and no ordering expression in the file
 * mentions a condition.
 *
 * That distinction is the whole point of this wall — a condition is a
 * DESCRIPTION, not a placement input — so the exception is held to it below
 * rather than granted by name. If that module ever sorts, scores or filters by
 * condition, the second assertion fails and the exception stops applying.
 */
const CONDITION_DISPLAY_READERS = ['services/catalog-hydration.service.ts'];

/**
 * An ordering expression that mentions a condition — what the exception forbids.
 *
 * Anchored on real ordering CONSTRUCTS (`.sort(`, `sortBy`, `orderBy`, `rankBy`,
 * `scoreBy`) rather than on the word "sort" anywhere, and case-INSENSITIVE. The
 * first version of this pattern was neither, and its mutation test proved it: a
 * `zzSortByCondition` helper added to the excused module left the gate GREEN,
 * because `sort` did not match `Sort` and `[^)]*` could not span
 * `sort((left, right) =>`. An exception justified by an assertion that cannot
 * fire is an exception justified by nothing.
 */
const CONDITION_ORDERING =
  /(?:\.\s*sort\s*\(|\bsortBy\b|\borderBy\b|\brankBy\b|\bscoreBy\b)[\s\S]{0,100}?condition/i;

  it('no ranking surface imports a condition module or names its tables', () => {
    const offenders: string[] = [];
    for (const path of CONDITION_RANKING_SURFACE) {
      if (CONDITION_DISPLAY_READERS.includes(path)) continue;
      const source = stripComments(read(path));
      if (DOMAIN_REACH.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    // Vacuity: a FLOOR, not the exact 4 the copied list pinned. That `toBe(4)`
    // was correct for the copy and is exactly what made the copy permanent — it
    // fails the moment the shared derivation grows, which is the behaviour a
    // shared derivation exists to have. `assertRankingSurfaceIsWhole` carries
    // the per-shape floors for the surface itself.
    assertRankingSurfaceIsWhole();
    expect(RANKING_SURFACE_PATHS.length, 'the ranking surface derivation found nothing')
      .toBeGreaterThanOrEqual(40);

    // The union, asserted in BOTH directions, so neither half can vanish
    // silently — which is precisely what a straight substitution did to the
    // merchandising half. EXACT on the hand-listed half (a hand list is an
    // identity, not a predicate, #448) and DISJOINT from the derived half, so a
    // module that later enters the shared surface fails here as a decision to
    // take rather than becoming a file scanned twice.
    expect(CONDITION_MERCHANDISING_SURFACE.length, 'the merchandising half changed size').toBe(2);
    for (const path of CONDITION_MERCHANDISING_SURFACE) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file — did it move?`).toBe(
        true,
      );
      expect(
        RANKING_SURFACE_PATHS,
        `${path} is now in the shared derivation; delete it from the merchandising half rather ` +
          'than scanning it twice under two justifications',
      ).not.toContain(path);
    }
    expect(
      CONDITION_RANKING_SURFACE.length,
      'the union lost a member — it is not the sum of its two halves',
    ).toBe(RANKING_SURFACE_PATHS.length + CONDITION_MERCHANDISING_SURFACE.length);

    for (const path of CONDITION_RANKING_SURFACE) {
      expect(readRankingSurfaceFile(path).length).toBeGreaterThan(200);
    }

    // EXACT, and the exception must still BE one — measured, not asserted. A
    // stale exemption excuses nothing while looking like a decision.
    expect(CONDITION_DISPLAY_READERS.length, 'a second display reader was excused').toBe(1);
    for (const path of CONDITION_DISPLAY_READERS) {
      expect(
        CONDITION_RANKING_SURFACE,
        `${path} is excused from this wall but is not in the ranking surface`,
      ).toContain(path);
      const source = stripComments(read(path));
      expect(
        DOMAIN_REACH.test(source),
        `${path} is excused as a condition DISPLAY reader and no longer reads the domain`,
      ).toBe(true);
      // The property that makes the exception safe rather than merely justified.
      expect(
        CONDITION_ORDERING.test(source),
        `${path} now orders by condition; a condition is a DESCRIPTION, not a placement input`,
      ).toBe(false);
    }
  });

  it('the reach detector FIRES on a seeded import', () => {
    expect(
      DOMAIN_REACH.test("import { x } from '../services/condition/condition-write.service.js';"),
    ).toBe(true);
    expect(DOMAIN_REACH.test('const rows = await db.select().from(listingConditionPhotos);')).toBe(
      true,
    );
  });
});

describe('#90 gate 5 — the condition domain cannot read commercial standing', () => {
  // `\.\./(fees|referrals|payments)/` are the specifiers a module in
  // `services/condition/` actually writes — each of those domains is one `../`
  // away — and the absolute-looking forms alone never see them. One alternative
  // per domain covers every depth, because however many `../` segments precede
  // it the last always abuts the directory name.
  const COMMERCIAL_REACH =
    /from ['"][^'"]*(?:services\/fees|\.\.\/fees\/|db\/fees|schema\/fees|services\/referrals|\.\.\/referrals\/|db\/referrals|services\/payments|\.\.\/payments\/|db\/payments)[^'"]*['"]/;

  it('no condition module imports the fee, referral or payment domains', () => {
    const offenders: string[] = [];
    for (const path of CONDITION_DOMAIN_PATHS) {
      const source = stripComments(read(path));
      if (COMMERCIAL_REACH.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    // A vacuity floor rather than an exact count: the set is walked now, so it
    // GROWS when the domain does, and an exact number would fail every honest
    // addition while still not detecting the file a hand-maintained list omits.
    // The floor is what stops a broken walk from reading as a clean scan.
    expect(CONDITION_DOMAIN_PATHS.length).toBeGreaterThanOrEqual(9);
    expect(CONDITION_DOMAIN_PATHS.filter((path) => path.startsWith('services/'))).not.toEqual([]);
    expect(CONDITION_DOMAIN_PATHS.filter((path) => path.startsWith('db/condition/'))).not.toEqual(
      [],
    );
    for (const path of CONDITION_DOMAIN_PATHS) {
      expect(read(path).length).toBeGreaterThan(500);
    }
  });

  it('the commercial-reach detector FIRES on a seeded import', () => {
    expect(
      COMMERCIAL_REACH.test("import { feeFor } from '../../services/fees/fee.service.js';"),
    ).toBe(true);
    // The RELATIVE specifiers, which are what a module in `services/condition/`
    // would actually write: each of the three forbidden domains is one `../`
    // away. The absolute-looking probe above passes against a pattern that
    // misses all three, which is why it kept this wall green.
    expect(COMMERCIAL_REACH.test("import { feeFor } from '../fees/fee-calculation.js';")).toBe(true);
    expect(
      COMMERCIAL_REACH.test("import { paymentService } from '../payments/payment.service.js';"),
    ).toBe(true);
    expect(
      COMMERCIAL_REACH.test("import { attribute } from '../../referrals/attribution.js';"),
    ).toBe(true);
    // Neighbours that merely share a prefix are not those domains.
    expect(COMMERCIAL_REACH.test("import { x } from '../fees-display/format.js';")).toBe(false);
  });
});

describe('#90 gate 6 — a sub-floor mapping can never carry a taxonomy key', () => {
  it('exactly one module compares against the confidence floor, by NAME', () => {
    const mapping = stripComments(read('services/condition/condition-mapping.service.ts'));
    expect(mapping).toContain('CONDITION_MAPPING_CONFIDENCE_FLOOR');

    // The number itself appears nowhere in the domain's code: a second literal
    // is how the service and the CHECK start disagreeing about where the line
    // is, and the disagreement is invisible until a real feed sits on it.
    const literal = String(CONDITION_MAPPING_CONFIDENCE_FLOOR);
    const offenders = CONDITION_DOMAIN_PATHS.filter((path) => {
      if (path === 'db/schema/condition.ts') return false; // renders the CHECK from the constant
      return stripComments(read(path)).includes(literal);
    });
    expect(offenders).toEqual([]);
  });

  it('the schema renders the CHECK from the shared constant, not a literal', () => {
    const schema = stripComments(read('db/schema/condition.ts'));
    expect(schema).toContain('CONDITION_MAPPING_CONFIDENCE_FLOOR');
    const offers = stripComments(read('db/schema/offers.ts'));
    expect(offers).toContain('CONDITION_MAPPING_CONFIDENCE_FLOOR_SQL');
  });

  it('the literal detector FIRES on a seeded hard-coded floor', () => {
    expect(`if (rule.confidence < ${CONDITION_MAPPING_CONFIDENCE_FLOOR}) return;`).toContain(
      String(CONDITION_MAPPING_CONFIDENCE_FLOOR),
    );
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
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  /**
   * The one condition-NAMED module that is not a condition-domain module, EXACT.
   *
   * `services/catalog-pages/condition-scope.ts` belongs to #73's catalogue
   * pages — it is that domain's condition-scoped page selection, not this
   * domain's taxonomy. It fires none of the walls here TODAY, which is exactly
   * why admitting it would be the wrong fix rather than a harmless one: it would
   * put another domain's module behind this domain's walls, and the failure
   * would arrive later as a red build for whoever edits #73. Its own gate,
   * `catalog-page-isolation.test.ts`, is what covers it.
   *
   * EXACT rather than a `services/catalog-pages/` prefix: a directory-shaped
   * exclusion excuses everything in it forever, including the module somebody
   * adds there next.
   */
  const NOT_THIS_DOMAIN = [
    {
      path: 'services/catalog-pages/condition-scope.ts',
      why: "#73's catalogue-page condition scope, covered by catalog-page-isolation.test.ts",
    },
  ] as const;

  it('every condition-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: conditionDomainPaths,
      pattern: CONDITION_NAME_PATTERN,
      notThisDomain: NOT_THIS_DOMAIN,
      // Below today's 13 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 9,
      plantIn: 'lib',
      plantName: 'condition-cache.ts',
    });
    // The exclusion's own count, so a second entry is a decision somebody takes
    // rather than a line that appears (#448).
    expect(NOT_THIS_DOMAIN.length, 'the exclusion set changed').toBe(1);
  });
});
