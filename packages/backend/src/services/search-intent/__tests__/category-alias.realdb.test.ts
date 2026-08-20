/**
 * `category_aliases` read by the REAL entrypoint, against a REAL server (#732).
 *
 * The benchmark measures `interpretDeterministically` against an in-memory
 * fixture, which is what lets the whole labelled set run on every push — and it
 * is also exactly the shape of a mechanism that is GREEN AND INERT. The
 * interpreter can read an index perfectly while nothing ever fills it: the
 * candidate n-grams, the `= ANY` lookup, the `is_active` join and the wiring in
 * `planShoppingIntent` are all outside what a pure fixture can see, and every
 * one of them can be deleted without turning a single benchmark case red.
 *
 * So this file drives `planShoppingIntent` — the function the controller calls
 * — against rows it inserted through the taxonomy repository, and asserts the
 * plan carries the category. Three things make it a measurement rather than a
 * demonstration:
 *
 * - **A negative control**: the same query shape on a word nobody recorded
 *   resolves to no category, so the assertion is not passing because
 *   `planShoppingIntent` resolves everything.
 * - **A removal control**: the alias row is DELETED and the identical query is
 *   re-planned. If it still resolved, the row was never what did it.
 * - **A word no dictionary holds.** `CATEGORY_COLLOQUIALISMS` would answer
 *   `movil` whether or not this table were read, so every query here is a
 *   nonsense token this file minted.
 *
 * ## Scoping, because the database is SHARED
 *
 * One throwaway database serves the whole suite in parallel workers. Every
 * category, slug and alias here carries a per-run suffix, the assertions name
 * the slug this file created, and teardown deletes exactly what it wrote.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { categories } from '../../../db/schema/catalog.js';
import { categoryAliases } from '../../../db/schema/taxonomy.js';
import {
  deleteCategoryAlias,
  insertCategory,
  insertCategoryAlias,
} from '../../../db/taxonomy/taxonomyRepository.js';
import { normalizeCatalogAlias } from '../../taxonomy/alias-normalization.js';
import { planShoppingIntent } from '../plan.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

const createdCategoryIds: string[] = [];

/**
 * A token no dictionary, slug or product name in this repository contains.
 *
 * The whole point: a query whose only possible resolution is a row this file
 * wrote. `movil` would pass through `CATEGORY_COLLOQUIALISMS` with the table
 * unread, and a fixture on that side of the distinction proves nothing.
 */
const ALIAS_WORD = `zibbolan${RUN}`;
const UNRECORDED_WORD = `qorvexil${RUN}`;

async function categorySlugFor(query: string, locale = 'en-GB'): Promise<string | undefined> {
  const plan = await planShoppingIntent({ request: { query, locale } }, db);
  expect(plan.status, `planShoppingIntent refused "${query}"`).toBe('planned');
  return plan.status === 'planned' ? plan.result.interpretation.category?.slug : undefined;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (db) {
    if (createdCategoryIds.length > 0) {
      await db
        .delete(categoryAliases)
        .where(inArray(categoryAliases.categoryId, createdCategoryIds));
      await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
    }
    await closePostgres();
  }
}, 60_000);

