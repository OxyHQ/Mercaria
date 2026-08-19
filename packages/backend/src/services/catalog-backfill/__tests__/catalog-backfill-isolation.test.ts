/**
 * The walls around the legacy-catalogue migration domain (#367 workstream 13).
 *
 * Six scanned gates over every module in `services/catalog-backfill/`,
 * `db/catalogBackfill/` and the three `scripts/backfill-catalog-*.ts` — the
 * whole DIRECTORIES, so each wall holds for modules nobody has written yet.
 *
 * #460 did NOT move the count: the whole-tree sweep finds the same eleven
 * modules the two directories plus the script prefix already reached. What it
 * adds is the direction a directory list is blind to — a module ADDED somewhere
 * neither names, which no floor and no count in this file could ever see. The
 * script prefix in particular was a hand-written rule (`startsWith`), and it is
 * now the same NAME pattern everything else uses.
 * Every one carries a vacuity floor read off the real tree (a scan of nothing
 * passes every pattern) and a mutation self-test proving the detector fires on
 * the shape it is hunting.
 *
 * ## Why each wall, rather than a habit
 *
 * 1. **No similarity metric, distance or threshold.** ADR 0007 D6 names the
 *    failure: inventing a normalization for `Tono` because it looks like `Color`
 *    is the false merge #58 is shaped around. A migration is exactly where
 *    somebody reaches for one, because the honest report has a large `invalid`
 *    count in it and a similarity score makes that number smaller.
 * 2. **One write, through the sanctioned writer.** `listings.published_at` and
 *    the archive provenance are DERIVED inside the three statements that may
 *    write the table, counted by `listing-publication-chokepoint.test.ts`. This
 *    domain writes one column of that table and does it through
 *    `updateListingColumns`; the import list is asserted EXACTLY, so a second
 *    module reaching for the repository fails here before it fails there.
 * 3. **No write to any catalog authority.** `categories`, the two legacy option
 *    tables, `product_type_definitions` and `brands` are read and never written.
 *    A migration that could publish a category or mint a brand would be able to
 *    resolve its own backlog, which is precisely the thing it must not do.
 * 4. **No canonical minting.** #60 owns creating canonical entities and #58 owns
 *    matching. A `create_new` recommendation is not this domain's to act on.
 * 5. **No re-implementation of #367 step 4.** The option subjects are classified
 *    there, under their own refusal vocabulary. This domain QUOTES the counts
 *    through `countQueuedClaims` and may not import the resolver — two
 *    authorities over one fact disagree the first time somebody publishes an
 *    alias.
 * 6. **No ranking, fee, referral or payment reference.** ADR 0007's non-goals. A
 *    legacy category assignment is one join from a plan-weighted ordering.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * What a module of this domain is called, wherever it lives.
 *
 * BOTH orders, because the scripts are spelled the other way round
 * (`scripts/backfill-catalog-classify.ts`), and the hyphen is optional for
 * `db/catalogBackfill/`.
 *
 * **The narrowness is the point.** A bare `backfill` would swallow #60's
 * separate flag-gated catalogue backfill — `services/backfill/`, `db/backfill/`,
 * `db/schema/backfill.ts`, `routes/internal-backfill.ts` and eleven more, all
 * covered by `services/__tests__/backfill-isolation.test.ts` — plus #367's
 * `scripts/backfill-variant-axes.ts` and two sibling `backfill.service.ts`
 * modules. Measured: bare `backfill` selects 27 modules that are NOT this
 * domain's; this pattern selects 11 and every one is.
 */
const CATALOG_BACKFILL_NAME_PATTERN = /catalog-?backfill|backfill-catalog/i;

/** The two directories this domain owns outright. */
const OWNED_DIRECTORIES = ['services/catalog-backfill', 'db/catalogBackfill'] as const;

/**
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * `scripts` is in the list and is where the three operator entry points live;
 * the other four hold nothing named for this domain today, and they are here so
 * that a route or a schema table added tomorrow lands inside the walls rather
 * than turning the whole-tree assertion red for a module that plainly belongs.
 */
const SHARED_DIRECTORIES = ['scripts', 'routes', 'controllers', 'middleware', 'db/schema'] as const;

/** Every module of the catalog-backfill domain, enumerated from disk. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // RECURSIVE, where this read one directory level.
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, CATALOG_BACKFILL_NAME_PATTERN, readDir),
  ];
}

/** Every production module in the domain. Tests are excluded — they name what they refuse. */
function domainFiles(): string[] {
  return domainRelativePaths()
    .map((path) => join(SRC_ROOT, path))
    .sort();
}

