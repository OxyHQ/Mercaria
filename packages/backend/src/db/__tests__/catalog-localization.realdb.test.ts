/**
 * Catalog localization against a REAL Postgres server (ADR 0007 D4).
 *
 * Everything here is a property the database holds and a mocked repository
 * cannot: the two triggers D4 puts in the database precisely so no service can
 * forget them, the CHECKs that make a half-declared or dishonest row
 * unrepresentable, the partial unique that makes "the current slug" one row, and
 * the full unique that stops a retired slug being reissued to somebody else's
 * category.
 *
 * A mocked `insert` accepts any statement, including one the server rejects
 * outright — which is exactly the class of bug this file exists to catch. Two of
 * the CHECKs below are in the schema BECAUSE the obvious spelling admitted the
 * row it was written to refuse, and only a server said so.
 *
 * ## Scoping, because the test database is SHARED across parallel files
 *
 * Every fixture is suffixed with a per-run token and every assertion is scoped
 * to the ids this file created. Teardown deletes children before parents: the
 * localizations cascade from their categories, but deleting them explicitly is
 * what makes a genuine children-first mistake loud rather than silent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, getTableColumns, getTableName, inArray, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { isCheckViolation, isUniqueViolation, sqlColumnName, uuidv7 } from '@oxyhq/db';
import { HUMAN_SETTLED_LOCALIZATION_STATUSES } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import * as schema from '../schema/index.js';
import { categories } from '../schema/catalog.js';
import { attributeDefinitions, attributeEnumValues } from '../schema/attributeRegistry.js';
import { productTypeDefinitions } from '../schema/productTypes.js';
import {
  attributeValueLocalizations,
  categoryLocalizations,
  categoryLocalizedSlugs,
  productTypeLocalizations,
} from '../schema/catalogLocalization.js';
import {
  copyForwardProductTypeLocalizations,
  upsertProductTypeLocalization,
} from '../catalogLocalization/productTypeLocalizationRepository.js';
import {
  findCategoryByLocalizedSlug,
  findCurrentCategoryLocalizedSlugs,
  issueCategoryLocalizedSlug,
} from '../catalogLocalization/categoryLocalizedSlugRepository.js';
import { upsertCategoryLocalization } from '../catalogLocalization/categoryLocalizationRepository.js';
import { readLocalizedCategories } from '../../services/catalog-localization/read.service.js';

/**
 * A trigger REFUSED the write, and it was the trigger this case names.
 *
 * The RAISE text lives on the error's CAUSE: drizzle wraps a driver failure in a
 * `Failed query: …` message of its own, so matching the top-level message would
 * pass against ANY refusal — a CHECK, a foreign key, a unique — which is exactly
 * the check that cannot tell one failure from another. Measured here: the first
 * run of this file asserted the top-level message and reported three failures
 * for triggers that had fired correctly.
 */
async function expectTriggerRefusal(pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected a trigger to refuse, but the write succeeded').toBeDefined();
  const cause = (thrown as { cause?: { message?: string } }).cause;
  expect(String(cause?.message ?? thrown)).toMatch(pattern);
}

/**
 * Every drizzle table the schema barrel exports.
 *
 * Walked rather than listed so the trigger census below covers a localization
 * table somebody adds later — finding fewer tables to protect looks exactly like
 * there BEING fewer, which is the failure this file's whole family census
 * exists to prevent one layer up.
 */
const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();

const categoryIds: string[] = [];
const definitionIds: string[] = [];
const enumValueIds: string[] = [];
/**
 * Real product-type VERSION rows.
 *
 * These were synthetic string ids while D5 was built in parallel and
 * `product_type_localizations.product_type_definition_id` carried a ledgered
 * deferral. The rebase that converted the deferral into a real `cascade`
 * reference turned six of these cases red immediately — the FK doing precisely
 * what it exists to do, on the first run after it landed. The copy forward
 * still treats the two ids as opaque; the DATABASE no longer does.
 *
 * `(key, version)` is unique, so each fixture takes its own key: a shared key
 * with two versions would be truer to life and would also make these cases
 * depend on D5's freeze trigger, which is not what they measure.
 */
const productTypeVersionIds: string[] = [];

