/**
 * The category-alias vocabulary widening, against a REAL Postgres server
 * (#367 Translation model, "localized aliases, synonyms, regional terms,
 * abbreviations, common misspellings and transliterations").
 *
 * ## What only a real server can settle
 *
 * `category_aliases_kind_check` is rendered from `CATEGORY_ALIAS_KINDS` by
 * `checkOneOf`, and widening it is a `DROP CONSTRAINT` / `ADD CONSTRAINT` pair
 * in a migration. Three things about that are invisible to `tsc`, to a mocked
 * repository, and to reading the diff:
 *
 * 1. **Whether the widening reached the SERVER.** A tuple widened in TypeScript
 *    with no migration is a green build whose first `transliteration` write
 *    fails in production — the house rule for every tuple-rendered CHECK. Every
 *    assertion below reads the LIVE `pg_constraint` definition or performs a
 *    real INSERT, so none of them can pass unless the migration ran.
 * 2. **Whether the CHECK still REFUSES.** A widening that became `CHECK (true)`
 *    admits everything and every functional test stays green. So the acceptance
 *    is PAIRED with a refusal on the same column.
 * 3. **Whether the constraint was VALIDATED.** One added `NOT VALID` governs new
 *    writes only and leaves existing violators in place and invisible;
 *    `convalidated` is the only thing that tells the two apart.
 *
 * ## Why this is derived from the tuple rather than a list of eight strings
 *
 * A hand-written list of the members is a second copy of the vocabulary, and it
 * agrees with the first until somebody adds a ninth member and updates only one
 * of them. The acceptance iterates `CATEGORY_ALIAS_KINDS` itself, so a member
 * added without a migration fails HERE — which is the whole point — and a
 * member added WITH one needs no edit to this file.
 *
 * That makes the tuple both the subject and the instrument, so the floors below
 * are load-bearing: an EMPTY tuple would iterate nothing and report a clean
 * pass, and a `permitted()` that extracted nothing would report every member
 * missing for the wrong reason.
 *
 * ## What this file deliberately does NOT assert
 *
 * That a Cyrillic transliteration and its Latin form are storable side by side.
 * They are — the fold performs no script conversion — but two DISTINCT Cyrillic
 * aliases of one category in one locale are NOT, because `normalizeCatalogAlias`
 * folds `й`->`и` and `ё`->`е` into `normalized_alias`, which
 * `category_aliases_category_locale_normalized_key` is defined over. That is
 * #854, it is a defect in the NORMALIZER reachable from every kind including the
 * five that predate this widening, and `kind` is not a column in that index — so
 * it is neither caused nor fixed by anything here. Pinning it in this file would
 * attach a normalizer regression to a vocabulary change and send whoever breaks
 * it to the wrong module.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { isCheckViolation, uuidv7 } from '@oxyhq/db';
import { CATEGORY_ALIAS_KINDS, type CategoryAliasKind } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { categories } from '../schema/catalog.js';
import { insertCategory, insertCategoryAlias } from '../taxonomy/taxonomyRepository.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

const createdCategoryIds: string[] = [];

/**
 * A type ALIAS, not an `interface`, and `component-axis-widening.realdb.test.ts`
 * explains why in the same words: `db.execute<T>` constrains `T` to
 * `Record<string, unknown>`, an interface gets no implicit index signature and a
 * type alias over an object literal does. The interface spelling RUNS fine under
 * vitest — esbuild strips types without checking them — and fails only the
 * typecheck job, which is this repository's reason for typechecking rather than
 * trusting a build. Written as an interface here first; caught there.
 */
type ConstraintRow = {
  conname: string;
  convalidated: boolean;
  definition: string;
};

/**
 * The live definition of the kind CHECK, read from the server.
 *
 * Matched on the CONSTRAINT NAME rather than on the definition text: the name is
 * what the migration writes and what a rename would have to change, whereas a
 * pattern over the definition would also match any future CHECK that happens to
 * mention the column.
 */