/**
 * Strip comments before scanning.
 *
 * Load-bearing rather than tidy: every module in this domain documents what it
 * refuses to do in the vocabulary the detectors hunt — `product-type-text.ts`
 * names `trigram_similarity` and `stemming` as string VALUES — so an unstripped
 * scan fires on the prose explaining why the thing is forbidden.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A similarity metric, as a CALL or an IMPORT rather than as a word.
 *
 * Call-shaped on purpose: `LEGACY_PRODUCT_TYPE_FORBIDDEN_FOLDS` and
 * `LEGACY_CATALOG_FORBIDDEN_SIGNALS` state the prohibition using these very
 * words as VALUES, and a bare-word scan would report the guard rail as the
 * violation.
 */
const FUZZY_REFERENCE =
  /\b(similarity|levenshtein|jaroWinkler|jaro_winkler|editDistance|soundex|metaphone|damerau|fuzzyMatch|closestMatch|bestMatch|scoreMatch)\s*\(|from\s+'(?:[^']*\/)?(?:fuse(?:\.js)?|fuzzysort|fuzzy|leven|fast-levenshtein|fastest-levenshtein|string-similarity|natural)'|pg_trgm|<->|word_similarity|findBrandNameCandidates/;

/** A drizzle or raw write against any table this domain must only read. */
const FORBIDDEN_TABLE_WRITE = new RegExp(
  [
    'categories',
    'listingOptions',
    'productVariantOptionValues',
    'productTypeDefinitions',
    'productTypeCategoryScopes',
    'brands',
    'brandAliases',
    'listings',
  ]
    .flatMap((identifier) => [
      `\\.\\s*insert\\s*\\(\\s*${identifier}\\s*\\)`,
      `\\.\\s*update\\s*\\(\\s*${identifier}\\s*\\)`,
      `\\.\\s*delete\\s*\\(\\s*${identifier}\\s*\\)`,
    ])
    .concat([
      'insert\\s+into\\s+"?(?:categories|listings|listing_options|product_variant_option_values|product_type_definitions|brands)"?',
      'update\\s+"?(?:categories|listings|listing_options|product_variant_option_values|product_type_definitions|brands)"?\\s+set',
      'delete\\s+from\\s+"?(?:categories|listings|listing_options|product_variant_option_values|product_type_definitions|brands)"?',
    ])
    .join('|'),
  'iu',
);

/** Minting a canonical entity, a brand or an attachment — #58 and #60's work. */
const CANONICAL_MINT_REFERENCE =
  /createCanonicalProduct|createCanonicalVariant|createBrand|createProductFamily|ensureBrand|insertNativeListingLink|attachNativeVariant|requestNativeOfferSync|canonical\/brand\.service|canonical\/canonical-product\.service|services\/matching\//;

/** #367 step 4's resolver, which owns the option subjects. */
const STEP_FOUR_RESOLVER_REFERENCE =
  /variant-axes\/legacy-resolution|variant-axes\/backfill\.service|resolveLegacyOptionName|resolveLegacyOptionValue|legacyOptionNameToKey/;

/**
 * Any import from #60's backfill domain.
 *
 * One module of it is legitimate and the rest are not: `cohort.ts` is a pure
 * value plus two pure functions over it, and reusing it is what makes "selected
 * stores" mean the same thing to both migrations. Everything else in
 * `services/backfill/` — the runner, the stages, the graph writer, the report
 * repositories — is #60's internals, and reaching into them would put this
 * workstream inside the canonical-graph migration's lease, counters and stage
 * table rather than beside them.
 */
const BACKFILL_DOMAIN_IMPORT = /from\s+'[^']*\/backfill\/([a-zA-Z0-9._-]+)'/gu;

/** The only module of #60's domain this one may import. */
const PERMITTED_BACKFILL_MODULES = ['cohort.js'];

/** Ranking, fees, referrals and payments — ADR 0007's non-goals. */
const COMMERCIAL_REFERENCE =
  /services\/ranking\/|\.\.\/ranking\/|rankingPolicy|rankOffers|ranking_policy_versions|services\/fees\/|\.\.\/fees\/|fee_schedules|marketplace_fee|services\/referral|referral_|services\/payments\/|\.\.\/payments\//;

/** The listing repository — permitted in exactly one module. */
const LISTING_REPOSITORY_IMPORT = /catalog\/listingRepository/;

