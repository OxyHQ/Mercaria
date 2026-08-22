/**
 * A collection arranges the catalogue; it never classifies it (ADR 0007 D3).
 *
 * D3's merchandising paragraph is two sentences, and the second is the invariant
 * this file holds: `collections`, `collection_rules` and `listing_collections`
 * "are **not** given category semantics and **a collection membership never
 * becomes a product fact**."
 *
 * ## What was here before this file: nothing
 *
 * D3's OTHER half — "nothing in navigation may write to `categories`" — has had
 * a scanned wall since #367 step 7 (`navigation-isolation.test.ts` WALL 1 and
 * WALL 4). The merchandising half had the sentence and no mechanism. Measured on
 * `db3b3bf`: the whole domain touches a category on exactly ONE line, and it is a
 * read (`db/merchandising/collectionRules.ts` maps the `categorySlug` rule field
 * onto `listings.categorySlugs` for an `arrayContains` predicate). So the
 * property held, by everybody's good behaviour, and adding
 * `updateListingColumns(id, { categoryId })` to `collection.service.ts` tomorrow
 * would have failed no test in this repository.
 *
 * ## The failure worth a gate, because it is not a crash
 *
 * A merchant needs a *Summer Sale* shelf. The browse tree reads `categories`, so
 * the cheapest way to get one is to mint a *Summer Sale* category and file forty
 * products under it. Every page renders. What has happened is that the taxonomy
 * is now carrying a marketing campaign: `listings.category_slugs` says a
 * swimsuit's browse path is `summer-sale`, the facet counts under *Swimwear* are
 * wrong, and nobody finds out until a shopper filters *Swimwear* in September and
 * sees nothing. The same shape reaches the same place through a secondary
 * classification, which is why `middleware/taxonomy-classification-schemas.ts`
 * already refuses a set of reasons by name and calls them "exactly the fake
 * category ADR 0007 D3 refuses" — that gate guards the classification surface's
 * INPUT. This one guards the merchandising domain's REACH, which is the door the
 * same mistake walks through when it is a convenience rather than a request.
 *
 * ## The boundary is READ versus WRITE, and getting it wrong disables the gate
 *
 * A collection legitimately reads a category. `categorySlug` is a
 * `CollectionRuleField` in the published contract, and "everything in Shoes" is
 * the ordinary reason somebody builds an automated collection. A wall that fired
 * on the WORD `category` would go red on `collectionRules.ts:62` — the one line
 * in the domain that is supposed to be there — and whoever hit it would delete
 * the wall, not the line. `navigation-isolation.test.ts` records the same
 * reasoning for the same tables.
 *
 * So the detectors name drizzle's WRITE VERBS against a product or taxonomy
 * table, the WRITER SYMBOLS by name, and IMPORTS of the write services. A bare
 * column reference is not a violation, and the positive control at WALL 2
 * asserts the permitted read is still present and still green — without it, this
 * whole file would keep passing on the day somebody deleted the read it exists
 * to permit.
 *
 * ## `collection` means two unrelated things in this tree
 *
 * Merchandising collections, and PICKUP collection — collecting a parcel (#93).
 * The whole-tree sweep matches both, so the four pickup modules are counted
 * exclusions with reasons rather than a narrower pattern: a pattern tuned until
 * it stops matching them is a pattern nobody can check, and the next
 * pickup-named module would silently land inside a wall about merchandising.
 * `PICKUP_COLLECTION_MODULES` is the ONE source of that carve-out — the
 * population filters by it and `assertNothingOutsideDomainPopulation` excuses by
 * it, so the two cannot drift into disagreeing about which tree a module is in.
 *
 * ## What this deliberately does NOT do
 *
 * It does not claim `middleware/schemas.ts` is covered. The collection request
 * schemas live in that shared module, which is named for no domain and belongs
 * to none; it declares zod shapes and can write nothing, so it is outside the
 * population and outside every wall here. Stated rather than left for a reader
 * to discover.
 *
 * It takes no position on a collection referencing a category — a rule value IS
 * a category slug. WALL 3 refuses a category COLUMN on the three tables, which
 * is D3's "not given category semantics" at the row, and nothing more.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  COLLECTION_FORBIDDEN_PRODUCT_WRITES,
  COLLECTION_PRODUCT_WRITES,
} from '@mercaria/shared-types';
import {
  COLLECTION_RULE_FIELDS,
  collectionRules,
  collections,
  listingCollections,
} from '../../db/schema/merchandising.js';
import {
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
  type DirectoryReader,
  type ForeignModule,
} from '../../__tests__/domain-population.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';
import { dispositionKey, forbiddenSymbolsReachableFrom } from '../../__tests__/import-closure.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * What a module of this domain is called, wherever it lives.
 *
 * Deliberately the BROAD word. It matches the pickup domain too, and that is the
 * point: the sweep's job is to put every `collection`-named module in front of a
 * decision, and the four that are not merchandising are excused below by name.
 */
