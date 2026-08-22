/**
 * Epic #367 line 143 — the enforcement half, against a REAL Postgres server.
 *
 * `categoryScopeFreeze.ts` declares which tables may say something
 * category-specific about a versioned catalog contract and which trigger freezes
 * each one with its version. This file EXECUTES that declaration, because a
 * trigger that exists and permits everything reads identically to one that
 * works — `pg_trigger` cannot tell them apart, and neither can a mocked insert.
 *
 * ## What is measured, per frozen member
 *
 * With the parent still a DRAFT: an INSERT, an UPDATE and a DELETE of the scope
 * row all SUCCEED. That is the positive control, and it is the half that would
 * be missing from a gate satisfied by a trigger which refuses everything —
 * which would also break every legitimate authoring path.
 *
 * With the parent PUBLISHED: the same three writes are REFUSED, each with
 * SQLSTATE `23001` (`restrict_violation`) rather than merely "an error", because
 * a unique violation, a foreign-key violation and a CHECK all throw too and none
 * of them is the property under test.
 *
 * ## And the mutation self-test
 *
 * Every refusal is re-run against a TEMP CLONE of the same table carrying no
 * triggers at all, with the same real published parent, and must then be
 * ACCEPTED. Without it, a refusal coming from a CHECK, a unique index or a
 * foreign key on the real table would read exactly like the freeze working. A
 * temp table takes locks on nothing shared, so this needs no
 * `DISABLE TRIGGER` window on the suite's shared database
 * (`db/__tests__/trigger-toggle-lock.ts` records why that matters) — the
 * `commerce-history-immutability.realdb.test.ts` technique, one domain over.
 *
 * That probe has its own two floors, because "everything was accepted" is also
 * what a probe measuring nothing says: the inserted row is COUNTED (an UPDATE
 * and a DELETE matching zero rows are accepted whatever the clone does), and
 * the same row is inserted a second time and must be refused `23505` by the
 * pair unique `including all` copied — so a clone that turned out to carry no
 * constraints, or a statement aimed at the wrong table, fails here rather than
 * handing the trigger the credit.
 *
 * ## Vacuity
 *
 * The frozen set is DERIVED from the declaration and floored, and every member
 * must have a builder here — a new frozen table with no builder fails this file
 * by name rather than being skipped into a smaller, tidier green.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { categories } from '../schema/catalog.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
} from '../schema/attributeRegistry.js';
import {
  productTypeCategoryScopes,
  productTypeDefinitions,
} from '../schema/productTypes.js';
import { CATEGORY_SCOPE_DISPOSITIONS } from '../categoryScopeFreeze.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on the shared database. */
const RUN = `r${uuidv7().slice(-12).replace(/\W/gu, '')}`;
const CATEGORY_A = uuidv7();
const CATEGORY_B = uuidv7();

/** Measured: 2. A floor, so a declaration that lost an entry fails here too. */
const FROZEN_FLOOR = 2;

/** PostgreSQL's `restrict_violation`, which every freeze trigger here raises. */
const RESTRICT_VIOLATION = '23001';

interface ScopeFixture {
  /** Create the parent version in DRAFT and return its id. */
  readonly draftParent: () => Promise<string>;
  /** Move that parent to its published state. */
  readonly publishParent: (parentId: string) => Promise<void>;
  /** Return it to draft, so teardown can delete the children. */
  readonly demoteParent: (parentId: string) => Promise<void>;
  readonly insertScope: (parentId: string, categoryId: string) => Promise<void>;
  readonly updateScope: (parentId: string, categoryId: string) => Promise<void>;
  readonly deleteScope: (parentId: string, categoryId: string) => Promise<void>;
  readonly deleteParent: (parentId: string) => Promise<void>;
  /** The columns a clone row needs, for the mutation self-test. */
  readonly cloneRow: (parentId: string, categoryId: string) => Record<string, string | boolean>;
  readonly parentColumn: string;
}