describe('planShoppingIntent resolves a category through a stored alias', () => {
  let categoryId: string;
  let slug: string;
  let aliasId: string;

  beforeAll(async () => {
    slug = `alias-cat-${RUN}`;
    const row = await insertCategory({
      key: slug,
      name: `Alias category ${RUN}`,
      slug,
      parentId: null,
    });
    categoryId = row.id;
    createdCategoryIds.push(row.id);
    const alias = await insertCategoryAlias({
      categoryId,
      locale: 'en',
      alias: ALIAS_WORD,
      normalizedAlias: normalizeCatalogAlias(ALIAS_WORD),
      kind: 'search_term',
    });
    aliasId = alias.id;
  }, 120_000);

  it('resolves a word that exists ONLY as a stored alias', async () => {
    expect(await categorySlugFor(`${ALIAS_WORD} under 300 GBP`)).toBe(slug);
  });

  it('resolves it from ANOTHER locale, as the dictionaries do', async () => {
    // Localization rule 6: an `en` row answers a Spanish-locale query, or one
    // word would behave differently depending on which locale happened to hold
    // it. The locale is a TIE-BREAK, never a filter.
    expect(await categorySlugFor(`${ALIAS_WORD} de segunda mano`, 'es-ES')).toBe(slug);
  });

  it('resolves an ACCENTED query against a folded row', async () => {
    // The normalizer's whole job. `apply.ts` stores `normalizeCatalogAlias`'s
    // output and `catalogAliasCandidates` asks for the same space, so the two
    // meet — a `trim().toLowerCase()` write would store the accent and the
    // lookup would ask for the folded form and find nothing.
    const accented = `${ALIAS_WORD}á`;
    const accentedAlias = await insertCategoryAlias({
      categoryId,
      locale: 'es',
      alias: accented,
      normalizedAlias: normalizeCatalogAlias(accented),
      kind: 'synonym',
    });
    try {
      expect(await categorySlugFor(`${accented} barato`, 'es-ES')).toBe(slug);
    } finally {
      await deleteCategoryAlias(accentedAlias.id);
    }
  });

  it('resolves NOTHING for a word nobody recorded — the negative control', async () => {
    expect(await categorySlugFor(`${UNRECORDED_WORD} under 300 GBP`)).toBeUndefined();
  });

  it('stops resolving when the ROW is removed — the removal control', async () => {
    // Everything above would look identical if some other mechanism were
    // answering. This is the one that says the row did it.
    await deleteCategoryAlias(aliasId);
    try {
      expect(await categorySlugFor(`${ALIAS_WORD} under 300 GBP`)).toBeUndefined();
    } finally {
      const restored = await insertCategoryAlias({
        categoryId,
        locale: 'en',
        alias: ALIAS_WORD,
        normalizedAlias: normalizeCatalogAlias(ALIAS_WORD),
        kind: 'search_term',
      });
      aliasId = restored.id;
    }
  });

  it('withholds an alias whose category is no longer ACTIVE', async () => {
    // An alias pointing at a deprecated or merged category is a row that still
    // exists. Resolving a shopper's word onto a shelf nothing can be listed on
    // is worse than resolving it onto nothing, which is why `is_active` is in
    // the repository read rather than left to a caller to remember.
    await db.update(categories).set({ isActive: false }).where(eq(categories.id, categoryId));
    try {
      expect(await categorySlugFor(`${ALIAS_WORD} under 300 GBP`)).toBeUndefined();
    } finally {
      await db.update(categories).set({ isActive: true }).where(eq(categories.id, categoryId));
    }
  });
});

describe('one alias naming several categories is REFUSED, not picked', () => {
  const shared = `plurivox${RUN}`;
  let firstSlug: string;

  beforeAll(async () => {
    const first = await insertCategory({
      key: `amb-one-${RUN}`,
      name: `Ambiguous one ${RUN}`,
      slug: `amb-one-${RUN}`,
      parentId: null,
    });
    const second = await insertCategory({
      key: `amb-two-${RUN}`,
      name: `Ambiguous two ${RUN}`,
      slug: `amb-two-${RUN}`,
      parentId: null,
    });
    createdCategoryIds.push(first.id, second.id);
    firstSlug = first.slug;
    // The unique is `(category_id, locale, normalized_alias)`, so ONE alias
    // under two categories is a legitimate row pair — "phone" names more than
    // one shelf — and this is the state the repository's list return exists for.
    for (const category of [first, second]) {
      await insertCategoryAlias({
        categoryId: category.id,
        locale: 'en',
        alias: shared,
        normalizedAlias: normalizeCatalogAlias(shared),
        kind: 'search_term',
      });
    }
  }, 120_000);

  it('applies no category filter and reports the phrase as ambiguous', async () => {
    const plan = await planShoppingIntent({ request: { query: `${shared} laptop`, locale: 'en-GB' } }, db);
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.result.interpretation.category).toBeUndefined();
    // Reported, never silently dropped — and reported as an UNRESOLVED phrase
    // rather than a `category` clarification, whose options are composed from a
    // RESOLVED category name and would be an empty list that
    // `selectClarifications` silently drops.
    expect(
      plan.result.unresolved.filter((entry) => entry.kind === 'ambiguous_phrase').map((entry) => entry.phrase),
    ).toContain(shared);
  });

  it('breaks the tie on the request locale when only one side matches it', async () => {
    // The reason `category_aliases.locale` is a column rather than a comment.
    // A second row for the FIRST category in `es` makes `es-ES` unambiguous
    // while `en-GB` stays ambiguous — the same rows, two answers, which is a
    // pair a single-locale fixture could not distinguish.
    const esOnly = `unilingua${RUN}`;
    const rows = [];
    for (const [categoryId, locale] of [
      [createdCategoryIds[createdCategoryIds.length - 2], 'es'],
      [createdCategoryIds[createdCategoryIds.length - 1], 'de'],
    ] as const) {
      rows.push(
        await insertCategoryAlias({
          categoryId: categoryId ?? '',
          locale,
          alias: esOnly,
          normalizedAlias: normalizeCatalogAlias(esOnly),
          kind: 'search_term',
        }),
      );
    }
    try {
      expect(await categorySlugFor(`${esOnly} barato`, 'es-ES')).toBe(firstSlug);
      expect(await categorySlugFor(`${esOnly} cheap`, 'en-GB')).toBeUndefined();
    } finally {
      for (const row of rows) await deleteCategoryAlias(row.id);
    }
  });
});