const MERCHANDISING_NAMED = /merchandis|collection/i;

/** The directory this domain owns outright. */
const OWNED_DIRECTORIES = ['db/merchandising'] as const;

/**
 * The shared directories a merchandising module lives in under a domain name.
 *
 * `connectors` is in the list because `connectors/collections.ts` normalizes a
 * PLATFORM's collection list, and a platform collection is the thing most likely
 * to be mistaken for a category on the way in — a Shopify "smart collection" and
 * a category are the same shape from the outside.
 */
const SHARED_DIRECTORIES = [
  'routes',
  'controllers',
  'middleware',
  'db/schema',
  'services',
  'connectors',
] as const;

/**
 * `collection` modules that belong to PICKUP (#93), not to merchandising.
 *
 * Collecting a parcel from a pickup point. They share a word and nothing else —
 * no table, no service and no route — and each has its own domain's gate.
 */
const PICKUP_COLLECTION_MODULES: readonly ForeignModule[] = [
  {
    path: 'controllers/collection-code.controller.ts',
    why: "The pickup collection CODE surface (#93) — the one-time code a buyer shows at a pickup point. It reaches services/pickup, not a collection.",
  },
  {
    path: 'db/pickup/collectionRepository.ts',
    why: 'The pickup domain\'s own repository, over order_pickups. It shares the word "collection" with merchandising and no table with it.',
  },
  {
    path: 'services/pickup/collection-code.ts',
    why: 'Mints and verifies the pickup collection code (#93). Nothing to do with a merchandising collection.',
  },
  {
    path: 'services/pickup/collection.service.ts',
    why: 'The pickup collection service (#93) — marking an order collected. It has its own domain gate in services/__tests__/pickup-isolation.test.ts.',
  },
];

/** ONE source of the pickup carve-out, read by the population AND the exclusion. */
const NOT_MERCHANDISING = new Set(PICKUP_COLLECTION_MODULES.map((entry) => entry.path));