/**
 * The ONE module that may reach the sanctioned listing writer.
 *
 * An exact list rather than a directory rule: a rule covering
 * `services/catalog-backfill/` would quietly admit the next module somebody adds
 * there, and "one write, in one place" is the whole of why this domain is
 * allowed to write at all.
 */
const PERMITTED_LISTING_WRITERS = ['services/catalog-backfill/repair.service.ts'];

describe('the enumeration itself', () => {
  it('finds every module in the domain, with a floor read off the real tree', () => {
    // A scan of nothing passes every pattern below. Printed on SUCCESS by being
    // the assertion: the number this compares is the population every wall was
    // measured against.
    const files = domainFiles();
    expect(files.length, 'the domain scan found almost nothing — did the walk work?')
      .toBeGreaterThanOrEqual(9);
    for (const file of files) {
      expect(readFileSync(file, 'utf8').length, `${file} is empty`).toBeGreaterThan(200);
    }
    // The three scripts specifically, because they live outside the two scanned
    // directories and a glob that stopped matching them would take a third of
    // the domain out of every wall with no other symptom.
    const scripts = files.filter((file) => file.includes(`${join('scripts', 'backfill-catalog-')}`));
    expect(scripts).toHaveLength(3);
  });
});

describe('wall 1 — no similarity metric, distance or threshold', () => {
  it('finds none in the domain', () => {
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(
        FUZZY_REFERENCE.test(source),
        `${relative(SRC_ROOT, file)} reaches for a similarity metric. ADR 0007 D6: inventing a ` +
          'normalization because two strings look alike is the false merge #58 is shaped around',
      ).toBe(false);
    }
  });

  it('has a detector that fires on the shapes it claims to', () => {
    for (const positive of [
      'const score = similarity(a, b);',
      "import Fuse from 'fuse.js';",
      'sql`select * from brands order by name <-> ${q}`',
      'const best = closestMatch(text, keys);',
      'const rows = await findBrandNameCandidates(db, name);',
    ]) {
      expect(FUZZY_REFERENCE.test(positive), `detector missed: ${positive}`).toBe(true);
    }
    for (const negative of [
      "const folded = raw.trim().toLowerCase().replace(/[\\s-]+/gu, '_');",
      'const brands = await findBrandsByNormalizedName(db, normalized);',
      "if (candidateBrandIds.length > 1) return { reason: 'vendor_brand_multiple_candidates' };",
    ]) {
      expect(FUZZY_REFERENCE.test(negative), `detector over-matched: ${negative}`).toBe(false);
    }
  });
});

describe('wall 2 — one write, through the sanctioned writer', () => {
  it('lets exactly one module reach the listing repository', () => {
    const importers = domainFiles()
      .filter((file) => LISTING_REPOSITORY_IMPORT.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC_ROOT, file).split('\\').join('/'))
      .sort();
    // Exact identity, never containment: an allow-list that may only grow is the
    // gate switching itself off one defensible entry at a time. It is also its
    // own positive control — it can only pass by having FOUND the real importer.
    expect(
      importers,
      'a second module reaches the listing writer. This domain writes ONE column of `listings`, ' +
        'in `repair.service.ts`, and every other subject is report-only',
    ).toEqual(PERMITTED_LISTING_WRITERS);
  });

  it('has a detector that fires on the import shape', () => {
    expect(
      LISTING_REPOSITORY_IMPORT.test("import { updateListingColumns } from '../../db/catalog/listingRepository.js';"),
    ).toBe(true);
    expect(LISTING_REPOSITORY_IMPORT.test("import { listings } from '../schema/catalog.js';")).toBe(
      false,
    );
  });
});

describe('wall 3 — no write to any catalog authority', () => {
  it('finds no insert, update or delete against one', () => {
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(
        FORBIDDEN_TABLE_WRITE.test(source),
        `${relative(SRC_ROOT, file)} writes a catalog authority directly. A migration that can ` +
          'publish a category or mint a brand can resolve its own backlog',
      ).toBe(false);
    }
  });

  it('has a detector that fires on both the builder and the raw spellings', () => {
    for (const positive of [
      'await db.insert(categories).values({});',
      'await tx\n  .update(listings)\n  .set({ categorySlugs });',
      'await db.delete(brandAliases).where(eq(x, y));',
      'await db.execute(sql`update categories set ancestor_slugs = x`);',
      'await db.execute(sql`insert into product_type_definitions (id) values (1)`);',
    ]) {
      expect(FORBIDDEN_TABLE_WRITE.test(positive), `detector missed: ${positive}`).toBe(true);
    }
    for (const negative of [
      'const rows = await db.select().from(categories);',
      "import { listings } from '../schema/catalog.js';",
      'await updateListingColumns(listingId, { categorySlugs }, tx);',
    ]) {
      expect(FORBIDDEN_TABLE_WRITE.test(negative), `detector over-matched: ${negative}`).toBe(
        false,
      );
    }
  });
});

