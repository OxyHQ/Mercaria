/**
 * The batched reads a composition needs and no other domain publishes
 * (#367 step 5, ADR 0007 D10).
 *
 * Every function here is a SELECT over a table somebody else owns, and that is
 * stated rather than hidden. The authoring domain composes eleven tables in
 * three domains; #94's registry, #367 step 1's taxonomy and step 3's product
 * types each publish the reads THEY need, and a form of forty fields needs
 * different ones — by id rather than by key, in a batch rather than singly.
 *
 * The rule this file follows, and the reason it is a repository rather than a
 * service reaching for a table: **it writes nothing.** There is no insert, no
 * update and no delete anywhere in it, and `catalog-authoring-isolation.test.ts`
 * fails the build if one appears. A read across a boundary is a join; a write
 * across one is a second authority.
 *
 * Where a batched read WOULD duplicate an existing one it is not here —
 * `listAttributeEnumValues` (#94), `findCategoryById` (#367 step 1),
 * `listProductTypeFields` and `listProductTypeFieldGroups` (step 3) are all
 * called directly from the service.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';
import { attributeDefinitions, attributeLabels } from '../schema/attributeRegistry.js';
import { categories } from '../schema/catalog.js';
import {
  productTypeCategoryScopes,
  productTypeDefinitions,
} from '../schema/productTypes.js';

export type AttributeDefinitionRow = typeof attributeDefinitions.$inferSelect;
export type AttributeLabelRow = typeof attributeLabels.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type ProductTypeDefinitionRow = typeof productTypeDefinitions.$inferSelect;

/**
 * The EXACT attribute versions a set of product-type fields cite, by id.
 *
 * By ID and not by key, which is the whole reason this exists beside #94's
 * `findActiveAttributeDefinitionsByKeys`: that one answers "what does this
 * attribute mean NOW", and a schema has to answer "what did it mean when this
 * version was published". Resolving a field's meaning through the active version
 * would make a published product type silently adopt a registry change, which is
 * exactly the reinterpretation ADR 0007 D5 freezes a version to prevent.
 */
export async function listAttributeDefinitionsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<AttributeDefinitionRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(attributeDefinitions)
    .where(inArray(attributeDefinitions.id, [...ids]))
    // `key` alone is not a total order over an id set: the only NON-partial
    // unique here is `(key, version)`, and this read is deliberately by VERSION
    // id, so two versions of one key can both be cited and tie. The composed
    // schema is hashed into `authoringEtag`, so a tie is not cosmetic — it
    // produces two validators for identical content and every revalidation
    // misses. `version` completes the unique, which makes the order total.
    .orderBy(asc(attributeDefinitions.key), asc(attributeDefinitions.version));
}

/**
 * Every localized label and description for a set of definition VERSIONS,
 * narrowed to a locale chain.
 *
 * One statement whatever the field count. #94 publishes the per-definition read
 * because its own operator surface shows one attribute at a time; a form shows
 * forty, and forty statements on the critical path of opening a product editor
 * is the N+1 this exists to avoid.
 */
export async function listAttributeLabelsForDefinitions(
  db: DatabaseOrTransaction,
  attributeDefinitionIds: readonly string[],
  locales: readonly string[],
): Promise<AttributeLabelRow[]> {
  if (attributeDefinitionIds.length === 0 || locales.length === 0) return [];
  return db
    .select()
    .from(attributeLabels)
    .where(
      and(
        inArray(attributeLabels.attributeDefinitionId, [...attributeDefinitionIds]),
        inArray(attributeLabels.locale, [...locales]),
      ),
    );
}

/**
 * The PUBLISHED product-type versions a category may be authored under.
 *
 * Three ways a version reaches a category, and only two of them are a join:
 *
 *  1. a scope row naming the category itself;
 *  2. a scope row naming a strict ANCESTOR of it, with `include_descendants`.
 *
 * There is deliberately no third disjunct. `attribute_definition_categories`
 * reads an empty scope as "applies everywhere", and `product_type_category_scopes`
 * reads it as "nowhere" — the grant/narrow asymmetry ADR 0007 D5 records — so a
 * version nobody scoped is offered under no category at all. Copying #94's
 * `not exists` disjunct here would offer every freshly drafted schema everywhere,
 * which is the failure the asymmetry exists to prevent.
 *
 * The ancestry walk is a recursive CTE over `parent_id` rather than a containment
 * test on `ancestor_ids`, because the scope's `include_descendants` is what
 * decides whether a hop counts and the GIN'd array cannot express "and only if
 * that particular ancestor said so".
 */
