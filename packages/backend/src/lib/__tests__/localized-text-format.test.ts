/**
 * Which localized fields carry plain text and which carry structured rich text,
 * and the refusal that makes the declaration mean something (#367 line 187).
 *
 * Four kinds of gate live here, and each exists because the thing it measures
 * fails SILENTLY.
 *
 * 1. **The population walk.** A sanitization policy that covers most of its
 *    subject is not a smaller version of one — the column it misses is the whole
 *    finding. So the population is derived twice from the running schema (every
 *    `locale`-bearing table; every table carrying all seven family columns) and
 *    every walked table must be either IN SCOPE or excluded WITH A REASON.
 *    Silence is not a disposition.
 * 2. **The vocabulary gates.** The permitted structure tuple is closed and
 *    disjoint from the fourteen prohibitions, and no descriptor may permit
 *    anything outside it.
 * 3. **The behaviour, over EVERY declared key.** Not over a sample: four
 *    identical tie-breaks were mutated one epic over and three were defended by
 *    accident, because only one fixture contained the collision.
 * 4. **The live surfaces, through PRODUCTION's own schemas.** Every case calls
 *    `.parse()` on the exported zod object the route mounts, never on the
 *    assertion — a test that called `assertLocalizedText` directly would stay
 *    green after somebody removed the check from a field.
 *
 * Every detector here carries its own mutation self-test, separately, and every
 * census carries a vacuity floor. `expect(found).toBe(LIST.length)` is not one
 * of them: an assertion driven by the list it is checking cannot fail.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_LOCALIZATION_TEXT_TABLES,
  LOCALIZATION_FAMILY_COLUMNS,
  LOCALE_SCOPED_TABLES_WITHOUT_LOCALIZED_COPY,
  LOCALIZED_TEXT_COLUMNS_WITHOUT_LOCALIZED_COPY,
  LOCALIZED_FORBIDDEN_TEXT_STRUCTURES,
  LOCALIZED_RICH_TEXT_STRUCTURES,
  LOCALIZED_TEXT_COLUMN_KEYS,
  LOCALIZED_TEXT_FIELDS,
  LOCALIZED_TEXT_FORMATS,
  PLAIN_LOCALIZED_TEXT_COLUMN_KEYS,
  RICH_LOCALIZED_TEXT_COLUMN_KEYS,
  type LocalizedTextColumnKey,
} from '@mercaria/shared-types';
import * as schema from '../../db/schema/index.js';
import { assertLocalizedText, containsMarkup, structuresIn } from '../localized-text.js';
import { stripHtmlTags } from '../../services/feed-import/transforms.js';
import { upsertListingLocalizationSchema } from '../../middleware/listing-localization-schemas.js';
import { reviewLocalizationSchema } from '../../middleware/catalog-governance-schemas.js';
import { replaceNavigationNodesBodySchema } from '../../middleware/navigation-schemas.js';
import { attributeDefinitionDraftSchema } from '../../middleware/attribute-schemas.js';
import { canonicalProductObservationSchema } from '../../middleware/canonical-catalog-schemas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC = join(HERE, '..', '..');

const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/** Structural columns the family adds, which are never localized copy. */
const STRUCTURAL = new Set<string>([
  'id',
  ...LOCALIZATION_FAMILY_COLUMNS,
  'created_at',
  'updated_at',
]);

interface WalkedColumn {
  readonly table: string;
  readonly column: string;
}

/**
 * Every locale-scoped FREE-TEXT column in the running schema.
 *
 * Runtime reflection, not a source grep: eight of the nine family tables get
 * `locale` from the `localizationColumns()` spread and a grep for `locale:`
 * finds one of them. `sqlColumnName` and not the TS property: the census
 * `differs` case below proves why.
 *
 * "Free text" is `text()` with no `enum` — a closed vocabulary is a state, not
 * authored copy — and not an id and not a structural family column.
 */
function walkLocaleScopedTables(): {
  readonly tables: readonly string[];
  readonly columns: readonly WalkedColumn[];
} {
  const seen: string[] = [];
  const columns: WalkedColumn[] = [];
  for (const table of tables) {
    const entries = Object.values(getTableColumns(table as never)).map(
      (column) => [sqlColumnName(column as never), column as Record<string, unknown>] as const,
    );
    if (!entries.some(([name]) => name === 'locale')) continue;
    const tableName = getTableName(table as never);
    seen.push(tableName);
    for (const [name, column] of entries) {
      if (column.columnType !== 'PgText') continue;
      if (STRUCTURAL.has(name) || name === 'locale' || name.endsWith('_id')) continue;
      const enumValues = column.enumValues as readonly string[] | undefined;
      if (enumValues !== undefined && enumValues.length > 0) continue;
      columns.push({ table: tableName, column: name });
    }
  }
  return { tables: seen.sort(), columns };
}