describe('wall 3b — only #60’s cohort, never its internals', () => {
  it('imports exactly one module of the canonical-graph backfill', () => {
    const found = new Set<string>();
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(BACKFILL_DOMAIN_IMPORT)) {
        found.add(match[1] ?? '');
      }
    }
    // Exact identity, and its own positive control: it can only pass by having
    // FOUND the cohort import, so a probe that stopped matching fails here
    // instead of reporting a tidy empty set.
    expect(
      [...found].sort(),
      'this domain reaches into #60’s backfill internals. Only `cohort.ts` is shared — the ' +
        'runner, the stages, the graph writer and the report repositories are that migration’s',
    ).toEqual(PERMITTED_BACKFILL_MODULES);
  });

  it('has a probe that reads a module name out of BOTH import spellings', () => {
    // The mutation self-test, and it earned its keep: the first version of this
    // probe required the literal `services/backfill/`, which the modules INSIDE
    // `services/catalog-backfill/` never write — they reach a sibling directory
    // as `../backfill/…`. So the wall above was passing by finding only the two
    // spellings from `db/` and `scripts/`, and a service module importing #60's
    // runner would have walked straight through it.
    const probe = new RegExp(BACKFILL_DOMAIN_IMPORT.source, 'u');
    expect(probe.exec("import { ALL_COHORT } from '../backfill/cohort.js';")?.[1]).toBe(
      'cohort.js',
    );
    expect(
      probe.exec("import { x } from '../../services/backfill/cohort.js';")?.[1],
    ).toBe('cohort.js');
    expect(
      probe.exec("import { runCatalogBackfillPage } from '../backfill/backfill.service.js';")?.[1],
    ).toBe('backfill.service.js');

    // Negative controls. The domain's own directory ends in `-backfill/`, not
    // `/backfill/`, so a self-import must not read as a reach into #60's.
    expect(probe.test("import { classify } from '../catalog-backfill/classify.service.js';")).toBe(
      false,
    );
    expect(probe.test("import { listings } from '../schema/catalog.js';")).toBe(false);
  });
});

describe('walls 4, 5 and 6 — canonical minting, step 4’s resolver, and the non-goals', () => {
  it('finds none of them in the domain', () => {
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      const path = relative(SRC_ROOT, file);
      expect(
        CANONICAL_MINT_REFERENCE.test(source),
        `${path} mints a canonical entity. #58 matches and #60 mints; this domain classifies`,
      ).toBe(false);
      expect(
        STEP_FOUR_RESOLVER_REFERENCE.test(source),
        `${path} re-implements #367 step 4. The option subjects are classified there; this ` +
          'domain quotes the counts through countQueuedClaims',
      ).toBe(false);
      expect(
        COMMERCIAL_REFERENCE.test(source),
        `${path} references ranking, fees, referrals or payments — ADR 0007's non-goals`,
      ).toBe(false);
    }
  });

  it('has detectors that fire on the shapes they claim to', () => {
    expect(CANONICAL_MINT_REFERENCE.test('await createBrand({ name });')).toBe(true);
    expect(CANONICAL_MINT_REFERENCE.test("import { runMatch } from '../matching/match.service.js';"))
      .toBe(false);
    expect(
      CANONICAL_MINT_REFERENCE.test("import { x } from '../../services/matching/match.service.js';"),
    ).toBe(true);

    expect(STEP_FOUR_RESOLVER_REFERENCE.test('const key = legacyOptionNameToKey(name);')).toBe(true);
    expect(
      STEP_FOUR_RESOLVER_REFERENCE.test(
        "import { countQueuedClaims } from '../../db/variantAxes/attributeClaimRepository.js';",
      ),
      'the quote must stay permitted — it is how the option backlog reaches the report',
    ).toBe(false);

    expect(COMMERCIAL_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const ranked = listings.sort();')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* #454: the detector must match the IDIOM, not one spelling of it            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * These detectors named each forbidden domain by its `services/<domain>/` path
 * only, which is not the specifier a module inside this domain writes: a
 * sibling directory is one `../` away, so the real import is `'../<domain>/…'`
 * and it passed the wall untouched. MEASURED on `origin/main` by executing each
 * pattern against that spelling.
 *
 * One relative alternative per domain covers EVERY depth, because however many
 * `../` segments precede it the last always abuts the directory name.
 *
 * The probes below are written from the IDIOM rather than from the regex — a
 * self-test derived from the pattern can only confirm the pattern matches
 * itself. The imported SYMBOL is deliberately neutral in each: the sibling
 * probe in `freshness-isolation.test.ts` imported `rankOffers`, which its
 * pattern matches by function NAME, so it passed without ever exercising the
 * path alternative it appeared to cover.
 */
describe('#454: a relative import cannot walk around these detectors', () => {
  it('COMMERCIAL_REFERENCE sees a sibling-relative import', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { helper } from '../ranking/thing.service.js';"),
      "a module here reaches ranking as '../ranking/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { helper } from '../../services/ranking/thing.service.js';")).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { helper } from '../fees/thing.service.js';"),
      "a module here reaches fees as '../fees/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { helper } from '../../services/fees/thing.service.js';")).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { helper } from '../payments/thing.service.js';"),
      "a module here reaches payments as '../payments/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { helper } from '../../services/payments/thing.service.js';")).toBe(true);
    // The negative half, or the widening would fire on ordinary imports.
    expect(COMMERCIAL_REFERENCE.test("import { helper } from '../ranking-display/format.js';")).toBe(false);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

});

