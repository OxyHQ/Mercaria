/**
 * A foreign key never points at presentation.
 *
 * ADR 0007 D1 is the one invariant the whole catalog epic exists to establish:
 * a concept is an opaque `id` plus a stable machine `key`, and "a label, name,
 * description or slug is presentation and is never identity". D1 lists three
 * enforcement mechanisms. The first is "no foreign key in the catalog domain
 * targets a `name` or `slug` column"; the third names THIS FILE by its exact
 * basename. It did not exist until #367's documentation and invariants audit,
 * so for thirteen merged layers the invariant was a convention: the census was
 * clean and nothing would have failed if somebody had pointed a foreign key at
 * `categories.slug`.
 *
 * ## Why a foreign key onto a slug is the failure worth a gate
 *
 * It does not break anything on the day it lands. `ancestor_slugs` was exactly
 * this shape before #367 and worked for years — until a category is renamed,
 * which is an ordinary editorial act, and the rename silently becomes a graph
 * mutation. The damage is invisible in every test that does not rename
 * something, and the surface it appears on is a shopper's broken link months
 * later.
 *
 * ## Scope: the WHOLE schema, not the catalog's corner of it
 *
 * The population is every `db/schema/*.ts`, derived by walking the directory
 * rather than named in a list here. Two reasons. A hand list is blind in the
 * one direction that matters — an ADDED file — and `docs/isolation-gates.md`
 * records two "already complete" populations that passed 30 tests green with
 * new violating modules on disk. And the invariant is not catalog-specific: an
 * order line keyed on a product's display name is the same defect, and nothing
 * about D1's reasoning stops at the catalog's edge.
 *
 * ## What this deliberately does NOT do
 *
 * It does not strip comments. The failure direction of raw source is a false
 * POSITIVE — corrected in one line — while comment stripping truncates at a
 * `//` inside a string literal and can hide a real declaration. The forbidden
 * column names are therefore assembled from fragments below rather than written
 * out beside a `references(`, so this file cannot become the offender it looks
 * for.
 *
 * It does not assert anything about a column's TYPE, only about what a foreign
 * key points AT. "Is this string a display name" is undecidable from the schema;
 * "does a foreign key target a column called `slug`" is not.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const MIDDLEWARE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'middleware');

/**
 * Both spellings of a single-column foreign key.
 *
 * The house form is `.references(() => table.id)`; 47 of the 769 declarations
 * use `.references((): AnyPgColumn => table.id)`, the annotation drizzle needs
 * for a self- or circular reference. A regex covering only the first form
 * reports 722 instead of 769 and reads as a complete census — which is the
 * failure this comment exists to stop somebody re-introducing while tidying.
 */
const SINGLE_COLUMN_FK =
  /\.references\(\s*\([^)]*\)(?::\s*[A-Za-z]+)?\s*=>\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g;