async function versionId(label: string): Promise<string> {
  const [row] = await db
    .insert(productTypeDefinitions)
    .values({ key: `l10n_${label.replace(/-/gu, '_')}_${RUN}`, version: 1, name: label })
    .returning();
  productTypeVersionIds.push(row.id);
  return row.id;
}

async function createCategory(name: string): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({ name, slug: `${name.toLowerCase()}-${RUN}`, key: `l10n.${name.toLowerCase()}.${RUN}` })
    .returning();
  categoryIds.push(row.id);
  return row.id;
}

async function createEnumValue(value: string, label: string): Promise<string> {
  const [definition] = await db
    .insert(attributeDefinitions)
    .values({ key: `l10n_${value}_${RUN}`, label, valueType: 'enum' })
    .returning();
  definitionIds.push(definition.id);
  const [enumValue] = await db
    .insert(attributeEnumValues)
    .values({ attributeDefinitionId: definition.id, value, label })
    .returning();
  enumValueIds.push(enumValue.id);
  return enumValue.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  if (enumValueIds.length > 0) {
    await db
      .delete(attributeValueLocalizations)
      .where(inArray(attributeValueLocalizations.attributeEnumValueId, enumValueIds));
    await db.delete(attributeEnumValues).where(inArray(attributeEnumValues.id, enumValueIds));
  }
  if (definitionIds.length > 0) {
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, definitionIds));
  }
  if (productTypeVersionIds.length > 0) {
    // The localizations cascade from their version rows; deleting them first
    // anyway is what makes a genuine children-first mistake loud.
    await db
      .delete(productTypeLocalizations)
      .where(inArray(productTypeLocalizations.productTypeDefinitionId, productTypeVersionIds));
    await db.delete(productTypeDefinitions).where(inArray(productTypeDefinitions.id, productTypeVersionIds));
  }
  if (categoryIds.length > 0) {
    await db
      .delete(categoryLocalizedSlugs)
      .where(inArray(categoryLocalizedSlugs.categoryId, categoryIds));
    await db
      .delete(categoryLocalizations)
      .where(inArray(categoryLocalizations.categoryId, categoryIds));
    await db.delete(categories).where(inArray(categories.id, categoryIds));
  }
  await closePostgres();
});