const FIXTURES: Record<string, ScopeFixture> = {
  attribute_definition_categories: {
    parentColumn: 'attribute_definition_id',
    draftParent: async () => {
      const id = uuidv7();
      await db.insert(attributeDefinitions).values({
        id,
        key: `scope_freeze_${RUN}_${id.slice(-6)}`,
        version: 1,
        lifecycleState: 'draft',
        label: 'Scope freeze probe',
        valueType: 'string',
        cardinality: 'single',
      });
      return id;
    },
    publishParent: async (parentId) => {
      await db
        .update(attributeDefinitions)
        .set({ lifecycleState: 'active', publishedAt: new Date(), publishedByOxyUserId: RUN })
        .where(eq(attributeDefinitions.id, parentId));
    },
    demoteParent: async (parentId) => {
      await db
        .update(attributeDefinitions)
        .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
        .where(eq(attributeDefinitions.id, parentId));
    },
    insertScope: async (parentId, categoryId) => {
      await db
        .insert(attributeDefinitionCategories)
        .values({ attributeDefinitionId: parentId, categoryId, includeDescendants: true });
    },
    updateScope: async (parentId, categoryId) => {
      await db
        .update(attributeDefinitionCategories)
        .set({ includeDescendants: false })
        .where(
          sql`${attributeDefinitionCategories.attributeDefinitionId} = ${parentId}
              and ${attributeDefinitionCategories.categoryId} = ${categoryId}`,
        );
    },
    deleteScope: async (parentId, categoryId) => {
      await db
        .delete(attributeDefinitionCategories)
        .where(
          sql`${attributeDefinitionCategories.attributeDefinitionId} = ${parentId}
              and ${attributeDefinitionCategories.categoryId} = ${categoryId}`,
        );
    },
    deleteParent: async (parentId) => {
      await db.delete(attributeDefinitions).where(eq(attributeDefinitions.id, parentId));
    },
    cloneRow: (parentId, categoryId) => ({
      id: uuidv7(),
      attribute_definition_id: parentId,
      category_id: categoryId,
      include_descendants: true,
    }),
  },
  product_type_category_scopes: {
    parentColumn: 'product_type_definition_id',
    draftParent: async () => {
      const id = uuidv7();
      await db.insert(productTypeDefinitions).values({
        id,
        key: `scope.freeze.${RUN}.k${id.slice(-6)}`,
        version: 1,
        lifecycle: 'draft',
        name: 'Scope freeze probe',
      });
      return id;
    },
    publishParent: async (parentId) => {
      await db
        .update(productTypeDefinitions)
        .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: RUN })
        .where(eq(productTypeDefinitions.id, parentId));
    },
    demoteParent: async (parentId) => {
      await db
        .update(productTypeDefinitions)
        .set({ lifecycle: 'draft', publishedAt: null, publishedByOxyUserId: null })
        .where(eq(productTypeDefinitions.id, parentId));
    },
    insertScope: async (parentId, categoryId) => {
      await db
        .insert(productTypeCategoryScopes)
        .values({ productTypeDefinitionId: parentId, categoryId, includeDescendants: true });
    },
    updateScope: async (parentId, categoryId) => {
      await db
        .update(productTypeCategoryScopes)
        .set({ includeDescendants: false })
        .where(
          sql`${productTypeCategoryScopes.productTypeDefinitionId} = ${parentId}
              and ${productTypeCategoryScopes.categoryId} = ${categoryId}`,
        );
    },
    deleteScope: async (parentId, categoryId) => {
      await db
        .delete(productTypeCategoryScopes)
        .where(
          sql`${productTypeCategoryScopes.productTypeDefinitionId} = ${parentId}
              and ${productTypeCategoryScopes.categoryId} = ${categoryId}`,
        );
    },
    deleteParent: async (parentId) => {
      await db.delete(productTypeDefinitions).where(eq(productTypeDefinitions.id, parentId));
    },
    cloneRow: (parentId, categoryId) => ({
      id: uuidv7(),
      product_type_definition_id: parentId,
      category_id: categoryId,
      include_descendants: true,
    }),
  },
};

const frozen = CATEGORY_SCOPE_DISPOSITIONS.flatMap((entry) =>
  entry.kind === 'frozen_with_its_version' ? [entry] : [],
);

/** The parents this run created, so teardown can unwind them in order. */
const createdParents: { table: string; parentId: string }[] = [];

/** Attempt a write and report the SQLSTATE, or `accepted`. */
async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return 'accepted';
  } catch (error) {
    // A drizzle error's SQLSTATE lives on `cause`, never on `error.code`.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return `refused:${cause?.code ?? 'unknown'}`;
  }
}

/** The refusal's message, for the "which function raised it" assertion. */
async function refusalMessage(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return '';
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? '';
  }
}

