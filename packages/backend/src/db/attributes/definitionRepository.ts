/**
 * Reads and writes for the versioned attribute registry (#94):
 * `attribute_definitions` and its labels, category scopes, enum values and
 * value aliases.
 *
 * Five tables in one module because they are one AGGREGATE — a definition
 * version and everything that gives its values meaning. Nothing here reads a
 * canonical product or variant; the annotation side lives in
 * `db/canonical/attributeRepository.ts` and cites this one through a real
 * foreign key.
 *
 * ## Category resolution walks the tree, and does it in SQL
 *
 * `listActiveDefinitionsForCategory` answers "which attributes apply here",
 * which is three questions at once: definitions scoped to this category,
 * definitions scoped to an ANCESTOR with `include_descendants`, and unscoped
 * definitions (which apply anywhere). The ancestor walk is a recursive CTE
 * rather than a read of `categories.ancestor_slugs`, because that array is a
 * maintained denormalization and this answer decides what a shopper may filter
 * on — a stale array would silently drop a whole category's filters.
 *
 * The CTE returns IDS ONLY and the rows are then read through drizzle. That is
 * deliberate: `db.execute` bypasses drizzle's column mappers, so a `timestamptz`
 * comes back as a raw string and `res.json` ships it as happily as a `Date`
 * (`CONVENTIONS.md`, third naming trap). Selecting ids sidesteps the whole class.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AttributeLifecycleState } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
  attributeEnumValues,
  attributeLabels,
  attributeValueAliases,
} from '../schema/attributeRegistry.js';

export type AttributeDefinitionRow = typeof attributeDefinitions.$inferSelect;
export type AttributeDefinitionInsert = typeof attributeDefinitions.$inferInsert;
export type AttributeDefinitionCategoryRow = typeof attributeDefinitionCategories.$inferSelect;
export type AttributeLabelRow = typeof attributeLabels.$inferSelect;
export type AttributeEnumValueRow = typeof attributeEnumValues.$inferSelect;
export type AttributeValueAliasRow = typeof attributeValueAliases.$inferSelect;

/** Insert one DRAFT definition version. Publishing is a separate, audited act. */
export async function insertAttributeDefinition(
  db: DatabaseOrTransaction,
  input: AttributeDefinitionInsert,
): Promise<AttributeDefinitionRow> {
  const rows = await db.insert(attributeDefinitions).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertAttributeDefinition returned no row.');
  return row;
}

export async function findAttributeDefinitionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<AttributeDefinitionRow | undefined> {
  const rows = await db
    .select()
    .from(attributeDefinitions)
    .where(eq(attributeDefinitions.id, id))
    .limit(1);
  return rows[0];
}

/**
 * The ACTIVE version of one attribute — the meaning a new observation is read
 * under.
 *
 * Exactly one row can satisfy this, held by
 * `attribute_definitions_one_active_per_key`. A `limit(1)` here would hide a
 * broken index behind a plausible answer, so the constraint is what makes the
 * limit honest rather than the limit making the query safe.
 */
export async function findActiveAttributeDefinition(
  db: DatabaseOrTransaction,
  key: string,
): Promise<AttributeDefinitionRow | undefined> {
  const rows = await db
    .select()
    .from(attributeDefinitions)
    .where(and(eq(attributeDefinitions.key, key), eq(attributeDefinitions.lifecycleState, 'active')))
    .limit(1);
  return rows[0];
}

/** One exact version — what a stored value cites, whatever its lifecycle state. */
export async function findAttributeDefinitionVersion(
  db: DatabaseOrTransaction,
  key: string,
  version: number,
): Promise<AttributeDefinitionRow | undefined> {
  const rows = await db
    .select()
    .from(attributeDefinitions)
    .where(and(eq(attributeDefinitions.key, key), eq(attributeDefinitions.version, version)))
    .limit(1);
  return rows[0];
}

/** Every version of one key, newest first. */
export async function listAttributeDefinitionVersions(
  db: DatabaseOrTransaction,
  key: string,
): Promise<AttributeDefinitionRow[]> {
  return db
    .select()
    .from(attributeDefinitions)
    .where(eq(attributeDefinitions.key, key))
    .orderBy(sql`${attributeDefinitions.version} desc`);
}

/** The highest version number recorded for a key, or 0 when the key is new. */
export async function maxAttributeDefinitionVersion(
  db: DatabaseOrTransaction,
  key: string,
): Promise<number> {
  const rows = await db
    .select({ version: attributeDefinitions.version })
    .from(attributeDefinitions)
    .where(eq(attributeDefinitions.key, key))
    .orderBy(sql`${attributeDefinitions.version} desc`)
    .limit(1);
  return rows[0]?.version ?? 0;
}

export async function listActiveAttributeDefinitions(
  db: DatabaseOrTransaction,
): Promise<AttributeDefinitionRow[]> {
  return db
    .select()
    .from(attributeDefinitions)
    .where(eq(attributeDefinitions.lifecycleState, 'active'))
    .orderBy(asc(attributeDefinitions.key));
}