/** The `foreignColumns:` member of a composite `foreignKey({ ... })`. */
const COMPOSITE_FK_BLOCK = /foreignColumns:\s*\[([^\]]*)\]/g;
const COMPOSITE_MEMBER = /([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g;

/**
 * Columns that are presentation, in both the drizzle camelCase spelling and the
 * SQL snake_case one. Assembled from fragments so a text search for the
 * forbidden shape does not land on this file.
 */
const PRESENTATION_COLUMNS: readonly string[] = [
  'na' + 'me',
  'sl' + 'ug',
  'la' + 'bel',
  'ti' + 'tle',
  'des' + 'cription',
  'han' + 'dle',
  'display' + 'Name',
  'display_' + 'name',
  'localized' + 'Name',
  'localized_' + 'name',
  'head' + 'ing',
  'cap' + 'tion',
];

/**
 * The ONE single-column foreign key in this repository whose target is not
 * `id`, with its reason.
 *
 * `entitlement_definitions.capability_key` is a stable machine key in D1's own
 * sense — immutable, lowercase, namespaced — so it is consistent with the
 * invariant and inconsistent only with D1's stricter sentence that `id` is "the
 * only thing a foreign key ever references". It is excused here rather than
 * silently admitted, and the excuse carries its own exact-count assertion plus
 * probes in both directions, per `docs/isolation-gates.md` §Exemptions.
 */
const NON_ID_TARGET_EXEMPTIONS: readonly { table: string; column: string; why: string }[] = [
  {
    table: 'entitlementDefinitions',
    column: 'capabilityKey',
    why: 'A stable machine key, not presentation: merchant plan entitlements are named by capability key so a plan definition and a seed can cite one without a uuid. ADR 0007 D1 permits a key as identity; it is only D1’s stricter "id is the only foreign-key target" sentence that this diverges from.',
  },
];

/**
 * Identity-shaped request fields that are still a bare string, frozen at
 * today's exact set.
 *
 * ADR 0007 D1's third enforcement mechanism, and the epic's own "prevent new
 * ambiguous `category: string`" checkbox. It cannot assert ZERO: the v1 listing
 * contracts accept a free-text category and a free-text `productType`, they are
 * a shipped wire contract a mobile build cannot be recalled from, and #367
 * deliberately did not break them.
 *
 * So the assertion is an exact set, not a count and not a ceiling. A NEW bare
 * identity string anywhere under `middleware/` fails this test; removing one as
 * a v1 contract retires fails it too, which is correct — the retirement is the
 * moment somebody should be reading this list.
 *
 * Note what is NOT in it: all nine of the catalog epic's own schema modules
 * (`catalog-authoring-schemas.ts`, `catalog-proposal-schemas.ts`,
 * `navigation-schemas.ts`, `facet-schemas.ts`, `compatibility-schemas.ts`,
 * `attribute-schemas.ts`, `canonical-catalog-schemas.ts`,
 * `catalog-governance-schemas.ts`, `catalog-page-schemas.ts`) contribute zero
 * rows. The epic's own contracts are clean; every entry below predates it.
 */
const LEGACY_BARE_IDENTITY_FIELDS: readonly { file: string; field: string; why: string }[] = [
  { file: 'schemas.ts', field: 'category', why: 'createP2PListingSchema (v1)' },
  { file: 'schemas.ts', field: 'category', why: 'updateListingSchema (v1)' },
  { file: 'schemas.ts', field: 'productType', why: 'updateListingSchema — the Shopify free-text field, not a product type definition' },
  { file: 'schemas.ts', field: 'category', why: 'createStoreProductSchema (v1)' },
  { file: 'schemas.ts', field: 'productType', why: 'createStoreProductSchema — the Shopify free-text field' },
  { file: 'schemas.ts', field: 'productType', why: 'ingestProductSchema — the plugin push contract, mirrors the platform field' },
  { file: 'sell-yours-schemas.ts', field: 'category', why: 'patchSellerDraftSchema — beside a real canonicalProductId' },
];

/** Field names that must never be a bare string in a request schema. */
const IDENTITY_SHAPED_FIELDS = [
  'categ' + 'ory',
  'category' + 'Name',
  'option' + 'Name',
  'attribute' + 'Name',
  'product' + 'Type',
  'productType' + 'Name',
  'bra' + 'nd',
  'brand' + 'Name',
  'controlled' + 'Value',
];

const BARE_IDENTITY_FIELD = new RegExp(
  `^\\s*(${IDENTITY_SHAPED_FIELDS.join('|')})\\s*:\\s*z\\.string\\(`,
  'u',
);

/** Floors, per SHAPE, set to today's counts. One total would let a shape collapse to zero. */
const MINIMUM_SCHEMA_FILES = 78;
const MINIMUM_SINGLE_COLUMN_FKS = 740;
const MINIMUM_COMPOSITE_FK_TARGETS = 15;
const MINIMUM_MIDDLEWARE_FILES = 60;

interface ForeignKeyTarget {
  readonly file: string;
  readonly table: string;
  readonly column: string;
  readonly shape: 'single' | 'composite';
}

function readSchemaSources(): { file: string; source: string }[] {
  const files = readdirSync(SCHEMA_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .sort();
  return files.map((file) => {
    const path = join(SCHEMA_DIR, file);
    // A readdir that returned a cached or empty result reads exactly like a
    // clean scan; stat every path so it cannot.
    expect(statSync(path).size, `${file} is empty`).toBeGreaterThan(200);
    return { file, source: readFileSync(path, 'utf8') };
  });
}

function collectForeignKeyTargets(sources: { file: string; source: string }[]): ForeignKeyTarget[] {
  const targets: ForeignKeyTarget[] = [];
  for (const { file, source } of sources) {
    for (const match of source.matchAll(SINGLE_COLUMN_FK)) {
      targets.push({ file, table: match[1], column: match[2], shape: 'single' });
    }
    for (const block of source.matchAll(COMPOSITE_FK_BLOCK)) {
      for (const member of block[1].matchAll(COMPOSITE_MEMBER)) {
        targets.push({ file, table: member[1], column: member[2], shape: 'composite' });
      }
    }
  }
  return targets;
}

function isPresentationColumn(column: string): boolean {
  return PRESENTATION_COLUMNS.includes(column);
}

describe('catalog identity: a foreign key never points at presentation (ADR 0007 D1)', () => {
  const sources = readSchemaSources();
  const targets = collectForeignKeyTargets(sources);
  const single = targets.filter((t) => t.shape === 'single');
  const composite = targets.filter((t) => t.shape === 'composite');

  it('walked a real population', () => {
    expect(sources.length).toBeGreaterThanOrEqual(MINIMUM_SCHEMA_FILES);
    expect(single.length).toBeGreaterThanOrEqual(MINIMUM_SINGLE_COLUMN_FKS);
    expect(composite.length).toBeGreaterThanOrEqual(MINIMUM_COMPOSITE_FK_TARGETS);
    // Printed on SUCCESS: a floor that is met tells you nothing about the size
    // of what met it, and the number is how the next reader notices a collapse.
    console.log(
      `[catalog-identity] ${sources.length} schema files; ${single.length} single-column foreign keys; ${composite.length} composite foreign-key target columns.`,
    );
  });

  it('CLAUSE 1 — no foreign key, single or composite, targets a presentation column', () => {
    const offenders = targets
      .filter((t) => isPresentationColumn(t.column))
      .map((t) => `${t.file}: ${t.table}.${t.column} (${t.shape})`);
    expect(offenders).toEqual([]);
  });

  it('CLAUSE 2 — every single-column foreign key targets `id`, except the named exemptions', () => {
    const exempt = new Set(NON_ID_TARGET_EXEMPTIONS.map((e) => `${e.table}.${e.column}`));
    const offenders = single
      .filter((t) => t.column !== 'id' && !exempt.has(`${t.table}.${t.column}`))
      .map((t) => `${t.file}: ${t.table}.${t.column}`);
    expect(offenders).toEqual([]);
    const idTargets = single.filter((t) => t.column === 'id').length;
    console.log(
      `[catalog-identity] ${idTargets} of ${single.length} single-column foreign keys target \`id\`; ${single.length - idTargets} exempt.`,
    );
  });

  it('CLAUSE 2 — the exemption list is exactly one, and it still fires', () => {
    // Its own exact-count assertion: a list of excuses that can grow silently
    // is the mechanism by which a gate erodes to `>= 0`.
    expect(NON_ID_TARGET_EXEMPTIONS).toHaveLength(1);
    for (const exemption of NON_ID_TARGET_EXEMPTIONS) {
      expect(exemption.why.length).toBeGreaterThan(60);
      // Does it still fire? The excused declaration must still be in the walk's
      // own output — an exemption for something nobody writes any more is an
      // excuse nobody is using, and it should be deleted rather than kept.
      const stillPresent = single.some(
        (t) => t.table === exemption.table && t.column === exemption.column,
      );
      expect(stillPresent, `${exemption.table}.${exemption.column} is excused but no longer exists`).toBe(true);
    }
  });

  it('CLAUSE 2 — could an exemption EVER fire? a shape the walk never produces must fail', () => {
    // The other direction, and the one a size assertion cannot see: three of six
    // exemptions in another guard in this repository were structurally
    // unmatchable from birth (a camelCase segment against a lowercase-only
    // pattern), and a reconciliation reports zero for that exactly as it does
    // for a legitimately removed subject.
    const unmatchable = { table: 'entitlement_definitions', column: 'capability_key' };
    const wouldEverMatch = single.some(
      (t) => t.table === unmatchable.table && t.column === unmatchable.column,
    );
    expect(
      wouldEverMatch,
      'the walk produces camelCase identifiers, so a snake_case exemption could never match anything',
    ).toBe(false);
  });

  it('CLAUSE 3 — no NEW bare identity-shaped string in a request schema', () => {
    const files = readdirSync(MIDDLEWARE_DIR)
      .filter((entry) => entry.endsWith('.ts'))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_MIDDLEWARE_FILES);

    const found: { file: string; field: string; line: number }[] = [];
    for (const file of files) {
      const path = join(MIDDLEWARE_DIR, file);
      expect(statSync(path).size, `${file} is empty`).toBeGreaterThan(0);
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const match = BARE_IDENTITY_FIELD.exec(line);
        if (match) found.push({ file, field: match[1], line: index + 1 });
      });
    }

    const asKey = (entry: { file: string; field: string }) => `${entry.file}:${entry.field}`;
    const foundCounts = new Map<string, number>();
    for (const entry of found) foundCounts.set(asKey(entry), (foundCounts.get(asKey(entry)) ?? 0) + 1);
    const expectedCounts = new Map<string, number>();
    for (const entry of LEGACY_BARE_IDENTITY_FIELDS) {
      expectedCounts.set(asKey(entry), (expectedCounts.get(asKey(entry)) ?? 0) + 1);
    }

    expect(Object.fromEntries([...foundCounts].sort())).toEqual(
      Object.fromEntries([...expectedCounts].sort()),
    );
    console.log(
      `[catalog-identity] ${files.length} request-schema modules; ${found.length} legacy bare identity fields, all pre-#367; 0 in the epic's own nine schema modules.`,
    );
  });

  it('CLAUSE 3 — the catalog epic’s own request schemas contribute none of them', () => {
    // Named separately from the frozen set above, because "the total is 7" and
    // "none of the 7 is ours" are different facts and the first can stay true
    // while the second stops being.
    const epicModules = [
      'catalog-authoring-schemas.ts',
      'catalog-proposal-schemas.ts',
      'catalog-governance-schemas.ts',
      'catalog-page-schemas.ts',
      'navigation-schemas.ts',
      'facet-schemas.ts',
      'compatibility-schemas.ts',
      'attribute-schemas.ts',
      'canonical-catalog-schemas.ts',
    ];
    const offenders: string[] = [];
    for (const file of epicModules) {
      const path = join(MIDDLEWARE_DIR, file);
      expect(statSync(path).size, `${file} is missing or empty`).toBeGreaterThan(200);
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const match = BARE_IDENTITY_FIELD.exec(line);
          if (match) offenders.push(`${file}:${index + 1} ${match[1]}`);
        });
    }
    expect(offenders).toEqual([]);
    expect(epicModules).toHaveLength(9);
  });

  describe('mutation self-tests — each clause, against source the detectors never receive from disk', () => {
    it('CLAUSE 1 fires on a foreign key aimed at a slug, in both foreign-key shapes', () => {
      const single = collectForeignKeyTargets([
        {
          file: 'synthetic.ts',
          source: 'categoryId: text().references(() => categories.slug, { onDelete: 1 }),',
        },
      ]);
      expect(single).toHaveLength(1);
      expect(isPresentationColumn(single[0].column)).toBe(true);

      const composed = collectForeignKeyTargets([
        {
          file: 'synthetic.ts',
          source: 'foreignKey({ columns: [t.a, t.b], foreignColumns: [categories.id, categories.name] })',
        },
      ]);
      expect(composed).toHaveLength(2);
      expect(composed.filter((t) => isPresentationColumn(t.column))).toHaveLength(1);
    });

    it('CLAUSE 1 does NOT fire on the legitimate shapes it sits beside', () => {
      // A detector that cannot tell a legitimate value from its quarry is worse
      // than none: it gets narrowed under pressure, and the narrowing is the
      // permissive direction.
      const clean = collectForeignKeyTargets([
        {
          file: 'synthetic.ts',
          source: [
            'parentId: text().references((): AnyPgColumn => categories.id),',
            'ownerId: text().references(() => stores.id, { onDelete: "cascade" }),',
            'foreignColumns: [productTypeFieldGroups.id, productTypeFieldGroups.productTypeDefinitionId],',
          ].join('\n'),
        },
      ]);
      expect(clean).toHaveLength(4);
      expect(clean.filter((t) => isPresentationColumn(t.column))).toEqual([]);
    });

    it('the typed-arrow spelling is counted — the regex that misses it reads as a clean census', () => {
      const typed = collectForeignKeyTargets([
        { file: 'synthetic.ts', source: 'x: text().references((): AnyPgColumn => t.slug),' },
      ]);
      expect(typed).toHaveLength(1);
      expect(typed[0].column).toBe('sl' + 'ug');
    });

    it('CLAUSE 3 fires on a new bare identity string and not on the id-shaped form beside it', () => {
      expect(BARE_IDENTITY_FIELD.test('  category: z.string().trim().min(1),')).toBe(true);
      expect(BARE_IDENTITY_FIELD.test('    productType: z.string().optional(),')).toBe(true);
      expect(BARE_IDENTITY_FIELD.test('  categoryId: z.string().min(1),')).toBe(false);
      expect(BARE_IDENTITY_FIELD.test('  categoryKey: z.string().min(1),')).toBe(false);
      expect(BARE_IDENTITY_FIELD.test('  productTypeKey: z.string(),')).toBe(false);
    });
  });
});