beforeAll(async () => {
  db = await connectPostgres();
  await db.insert(categories).values([
    {
      id: CATEGORY_A,
      key: `scope.freeze.a.${RUN}`,
      name: 'Scope freeze A',
      slug: `scope-freeze-a-${RUN}`,
      lifecycle: 'published',
    },
    {
      id: CATEGORY_B,
      key: `scope.freeze.b.${RUN}`,
      name: 'Scope freeze B',
      slug: `scope-freeze-b-${RUN}`,
      lifecycle: 'published',
    },
  ]);
});

afterAll(async () => {
  if (db !== undefined) {
    for (const { table, parentId } of createdParents) {
      const fixture = FIXTURES[table];
      if (fixture === undefined) continue;
      // Demote FIRST. The freeze this file exists to prove is what refuses the
      // child deletes below while the parent is published, so a teardown that
      // deleted first would be the very write the trigger stops.
      await fixture.demoteParent(parentId);
      await fixture.deleteScope(parentId, CATEGORY_A);
      await fixture.deleteScope(parentId, CATEGORY_B);
      await fixture.deleteParent(parentId);
    }
    await db.delete(categories).where(inArray(categories.id, [CATEGORY_A, CATEGORY_B]));
  }
  await closePostgres();
});

describe('a category-specific override cannot be edited after its version is published', () => {
  it('has a builder for every frozen table the declaration names', () => {
    expect(frozen.length).toBeGreaterThanOrEqual(FROZEN_FLOOR);
    const missing = frozen.map((entry) => entry.table).filter((table) => !(table in FIXTURES));
    expect(
      missing,
      'A table is declared frozen with its version and this file cannot build a parent for it, ' +
        'so its trigger is declared and never executed. Add a fixture.',
    ).toEqual([]);
  });

  for (const entry of frozen) {
    describe(entry.table, () => {
      it('permits the three writes while the version is a DRAFT', async () => {
        const fixture = FIXTURES[entry.table];
        if (fixture === undefined) throw new Error(`no fixture for ${entry.table}`);
        const parentId = await fixture.draftParent();
        createdParents.push({ table: entry.table, parentId });

        expect(await outcome(() => fixture.insertScope(parentId, CATEGORY_A))).toBe('accepted');
        expect(await outcome(() => fixture.updateScope(parentId, CATEGORY_A))).toBe('accepted');
        expect(await outcome(() => fixture.deleteScope(parentId, CATEGORY_A))).toBe('accepted');
      });

      it('refuses all three once it is PUBLISHED, with restrict_violation', async () => {
        const fixture = FIXTURES[entry.table];
        if (fixture === undefined) throw new Error(`no fixture for ${entry.table}`);
        const parentId = await fixture.draftParent();
        createdParents.push({ table: entry.table, parentId });

        // One scope written while it is still legal to, so the UPDATE and the
        // DELETE below have a row to aim at. Without it a DELETE matching zero
        // rows passes whatever the trigger does — a `BEFORE ... FOR EACH ROW`
        // trigger never fires on a statement that touches nothing.
        await fixture.insertScope(parentId, CATEGORY_A);
        await fixture.publishParent(parentId);

        // INSERT: the widening ADR 0007 D2 names as the one edit the
        // immutability guarantee exists to refuse.
        expect(await outcome(() => fixture.insertScope(parentId, CATEGORY_B))).toBe(
          `refused:${RESTRICT_VIOLATION}`,
        );
        // UPDATE: flipping `include_descendants` is the inheritance rule itself.
        expect(await outcome(() => fixture.updateScope(parentId, CATEGORY_A))).toBe(
          `refused:${RESTRICT_VIOLATION}`,
        );
        // DELETE: without this the widest edit of the three stays available —
        // remove the scope and re-add it saying something else.
        expect(await outcome(() => fixture.deleteScope(parentId, CATEGORY_A))).toBe(
          `refused:${RESTRICT_VIOLATION}`,
        );

        // And the row is still there, so the refusal was not a rollback of a
        // delete that had already happened.
        const message = await refusalMessage(() => fixture.deleteScope(parentId, CATEGORY_A));
        expect(message).toContain('publish a new version instead');
      });

      it('names a trigger that is actually mounted, enabled, and on all three events', async () => {
        const rows = await db.execute<{
          tgname: string;
          tgenabled: string;
          events: string;
          timing: string;
        }>(sql`
          select tgname,
                 tgenabled,
                 array_to_string(array_remove(array[
                   case when (tgtype::int & 4) > 0 then 'insert' end,
                   case when (tgtype::int & 8) > 0 then 'delete' end,
                   case when (tgtype::int & 16) > 0 then 'update' end], null), ',') as events,
                 case when (tgtype::int & 2) > 0 then 'before' else 'after' end as timing
          from pg_trigger
          where tgrelid = ${sql.raw(`'public.${entry.table}'::regclass`)}
            and not tgisinternal
            and tgname = ${entry.trigger}
        `);
        const trigger = [...rows][0];
        expect(trigger, `${entry.trigger} is not mounted on ${entry.table}`).toBeDefined();
        // `O` is "enabled, origin". A trigger left `D` by an aborted
        // DISABLE TRIGGER window enforces nothing and still appears here.
        expect(trigger?.tgenabled).toBe('O');
        expect(trigger?.timing).toBe('before');
        expect(trigger?.events).toBe('insert,delete,update');
      });

      /**
       * THE mutation self-test.
       *
       * Same real published parent, same three statements, against a temp clone
       * of the same table carrying no triggers. Every one must be ACCEPTED — so
       * a refusal above that actually came from a CHECK, a unique index or a
       * foreign key would show up here as a refusal too, and this test would go
       * red rather than the freeze quietly getting the credit.
       */
      it('is the TRIGGER doing the refusing, not the table', async () => {
        const fixture = FIXTURES[entry.table];
        if (fixture === undefined) throw new Error(`no fixture for ${entry.table}`);
        const parentId = await fixture.draftParent();
        createdParents.push({ table: entry.table, parentId });
        await fixture.publishParent(parentId);

        const row = fixture.cloneRow(parentId, CATEGORY_B);
        const columnList = Object.keys(row)
          .map((name) => `"${name}"`)
          .join(', ');
        const values = Object.values(row);

        // The clone lives for one transaction, so every statement runs inside
        // it. `including all` copies the defaults, the CHECKs and the indexes —
        // so a refusal coming from the pair unique still shows up here — and
        // copies NO trigger, which is the one thing being taken away.
        const results = await db.transaction(async (tx) => {
          await tx.execute(
            sql.raw(
              `create temp table scope_clone (like public.${entry.table} including all) on commit drop`,
            ),
          );
          const inserted = await outcome(() =>
            tx.execute(
              sql`insert into scope_clone (${sql.raw(columnList)}) values (${sql.join(
                values.map((value) => sql`${value}`),
                sql`, `,
              )})`,
            ),
          );
          // The INSERT really landed. Without this the two statements below
          // match ZERO rows and report `accepted` whatever the clone does — an
          // "it was the trigger" verdict reached by measuring nothing.
          const present = [
            ...(await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from scope_clone
                  where ${sql.raw(`"${fixture.parentColumn}"`)} = ${parentId}`,
            )),
          ][0]?.n;

          // And the clone is CAPABLE of refusing: `including all` copied the
          // pair unique, so a DIFFERENT id naming the same (definition,
          // category) is a `23505`. A probe that answered `accepted` to
          // everything — a clone that turned out to carry no constraints, a
          // statement aimed at the wrong table — passes this test's headline
          // assertion and fails here.
          //
          // Inside a SAVEPOINT, because one failed statement aborts the WHOLE
          // transaction in PostgreSQL (`25P02`) and the update and delete below
          // would then fail for a reason that has nothing to do with them.
          // `tx.transaction(...)` is what issues the savepoint.
          const twin = fixture.cloneRow(parentId, CATEGORY_B);
          const duplicate = await outcome(() =>
            tx.transaction((sp) =>
              sp.execute(
                sql`insert into scope_clone (${sql.raw(columnList)}) values (${sql.join(
                  Object.values(twin).map((value) => sql`${value}`),
                  sql`, `,
                )})`,
              ),
            ),
          );

          const updated = await outcome(() =>
            tx.execute(
              sql`update scope_clone set include_descendants = false
                  where ${sql.raw(`"${fixture.parentColumn}"`)} = ${parentId}`,
            ),
          );
          const deleted = await outcome(() =>
            tx.execute(
              sql`delete from scope_clone
                  where ${sql.raw(`"${fixture.parentColumn}"`)} = ${parentId}`,
            ),
          );
          // The clone is dropped at commit; nothing here touches a shared table.
          return { inserted, present, duplicate, updated, deleted };
        });

        expect(results).toEqual({
          inserted: 'accepted',
          present: 1,
          duplicate: 'refused:23505',
          updated: 'accepted',
          deleted: 'accepted',
        });
      });
    });
  }
});