export async function findActiveAttributeDefinitionsByKeys(
  db: DatabaseOrTransaction,
  keys: readonly string[],
): Promise<AttributeDefinitionRow[]> {
  if (keys.length === 0) return [];
  return db
    .select()
    .from(attributeDefinitions)
    .where(
      and(
        inArray(attributeDefinitions.key, [...keys]),
        eq(attributeDefinitions.lifecycleState, 'active'),
      ),
    );
}

/**
 * Move one version's lifecycle state.
 *
 * A CAS on the CURRENT state, one statement, so two concurrent publishes
 * produce exactly one winner — the order-status-machine shape
 * (`CONVENTIONS.md`, "a conditional write must stay ONE statement"). A
 * read-then-write here would let two operators both believe they published, and
 * the partial unique would then refuse the second with an index violation the
 * caller could not explain.
 */
export async function transitionAttributeDefinition(
  db: DatabaseOrTransaction,
  id: string,
  expected: AttributeLifecycleState,
  next: AttributeLifecycleState,
  audit: { publishedByOxyUserId?: string; publishedAt?: Date; deprecatedAt?: Date },
): Promise<AttributeDefinitionRow | undefined> {
  const rows = await db
    .update(attributeDefinitions)
    .set({
      lifecycleState: next,
      ...(audit.publishedByOxyUserId === undefined
        ? {}
        : { publishedByOxyUserId: audit.publishedByOxyUserId }),
      ...(audit.publishedAt === undefined ? {} : { publishedAt: audit.publishedAt }),
      ...(audit.deprecatedAt === undefined ? {} : { deprecatedAt: audit.deprecatedAt }),
    })
    .where(and(eq(attributeDefinitions.id, id), eq(attributeDefinitions.lifecycleState, expected)))
    .returning();
  return rows[0];
}

/** Update a DRAFT version's editable columns. Callers hold the draft guard. */
export async function updateDraftAttributeDefinition(
  db: DatabaseOrTransaction,
  id: string,
  patch: Partial<AttributeDefinitionInsert>,
): Promise<AttributeDefinitionRow | undefined> {
  const rows = await db
    .update(attributeDefinitions)
    .set(patch)
    .where(and(eq(attributeDefinitions.id, id), eq(attributeDefinitions.lifecycleState, 'draft')))
    .returning();
  return rows[0];
}

/** Scope a definition version to a category. Converges on the pair's unique. */
export async function addAttributeDefinitionCategory(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
  categoryId: string,
  includeDescendants: boolean,
): Promise<AttributeDefinitionCategoryRow | undefined> {
  const rows = await db
    .insert(attributeDefinitionCategories)
    .values({ attributeDefinitionId, categoryId, includeDescendants })
    .onConflictDoNothing({
      target: [
        attributeDefinitionCategories.attributeDefinitionId,
        attributeDefinitionCategories.categoryId,
      ],
    })
    .returning();
  return rows[0];
}

export async function listAttributeDefinitionCategories(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
): Promise<AttributeDefinitionCategoryRow[]> {
  return db
    .select()
    .from(attributeDefinitionCategories)
    .where(eq(attributeDefinitionCategories.attributeDefinitionId, attributeDefinitionId))
    .orderBy(asc(attributeDefinitionCategories.categoryId));
}

export async function listAttributeDefinitionCategoriesForMany(
  db: DatabaseOrTransaction,
  attributeDefinitionIds: readonly string[],
): Promise<AttributeDefinitionCategoryRow[]> {
  if (attributeDefinitionIds.length === 0) return [];
  return db
    .select()
    .from(attributeDefinitionCategories)
    .where(
      inArray(attributeDefinitionCategories.attributeDefinitionId, [...attributeDefinitionIds]),
    )
    .orderBy(asc(attributeDefinitionCategories.categoryId));
}

/**
 * Active definitions that apply to a category, INHERITANCE included.
 *
 * See the module header for why the ancestor walk is a CTE and why it returns
 * ids. The three disjuncts, in the order the SQL states them:
 *
 * 1. a scope row naming this category exactly;
 * 2. a scope row naming a STRICT ancestor of it, with `include_descendants`;
 * 3. no scope rows at all — the unscoped definition, which applies anywhere.
 *
 * Dropping disjunct 3 is the mistake that looks correct: a query joining only
 * the scope table answers with every general attribute missing, and the symptom
 * is a category page with no filters rather than an error.
 */
export async function listActiveDefinitionsForCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<AttributeDefinitionRow[]> {
  const matched = await db.execute<{ id: string }>(sql`
    with recursive ancestry as (
      select id, parent_id, 0 as depth from categories where id = ${categoryId}
      union all
      select c.id, c.parent_id, ancestry.depth + 1
      from categories c join ancestry on c.id = ancestry.parent_id
    )
    select d.id as id
    from attribute_definitions d
    where d.lifecycle_state = 'active'
      and (
        exists (
          select 1 from attribute_definition_categories s
          join ancestry a on a.id = s.category_id
          where s.attribute_definition_id = d.id
            and (a.depth = 0 or s.include_descendants)
        )
        or not exists (
          select 1 from attribute_definition_categories s
          where s.attribute_definition_id = d.id
        )
      )
  `);

  const ids = [...matched].map((row) => row.id);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(attributeDefinitions)
    .where(inArray(attributeDefinitions.id, ids))
    .orderBy(asc(attributeDefinitions.key));
}