/** Every module of the merchandising-collection domain, enumerated from disk. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, MERCHANDISING_NAMED, readDir),
  ].filter((relative) => !NOT_MERCHANDISING.has(relative));
}

/** Every module of the domain, with its source. */
function domainSources(): { readonly relative: string; readonly source: string }[] {
  return domainRelativePaths().map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * Source with comments removed, run before every detector below.
 *
 * These modules document what they refuse to do in the same vocabulary a
 * violation would use — this file's own subject is written into
 * `db/schema/merchandising.ts`'s docblock — so a scan over raw source would fire
 * on the explanation, and the fix somebody reaches for is deleting the
 * explanation. The line rule requires the `//` to start a line or follow
 * whitespace, so a `://` inside a URL does not swallow the rest of the line and
 * hide a violation after it.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Which of `patterns` survive in `source` once its comments are gone. */
function violations(source: string, patterns: readonly RegExp[]): string[] {
  const stripped = withoutComments(source);
  return patterns.filter((pattern) => pattern.test(stripped)).map((pattern) => pattern.source);
}

/**
 * Every way this domain could write a product's category, as SEPARATE detectors.
 *
 * An array rather than one alternation, because a mutation self-test over a
 * single mega-regex proves one branch fires and reads as though it proved all of
 * them. Measured elsewhere in this repo: four sibling tie-breaks were mutation
 * tested, removing one went red and removing another stayed green, because only
 * one fixture carried the collision. Each entry below is mutated on its own.
 *
 * The four shapes, and each is a real door:
 *
 *  1. A drizzle WRITE VERB against a product or taxonomy table — the bypass that
 *     needs no repository at all.
 *  2. An IMPORT of a write service or a taxonomy write repository, which is how
 *     the reach arrives before the call does.
 *  3. A WRITER SYMBOL called by name — `insertListing` and `updateListingColumns`
 *     are the two the domain is closest to, since `collection.service.ts` already
 *     imports four READ helpers from the module that holds them.
 *  4. RAW SQL against the two columns, which nothing above would see.
 */
const CATEGORY_WRITE_DETECTORS: readonly RegExp[] = [
  /\.(insert|update|delete)\s*\(\s*(categories|listings|canonicalProducts|canonicalProductFamilies|listingSecondaryCategories|canonicalProductSecondaryCategories)\s*\)/,
  /from\s+'[^']*(catalog-write\.service|taxonomyRepository|classificationRepository|classification\.service|canonicalProductRepository|productFamilyRepository|graph-writer)[^']*'/,
  /\b(insertListing|updateListingColumns|rederiveCategoryBrowsePaths|insertSecondaryClassification|deleteSecondaryClassification|recordSecondaryClassification|withdrawSecondaryClassification|insertCanonicalProduct|updateCanonicalProduct|insertCategory|updateCategoryPresentation|moveCategory|mergeCategory|setCategoryLifecycle|insertP2PListingWithin|createP2PListing|createStoreProduct|createStoreProductWithin|finishStoreProductCreation|syncListingFacets)\s*\(/,
  /\bupdate\s+listings\s+set\b|\binsert\s+into\s+(categories|listing_secondary_categories)\b/i,
];
// #723: the loops below are this list's only readers, so emptying it makes every
// wall a no-op and nothing goes red. The floor is today's count — an addition
// passes freely, a REMOVAL has to move this number in the same diff.
expect(
  CATEGORY_WRITE_DETECTORS.length,
  'CATEGORY_WRITE_DETECTORS shrank without this floor moving — the walls below now defend less than they did',
).toBeGreaterThanOrEqual(4);

/**
 * The permitted READ, named so the asymmetry is measured rather than described.
 *
 * `collectionRules.ts` maps the `categorySlug` rule field onto the listing column
 * and builds an `arrayContains` predicate from it. If this ever stops matching,
 * either the read moved — and the walls above are now guarding a domain that no
 * longer reads a category, which is a different (and smaller) claim — or the read
 * was deleted. Both are worth failing the build for.
 */
const PERMITTED_CATEGORY_READ = /\bcategorySlug\s*:\s*listings\.categorySlugs\b/;

/** A category column has no business on a merchandising row (D3, at the table). */
const FORBIDDEN_MERCHANDISING_COLUMNS = [
  'categoryId',
  'categorySlug',
  'categorySlugs',
  'categoryKey',
  'categoryName',
  'ancestorIds',
  'ancestorSlugs',
  'selectable',
  'lifecycle',
  'productType',
  'brandId',
] as const;

describe('the merchandising domain cannot write a product fact (ADR 0007 D3)', () => {
  const domain = domainSources();

  it('is not vacuous: the domain has real modules and they hold real source', () => {
    // Every wall below is satisfied by an empty file list and by files the reader
    // failed to open, and both read exactly like a clean scan.
    expect(
      domain.length,
      'the merchandising population found too few modules to be real',
    ).toBeGreaterThanOrEqual(8);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('WALL 1: no module writes a category, a classification or a listing', () => {
    for (const file of domain) {
      expect(
        violations(file.source, CATEGORY_WRITE_DETECTORS),
        `${file.relative} writes a product fact. A collection arranges the catalogue and is ` +
          'never a second authority over what a product IS (ADR 0007 D3) — the membership row ' +
          'in listing_collections is the only product fact this domain may write',
      ).toEqual([]);
    }
  });

  it('WALL 2: and the permitted category READ is still there, and still green', () => {
    // The other half of WALL 1. Without this the file would keep passing on the
    // day the legitimate read was deleted — and a wall around a domain that no
    // longer does the thing is the "green and inert" shape, not a stronger wall.
    const rules = domain.find(
      (file) => file.relative === 'db/merchandising/collectionRules.ts',
    );
    expect(rules, 'collectionRules.ts is not in the population').toBeDefined();
    const stripped = withoutComments(rules.source);
    expect(
      PERMITTED_CATEGORY_READ.test(stripped),
      'the categorySlug rule field no longer reads listings.categorySlugs — either the read ' +
        'moved, or the domain stopped reading categories and these walls now guard less',
    ).toBe(true);
    // …and that same module passes every detector above. This is the assertion
    // that says the boundary is READ/WRITE and not "mentions a category".
    expect(
      violations(rules.source, CATEGORY_WRITE_DETECTORS),
      'the permitted category read trips a write detector — the boundary is wrong, and the ' +
        'next person to hit it will delete the wall rather than the line',
    ).toEqual([]);
    // The contract half: `categorySlug` is a published rule field, so the read is
    // owed to callers rather than being an implementation detail.
    expect(COLLECTION_RULE_FIELDS).toContain('categorySlug');
  });

  it('WALL 3: no merchandising table carries category semantics', () => {
    // Walked from the REAL drizzle tables, so a column added in a migration and
    // mirrored into the schema fails here rather than being described away.
    for (const [name, table] of [
      ['collections', collections],
      ['collection_rules', collectionRules],
      ['listing_collections', listingCollections],
    ] as const) {
      const columns = Object.keys(getTableColumns(table));
      expect(columns.length, `${name} listed no columns — did the table move?`).toBeGreaterThan(3);
      assertEachOf(FORBIDDEN_MERCHANDISING_COLUMNS, 11, (forbidden) => {
        expect(
          columns,
          `${name} must not carry ${forbidden}: D3 keeps these three tables "not given category ` +
            'semantics", and a category on the membership row is a collection becoming a category',
        ).not.toContain(forbidden);
      });
    }
    // The positive controls: the columns each table SHOULD carry are present, so
    // a renamed table cannot pass WALL 3 by having no columns to check.
    expect(Object.keys(getTableColumns(collections))).toContain('handle');
    expect(Object.keys(getTableColumns(collectionRules))).toContain('field');
    expect(Object.keys(getTableColumns(listingCollections))).toContain('listingId');
    expect(Object.keys(getTableColumns(listingCollections))).toContain('collectionId');
  });

  it('WALL 4: the prohibition and the permission are disjoint vocabularies', () => {
    const permitted = new Set<string>(COLLECTION_PRODUCT_WRITES);
    assertEachOf(COLLECTION_FORBIDDEN_PRODUCT_WRITES, 7, (forbidden) => {
      expect(
        permitted.has(forbidden),
        `${forbidden} is both permitted and forbidden`,
      ).toBe(false);
    });
    // The prohibition names the two somebody reaches for FIRST: minting a
    // category to be the collection, and filing products under it.
    expect(COLLECTION_FORBIDDEN_PRODUCT_WRITES).toContain('category_definition');
    expect(COLLECTION_FORBIDDEN_PRODUCT_WRITES).toContain('primary_category');
    // …and the permitted set is exactly one member: the membership row.
    expect(COLLECTION_PRODUCT_WRITES).toEqual(['collection_membership']);
  });
});

describe('the detectors themselves', () => {
  /**
   * One crafted sample per detector, EACH mutated on its own.
   *
   * `fires` must trip exactly this detector; `clean` must trip none of them and
   * is drawn from the domain's real vocabulary, so a detector that fires on
   * everything fails here rather than passing WALL 1 by refusing the whole tree.
   */
  const CASES: readonly { readonly fires: string; readonly clean: string }[] = [
    {
      fires: 'await tx.update(listings).set({ categoryId });',
      clean: 'await tx.update(collections).set({ title });',
    },
    {
      fires: "import { updateListing } from '../../services/catalog-write.service.js';",
      clean: "import { findListingById } from '../catalog/listingRepository.js';",
    },
    {
      fires: 'await updateListingColumns(listingId, { categorySlugs }, tx);',
      clean: 'await setListingAutomatedMemberships(listingId, all, matched);',
    },
    {
      fires: "await tx.execute(sql`update listings set category_id = ${id}`);",
      clean: "await tx.execute(sql`update collections set title = ${t}`);",
    },
  ];

  it('every detector fires on its own shape and on nothing else', () => {
    assertEachOf(CASES, 4, (sample, index) => {
      const detector = CATEGORY_WRITE_DETECTORS[index];
      // Through `violations()` — the function the real scan calls — rather than
      // against the regex directly, so a control that does not take production's
      // code path cannot report a detector working when it is inert.
      expect(
        violations(sample.fires, [detector]),
        `detector ${index} does not fire on the write it exists to catch`,
      ).toEqual([detector.source]);
      // The NEGATIVE control, and it is per-detector: a detector that matched
      // everything would satisfy the assertion above and refuse the whole domain.
      expect(
        violations(sample.clean, [detector]),
        `detector ${index} fires on a legitimate merchandising write`,
      ).toEqual([]);
    });
  });

  it('each detector is the ONLY one that catches its shape', () => {
    // The trap this exists for: if two detectors both match a sample, removing
    // either leaves the suite green and the pair reads as two working walls.
    // Measured elsewhere in this repo on four sibling tie-breaks, three of which
    // were defended by accident.
    assertEachOf(CASES, 4, (sample, index) => {
      expect(
        violations(sample.fires, CATEGORY_WRITE_DETECTORS),
        `more than one detector catches sample ${index}, so removing one of them would leave ` +
          'this suite green and the redundant wall would read as load-bearing',
      ).toEqual([CATEGORY_WRITE_DETECTORS[index].source]);
    });
  });

  it('a category READ fires nothing — the boundary, stated as a test', () => {
    // The three shapes the domain legitimately uses. A wall that caught any of
    // them is one whoever hit it next would disable.
    for (const read of [
      'const ARRAY_COLUMNS = { tag: listings.tags, categorySlug: listings.categorySlugs };',
      'predicates.push(arrayContains(listings.categorySlugs, [value]));',
      'const rows = await db.select({ listing: listings }).from(listings);',
      "import { findCategoryBySlug } from '../catalog/categoryRepository.js';",
    ]) {
      expect(violations(read, CATEGORY_WRITE_DETECTORS), `a read tripped a wall: ${read}`).toEqual(
        [],
      );
    }
  });

  it('a comment naming a write does not fire, and the stripper is not total', () => {
    expect(violations('// await tx.update(listings).set({ categoryId });\n', CATEGORY_WRITE_DETECTORS)).toEqual([]);
    expect(violations('/* insertCategory(x) */', CATEGORY_WRITE_DETECTORS)).toEqual([]);
    // …and the stripper leaves real code alone, or every wall above is vacuous
    // for the reason the stripper was added.
    expect(withoutComments('const url = "https://x.example/a"; // note')).toContain('https://x.example/a');
    expect(withoutComments('insertCategory(x); // note').trim()).toBe('insertCategory(x);');
  });
});

describe('#460 — the population the walls are applied to', () => {
  it('nothing naming a collection anywhere in src/ sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: MERCHANDISING_NAMED,
      notThisDomain: PICKUP_COLLECTION_MODULES,
      expectedExclusions: 4,
      // Below today's 13 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 9,
      plantIn: 'lib',
      plantName: 'collection-cache.ts',
    });
  });

  it('floors PER SHAPE, because the two sources break independently', () => {
    // One total lets the owned walk collapse to zero while the shared sweep
    // carries it, which is exactly the asymmetry #609 measured in 27 gates.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, MERCHANDISING_NAMED).filter(
      (relative) => !NOT_MERCHANDISING.has(relative),
    );
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(2);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      5,
    );
  });

  it('the modules a one-level sweep would miss are in the population', () => {
    // An identity assertion, not a floor: a floor is met without any of them.
    // `controllers/admin/` and `routes/admin/` are the two directories #609 found
    // 27 gates failing to recurse into, and this domain has a module in each.
    const population = domainRelativePaths();
    assertEachOf(
      [
        'controllers/admin/collections-admin.controller.ts',
        'routes/admin/collections.ts',
        'db/schema/merchandising.ts',
        'connectors/collections.ts',
        'services/collection.service.ts',
      ],
      5,
      (named) => {
        expect(population, `${named} is outside the walls`).toContain(named);
        expect(
          statSync(join(SRC_ROOT, named)).isFile(),
          `${named} no longer exists, so naming it proves nothing`,
        ).toBe(true);
      },
    );
  });

  it('both halves of the NAME pattern are load-bearing', () => {
    // A widening that changes nothing looks exactly like a fix. Each alternative
    // reaches a module the other does not, and each is asserted NOT to reach the
    // other's.
    expect(/merchandis/i.test('db/schema/merchandising.ts')).toBe(true);
    expect(/collection/i.test('db/schema/merchandising.ts')).toBe(false);
    expect(/collection/i.test('services/collection.service.ts')).toBe(true);
    expect(/merchandis/i.test('services/collection.service.ts')).toBe(false);
    const population = domainRelativePaths();
    expect(population).toContain('db/schema/merchandising.ts');
    expect(population).toContain('services/collection.service.ts');
  });

  it('the pickup carve-out has ONE source, so it cannot drift', () => {
    // The population filters by `NOT_MERCHANDISING` and the exclusion above
    // excuses by `PICKUP_COLLECTION_MODULES`. Two spellings would let a module be
    // excused while still being scanned, or scanned while being excused — and
    // `assertNothingOutsideDomainPopulation` fails loudly on the second only.
    expect(NOT_MERCHANDISING.size).toBe(PICKUP_COLLECTION_MODULES.length);
    assertEachOf(PICKUP_COLLECTION_MODULES, 4, (entry) => {
      expect(NOT_MERCHANDISING.has(entry.path)).toBe(true);
      expect(MERCHANDISING_NAMED.test(entry.path), `${entry.path} is not even swept`).toBe(true);
      expect(
        statSync(join(SRC_ROOT, entry.path)).isFile(),
        `${entry.path} no longer exists, so excusing it proves nothing`,
      ).toBe(true);
    });
  });
});