describe('the localization row shape', () => {
  it('refuses a base-locale row, because the base string lives on the entity', async () => {
    const categoryId = await createCategory('BaseLocale');
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'en',
        status: 'approved',
        provenance: 'mercaria',
        name: 'Shoes',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('ties `missing` to the absence of text in both directions', async () => {
    const categoryId = await createCategory('MissingShape');
    // Text on a `missing` row.
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'es',
        status: 'missing',
        provenance: 'mercaria',
        name: 'Zapatos',
      }),
    ).rejects.toSatisfy(isCheckViolation);
    // …and no text on a settled one. The biconditional is what makes BOTH
    // unrepresentable; a one-way requirement admits the second.
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: null,
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a blank string dressed as approved text', async () => {
    const categoryId = await createCategory('BlankText');
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: '   ',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses settled text with nobody named as having settled it', async () => {
    const categoryId = await createCategory('NoReviewer');
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'es',
        status: 'reviewed',
        provenance: 'professional',
        name: 'Zapatos',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('keeps a reviewer and a review instant together', async () => {
    const categoryId = await createCategory('HalfReview');
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'es',
        status: 'machine_translated',
        provenance: 'imported_source',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: null,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a machine row claiming approval, which no UPDATE trigger could see', async () => {
    const categoryId = await createCategory('MachineInsert');
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'es',
        status: 'approved',
        provenance: 'machine',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a machine row wearing somebody else’s review', async () => {
    const categoryId = await createCategory('MachineReviewer');
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'es',
        status: 'machine_translated',
        provenance: 'machine',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('permits one row per locale and no more', async () => {
    const categoryId = await createCategory('OnePerLocale');
    await upsertCategoryLocalization(
      { categoryId, locale: 'es', status: 'machine_translated', provenance: 'machine', name: 'Zapatos' },
      db,
    );
    await expect(
      db.insert(categoryLocalizations).values({
        categoryId,
        locale: 'es',
        status: 'machine_translated',
        provenance: 'machine',
        name: 'Calzado',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });
});

describe('the machine-write guard is ATTACHED to every table that can hold a provenance', () => {
  /**
   * ADR 0007 D4 makes "machine translation may never overwrite reviewed or
   * approved content" a TRIGGER rather than a service check. The trigger exists
   * and the four behavioural cases below drive it — all four on
   * `category_localizations`.
   *
   * That leaves the COVERAGE ungated, and this repository's migration protocol
   * is exactly where coverage goes: a regeneration DROPS every hand-written
   * trigger, so a rebase that re-emitted `0091` without two of its three
   * `CREATE TRIGGER` lines would leave the function in place, the census over
   * migration text passing ("the guard lives in exactly one file"), the status
   * list passing, and the behavioural cases passing — because they only ever
   * exercise categories. Protection would silently shrink from three tables to
   * one, and the symptom is a machine translation quietly replacing a human's
   * approved copy on product types and controlled values.
   *
   * So this asks the SERVER which triggers are installed, and derives the
   * population from the drizzle schema rather than from the trigger list. A
   * table's protection is identified by what its trigger's FUNCTION BODY says,
   * not by the function's name: `navigation_node_localizations` carries its own
   * narrower guard under a different name, and a name census would either miss
   * it or need an exemption that hides a genuinely unprotected table.
   */
  const protectableTables = tables
    .filter((table) => getTableName(table).endsWith('_localizations'))
    .filter((table) =>
      Object.values(getTableColumns(table)).some((column) => sqlColumnName(column) === 'provenance'),
    )
    .map(getTableName)
    .sort();

  it('finds the tables to protect, and there are several of them', () => {
    // The floor. A broken barrel import or a renamed column traverses nothing
    // and reports every table protected, which is the same output as every
    // table being protected.
    expect(protectableTables.length).toBeGreaterThanOrEqual(4);
    // A table with a `provenance` column is one a machine can claim to have
    // authored, which is exactly the set D4's rule is about.
    expect(protectableTables).toContain('category_localizations');
    expect(protectableTables).toContain('product_type_localizations');
    expect(protectableTables).toContain('attribute_value_localizations');
  });

  it('has a trigger whose body refuses a machine write, on every one of them', async () => {
    const rows = await db.execute<{
      tableName: string;
      triggerName: string;
      definition: string;
    }>(sql`
      select c.relname            as "tableName",
             t.tgname             as "triggerName",
             pg_get_functiondef(t.tgfoid) as "definition"
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where not t.tgisinternal
         and n.nspname = current_schema()
         and c.relname = any(${sql.raw(`array[${protectableTables.map((name) => `'${name}'`).join(', ')}]`)})
    `);

    const byTable = new Map<string, { triggerName: string; definition: string }[]>();
    for (const row of [...rows]) {
      const list = byTable.get(row.tableName) ?? [];
      list.push({ triggerName: row.triggerName, definition: row.definition });
      byTable.set(row.tableName, list);
    }

    const unprotected: string[] = [];
    for (const table of protectableTables) {
      const triggers = byTable.get(table) ?? [];
      // What makes a trigger THE guard is that its body names the machine
      // provenance and refuses. Both halves: a body mentioning `machine` without
      // raising is a trigger that reads the value and lets the write through.
      const guards = triggers.filter(
        (trigger) =>
          /'machine'/u.test(trigger.definition) && /raise\s+exception/iu.test(trigger.definition),
      );
      if (guards.length === 0) unprotected.push(table);
    }

    // Asserted FIRST, so the failure NAMES the tables a reader has to go and fix.
    // Measured: with this after the count control below, dropping two attachments
    // failed as `expected 2 to be greater than or equal to 4`, which says a
    // number is wrong and not which table lost its guard.
    expect(unprotected, 'localization tables with no machine-write guard').toEqual([]);

    // The control on the QUERY, kept as well as the verdict above. A predicate
    // that matched nothing reports every table unprotected and is caught by the
    // assertion above; this catches the subtler direction — a query narrowed so
    // it happens to return only the tables that ARE protected.
    expect([...byTable.keys()].length).toBeGreaterThanOrEqual(4);
  });

  it('backs the trigger with a row-level CHECK on every one of them, because a trigger cannot see an INSERT', async () => {
    // The trigger is BEFORE UPDATE, so it reads `OLD` — an INSERT never gives it
    // a row to compare against, and a machine row can therefore be CREATED
    // claiming approval. Three tables closed that with a pair of CHECKs;
    // `navigation_node_localizations` did not, and was MEASURED accepting the
    // exact row `category_localizations` refuses. Asserted here so a FIFTH member
    // of the family cannot reopen it: the trigger census above would pass on a
    // table that has the trigger and no CHECK, which is precisely the state
    // navigation was in.
    const rows = await db.execute<{ tableName: string; definition: string }>(sql`
      select c.relname as "tableName", pg_get_constraintdef(con.oid) as "definition"
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
       where con.contype = 'c'
         and n.nspname = current_schema()
         and c.relname = any(${sql.raw(`array[${protectableTables.map((name) => `'${name}'`).join(', ')}]`)})
    `);

    const byTable = new Map<string, string[]>();
    for (const row of [...rows]) {
      byTable.set(row.tableName, [...(byTable.get(row.tableName) ?? []), row.definition]);
    }

    const unchecked: string[] = [];
    for (const table of protectableTables) {
      const defs = byTable.get(table) ?? [];
      // Identified by what the CHECK SAYS, not by its name, for the reason the
      // trigger census reads function bodies: a differently-named equivalent is
      // still protection, and a name census would need an exemption that hides a
      // table carrying none.
      const guardsStatus = defs.some(
        (def) => /'machine'/u.test(def) && /'approved'/u.test(def) && /'reviewed'/u.test(def),
      );
      const guardsReviewer = defs.some(
        (def) => /'machine'/u.test(def) && /reviewed_by_oxy_user_id/u.test(def),
      );
      if (!guardsStatus || !guardsReviewer) {
        unchecked.push(
          `${table} (status guard: ${String(guardsStatus)}, reviewer guard: ${String(guardsReviewer)})`,
        );
      }
    }

    expect(unchecked, 'localization tables whose INSERT path a machine row can walk').toEqual([]);
    // The control on the query: it must have found CHECKs at all.
    expect([...byTable.keys()].length).toBeGreaterThanOrEqual(4);
  });

  it('protects the statuses shared-types calls human-settled, not a hand-typed pair', async () => {
    // The four behavioural cases below prove the guard refuses on `approved` and
    // `reviewed` and permits on `stale`. This asserts the trigger's own list is
    // the SAME list the application reads, so adding a settled status to
    // shared-types without widening the trigger fails here rather than leaving a
    // status the code treats as human-settled and the database does not.
    const rows = await db.execute<{ definition: string }>(sql`
      select pg_get_functiondef(t.tgfoid) as "definition"
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
         and c.relname = 'category_localizations'
    `);
    const guard = [...rows].find((row) => /'machine'/u.test(row.definition));
    expect(guard).toBeDefined();
    for (const status of HUMAN_SETTLED_LOCALIZATION_STATUSES) {
      expect(guard?.definition).toContain(`'${status}'`);
    }
    // A vacuity floor on the loop above: an empty tuple would assert nothing.
    expect(HUMAN_SETTLED_LOCALIZATION_STATUSES.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the machine-write guard', () => {
  it('refuses a machine translation landing on approved text', async () => {
    const categoryId = await createCategory('GuardApproved');
    await upsertCategoryLocalization(
      {
        categoryId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );
    await expectTriggerRefusal(/Machine translation may not replace approved text/u, () =>
      upsertCategoryLocalization(
        {
          categoryId,
          locale: 'es',
          status: 'machine_translated',
          provenance: 'machine',
          name: 'Calzado automatico',
        },
        db,
      ),
    );

    const [row] = await db
      .select()
      .from(categoryLocalizations)
      .where(
        and(
          eq(categoryLocalizations.categoryId, categoryId),
          eq(categoryLocalizations.locale, 'es'),
        ),
      );
    expect(row.name).toBe('Zapatos');
    expect(row.status).toBe('approved');
  });

  it('refuses one landing on reviewed text too', async () => {
    const categoryId = await createCategory('GuardReviewed');
    await upsertCategoryLocalization(
      {
        categoryId,
        locale: 'es',
        status: 'reviewed',
        provenance: 'community_reviewed',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );
    await expectTriggerRefusal(/Machine translation may not replace reviewed text/u, () =>
      upsertCategoryLocalization(
        { categoryId, locale: 'es', status: 'machine_translated', provenance: 'machine', name: 'X' },
        db,
      ),
    );
  });

  it('PERMITS one landing on stale text — the deliberate reading of D4', async () => {
    const categoryId = await createCategory('GuardStale');
    await upsertCategoryLocalization(
      {
        categoryId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );
    // Make it stale the way a source change does.
    await db.update(categories).set({ name: `GuardStale renamed ${RUN}` }).where(eq(categories.id, categoryId));

    const refreshed = await upsertCategoryLocalization(
      {
        categoryId,
        locale: 'es',
        status: 'machine_translated',
        provenance: 'machine',
        name: 'Calzado',
      },
      db,
    );
    expect(refreshed.status).toBe('machine_translated');
    expect(refreshed.name).toBe('Calzado');
  });

  it('lets a human replace machine text, which is the direction that must work', async () => {
    const categoryId = await createCategory('HumanOverMachine');
    await upsertCategoryLocalization(
      { categoryId, locale: 'es', status: 'machine_translated', provenance: 'machine', name: 'Calzado' },
      db,
    );
    const settled = await upsertCategoryLocalization(
      {
        categoryId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );
    expect(settled.status).toBe('approved');
    expect(settled.name).toBe('Zapatos');
  });
});

describe('the stale trigger', () => {
  it('marks a category’s translations stale when its source name changes, without blanking them', async () => {
    const categoryId = await createCategory('StaleSource');
    await upsertCategoryLocalization(
      {
        categoryId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );
    await upsertCategoryLocalization(
      { categoryId, locale: 'fr', status: 'missing', provenance: 'mercaria', name: null },
      db,
    );

    await db
      .update(categories)
      .set({ name: `Footwear ${RUN}` })
      .where(eq(categories.id, categoryId));

    const rows = await db
      .select()
      .from(categoryLocalizations)
      .where(eq(categoryLocalizations.categoryId, categoryId));
    const spanish = rows.find((row) => row.locale === 'es');
    const french = rows.find((row) => row.locale === 'fr');
    expect(spanish.status).toBe('stale');
    // The text survives. A stale translation is still the best text available;
    // withdrawing it would show a raw key to a shopper.
    expect(spanish.name).toBe('Zapatos');
    // …and a row with nothing to make stale is left where it was.
    expect(french.status).toBe('missing');
  });

  it('does not fire on a change that is not the source text', async () => {
    const categoryId = await createCategory('UnrelatedChange');
    await upsertCategoryLocalization(
      {
        categoryId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Zapatos',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );
    await db.update(categories).set({ position: 7 }).where(eq(categories.id, categoryId));
    const [row] = await db
      .select()
      .from(categoryLocalizations)
      .where(eq(categoryLocalizations.categoryId, categoryId));
    expect(row.status).toBe('approved');
  });

  it('marks a controlled value’s labels stale when its label or its value moves', async () => {
    const enumValueId = await createEnumValue(`teal${RUN}`, 'Teal');
    await db.insert(attributeValueLocalizations).values({
      attributeEnumValueId: enumValueId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      label: 'Verde azulado',
      reviewedByOxyUserId: `op-${RUN}`,
      reviewedAt: new Date(),
    });

    await db
      .update(attributeEnumValues)
      .set({ label: 'Teal (blue-green)' })
      .where(eq(attributeEnumValues.id, enumValueId));

    const [row] = await db
      .select()
      .from(attributeValueLocalizations)
      .where(eq(attributeValueLocalizations.attributeEnumValueId, enumValueId));
    expect(row.status).toBe('stale');
    expect(row.label).toBe('Verde azulado');
  });
});

describe('localized slugs', () => {
  it('issues one, retires it on a rename, and keeps the old URL resolving', async () => {
    const categoryId = await createCategory('SlugRename');
    const first = await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: 'calzado', provenance: 'mercaria' },
      db,
    );
    const second = await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: `zapatos-${RUN}`, provenance: 'mercaria' },
      db,
    );

    const current = await findCurrentCategoryLocalizedSlugs([categoryId], ['es'], db);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(second.id);

    const retired = await findCategoryByLocalizedSlug('es', 'calzado', db);
    expect(retired.id).toBe(first.id);
    expect(retired.categoryId).toBe(categoryId);
    expect(retired.supersededBySlugId).toBe(second.id);
  });

  it('is idempotent on the slug a category already carries', async () => {
    const categoryId = await createCategory('SlugIdempotent');
    const first = await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: `botas-${RUN}`, provenance: 'mercaria' },
      db,
    );
    const again = await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: `botas-${RUN}`, provenance: 'mercaria' },
      db,
    );
    expect(again.id).toBe(first.id);
    const rows = await db
      .select()
      .from(categoryLocalizedSlugs)
      .where(eq(categoryLocalizedSlugs.categoryId, categoryId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a slug another category holds, current or retired', async () => {
    const mine = await createCategory('SlugOwner');
    const theirs = await createCategory('SlugRival');
    const shared = `sandalias-${RUN}`;
    await issueCategoryLocalizedSlug(
      { categoryId: mine, locale: 'es', slug: shared, provenance: 'mercaria' },
      db,
    );
    await issueCategoryLocalizedSlug(
      { categoryId: mine, locale: 'es', slug: `${shared}-nuevo`, provenance: 'mercaria' },
      db,
    );
    // `shared` is now RETIRED and still owned. A rival taking it would make every
    // link to the old URL resolve to somebody else's category.
    await expect(
      issueCategoryLocalizedSlug(
        { categoryId: theirs, locale: 'es', slug: shared, provenance: 'mercaria' },
        db,
      ),
    ).rejects.toThrow(/already held in locale/u);
  });

  it('revives a category’s own retired slug rather than minting a second row', async () => {
    const categoryId = await createCategory('SlugRevive');
    const original = `mocasines-${RUN}`;
    const first = await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: original, provenance: 'mercaria' },
      db,
    );
    await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: `${original}-b`, provenance: 'mercaria' },
      db,
    );
    const revived = await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: original, provenance: 'mercaria' },
      db,
    );
    expect(revived.id).toBe(first.id);
    expect(revived.supersededAt).toBeNull();
    const rows = await db
      .select()
      .from(categoryLocalizedSlugs)
      .where(eq(categoryLocalizedSlugs.categoryId, categoryId));
    expect(rows).toHaveLength(2);
  });

  it('freezes a slug row’s identity against an UPDATE', async () => {
    const categoryId = await createCategory('SlugFrozen');
    const row = await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: `chanclas-${RUN}`, provenance: 'mercaria' },
      db,
    );
    await expectTriggerRefusal(/A localized slug is frozen/u, () =>
      db
        .update(categoryLocalizedSlugs)
        .set({ slug: `chanclas-${RUN}-edited` })
        .where(eq(categoryLocalizedSlugs.id, row.id)),
    );
  });

  it('refuses two current slugs for one category and locale', async () => {
    const categoryId = await createCategory('SlugTwoCurrent');
    await issueCategoryLocalizedSlug(
      { categoryId, locale: 'es', slug: `alpargatas-${RUN}`, provenance: 'mercaria' },
      db,
    );
    await expect(
      db.insert(categoryLocalizedSlugs).values({
        categoryId,
        locale: 'es',
        slug: `alpargatas-${RUN}-dos`,
        provenance: 'mercaria',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses a slug shape a URL cannot carry', async () => {
    const categoryId = await createCategory('SlugShape');
    await expect(
      db.insert(categoryLocalizedSlugs).values({
        categoryId,
        locale: 'es',
        slug: 'Zapatos De Vestir',
        provenance: 'mercaria',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('the batched read', () => {
  it('resolves name, description and slug down the chain in three statements', async () => {
    const withSpanish = await createCategory('ReadSpanish');
    const withoutSpanish = await createCategory('ReadEnglishOnly');

    await upsertCategoryLocalization(
      {
        categoryId: withSpanish,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Zapatos',
        description: 'Calzado de todo tipo',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );
    await issueCategoryLocalizedSlug(
      { categoryId: withSpanish, locale: 'es', slug: `zapatos-read-${RUN}`, provenance: 'mercaria' },
      db,
    );

    const presented = await readLocalizedCategories([withSpanish, withoutSpanish], 'es-MX', db);
    expect(presented.map((entry) => entry.categoryId)).toEqual([withSpanish, withoutSpanish]);

    const [first, second] = presented;
    expect(first.name.outcome).toBe('resolved');
    if (first.name.outcome === 'resolved') {
      expect(first.name.value).toBe('Zapatos');
      expect(first.name.effectiveLocale).toBe('es');
      expect(first.name.step).toBe('language');
    }
    expect(first.description.outcome).toBe('resolved');
    expect(first.slug.outcome).toBe('resolved');
    if (first.slug.outcome === 'resolved') expect(first.slug.slug).toBe(`zapatos-read-${RUN}`);

    // The untranslated one falls all the way to the base columns rather than
    // vanishing or rendering blank.
    expect(second.name.outcome).toBe('resolved');
    if (second.name.outcome === 'resolved') {
      expect(second.name.value).toBe('ReadEnglishOnly');
      expect(second.name.step).toBe('base');
    }
    // `categories` carries no description column, so this is the one field that
    // legitimately has no answer at all.
    expect(second.description.outcome).toBe('unavailable');
  });

  it('cascades a category’s translations and slugs away with it', async () => {
    const [row] = await db
      .insert(categories)
      .values({ name: `Cascade ${RUN}`, slug: `cascade-${RUN}`, key: `l10n.cascade.${RUN}` })
      .returning();
    await upsertCategoryLocalization(
      { categoryId: row.id, locale: 'es', status: 'machine_translated', provenance: 'machine', name: 'Cascada' },
      db,
    );
    await issueCategoryLocalizedSlug(
      { categoryId: row.id, locale: 'es', slug: `cascada-${RUN}`, provenance: 'mercaria' },
      db,
    );

    await db.delete(categories).where(eq(categories.id, row.id));

    const [{ localizations, slugs }] = await db
      .select({
        localizations: sql<number>`(select count(*) from category_localizations where category_id = ${row.id})`,
        slugs: sql<number>`(select count(*) from category_localized_slugs where category_id = ${row.id})`,
      })
      .from(sql`(select 1) as probe`);
    expect(Number(localizations)).toBe(0);
    expect(Number(slugs)).toBe(0);
  });
});

describe('carrying localizations across a product-type version bump', () => {
  /** One version's Spanish, settled by a human, with every field filled. */
  async function seedSpanish(version: string, helpText: string | null): Promise<void> {
    await upsertProductTypeLocalization(
      {
        productTypeDefinitionId: version,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Zapatilla',
        description: 'Calzado deportivo',
        helpText,
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );
  }

  it('carries an unchanged field forward with its status and its reviewer intact', async () => {
    const v1 = await versionId('ptv1-unchanged');
    const v2 = await versionId('ptv2-unchanged');
    await seedSpanish(v1, 'Elige tu talla');

    // v2 tightened a validation rule and renamed nothing.
    const result = await copyForwardProductTypeLocalizations(
      v1,
      v2,
      { kind: 'diffed', changedFields: [] },
      db,
    );
    expect(result).toEqual({ copied: 1, staleOnArrival: 0, skippedExisting: 0 });

    const [carried] = await db
      .select()
      .from(productTypeLocalizations)
      .where(eq(productTypeLocalizations.productTypeDefinitionId, v2));
    expect(carried.status).toBe('approved');
    expect(carried.name).toBe('Zapatilla');
    // The reviewer travels with the text, so a queue can say who settled it.
    expect(carried.reviewedByOxyUserId).toBe(`op-${RUN}`);
  });

  it('marks stale only the locales holding text for a field that changed', async () => {
    const v1 = await versionId('ptv1-granular');
    const v2 = await versionId('ptv2-granular');
    await seedSpanish(v1, null); // no help text in Spanish
    await upsertProductTypeLocalization(
      {
        productTypeDefinitionId: v1,
        locale: 'fr',
        status: 'approved',
        provenance: 'professional',
        name: 'Basket',
        helpText: 'Choisissez votre pointure',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );

    const result = await copyForwardProductTypeLocalizations(
      v1,
      v2,
      { kind: 'diffed', changedFields: ['product_type.help_text'] },
      db,
    );
    expect(result.copied).toBe(2);
    // ONE of the two. The Spanish row holds no help text, so nothing it carries
    // stopped being true — that is the whole point of the granularity, and a
    // naive "any field changed ⇒ stale" would report 2 here.
    expect(result.staleOnArrival).toBe(1);

    const rows = await db
      .select()
      .from(productTypeLocalizations)
      .where(eq(productTypeLocalizations.productTypeDefinitionId, v2));
    expect(rows.find((row) => row.locale === 'es').status).toBe('approved');
    expect(rows.find((row) => row.locale === 'fr').status).toBe('stale');
    // Stale never blanks. The French help text is still the best available.
    expect(rows.find((row) => row.locale === 'fr').helpText).toBe('Choisissez votre pointure');
  });

  it('stales everything when the caller cannot diff the versions', async () => {
    const v1 = await versionId('ptv1-unknown');
    const v2 = await versionId('ptv2-unknown');
    await seedSpanish(v1, 'Elige tu talla');

    const result = await copyForwardProductTypeLocalizations(v1, v2, { kind: 'unknown' }, db);
    expect(result).toEqual({ copied: 1, staleOnArrival: 1, skippedExisting: 0 });
  });

  it('never overwrites text somebody already wrote against the new version', async () => {
    const v1 = await versionId('ptv1-retry');
    const v2 = await versionId('ptv2-retry');
    await seedSpanish(v1, 'Elige tu talla');
    // A translator got there between the first publish attempt and its retry.
    await upsertProductTypeLocalization(
      {
        productTypeDefinitionId: v2,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Zapatilla v2',
        reviewedByOxyUserId: `op-${RUN}`,
        reviewedAt: new Date(),
      },
      db,
    );

    const result = await copyForwardProductTypeLocalizations(v1, v2, { kind: 'unknown' }, db);
    expect(result).toEqual({ copied: 0, staleOnArrival: 0, skippedExisting: 1 });

    const [kept] = await db
      .select()
      .from(productTypeLocalizations)
      .where(eq(productTypeLocalizations.productTypeDefinitionId, v2));
    expect(kept.name).toBe('Zapatilla v2');
    expect(kept.status).toBe('approved');
  });

  it('does not resurrect a withdrawn translation onto a new meaning', async () => {
    const v1 = await versionId('ptv1-withdrawn');
    const v2 = await versionId('ptv2-withdrawn');
    await upsertProductTypeLocalization(
      {
        productTypeDefinitionId: v1,
        locale: 'es',
        status: 'deprecated',
        provenance: 'community_reviewed',
        name: 'Zapatilla retirada',
      },
      db,
    );

    const result = await copyForwardProductTypeLocalizations(
      v1,
      v2,
      { kind: 'diffed', changedFields: [] },
      db,
    );
    expect(result.copied).toBe(0);
    const rows = await db
      .select()
      .from(productTypeLocalizations)
      .where(eq(productTypeLocalizations.productTypeDefinitionId, v2));
    expect(rows).toHaveLength(0);
  });

  it('carries a `missing` row without staling it', async () => {
    const v1 = await versionId('ptv1-missing');
    const v2 = await versionId('ptv2-missing');
    await upsertProductTypeLocalization(
      { productTypeDefinitionId: v1, locale: 'es', status: 'missing', provenance: 'mercaria' },
      db,
    );

    const result = await copyForwardProductTypeLocalizations(v1, v2, { kind: 'unknown' }, db);
    // `missing` holds nothing to be stale, and the CHECK tying `missing` to a
    // null name would refuse the write anyway — a confusing way to learn about
    // a status nobody meant to set.
    expect(result).toEqual({ copied: 1, staleOnArrival: 0, skippedExisting: 0 });
    const [row] = await db
      .select()
      .from(productTypeLocalizations)
      .where(eq(productTypeLocalizations.productTypeDefinitionId, v2));
    expect(row.status).toBe('missing');
  });
});