/** Whether a definition's scope admits a category. The single-attribute form of the above. */
export async function definitionAppliesToCategory(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
  categoryId: string,
): Promise<boolean> {
  const scopes = await listAttributeDefinitionCategories(db, attributeDefinitionId);
  if (scopes.length === 0) return true;
  const matched = await db.execute<{ id: string }>(sql`
    with recursive ancestry as (
      select id, parent_id, 0 as depth from categories where id = ${categoryId}
      union all
      select c.id, c.parent_id, ancestry.depth + 1
      from categories c join ancestry on c.id = ancestry.parent_id
    )
    select s.id as id
    from attribute_definition_categories s
    join ancestry a on a.id = s.category_id
    where s.attribute_definition_id = ${attributeDefinitionId}
      and (a.depth = 0 or s.include_descendants)
    limit 1
  `);
  return [...matched].length > 0;
}

export async function upsertAttributeLabel(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
  locale: string,
  label: string,
  description?: string,
): Promise<AttributeLabelRow | undefined> {
  const rows = await db
    .insert(attributeLabels)
    .values({ attributeDefinitionId, locale, label, description: description ?? null })
    .onConflictDoUpdate({
      target: [attributeLabels.attributeDefinitionId, attributeLabels.locale],
      set: { label, description: description ?? null },
    })
    .returning();
  return rows[0];
}

export async function listAttributeLabels(
  db: DatabaseOrTransaction,
  attributeDefinitionIds: readonly string[],
): Promise<AttributeLabelRow[]> {
  if (attributeDefinitionIds.length === 0) return [];
  return db
    .select()
    .from(attributeLabels)
    .where(inArray(attributeLabels.attributeDefinitionId, [...attributeDefinitionIds]))
    .orderBy(asc(attributeLabels.locale));
}

export async function insertAttributeEnumValue(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
  value: string,
  label: string,
  position: number,
): Promise<AttributeEnumValueRow | undefined> {
  const rows = await db
    .insert(attributeEnumValues)
    .values({ attributeDefinitionId, value, label, position })
    .onConflictDoNothing({
      target: [attributeEnumValues.attributeDefinitionId, attributeEnumValues.value],
    })
    .returning();
  return rows[0];
}

export async function listAttributeEnumValues(
  db: DatabaseOrTransaction,
  attributeDefinitionIds: readonly string[],
): Promise<AttributeEnumValueRow[]> {
  if (attributeDefinitionIds.length === 0) return [];
  return db
    .select()
    .from(attributeEnumValues)
    .where(inArray(attributeEnumValues.attributeDefinitionId, [...attributeDefinitionIds]))
    .orderBy(asc(attributeEnumValues.position), asc(attributeEnumValues.value));
}

export async function insertAttributeValueAlias(
  db: DatabaseOrTransaction,
  input: {
    attributeDefinitionId: string;
    enumValueId: string;
    alias: string;
    catalogSourceId?: string;
  },
): Promise<AttributeValueAliasRow | undefined> {
  const rows = await db
    .insert(attributeValueAliases)
    .values({
      attributeDefinitionId: input.attributeDefinitionId,
      enumValueId: input.enumValueId,
      alias: input.alias,
      catalogSourceId: input.catalogSourceId ?? null,
    })
    .onConflictDoNothing({
      target: [attributeValueAliases.attributeDefinitionId, attributeValueAliases.normalizedAlias],
    })
    .returning();
  return rows[0];
}

export async function listAttributeValueAliases(
  db: DatabaseOrTransaction,
  attributeDefinitionIds: readonly string[],
): Promise<AttributeValueAliasRow[]> {
  if (attributeDefinitionIds.length === 0) return [];
  return db
    .select()
    .from(attributeValueAliases)
    .where(inArray(attributeValueAliases.attributeDefinitionId, [...attributeDefinitionIds]))
    .orderBy(asc(attributeValueAliases.normalizedAlias));
}

/** Definitions with no category scope at all — the ones that apply anywhere. */
export async function listUnscopedActiveDefinitions(
  db: DatabaseOrTransaction,
): Promise<AttributeDefinitionRow[]> {
  const scoped = db
    .select({ id: attributeDefinitionCategories.attributeDefinitionId })
    .from(attributeDefinitionCategories);
  return db
    .select()
    .from(attributeDefinitions)
    .where(
      and(
        eq(attributeDefinitions.lifecycleState, 'active'),
        sql`${attributeDefinitions.id} not in ${scoped}`,
        isNull(attributeDefinitions.deprecatedAt),
      ),
    )
    .orderBy(asc(attributeDefinitions.key));
}