/**
 * WALL 1 applied to what the domain can REACH, not to what it spells (#568).
 *
 * WALL 1 reads each module's own text, which answers "does this file contain the
 * word" when what it means to answer is "can this module cause the write". The
 * two come apart at the first wrapper, and this domain is closer to that than
 * most: `collection.service.ts` already imports FOUR read helpers from
 * `db/catalog/listingRepository.ts`, the module that also holds `insertListing`
 * and `updateListingColumns`. One helper there that grew a category write, or one
 * new export wrapping it, and the name-keyed scan sees nothing.
 *
 * ## Bounds, stated rather than implied
 *
 * The walk follows named value imports along relative specifiers. A dynamic
 * `import()`, a symbol reached through an object property, and anything behind a
 * package boundary are invisible to it. It raises the cost of an accidental
 * wrapper; it is not a sandbox, and WALL 1 is not replaced by it.
 */
const PERMITTED_TRANSITIVE_WRITES: Readonly<Record<string, string>> = Object.freeze({});

/** Pinned, because a disposition census is satisfied by disposing of everything. */
const EXPECTED_DISPOSITION_COUNT = 0;

describe('WALL 1 survives a one-hop wrapper (#568)', () => {
  const entries = (): string[] =>
    domainRelativePaths().filter((relative) => !relative.startsWith('db/schema/'));

  it('disposes of exactly the paths somebody has reviewed, and no more', () => {
    expect(
      Object.keys(PERMITTED_TRANSITIVE_WRITES),
      'a transitive write was dispositioned or removed — move this number deliberately',
    ).toHaveLength(EXPECTED_DISPOSITION_COUNT);
  });

  it('no module in the domain can REACH a category write', () => {
    const modules = entries();
    expect(modules.length, 'no entry module to walk from').toBeGreaterThanOrEqual(7);
    let bodies = 0;
    for (const entry of modules) {
      const result = forbiddenSymbolsReachableFrom({
        srcRoot: SRC_ROOT,
        entry,
        // The SAME detectors WALL 1 uses, read from one place, so the two cannot
        // drift into forbidding different things.
        forbidden: CATEGORY_WRITE_DETECTORS,
      });
      bodies += result.bodiesScanned;
      const undispositioned = result.findings.filter(
        (finding) => PERMITTED_TRANSITIVE_WRITES[dispositionKey(finding)] === undefined,
      );
      expect(
        undispositioned.map(
          (finding) => `${dispositionKey(finding)}  via  ${finding.path.join(' -> ')}`,
        ),
        `${entry} reaches a category write through an undispositioned path`,
      ).toEqual([]);
    }
    // The vacuity floor, and it is the one that matters: a walk that resolved
    // nothing finds nothing and reads exactly like a clean domain.
    expect(bodies, 'the import walk reached too few bodies to be real').toBeGreaterThanOrEqual(20);
  });

  it('MUTATION SELF-TEST: a one-hop wrapper is caught, through the real walker', () => {
    // The shape that defeats WALL 1: the guarded module names only the wrapper,
    // and the wrapper names the writer.
    const files: Record<string, string> = {
      '/src/entry.ts':
        "import { fileUnder } from './wrapper.js';\nexport async function go() { return fileUnder(); }\n",
      '/src/wrapper.ts':
        "import { updateListingColumns } from './repo.js';\nexport async function fileUnder() { return updateListingColumns('l', { categoryId: 'c' }); }\n",
      '/src/repo.ts': 'export async function updateListingColumns() { return 1; }\n',
    };
    const crafted = (): ReturnType<typeof forbiddenSymbolsReachableFrom> =>
      forbiddenSymbolsReachableFrom({
        srcRoot: '/src',
        entry: 'entry.ts',
        forbidden: CATEGORY_WRITE_DETECTORS,
        readFile: (path) => files[path] ?? '',
        fileExists: (path) => files[path] !== undefined,
      });

    const caught = crafted();
    expect.soft(caught.unresolvedBodies).toBe(0);
    expect.soft(caught.bodiesScanned).toBeGreaterThanOrEqual(2);
    // It must red, and it must red NAMING THE WRAPPER — a gate that fires without
    // saying which hop is at fault sends the next reader to the wrong module.
    expect(caught.findings.map((finding) => finding.firstHop)).toContain('wrapper.ts#fileUnder');

    // NEGATIVE CONTROL: the same graph with the wrapper doing the READ instead.
    // Without it, a walker that fired on every input would pass the assertion
    // above and measure nothing.
    files['/src/wrapper.ts'] =
      "import { findListingById } from './repo.js';\nexport async function fileUnder() { return findListingById('l'); }\n";
    files['/src/repo.ts'] = 'export async function findListingById() { return null; }\n';
    const clean = crafted();
    expect.soft(clean.unresolvedBodies, 'the clean walk resolved nothing, so it proves nothing').toBe(0);
    expect.soft(clean.bodiesScanned).toBeGreaterThanOrEqual(2);
    expect(clean.findings).toEqual([]);
  });
});