async function kindConstraints(): Promise<ConstraintRow[]> {
  const rows = await db.execute<ConstraintRow>(sql`
    select c.conname,
           c.convalidated,
           pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'category_aliases'
       and c.contype = 'c'
       and c.conname = 'category_aliases_kind_check'
  `);
  return [...rows];
}

/** The quoted values a CHECK definition permits. */
function permitted(definition: string): Set<string> {
  return new Set([...definition.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1] as string));
}

async function makeCategory(name: string): Promise<string> {
  const handle = `alias-kind-${name}-${RUN}`;
  const row = await insertCategory({
    key: handle,
    name: `Alias kind ${name}`,
    slug: handle,
    parentId: null,
  });
  createdCategoryIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  // Scoped to the ids THIS run minted, because the test database is shared with
  // every parallel file. `inArray` and not a bare array in a `sql` template:
  // drizzle renders a bare JS array as a ROW CONSTRUCTOR.
  // Aliases go with the category — `category_aliases.category_id` is `cascade`.
  if (createdCategoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  }
  await closePostgres();
});

describe('category_aliases_kind_check — the widening reached the server', () => {
  it('exists exactly once and is VALIDATED — the population floor', async () => {
    const rows = await kindConstraints();
    // Without this, a renamed or dropped constraint leaves every acceptance
    // below iterating an empty definition and reporting nothing wrong.
    expect(rows).toHaveLength(1);
    expect(rows[0].convalidated, 'a NOT VALID CHECK governs new writes only').toBe(true);
  });

  it('the vocabulary is non-empty and extractable — the instrument floors', async () => {
    // The tuple is the instrument for the acceptance below, so an empty one
    // would iterate nothing and pass. Floored, not pinned: adding a member
    // must not be a test edit.
    expect(CATEGORY_ALIAS_KINDS.length).toBeGreaterThanOrEqual(8);

    const [row] = await kindConstraints();
    // And a `permitted()` that matched nothing would report every member
    // missing — a true-looking failure about the wrong thing.
    expect(permitted(row.definition).size).toBeGreaterThanOrEqual(8);
  });

  it('permits every member of CATEGORY_ALIAS_KINDS — derived, not listed', async () => {
    const [row] = await kindConstraints();
    const values = permitted(row.definition);
    const missing = CATEGORY_ALIAS_KINDS.filter((kind) => !values.has(kind));
    expect(
      missing,
      [
        `category_aliases_kind_check does not permit: ${missing.join(', ')}.`,
        'The tuple in @mercaria/shared-types was widened without the migration that',
        'widens the CHECK, so the build is green and the first such write fails in',
        'production. Run `bun run build:shared-types` then `bun run db:generate`.',
      ].join(' '),
    ).toEqual([]);
  });

  it('still REFUSES a value outside the tuple — the widening is not CHECK (true)', async () => {
    const categoryId = await makeCategory('refusal');
    await expect(
      insertCategoryAlias({
        categoryId,
        locale: 'en',
        // Deliberately plausible: the shape a future member would have, so this
        // fails the day somebody adds one to the CHECK and not to the tuple.
        alias: 'Marketing name',
        normalizedAlias: `marketing-name-${RUN}`,
        kind: 'marketing_name' as CategoryAliasKind,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('stores a real row under each of the three kinds #367 names', async () => {
    // The end-to-end proof, through the one production writer. A CHECK that
    // permits the value and a writer that can emit it are different facts.
    const categoryId = await makeCategory('accepts');
    const added: readonly CategoryAliasKind[] = ['transliteration', 'abbreviation', 'regional_term'];

    for (const kind of added) {
      const row = await insertCategoryAlias({
        categoryId,
        locale: 'en',
        alias: `Alias ${kind}`,
        normalizedAlias: `alias-${kind}-${RUN}`,
        kind,
      });
      expect(row.kind).toBe(kind);
    }
  });
});