describe('the population the six walls above are applied to (#460)', () => {
  it('nothing naming this domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: CATALOG_BACKFILL_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement:
      // all eleven modules the whole-tree sweep finds are this domain's.
      notThisDomain: [],
      // Below today's 11 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 8,
      plantIn: 'lib',
      plantName: 'catalog-backfill-cache.ts',
    });
  });

  it('floors PER SHAPE, because the two sources break independently', () => {
    // One total lets the owned walk collapse to zero while the scripts carry it,
    // which is exactly the pair this domain has.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, CATALOG_BACKFILL_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(6);
    expect(shared.length, 'the shared-directory name sweep reached no script').toBeGreaterThanOrEqual(
      3,
    );
  });

  it('the three operator scripts arrive through the NAME pattern, not a prefix rule', () => {
    // They used to be selected by `entry.startsWith('backfill-catalog-')`, a
    // second spelling of the population living ten lines from the first. These
    // are the modules that rule reached, and each must still be covered.
    const population = domainRelativePaths();
    for (const script of [
      'scripts/backfill-catalog-classify.ts',
      'scripts/backfill-catalog-paths.ts',
      'scripts/backfill-catalog-reconcile.ts',
    ]) {
      expect(population, `${script} is outside the walls`).toContain(script);
      expect(
        statSync(join(SRC_ROOT, script)).isFile(),
        `${script} no longer exists, so naming it proves nothing`,
      ).toBe(true);
    }
  });

  it('and #60’s separate backfill domain stays OUT of it', () => {
    // The narrowness of the name pattern, measured rather than described. A bare
    // `backfill` would pull in a whole other domain that has its own gate, and
    // the walls here are not the walls there.
    const population = domainRelativePaths();
    for (const foreign of [
      'services/backfill/backfill.service.ts',
      'db/schema/backfill.ts',
      'routes/internal-backfill.ts',
      'scripts/backfill-variant-axes.ts',
      'services/catalog-proposals/backfill.service.ts',
    ]) {
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
      expect(population, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(CATALOG_BACKFILL_NAME_PATTERN.test(foreign), `${foreign} matches the name`).toBe(false);
    }
  });

  it('both spellings of the NAME pattern are load-bearing', () => {
    // The scripts are `backfill-catalog-*` and the repository directory is
    // `catalogBackfill` — three different orders and casings for one domain, and
    // each alternative is asserted to reach what the others do not.
    expect(/catalog-?backfill/i.test('scripts/backfill-catalog-paths.ts')).toBe(false);
    expect(/backfill-catalog/i.test('db/catalogBackfill/legacyCatalogRepository.ts')).toBe(false);
    expect(/catalog-backfill/.test('db/catalogBackfill/legacyCatalogRepository.ts')).toBe(false);
    expect(CATALOG_BACKFILL_NAME_PATTERN.test('scripts/backfill-catalog-paths.ts')).toBe(true);
    expect(CATALOG_BACKFILL_NAME_PATTERN.test('db/catalogBackfill/legacyCatalogRepository.ts')).toBe(
      true,
    );
  });
});