export async function listPublishedProductTypesForCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<{ definition: ProductTypeDefinitionRow; includeDescendants: boolean }[]> {
  const matched = await db.execute<{ id: string; include_descendants: boolean }>(sql`
    with recursive ancestry as (
      select id, parent_id, 0 as depth from categories where id = ${categoryId}
      union all
      select c.id, c.parent_id, ancestry.depth + 1
      from categories c join ancestry on c.id = ancestry.parent_id
    )
    select d.id as id, bool_or(a.depth = 0 or s.include_descendants) as include_descendants
    from product_type_definitions d
    join product_type_category_scopes s on s.product_type_definition_id = d.id
    join ancestry a on a.id = s.category_id
    where d.lifecycle = 'published'
      and (a.depth = 0 or s.include_descendants)
    group by d.id
  `);

  const rows = [...matched];
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((row) => [row.id, row.include_descendants]));
  const definitions = await db
    .select()
    .from(productTypeDefinitions)
    .where(inArray(productTypeDefinitions.id, [...byId.keys()]))
    // `(key, version)` for the reason above: `key` is unique only under
    // `product_type_definitions_one_published_per_key`, a PARTIAL index. The
    // CTE above does filter `lifecycle = 'published'`, so the predicate happens
    // to hold today — but it holds one hop away, in a different statement, with
    // nothing local to this ORDER BY that would break if the CTE were edited.
    // The non-partial `(key, version)` unique needs no such argument.
    .orderBy(asc(productTypeDefinitions.key), asc(productTypeDefinitions.version));

  return definitions.map((definition) => ({
    definition,
    includeDescendants: byId.get(definition.id) ?? false,
  }));
}

/**
 * Whether a product-type VERSION is eligible under a category.
 *
 * The same question the listing above answers, asked about one pair — and asked
 * SEPARATELY rather than by scanning that list, because a draft pins a version
 * that may since have been deprecated, and the eligibility of a deprecated
 * version is still a real question a validation has to answer. Filtering on
 * `lifecycle = 'published'` here would report a pinned draft as miscategorized
 * the day its version was superseded.
 */
export async function productTypeIsScopedToCategory(
  db: DatabaseOrTransaction,
  productTypeDefinitionId: string,
  categoryId: string,
): Promise<boolean> {
  const matched = await db.execute<{ ok: boolean }>(sql`
    with recursive ancestry as (
      select id, parent_id, 0 as depth from categories where id = ${categoryId}
      union all
      select c.id, c.parent_id, ancestry.depth + 1
      from categories c join ancestry on c.id = ancestry.parent_id
    )
    select true as ok
    from product_type_category_scopes s
    join ancestry a on a.id = s.category_id
    where s.product_type_definition_id = ${productTypeDefinitionId}
      and (a.depth = 0 or s.include_descendants)
    limit 1
  `);
  return [...matched].length > 0;
}

/**
 * The categories an author may FILE a product under.
 *
 * `selectable` and `lifecycle = 'published'` are both required, and they are
 * different facts: a grouping root is published and not selectable, while a
 * connector holding pen is selectable and suppressed. Offering either would let
 * a real product land somewhere ADR 0007 D2 says it may not.
 */
export async function listSelectableCategories(
  db: DatabaseOrTransaction,
  options: { parentId?: string | null; limit: number },
): Promise<CategoryRow[]> {
  const selectable = and(
    eq(categories.selectable, true),
    eq(categories.lifecycle, 'published'),
  );
  return db
    .select()
    .from(categories)
    .where(
      options.parentId === undefined
        ? selectable
        : options.parentId === null
          ? and(selectable, sql`${categories.parentId} is null`)
          : and(selectable, eq(categories.parentId, options.parentId)),
    )
    // `(position, name, slug)` and NOT `(position, name)`: `categories.name` carries
    // no unique index, so two siblings sharing a position and a name were ordered by
    // whatever the planner returned — a page-2 read could then repeat or drop one,
    // and nothing anywhere would say so. `slug` carries `categories_slug_key`, so
    // adding it makes the order TOTAL. `name` stays the leading display key because
    // this is a picker a human reads.
    .orderBy(asc(categories.position), asc(categories.name), asc(categories.slug))
    .limit(options.limit);
}

/** One category, for the pin a draft states and a validation re-checks. */
export async function findCategoryRow(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<CategoryRow | null> {
  const rows = await db
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  return rows[0] ?? null;
}

/** The newest PUBLISHED version of a product type key, for the upgrade preview. */
export async function findPublishedVersionForKey(
  db: DatabaseOrTransaction,
  key: string,
): Promise<ProductTypeDefinitionRow | null> {
  const rows = await db
    .select()
    .from(productTypeDefinitions)
    .where(
      and(eq(productTypeDefinitions.key, key), eq(productTypeDefinitions.lifecycle, 'published')),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** One product-type version by `(key, version)` — what `?version=` resolves. */
export async function findProductTypeVersion(
  db: DatabaseOrTransaction,
  key: string,
  version: number,
): Promise<ProductTypeDefinitionRow | null> {
  const rows = await db
    .select()
    .from(productTypeDefinitions)
    .where(and(eq(productTypeDefinitions.key, key), eq(productTypeDefinitions.version, version)))
    .limit(1);
  return rows[0] ?? null;
}

/** The category ids a product-type version is scoped to — the schema's own pin. */
export async function listScopedCategoryIds(
  db: DatabaseOrTransaction,
  productTypeDefinitionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ categoryId: productTypeCategoryScopes.categoryId })
    .from(productTypeCategoryScopes)
    .where(eq(productTypeCategoryScopes.productTypeDefinitionId, productTypeDefinitionId));
  return rows.map((row) => row.categoryId);
}