const walked = walkLocaleScopedTables();

/** The tables whose free-text columns this policy declares. */
const IN_SCOPE_TABLES = [
  ...new Set(LOCALIZED_TEXT_COLUMN_KEYS.map((key) => LOCALIZED_TEXT_FIELDS[key].table)),
].sort();

describe('the population is walked, and every walked table has a disposition', () => {
  it('CONTROL — the TS property is not the SQL column name here, so a property-keyed probe lies', () => {
    // The premise the whole walk rests on, measured rather than assumed. If this
    // ever reported zero, `sqlColumnName` would be redundant and a reader would
    // be right to remove it.
    let differs = 0;
    let total = 0;
    for (const table of tables) {
      for (const [property, column] of Object.entries(getTableColumns(table as never))) {
        total++;
        if (sqlColumnName(column as never) !== property) differs++;
      }
    }
    expect(total).toBeGreaterThan(5_000);
    expect(differs).toBeGreaterThan(total / 2);
  });

  it('VACUITY FLOOR — the walk actually found a schema', () => {
    expect(tables.length).toBeGreaterThan(400);
    expect(walked.tables.length).toBeGreaterThanOrEqual(25);
    expect(walked.columns.length).toBeGreaterThanOrEqual(80);
  });

  it('derives the localization family from its seven columns, reproducing the declared list', () => {
    const derived = tables
      .filter((table) => {
        const names = new Set(
          Object.values(getTableColumns(table as never)).map((c) => sqlColumnName(c as never)),
        );
        return LOCALIZATION_FAMILY_COLUMNS.every((column) => names.has(column));
      })
      .map((table) => getTableName(table as never))
      .sort();
    expect(derived.length).toBeGreaterThanOrEqual(9);
    expect(derived).toEqual([...CATALOG_LOCALIZATION_TEXT_TABLES].sort());
  });

  it('partitions every locale-bearing table into IN SCOPE or excluded-with-a-reason', () => {
    const excluded = Object.keys(LOCALE_SCOPED_TABLES_WITHOUT_LOCALIZED_COPY);
    // Neither set may be empty, or the partition is satisfied by putting
    // everything on one side of it.
    expect(IN_SCOPE_TABLES.length).toBeGreaterThanOrEqual(9);
    expect(excluded.length).toBeGreaterThanOrEqual(10);
    // Disjoint: a table cannot be both.
    expect(IN_SCOPE_TABLES.filter((table) => excluded.includes(table))).toEqual([]);
    // Exhaustive, in BOTH directions. A new locale-bearing table fails here; an
    // exclusion naming a table that no longer exists fails here too.
    expect([...IN_SCOPE_TABLES, ...excluded].sort()).toEqual([...walked.tables]);
  });

  it('gives every exclusion a reason somebody wrote', () => {
    for (const [table, reason] of Object.entries(LOCALE_SCOPED_TABLES_WITHOUT_LOCALIZED_COPY)) {
      expect(reason.length, table).toBeGreaterThan(40);
    }
  });

  it('declares every free-text column of every IN SCOPE table, or excuses it by name', () => {
    const excusedColumns = Object.keys(LOCALIZED_TEXT_COLUMNS_WITHOUT_LOCALIZED_COPY);
    const expected = walked.columns
      .filter((column) => IN_SCOPE_TABLES.includes(column.table))
      .map((column) => `${column.table}.${column.column}`)
      .sort();
    expect(expected.length).toBeGreaterThanOrEqual(20);
    // Disjoint, then exhaustive in both directions.
    expect(excusedColumns.filter((key) => LOCALIZED_TEXT_COLUMN_KEYS.includes(key as never))).toEqual(
      [],
    );
    expect([...LOCALIZED_TEXT_COLUMN_KEYS, ...excusedColumns].sort()).toEqual(expected);
    for (const [column, reason] of Object.entries(LOCALIZED_TEXT_COLUMNS_WITHOUT_LOCALIZED_COPY)) {
      expect(reason.length, column).toBeGreaterThan(40);
    }
  });

  it('states each column\'s TypeScript property, checked against the real drizzle table', () => {
    // `assertLocalizedRow` is keyed on the PROPERTY a writer passes. It is
    // STATED rather than folded from the SQL name — a `_x` → `X` derivation is a
    // content fold and `script-coverage-census.test.ts` demanded six scripts of
    // fixtures for it — so THIS is what stops it being a second spelling that
    // can drift: the property is compared against what the schema declares.
    const byTable = new Map<string, readonly (readonly [string, string])[]>(
      tables.map((table) => [
        String(getTableName(table as never)),
        Object.entries(getTableColumns(table as never)).map(
          ([property, column]) => [property, sqlColumnName(column as never)] as const,
        ),
      ]),
    );
    let checked = 0;
    for (const key of LOCALIZED_TEXT_COLUMN_KEYS) {
      const field = LOCALIZED_TEXT_FIELDS[key];
      const columns = byTable.get(field.table);
      expect(columns, field.table).toBeDefined();
      const match = (columns ?? []).find(([, sqlName]) => sqlName === field.column);
      expect(match, key).toBeDefined();
      expect(match?.[0], key).toBe(field.property);
      checked++;
    }
    expect(checked).toBe(LOCALIZED_TEXT_COLUMN_KEYS.length);
    expect(checked).toBeGreaterThanOrEqual(20);
    // At least three columns genuinely differ between the two spellings, or this
    // case would pass against a `property` field nobody ever had to state.
    expect(
      LOCALIZED_TEXT_COLUMN_KEYS.filter(
        (key) => LOCALIZED_TEXT_FIELDS[key].property !== LOCALIZED_TEXT_FIELDS[key].column,
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('MUTATION SELF-TEST — the column walk notices a column it was not told about', () => {
    // Feeding the comparison a column the declaration does not carry must turn
    // it red. Without this the equality above is satisfied by a walk that
    // returns whatever the declaration says.
    const withExtra = [
      ...walked.columns
        .filter((column) => IN_SCOPE_TABLES.includes(column.table))
        .map((column) => `${column.table}.${column.column}`),
      'listing_localizations.subtitle',
    ].sort();
    const covered = [
      ...LOCALIZED_TEXT_COLUMN_KEYS,
      ...Object.keys(LOCALIZED_TEXT_COLUMNS_WITHOUT_LOCALIZED_COPY),
    ].sort();
    expect(covered).not.toEqual(withExtra);
  });
});

describe('the vocabulary is closed and the prohibitions are disjoint from it', () => {
  it('has exactly the two formats, derived and never stated twice', () => {
    expect([...LOCALIZED_TEXT_FORMATS].sort()).toEqual(['plain', 'rich']);
    for (const key of LOCALIZED_TEXT_COLUMN_KEYS) {
      const field = LOCALIZED_TEXT_FIELDS[key];
      expect(field.format, key).toBe(field.structures.length === 0 ? 'plain' : 'rich');
    }
  });

  it('keeps the permitted and forbidden structures disjoint, both non-empty', () => {
    expect(LOCALIZED_RICH_TEXT_STRUCTURES.length).toBeGreaterThanOrEqual(2);
    expect(LOCALIZED_FORBIDDEN_TEXT_STRUCTURES.length).toBeGreaterThanOrEqual(10);
    const permitted = new Set<string>(LOCALIZED_RICH_TEXT_STRUCTURES);
    for (const forbidden of LOCALIZED_FORBIDDEN_TEXT_STRUCTURES) {
      expect(permitted.has(forbidden), forbidden).toBe(false);
    }
    // …and no duplicates inside either, which would make a set-size check lie.
    expect(new Set(LOCALIZED_FORBIDDEN_TEXT_STRUCTURES).size).toBe(
      LOCALIZED_FORBIDDEN_TEXT_STRUCTURES.length,
    );
  });

  it('lets no descriptor permit a structure outside the allow-list', () => {
    const permitted = new Set<string>(LOCALIZED_RICH_TEXT_STRUCTURES);
    for (const key of LOCALIZED_TEXT_COLUMN_KEYS) {
      for (const structure of LOCALIZED_TEXT_FIELDS[key].structures) {
        expect(permitted.has(structure), `${key}:${structure}`).toBe(true);
      }
    }
  });

  it('refuses a permitted set that admits a blank line and not the newlines it is made of', () => {
    for (const key of LOCALIZED_TEXT_COLUMN_KEYS) {
      const structures = LOCALIZED_TEXT_FIELDS[key].structures;
      if (structures.includes('paragraph_break')) {
        expect(structures, key).toContain('line_break');
      }
    }
  });

  it('PINS THE CLASSIFICATION ITSELF, which the cases below cannot', () => {
    // Every behavioural case in this file is parameterised over
    // PLAIN_/RICH_LOCALIZED_TEXT_COLUMN_KEYS, which are DERIVED from the map
    // under test — so moving a field from plain to rich changes which cases run
    // and every one of them still passes. Measured: that exact mutation
    // survived the whole file. A classification is a DECISION, so it is pinned
    // against a list written HERE; reclassifying a field now takes an edit in
    // two places, which is what makes it deliberate.
    expect([...PLAIN_LOCALIZED_TEXT_COLUMN_KEYS].sort()).toEqual([
      'attribute_labels.label',
      'attribute_value_localizations.label',
      'canonical_images.alt',
      'canonical_product_family_localizations.name',
      'canonical_product_localizations.name',
      'category_localizations.name',
      'listing_localizations.title',
      'navigation_node_localizations.accessibility_label',
      'navigation_node_localizations.label',
      'product_type_field_localizations.example',
      'product_type_field_localizations.label',
      'product_type_field_localizations.placeholder',
      'product_type_localizations.name',
    ]);
    expect([...RICH_LOCALIZED_TEXT_COLUMN_KEYS].sort()).toEqual([
      'attribute_labels.description',
      'attribute_value_localizations.description',
      'canonical_product_family_localizations.description',
      'canonical_product_localizations.description',
      'category_localizations.description',
      'listing_localizations.description',
      'navigation_node_localizations.description',
      'product_type_field_localizations.help_text',
      'product_type_localizations.description',
      'product_type_localizations.help_text',
    ]);
  });

  it('VACUITY FLOOR — both formats are exercised by real columns', () => {
    // A declaration where every field is plain would pass every rich case below
    // by never running one.
    expect(PLAIN_LOCALIZED_TEXT_COLUMN_KEYS.length).toBeGreaterThanOrEqual(5);
    expect(RICH_LOCALIZED_TEXT_COLUMN_KEYS.length).toBeGreaterThanOrEqual(5);
    expect(
      PLAIN_LOCALIZED_TEXT_COLUMN_KEYS.length + RICH_LOCALIZED_TEXT_COLUMN_KEYS.length,
    ).toBe(LOCALIZED_TEXT_COLUMN_KEYS.length);
  });
});

/** What an injection attempt looks like, in the encodings this repository decodes. */
const MARKUP_PAYLOADS: readonly string[] = [
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&lt;img src=x onerror=alert(1)&gt;',
  '<a href="javascript:alert(1)">click</a>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<scr<b>ipt>alert(1)</scr<b>ipt>',
  '<b>Rebajas</b>',
];

describe('the markup detector is the stripper asked a question, not a second pattern', () => {
  it.each(MARKUP_PAYLOADS)('sees markup in `%s`', (payload) => {
    expect(containsMarkup(`antes ${payload} despues`)).toBe(true);
  });

  it('NEGATIVE CONTROL — leaves text a seller would legitimately type alone', () => {
    // A detector that fired on these would refuse real listings, and nothing in
    // a green suite would say so.
    for (const clean of [
      'cabe en telefonos 12 < 15 cm',
      'menos de 10 € — ¡oferta!',
      'Bold &amp; brave',
      'Talla > XL',
      'H2O <3',
      'Pixel 9 Pro, 256 GB',
      '中文标题 3 < 5',
    ]) {
      expect(containsMarkup(clean), clean).toBe(false);
    }
  });

  it('agrees with the owner of the pattern, which is what makes it one pattern', () => {
    // If this ever disagreed, there would be two tag patterns in the repository
    // and the docblock's claim would be false.
    for (const payload of MARKUP_PAYLOADS) {
      const decoded = payload.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>');
      expect(stripHtmlTags(decoded) !== decoded).toBe(true);
    }
  });
});

describe('the structure detector reports what a value actually carries', () => {
  it('finds a line break and a paragraph break, and the second implies the first', () => {
    expect(structuresIn('una linea')).toEqual([]);
    expect(structuresIn('una\nlinea')).toEqual(['line_break']);
    expect([...structuresIn('parrafo\n\notro')].sort()).toEqual(['line_break', 'paragraph_break']);
    // A blank line with trailing spaces on it is still a blank line.
    expect([...structuresIn('parrafo\n   \notro')].sort()).toEqual([
      'line_break',
      'paragraph_break',
    ]);
    expect([...structuresIn('a\r\n\r\nb')].sort()).toEqual(['line_break', 'paragraph_break']);
    // REGRESSION — a single Windows line break is ONE line break. The obvious
    // `[\n\r][^\S\n\r]*[\n\r]` blank-line pattern matches `\r\n` itself and
    // reports a paragraph break for it. Nothing observable changes today
    // (a plain field refuses both, a rich field permits both), which is exactly
    // why it needs a case: it starts mattering the moment a descriptor permits
    // `line_break` alone, and the descriptor shape already allows that.
    expect(structuresIn('a\r\nb')).toEqual(['line_break']);
    expect(structuresIn('a\rb')).toEqual(['line_break']);
  });

  it('MUTATION SELF-TEST — each half is detected by its own rule', () => {
    // Two separate detectors, mutated separately: a fixture carrying a blank
    // line would defend the line-break rule by accident.
    expect(structuresIn('solo\nsalto')).not.toContain('paragraph_break');
    expect(structuresIn('sin saltos')).not.toContain('line_break');
  });
});

describe('the refusal is asymmetric, and every declared key is driven through it', () => {
  it.each([...LOCALIZED_TEXT_COLUMN_KEYS])('refuses markup in `%s`', (key) => {
    for (const payload of MARKUP_PAYLOADS) {
      expect(() => assertLocalizedText(key, `antes ${payload} despues`), payload).toThrow(/markup/u);
    }
  });

  it.each([...LOCALIZED_TEXT_COLUMN_KEYS])('accepts clean single-line text in `%s`', (key) => {
    // The vacuity control. Without it every refusal above is satisfied by a
    // function that throws on everything.
    const clean = 'Zapatillas de correr, talla 42';
    expect(assertLocalizedText(key, clean)).toBe(clean);
  });

  it.each([...PLAIN_LOCALIZED_TEXT_COLUMN_KEYS])('refuses a line break in plain `%s`', (key) => {
    expect(() => assertLocalizedText(key, 'primera\nsegunda')).toThrow(/line_break/u);
    expect(() => assertLocalizedText(key, 'primera\n\nsegunda')).toThrow(/line_break/u);
  });

  it.each([...RICH_LOCALIZED_TEXT_COLUMN_KEYS])('keeps paragraph structure in rich `%s`', (key) => {
    const block = 'Primer parrafo.\n\nSegundo parrafo.\nUna linea mas.';
    expect(assertLocalizedText(key, block)).toBe(block);
  });

  it('NEVER SHORTENS — the caller\'s own .max() still bounds what is stored', () => {
    // `sanitizeAuthoredText` may only shorten; this may not change the value at
    // all. If it did, a `.max()` checked on the raw input would stop being a
    // bound on the stored one.
    for (const key of LOCALIZED_TEXT_COLUMN_KEYS) {
      const value = 'a'.repeat(200);
      expect(assertLocalizedText(key, value)).toBe(value);
    }
  });

  it('names the field and the declaration in the refusal', () => {
    // An operator reading a 400 has to be able to find the decision.
    try {
      assertLocalizedText('listing_localizations.title', '<b>x</b>');
      expect.unreachable('markup must be refused');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('listing_localizations.title');
      expect(message).toContain('LOCALIZED_TEXT_FIELDS');
    }
  });
});

/**
 * A body each production schema accepts, with the field under test filled in.
 *
 * Every case goes through the EXPORTED schema the route mounts. Calling
 * `assertLocalizedText` directly would keep this file green after somebody
 * removed the builder from a field, which is the failure mode it exists for.
 */
const SURFACE_PROBES: Readonly<
  Partial<Record<LocalizedTextColumnKey, (value: string) => unknown>>
> = {
  'listing_localizations.title': (value) =>
    upsertListingLocalizationSchema.parse({ title: value }),
  'listing_localizations.description': (value) =>
    upsertListingLocalizationSchema.parse({ title: 'Titulo', description: value }),
  'category_localizations.name': (value) =>
    reviewLocalizationSchema.parse({
      entity: 'category',
      entityId: 'cat_1',
      locale: 'es',
      status: 'approved',
      name: value,
      reason: 'revision',
    }),
  'category_localizations.description': (value) =>
    reviewLocalizationSchema.parse({
      entity: 'category',
      entityId: 'cat_1',
      locale: 'es',
      status: 'approved',
      description: value,
      reason: 'revision',
    }),
  'product_type_localizations.name': (value) =>
    reviewLocalizationSchema.parse({
      entity: 'product_type',
      entityId: 'pt_1',
      locale: 'es',
      status: 'approved',
      name: value,
      reason: 'revision',
    }),
  'product_type_localizations.description': (value) =>
    reviewLocalizationSchema.parse({
      entity: 'product_type',
      entityId: 'pt_1',
      locale: 'es',
      status: 'approved',
      description: value,
      reason: 'revision',
    }),
  'attribute_labels.label': (value) =>
    attributeDefinitionDraftSchema.parse({
      key: 'screen_size',
      label: 'Screen size',
      valueType: 'measurement',
      labels: [{ locale: 'es', label: value }],
    }),
  'attribute_labels.description': (value) =>
    attributeDefinitionDraftSchema.parse({
      key: 'screen_size',
      label: 'Screen size',
      valueType: 'measurement',
      labels: [{ locale: 'es', label: 'Tamano', description: value }],
    }),
  'navigation_node_localizations.label': (value) =>
    replaceNavigationNodesBodySchema.parse({
      nodes: [navigationNode({ label: value })],
    }),
  'navigation_node_localizations.description': (value) =>
    replaceNavigationNodesBodySchema.parse({
      nodes: [navigationNode({ label: 'Menu', description: value })],
    }),
  'navigation_node_localizations.accessibility_label': (value) =>
    replaceNavigationNodesBodySchema.parse({
      nodes: [navigationNode({ label: 'Menu', accessibilityLabel: value })],
    }),
  'canonical_images.alt': (value) =>
    canonicalProductObservationSchema.parse({
      sourceId: 'src_1',
      externalId: 'ext_1',
      observedAt: '2026-01-01T00:00:00.000Z',
      method: 'operator',
      matchRule: 'operator-observation',
      images: [{ sourceUrl: 'https://example.test/a.jpg', alt: value, locale: 'es' }],
    }),
};

function navigationNode(localization: Record<string, unknown>): Record<string, unknown> {
  return {
    key: 'menu.node',
    position: 0,
    target: { kind: 'category', categoryId: 'cat_1' },
    localizations: [
      { locale: 'es', status: 'approved', provenance: 'mercaria', ...localization },
    ],
  };
}

describe('the live request surfaces apply the declaration', () => {
  const probed = Object.keys(SURFACE_PROBES) as LocalizedTextColumnKey[];

  it('VACUITY FLOOR — there are probes, and they cover every declared surface', () => {
    expect(probed.length).toBeGreaterThanOrEqual(11);
    for (const key of probed) expect(LOCALIZED_TEXT_COLUMN_KEYS).toContain(key);
  });

  it.each(Object.keys(SURFACE_PROBES) as LocalizedTextColumnKey[])(
    'refuses markup through the real schema for `%s`',
    (key) => {
      const probe = SURFACE_PROBES[key];
      expect(probe).toBeDefined();
      expect(() => probe?.('<script>alert(1)</script>')).toThrow();
      expect(() => probe?.('&lt;b&gt;Rebajas&lt;/b&gt;')).toThrow();
    },
  );

  it.each(Object.keys(SURFACE_PROBES) as LocalizedTextColumnKey[])(
    'accepts clean text through the real schema for `%s`',
    (key) => {
      // The control that stops the case above passing against a schema that
      // rejects every body it is handed.
      expect(() => SURFACE_PROBES[key]?.('Zapatillas de correr')).not.toThrow();
    },
  );

  it.each(
    (Object.keys(SURFACE_PROBES) as LocalizedTextColumnKey[]).filter(
      (key) => LOCALIZED_TEXT_FIELDS[key].format === 'plain',
    ),
  )('refuses a line break through the real schema for plain `%s`', (key) => {
    expect(() => SURFACE_PROBES[key]?.('primera\nsegunda')).toThrow();
  });

  it.each(
    (Object.keys(SURFACE_PROBES) as LocalizedTextColumnKey[]).filter(
      (key) => LOCALIZED_TEXT_FIELDS[key].format === 'rich',
    ),
  )('accepts a paragraph break through the real schema for rich `%s`', (key) => {
    expect(() => SURFACE_PROBES[key]?.('Primero.\n\nSegundo.')).not.toThrow();
  });

  it('a listing localization keeps its description byte for byte', () => {
    const description = 'Primer parrafo.\n\nSegundo parrafo.';
    const parsed = upsertListingLocalizationSchema.parse({ title: 'Titulo', description });
    expect(parsed.description).toBe(description);
    expect(parsed.title).toBe('Titulo');
  });

  it('CONTRAST — the base-locale AUTHORING path still CLEANS rather than refusing', () => {
    // Pinned rather than assumed, and it is the divergence this box deliberately
    // did not close: `catalog-authoring-schemas.ts` has been accepting pasted
    // markup for as long as it has existed, so turning it into a 400 would start
    // refusing sellers mid-session. That convergence is #367 steps 5 and 6's.
    // This assertion is what stops somebody "unifying" the two by pointing the
    // localization path at the transform.
    expect(stripHtmlTags('<b>x</b>')).not.toBe('<b>x</b>');
    expect(() => assertLocalizedText('listing_localizations.title', '<b>x</b>')).toThrow();
  });
});

/** Strip block and line comments. A census over source must exclude them. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

function walkSource(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walkSource(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The drizzle SYMBOL each in-scope table is written through, and the production
 * modules that write it.
 *
 * MEASURED, not transcribed — the assertion below re-derives the module list
 * from source and compares. A table gaining a writer therefore fails this file
 * until somebody says whether the new writer needs the declaration applied,
 * which is the only thing that keeps the eleven columns with no request surface
 * from being a promise.
 */
interface WriterRecord {
  readonly symbol: string;
  readonly modules: readonly string[];
  /**
   * A module that legitimately writes this table WITHOUT applying the
   * declaration, and the reason — naming the PATH, never the category. Every
   * other recorded module must call the assertion for every declared column.
   */
  readonly unassertedModules?: Readonly<Record<string, string>>;
}

const WRITERS: Readonly<Record<string, WriterRecord>> =
  Object.freeze({
    category_localizations: {
      symbol: 'categoryLocalizations',
      modules: ['db/catalogLocalization/categoryLocalizationRepository.ts'],
    },
    product_type_localizations: {
      symbol: 'productTypeLocalizations',
      modules: ['db/catalogLocalization/productTypeLocalizationRepository.ts'],
    },
    product_type_field_localizations: {
      symbol: 'productTypeFieldLocalizations',
      modules: ['db/catalogLocalization/productTypeFieldLocalizationRepository.ts'],
      unassertedModules: {
        'db/catalogLocalization/productTypeFieldLocalizationRepository.ts':
          '`copyForwardProductTypeFieldLocalizations` is its ONLY writer and it carries rows ' +
          'that already exist to a new product-type version. No new text enters through it, and ' +
          'refusing there would fail a version bump on text written before this policy — losing ' +
          'the translation, which is the opposite of what the policy is for.',
      },
    },
    // No writer at all. #367's L2 translation of Mercaria's own catalogue copy
    // is modelled and nothing populates it yet.
    canonical_product_localizations: { symbol: 'canonicalProductLocalizations', modules: [] },
    canonical_product_family_localizations: {
      symbol: 'canonicalProductFamilyLocalizations',
      modules: [],
    },
    // The vertical-package apply, whose text is a code constant rather than a
    // request body — so there is no request surface to attach a schema to.
    attribute_value_localizations: {
      symbol: 'attributeValueLocalizations',
      modules: ['scripts/seed-verticals/apply.ts'],
    },
    attribute_labels: {
      symbol: 'attributeLabels',
      modules: ['db/attributes/definitionRepository.ts'],
    },
    navigation_node_localizations: {
      symbol: 'navigationNodeLocalizations',
      modules: ['db/navigation/navigationWriteRepository.ts'],
    },
    listing_localizations: {
      symbol: 'listingLocalizations',
      modules: ['db/catalogLocalization/listingLocalizationRepository.ts'],
    },
    canonical_images: { symbol: 'canonicalImages', modules: ['db/canonical/attributeRepository.ts'] },
  });

describe('the writer census — a new writer of an in-scope table fails the build', () => {
  const files = walkSource(BACKEND_SRC);
  const sources = new Map(
    files
      .map((file) => [relative(BACKEND_SRC, file), file] as const)
      .filter(([rel]) => !rel.startsWith(join('db', 'schema')))
      .map(([rel, file]) => [rel, stripComments(readFileSync(file, 'utf8'))] as const),
  );

  function writersOf(symbol: string): string[] {
    // `\s*` spans newlines, so a multi-line `.insert(\n  table,\n)` is matched —
    // a single-line pattern drops exactly the more complex declarations.
    const pattern = new RegExp(`\\.(insert|update|delete)\\(\\s*${symbol}\\s*[,)]`, 'u');
    return [...sources.entries()]
      .filter(([, body]) => pattern.test(body))
      .map(([rel]) => rel)
      .sort();
  }

  it('VACUITY FLOOR — the scan read the backend', () => {
    expect(sources.size).toBeGreaterThan(1_000);
    expect(Object.keys(WRITERS).sort()).toEqual([...IN_SCOPE_TABLES]);
  });

  it.each(Object.entries(WRITERS))('finds exactly the recorded writers of %s', (table, entry) => {
    expect(writersOf(entry.symbol), table).toEqual([...entry.modules].sort());
  });

  it('MUTATION SELF-TEST — the detector notices a writer, and notices its removal', () => {
    // Two directions, because a detector that matches nothing reports "no
    // writers" for every table and passes the two empty entries above.
    const withWriter = new RegExp(`\\.(insert|update|delete)\\(\\s*listingLocalizations\\s*[,)]`, 'u');
    expect(withWriter.test('await db.insert(listingLocalizations).values(row)')).toBe(true);
    expect(withWriter.test('await db.insert(\n  listingLocalizations,\n).values(row)')).toBe(true);
    expect(withWriter.test('await db.select().from(listingLocalizations)')).toBe(false);
    // …and a comment mentioning one is not a writer.
    expect(
      withWriter.test(stripComments('// await db.insert(listingLocalizations).values(row)')),
    ).toBe(false);
    expect(
      withWriter.test(stripComments('/* db.insert(listingLocalizations) */')),
    ).toBe(false);
  });

  it('routes every localized-text WRITE through the declaration, at the writer', () => {
    // The closure property, and the reason this file does not simply enumerate
    // request surfaces: a request schema covers HTTP and nothing else, and no
    // amount of searching can tell you the enumeration has finished. Every
    // module recorded above as a writer must NAME every declared column of its
    // table in an `assertLocalizedText`/`assertOptionalLocalizedText` call, or
    // be excused BY PATH with a reason. Combined with the writer census above —
    // which fails on a module nobody recorded — the set of code that can write
    // these columns is closed: a new writer either calls the assertion or turns
    // this file red.
    let asserted = 0;
    let excused = 0;
    for (const [table, entry] of Object.entries(WRITERS)) {
      const columns = LOCALIZED_TEXT_COLUMN_KEYS.filter(
        (key) => LOCALIZED_TEXT_FIELDS[key].table === table,
      );
      expect(columns.length, table).toBeGreaterThan(0);
      for (const module of entry.modules) {
        const excuse = entry.unassertedModules?.[module];
        if (excuse !== undefined) {
          expect(excuse.length, module).toBeGreaterThan(60);
          excused++;
          continue;
        }
        const body = sources.get(module);
        expect(body, module).toBeDefined();
        // ONE call, naming the TABLE. Per COLUMN was the first shape and it was
        // wrong: it demanded every writer name every declared column, which the
        // vertical-package seed cannot satisfy — it writes
        // `attribute_value_localizations.label` and not `.description`. The
        // row-shaped call has no such requirement and covers a column added
        // later with no edit here.
        expect(body, `${module} must call assertLocalizedRow('${table}', …)`).toContain(
          `assertLocalizedRow('${table}'`,
        );
        asserted++;
      }
    }
    // Floors, plural: a run where every module was excused, or where there were
    // no modules at all, would satisfy the loop above by doing nothing.
    expect(asserted).toBeGreaterThanOrEqual(6);
    expect(excused).toBeGreaterThanOrEqual(1);
  });

  it('MUTATION SELF-TEST — the write-chokepoint check reads real source', () => {
    // The check above is a substring test over a file this run read. If the map
    // were empty or the reads were failing, it would pass by iterating nothing.
    const listing = sources.get('db/catalogLocalization/listingLocalizationRepository.ts');
    expect(listing).toBeDefined();
    expect(listing).toContain("assertLocalizedRow('listing_localizations'");
    expect(listing).not.toContain("assertLocalizedRow('listing_subtitles'");
  });

  it('records which in-scope tables have a request surface and which do not', () => {
    const probed = new Set(
      (Object.keys(SURFACE_PROBES) as LocalizedTextColumnKey[]).map(
        (key) => LOCALIZED_TEXT_FIELDS[key].table,
      ),
    );
    // Both halves must be non-empty, or this states nothing. The unprobed
    // tables are the ones whose text arrives from a code constant, a
    // copy-forward or nothing at all — each named in `WRITERS` above.
    const unprobed = IN_SCOPE_TABLES.filter((table) => !probed.has(table));
    expect(probed.size).toBeGreaterThanOrEqual(5);
    expect(unprobed.length).toBeGreaterThanOrEqual(1);
    expect([...probed].sort()).toEqual([
      'attribute_labels',
      'canonical_images',
      'category_localizations',
      'listing_localizations',
      'navigation_node_localizations',
      'product_type_localizations',
    ]);
    expect(unprobed).toEqual([
      'attribute_value_localizations',
      'canonical_product_family_localizations',
      'canonical_product_localizations',
      'product_type_field_localizations',
    ]);
  });
});
