/**
 * The metadata reads that GENERATE a facet list (#367 Workstream 10,
 * ADR 0007 D2/D5).
 *
 * Nothing in this file counts anything. It answers three questions and no
 * others: which product type version governs this category, what that version
 * says about each attribute, and what a controlled value is called.
 *
 * ## Why the product type is resolved from the CATEGORY
 *
 * `canonical_products` carries no `product_type_definition_id` — ADR 0007 D13
 * gives that column to `listings` and `product_variants`, and the canonical
 * graph is not re-modelled by this epic. `product_type_category_scopes` is
 * therefore the join, which is also exactly where D2 and D5 put the eligibility:
 * the scope rows are owned by the PRODUCT-TYPE domain precisely so publishing a
 * version freezes its own category eligibility.
 *
 * Empty scope means NOTHING here, the opposite of `attribute_definition_categories`
 * — `productTypes.ts` states that inversion and this read inherits it by simply
 * joining: a version with no scope rows matches no category.
 */

import { sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';

/**
 * The authoring flow whose field order the facet rail follows.
 *
 * `product_type_fields` is unique on `(definition, flow, attribute)`, so one
 * attribute has a position PER FLOW and a facet rail needs exactly one. There is
 * no `shopper` member in `PRODUCT_TYPE_AUTHORING_FLOWS` — the vocabulary is
 * about who is AUTHORING — so the choice is between inventing a flow (a schema
 * change in a domain this one does not own) and naming one.
 *
 * `merchant` is named because it is the fullest flow: a merchant authoring a
 * product states every field the type defines, so its ordering is the type's own
 * statement of what matters most about this kind of thing. An attribute with no
 * `merchant` row falls back to the LOWEST position it holds in any flow, which
 * is deterministic and cannot depend on which flow happened to be read first.
 *
 * If a shopper-facing flow is ever wanted it belongs in
 * `PRODUCT_TYPE_AUTHORING_FLOWS` with a migration, owned by #367 Workstream 3 —
 * not as a second ordering table here.
 */
export const PRODUCT_TYPE_FACET_ORDERING_FLOW = 'merchant';

/** The published product type version governing a category, if there is one. */
export interface FacetProductTypeRow extends Record<string, unknown> {
  id: string;
  key: string;
  version: number;
  scopeDepth: number;
}

/**
 * The most SPECIFIC published product type version covering this category.
 *
 * "Most specific" is the length of the scope category's own ancestry: a version
 * scoped directly at `electronics.phones.smartphones` beats one scoped at
 * `electronics` with `include_descendants`. Ties break on `key`, so the answer
 * is total and reproducible — a facet rail whose order depended on which of two
 * equally-scoped types the planner returned first would reshuffle between
 * requests with nothing saying why.
 */
export async function findProductTypeForCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<FacetProductTypeRow | null> {
  const rows = await db.execute<FacetProductTypeRow>(sql`
    with target as (
      select c.id, c.ancestor_ids from categories c where c.id = ${categoryId}
    )
    select d.id, d.key, d.version, cardinality(sc_cat.ancestor_ids) as "scopeDepth"
    from product_type_definitions d
    join product_type_category_scopes s on s.product_type_definition_id = d.id
    join categories sc_cat on sc_cat.id = s.category_id
    cross join target t
    where d.lifecycle = 'published'
      and (s.category_id = t.id
           or (s.include_descendants and s.category_id = any(t.ancestor_ids)))
    order by "scopeDepth" desc, d.key
    limit 1`);
  return rows[0] ?? null;
}

/**
 * What one product type version says about each attribute it names.
 *
 * One row per attribute, already collapsed across flows: the ordering flow's own
 * position when it has one, otherwise the lowest across every flow. The
 * REQUIREMENT and SCOPE are taken from the same row the position came from, so a
 * field cannot be ordered by one flow's opinion and hidden by another's.
 */
export interface FacetProductTypeFieldRow extends Record<string, unknown> {
  attributeKey: string;
  attributeDefinitionId: string;
  attributeDefinitionVersion: number;
  scope: string;
  requirement: string;
  variantCapable: boolean;
  fieldPosition: number;
  groupKey: string | null;
  groupLabel: string | null;
  groupPosition: number;
}

export async function listProductTypeFacetFields(
  db: DatabaseOrTransaction,
  productTypeDefinitionId: string,
): Promise<FacetProductTypeFieldRow[]> {
  const rows = await db.execute<FacetProductTypeFieldRow>(sql`
    select distinct on (f.attribute_key)
           f.attribute_key as "attributeKey",
           f.attribute_definition_id as "attributeDefinitionId",
           f.attribute_definition_version as "attributeDefinitionVersion",
           f.scope,
           f.requirement,
           f.variant_capable as "variantCapable",
           f.position as "fieldPosition",
           g.key as "groupKey",
           g.label as "groupLabel",
           coalesce(g.position, 0) as "groupPosition"
    from product_type_fields f
    left join product_type_field_groups g on g.id = f.group_id
    where f.product_type_definition_id = ${productTypeDefinitionId}
    order by f.attribute_key,
             (f.flow = ${PRODUCT_TYPE_FACET_ORDERING_FLOW}) desc,
             f.position,
             f.id`);
  return [...rows];
}

/** A controlled value, with the registry's own display order and its id. */
export interface FacetEnumValueRow extends Record<string, unknown> {
  attributeKey: string;
  enumValueId: string;
  value: string;
  label: string;
  position: number;
}

/**
 * Every controlled value of the named attributes, in the REGISTRY's order.
 *
 * The order is `attribute_enum_values.position` and never the counts. Ordering a
 * size filter by popularity is how `S, M, L, XL` becomes `M, L, S, XL` — the
 * reasoning `facets.service.ts` already records for #94's own category facets,
 * restated here because this read is what makes it possible to obey.
 *
 * `enumValueId` travels because it is what `attribute_value_localizations` is
 * keyed on: a localized value label is resolved by ID, and re-deriving one from
 * the value string would be a second identity for a concept ADR 0007 D1 gives
 * exactly two.
 */
export async function listFacetEnumValues(
  db: DatabaseOrTransaction,
  attributeDefinitionIds: readonly string[],
): Promise<FacetEnumValueRow[]> {
  if (attributeDefinitionIds.length === 0) return [];
  const rows = await db.execute<FacetEnumValueRow>(sql`
    select d.key as "attributeKey",
           e.id as "enumValueId",
           e.value,
           e.label,
           e.position
    from attribute_enum_values e
    join attribute_definitions d on d.id = e.attribute_definition_id
    where e.attribute_definition_id = any(${sql.param([...attributeDefinitionIds])}::text[])
    order by d.key, e.position, e.value`);
  return [...rows];
}

/**
 * Per-locale attribute NAMES, for the facet's own label.
 *
 * `attribute_labels` rather than `services/catalog-localization`'s resolver,
 * and the reason is a real gap rather than a preference: `LOCALIZED_ENTITY_KINDS`
 * is `['category', 'product_type', 'attribute_value']`, and `attribute_labels`
 * is the ONE member of `CATALOG_LOCALIZATION_TEXT_TABLES` carrying a recorded
 * exemption from the family columns — it has no `status`, no `provenance` and no
 * reviewer. So `resolveLocalizedField` cannot be handed one of these rows.
 *
 * What this domain does NOT do is write a second fallback chain:
 * `localeFallbackChain` from that same module is pure and exported, and it is
 * what narrows this read. Making `attribute_definition` a full localization
 * entity is #367 Workstream 2's, and closing it removes this function.
 */
export interface FacetAttributeLabelRow extends Record<string, unknown> {
  attributeKey: string;
  locale: string;
  label: string;
}

export async function listFacetAttributeLabels(
  db: DatabaseOrTransaction,
  attributeDefinitionIds: readonly string[],
  locales: readonly string[],
): Promise<FacetAttributeLabelRow[]> {
  if (attributeDefinitionIds.length === 0 || locales.length === 0) return [];
  const rows = await db.execute<FacetAttributeLabelRow>(sql`
    select d.key as "attributeKey", l.locale, l.label
    from attribute_labels l
    join attribute_definitions d on d.id = l.attribute_definition_id
    where l.attribute_definition_id = any(${sql.param([...attributeDefinitionIds])}::text[])
      and l.locale = any(${sql.param([...locales])}::text[])`);
  return [...rows];
}
