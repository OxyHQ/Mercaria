/**
 * The walls around the legacy-catalogue migration domain (#367 workstream 13).
 *
 * Six scanned gates over every module in `services/catalog-backfill/`,
 * `db/catalogBackfill/` and the three `scripts/backfill-catalog-*.ts` — the
 * whole DIRECTORIES, so each wall holds for modules nobody has written yet.
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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const SCANNED_DIRECTORIES = [
  join(SRC_ROOT, 'services', 'catalog-backfill'),
  join(SRC_ROOT, 'db', 'catalogBackfill'),
];

/** Every production module in the domain. Tests are excluded — they name what they refuse. */
function domainFiles(): string[] {
  const files: string[] = [];
  for (const root of SCANNED_DIRECTORIES) {
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) continue;
      if (!entry.endsWith('.ts')) continue;
      files.push(full);
    }
  }
  for (const entry of readdirSync(join(SRC_ROOT, 'scripts'))) {
    if (entry.startsWith('backfill-catalog-') && entry.endsWith('.ts')) {
      files.push(join(SRC_ROOT, 'scripts', entry));
    }
  }
  return files.sort();
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
  /services\/ranking\/|rankingPolicy|rankOffers|ranking_policy_versions|services\/fees\/|fee_schedules|marketplace_fee|services\/referral|referral_|services\/payments\//;

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
