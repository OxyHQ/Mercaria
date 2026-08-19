/**
 * The invariance decision, enforced (#367 Translation model L2).
 *
 * `catalog-name-invariance.ts` records which catalogue names may never be
 * translated, and the enforcement is the ABSENCE of a column for any of them on
 * the localization tables. A missing column is a strong prohibition — there is
 * no value to refuse because there is nowhere to put one — and a completely
 * invisible one: "nobody added it yet" and "it may never be added" look
 * identical in a schema. This file is what tells them apart.
 *
 * ## It walks the drizzle TABLE, never the source text
 *
 * `getTableColumns()` reads the constructed table object, so it sees every
 * column including the ones supplied by a SPREAD. That is not a stylistic
 * choice here: this family builds its seven settlement columns through
 * `...localizationColumns()`, so **a census that grepped a schema file for
 * column names would find zero and report a clean pass** — the exact false
 * negative #699 hit three times in a row on `attribute_labels`, twice in the
 * wrong file and once in the right one.
 *
 * The positive control below plants that specific failure: it asserts the walk
 * finds `status`, a spread-supplied column, on a table whose source file never
 * writes the word next to it. A source-grep implementation fails that assertion
 * and passes everything else in this file.
 */

import { getTableColumns, getTableName } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PRODUCT_INVARIANT_FIELDS,
  CANONICAL_PRODUCT_LOCALIZABLE_FIELDS,
  INVARIANT_CATALOG_NAMES,
  INVARIANT_CATALOG_NAME_FIELDS,
  NAME_INVARIANCE_REASONS,
} from '@mercaria/shared-types';
import {
  canonicalProductFamilyLocalizations,
  canonicalProductLocalizations,
} from '../schema/catalogLocalization';
import { canonicalProductFamilies, canonicalProducts } from '../schema/canonicalCatalog';

/** Every SQL column name on a drizzle table, spread-supplied ones included. */
function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((column) => sqlColumnName(column));
}

const LOCALIZATION_TABLES = [canonicalProductLocalizations, canonicalProductFamilyLocalizations];

describe('the column walk can actually see what it is looking for', () => {
  it('finds a SPREAD-supplied column, which a source grep cannot', () => {
    // THE control for this whole file. `status`, `provenance` and five siblings
    // reach these tables through `...localizationColumns()`, so the schema file
    // never writes `status:` next to the table at all. A name-keyed census over
    // source text reports zero here and then reports a clean pass on every
    // absence assertion below, because it cannot see any column.
    for (const table of LOCALIZATION_TABLES) {
      const names = columnNames(table);
      expect(names).toContain('status');
      expect(names).toContain('provenance');
      expect(names).toContain('source_locale');
      expect(names).toContain('reviewed_by_oxy_user_id');
    }
  });

  it('finds the columns the table declares directly too', () => {
    expect(columnNames(canonicalProductLocalizations)).toContain('name');
    expect(columnNames(canonicalProductLocalizations)).toContain('canonical_product_id');
  });

  it('walks a non-empty population — the floor', () => {
    // A table list that emptied would pass every loop below while measuring
    // nothing at all.
    expect(LOCALIZATION_TABLES.length).toBeGreaterThanOrEqual(2);
    for (const table of LOCALIZATION_TABLES) {
      expect(columnNames(table).length).toBeGreaterThan(8);
    }
  });
});

describe('no invariant name has a column on a localization table', () => {
  it('refuses every field the decision names', () => {
    // The prohibition, enforced. `model_code`, `normalized_name` and `slug` must
    // have no home on either table — a localized `normalized_name` would make
    // one product resolve differently per market, and a localized `model_code`
    // would name a different part.
    expect(CANONICAL_PRODUCT_INVARIANT_FIELDS.length).toBeGreaterThan(0);
    for (const table of LOCALIZATION_TABLES) {
      const names = columnNames(table);
      for (const forbidden of CANONICAL_PRODUCT_INVARIANT_FIELDS) {
        expect(names).not.toContain(forbidden);
      }
    }
  });

  it('the invariant fields REALLY EXIST on the entity, so the refusal is about something', () => {
    // Without this the assertion above is satisfied by a typo. Every
    // `canonical_products`-owned invariant field must be a real column on the
    // real entity table — that is what makes "it exists there and may not exist
    // here" a statement rather than a spelling.
    const productColumns = columnNames(canonicalProducts);
    for (const field of CANONICAL_PRODUCT_INVARIANT_FIELDS) {
      expect(productColumns).toContain(field);
    }
  });

  it('permits exactly the fields the decision allows, and they exist on both sides', () => {
    for (const table of LOCALIZATION_TABLES) {
      const names = columnNames(table);
      for (const allowed of CANONICAL_PRODUCT_LOCALIZABLE_FIELDS) {
        expect(names).toContain(allowed);
      }
    }
    // …and on the entities they are translations OF, so the base text a reviewer
    // compares against is real.
    for (const allowed of CANONICAL_PRODUCT_LOCALIZABLE_FIELDS) {
      expect(columnNames(canonicalProducts)).toContain(allowed);
      expect(columnNames(canonicalProductFamilies)).toContain(allowed);
    }
  });
});

describe('the decision is well formed', () => {
  it('names a real reason for every invariant field, from the closed set', () => {
    expect(INVARIANT_CATALOG_NAMES.length).toBeGreaterThan(3);
    const reasons: readonly string[] = NAME_INVARIANCE_REASONS;
    for (const entry of INVARIANT_CATALOG_NAMES) {
      expect(reasons).toContain(entry.reason);
      // A reason short enough to be a label is a placeholder, and a placeholder
      // is how a decision decays into a slogan.
      expect(entry.note.length).toBeGreaterThan(60);
      expect(entry.owner.length).toBeGreaterThan(0);
    }
  });

  it('uses more than one reason — the four are not one reason', () => {
    // If every entry collapsed to a single reason, the vocabulary would be
    // ceremony and a reader would be right to replace it with a boolean.
    const used = new Set(INVARIANT_CATALOG_NAMES.map((entry) => entry.reason));
    expect(used.size).toBeGreaterThan(1);
  });

  it('keeps the localizable and invariant sets DISJOINT', () => {
    // The disjointness the whole device rests on: a field cannot be both
    // translatable and invariant.
    const localizable: readonly string[] = CANONICAL_PRODUCT_LOCALIZABLE_FIELDS;
    for (const field of CANONICAL_PRODUCT_INVARIANT_FIELDS) {
      expect(localizable).not.toContain(field);
    }
  });

  it('names owners other than the product, and they are not all the same table', () => {
    // `brands.name` and `product_identifiers.value` are in the list precisely
    // because a reader would think to look for them here. A list that had
    // silently narrowed to one table would still pass every assertion above.
    const owners = new Set(INVARIANT_CATALOG_NAMES.map((entry) => entry.owner));
    expect(owners.size).toBeGreaterThan(1);
    expect(owners).toContain('canonical_products');
    expect(INVARIANT_CATALOG_NAME_FIELDS.length).toBe(INVARIANT_CATALOG_NAMES.length);
  });

  it('the table names it cites are the real ones', () => {
    expect(getTableName(canonicalProducts)).toBe('canonical_products');
    expect(getTableName(canonicalProductLocalizations)).toBe('canonical_product_localizations');
    expect(getTableName(canonicalProductFamilyLocalizations)).toBe(
      'canonical_product_family_localizations',
    );
  });
});
