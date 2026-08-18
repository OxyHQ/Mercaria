/**
 * Every statement the facet domain issues (#367 Workstream 10).
 *
 * ## The one idea in this file
 *
 * A filter set is a CONJUNCTION OF NESTED EXISTENCE CLAIMS, not a bag of
 * independent predicates over a product:
 *
 * ```
 * exists (variant cv of p, active
 *          … every VARIANT requirement, against THIS cv
 *          … exists (offer o on cv, active and fresh
 *                     … every OFFER requirement, against THIS o))
 * ```
 *
 * Written any other way — one `exists` per requirement, each free to find its
 * own variant and its own offer — the statement answers "Red exists AND 43
 * exists" and reports a product that has no red 43. Every predicate is
 * individually true; the result is a false match, it renders perfectly, and the
 * shopper finds out at the size chart. Same-offer is the identical failure one
 * level down: a price from the cheap seller and stock from a different one.
 *
 * {@link buildEntityPredicate} is therefore the ONLY place a selection becomes
 * SQL, and it takes the variant and offer requirement sets TOGETHER. There is no
 * function here that accepts one variant requirement on its own, so the shape
 * that produced the bug has no way to be spelled.
 *
 * ## Counting
 *
 * Every count in this file is `count(distinct p.id)` — distinct canonical
 * PRODUCTS. A product with forty variants and two hundred offers is one result,
 * and `count(*)` over the value or offer rows would report it forty or two
 * hundred times. That is not a rounding difference: it is the number a shopper
 * reads beside a checkbox, and it would exceed the number of results the
 * checkbox produces.
 *
 * ## `cv.status = 'active'` is spelled ten times here and NOWHERE on the list rail
 *
 * The two rails serve one page and disagree about which variants may answer a
 * filter (#616). Measured: this file requires `active`;
 * `findVariantIntentMatches` in `db/search/searchCandidateRepository.ts`
 * requires `in ('active', 'discontinued')`; and
 * `findProductIdsSatisfyingAttributes` beside it carries NO status predicate at
 * all — wider than either, since the vocabulary is
 * `draft | active | discontinued | merged | suppressed`.
 *
 * Do not close the gap by copying either spelling into the other rail without a
 * decision. Narrowing the list rail to `active` would make it narrower than the
 * variant read twenty lines above it, whose docblock argues by name that
 * somebody searching a discontinued model means that model; widening this file
 * to match would admit products these counts exclude today. The full statement
 * of both candidate answers is on `findProductIdsSatisfyingAttributes`, which is
 * where a reader arrives holding the change.
 *
 * ## No index was added and none is needed
 *
 * The scope narrows on `canonical_products.category_id`
 * (`canonical_products_category_id_idx`) or on a bounded id list; the subtree
 * comes off `categories.ancestor_ids` (GIN); variant requirements land on
 * `canonical_attribute_values_variant_selected_key` and
 * `canonical_variant_attrs_key_unique`, both of which lead on `variant_id`;
 * product requirements land on `canonical_attribute_values_product_selected_key`;
 * offer requirements land on `offers_variant_comparison_idx`
 * (`canonical_variant_id, price_amount, id` where `status = 'active'`). #61
 * measured this graph at a million offers and adopted no projection; the shapes
 * appended to its workload measure these statements rather than a transcription
 * of them.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { ConditionGroup, OfferKind } from '@mercaria/shared-types';
import { conditionKeysInGroup } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';

/**
 * One requirement on an attribute, already normalized into the definition's
 * own base unit and canonical value spelling by the service.
 *
 * No `key`-less form and no free text: a requirement names a #94 registry key
 * (ADR 0007 D1 — a label is never identity), and its values are the controlled
 * spellings `canonical_attribute_values.normalized_text` stores.
 */
export interface FacetAttributeRequirement {
  readonly key: string;
  /** OR within one requirement, AND across requirements. */
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

/**
 * A price bound expressed PER SOURCE CURRENCY.
 *
 * The bound is converted into each currency present in scope rather than the
 * amounts being converted into the bound's — SQL cannot call `fx.service`, and
 * multiplying a `bigint` minor-unit column by a float rate in the statement
 * would put money arithmetic in the planner. The service does the conversion
 * once through `fx.convert`, the one authority, and hands the results down.
 * A currency with no rate produces no entry here and is REPORTED as
 * unconvertible rather than silently compared.
 */
export interface FacetPriceBound {
  readonly currency: string;
  readonly minMinor?: number;
  readonly maxMinor?: number;
}

/** Every requirement an OFFER must satisfy — all of them, on the same offer. */
export interface FacetOfferRequirements {
  readonly availability?: readonly string[];
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly markets?: readonly string[];
  readonly channels?: readonly ('native' | 'external')[];
  readonly priceBounds?: readonly FacetPriceBound[];
}

/** Whether any offer requirement is actually present. */
export function hasOfferRequirement(requirements: FacetOfferRequirements): boolean {
  return (
    (requirements.availability?.length ?? 0) > 0 ||
    (requirements.conditionGroups?.length ?? 0) > 0 ||
    (requirements.markets?.length ?? 0) > 0 ||
    (requirements.channels?.length ?? 0) > 0 ||
    (requirements.priceBounds?.length ?? 0) > 0
  );
}

/** Everything one facet run narrows by, partitioned by the grain it binds at. */
export interface FacetRequirements {
  /** Requirements about the PRODUCT — each independent, all about one row. */
  readonly product: readonly FacetAttributeRequirement[];
  /** Requirements about a VARIANT — all of them, on ONE variant. */
  readonly variant: readonly FacetAttributeRequirement[];
  /** Requirements about an OFFER — all of them, on ONE offer of that variant. */
  readonly offer: FacetOfferRequirements;
  /** Category ids the product must be filed under, when the shopper refined. */
  readonly categoryIds?: readonly string[];
}

/** The empty requirement set — what an unfiltered first load carries. */
export const NO_FACET_REQUIREMENTS: FacetRequirements = {
  product: [],
  variant: [],
  offer: {},
};

/** The set of canonical products a facet run is about. */
export type FacetScopeInput =
  | { readonly kind: 'categories'; readonly categoryIds: readonly string[] }
  | { readonly kind: 'products'; readonly canonicalProductIds: readonly string[] };

/** `now` is the caller's, so a run measures one instant across every statement. */
export interface FacetQueryContext {
  readonly scope: FacetScopeInput;
  readonly requirements: FacetRequirements;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Predicate construction
// ---------------------------------------------------------------------------

/**
 * An instant, bound the way postgres.js can actually serialise it.
 *
 * A bare `Date` interpolated into a `sql` template fails AT SERIALISATION in the
 * driver — `~/Oxy/AGENTS.md` names it, and this file hit it on the first real
 * run: five cases failed with `Received an instance of Date`, which reads like a
 * type error and is a binding one. The ISO string plus an explicit
 * `::timestamptz` is what the driver takes, and the cast is not optional —
 * without it the comparison is text against `timestamptz`.
 */
function instant(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

/** The scope, as a predicate over the alias `p`. */
function scopePredicate(scope: FacetScopeInput): SQL {
  const active = sql`p.status = 'active'`;
  if (scope.kind === 'categories') {
    return sql`${active} and p.category_id = any(${sql.param([...scope.categoryIds])}::text[])`;
  }
  return sql`${active} and p.id = any(${sql.param([...scope.canonicalProductIds])}::text[])`;
}

/**
 * One attribute requirement, as a predicate over a `canonical_attribute_values`
 * alias.
 *
 * `selection_state = 'selected'` and nothing else, the rule #94 states and
 * #70 repeats: a `conflicting` value is two sources disagreeing and the registry
 * deliberately selects neither, so filtering on one would answer with whichever
 * source was written first. `normalization_state` needs no test beside it —
 * `canonical_attribute_values_selected_state_check` makes `selected` imply
 * `normalized`, so a second predicate here would be a second spelling of a
 * constraint the database already holds.
 */
function attributeValuePredicate(alias: string, requirement: FacetAttributeRequirement): SQL {
  const parts: SQL[] = [
    sql`${sql.raw(alias)}.selection_state = 'selected'`,
    sql`${sql.raw(alias)}.attribute_key = ${requirement.key}`,
  ];
  if (requirement.values !== undefined && requirement.values.length > 0) {
    parts.push(
      sql`${sql.raw(alias)}.normalized_text = any(${sql.param([...requirement.values])}::text[])`,
    );
  }
  if (requirement.min !== undefined) {
    // The UPPER end of a stored range satisfies a lower bound — a value
    // recorded as 8–16 GB is at least 8. `normalized_number_max` is NULL for a
    // scalar, so the coalesce collapses to the scalar case.
    parts.push(
      sql`coalesce(${sql.raw(alias)}.normalized_number_max, ${sql.raw(alias)}.normalized_number) >= ${requirement.min}`,
    );
  }
  if (requirement.max !== undefined) {
    parts.push(sql`${sql.raw(alias)}.normalized_number <= ${requirement.max}`);
  }
  return sql.join(parts, sql` and `);
}

/**
 * One attribute requirement, as a predicate over a
 * `canonical_variant_attributes` alias — the AXIS assignment table.
 *
 * A variant's colour may be recorded as a registry value
 * (`canonical_attribute_values` at variant grain) or as the option assignment
 * that defines the variant (`canonical_variant_attributes`). Reading only the
 * first drops every variant whose axis was written by the matcher, which is most
 * of them; reading only the second drops every measured spec. So both are read
 * and OR'd — one requirement, two places it can be satisfied, still ONE variant.
 */
function variantAxisPredicate(alias: string, requirement: FacetAttributeRequirement): SQL {
  const parts: SQL[] = [
    sql`${sql.raw(alias)}.normalization_state = 'normalized'`,
    sql`${sql.raw(alias)}.attribute_key = ${requirement.key}`,
  ];
  if (requirement.values !== undefined && requirement.values.length > 0) {
    parts.push(
      sql`${sql.raw(alias)}.normalized_value = any(${sql.param([...requirement.values])}::text[])`,
    );
  }
  if (requirement.min !== undefined) {
    parts.push(sql`${sql.raw(alias)}.normalized_number >= ${requirement.min}`);
  }
  if (requirement.max !== undefined) {
    parts.push(sql`${sql.raw(alias)}.normalized_number <= ${requirement.max}`);
  }
  return sql.join(parts, sql` and `);
}

/** A product-grain requirement: an `exists` against the product's own values. */
function productRequirementExists(requirement: FacetAttributeRequirement): SQL {
  return sql`exists (
    select 1 from canonical_attribute_values pav
    where pav.product_id = p.id and ${attributeValuePredicate('pav', requirement)})`;
}

/** A variant-grain requirement, bound to ONE named variant alias. */
function variantRequirementExists(variantAlias: string, requirement: FacetAttributeRequirement): SQL {
  return sql`(exists (
      select 1 from canonical_attribute_values vav
      where vav.variant_id = ${sql.raw(variantAlias)}.id
        and ${attributeValuePredicate('vav', requirement)})
    or exists (
      select 1 from canonical_variant_attributes vaa
      where vaa.variant_id = ${sql.raw(variantAlias)}.id
        and ${variantAxisPredicate('vaa', requirement)}))`;
}

/**
 * Every offer requirement, on ONE offer of one named variant.
 *
 * `status = 'active'` and `stale_at > now` are #57's and #68's own liveness
 * tests, spelled the way `searchOfferRepository` spells them. A market
 * requirement admits a NULL country, matching that repository exactly: an offer
 * with no declared market is available everywhere rather than nowhere.
 *
 * Condition SEGMENTS collapse into ONE key membership test — the #90 rule
 * `listOffersForComparison` states, and the reason is a real bug: two ANDed
 * `IN` lists answer with the empty set for a facet UI that sent both a segment
 * and a key.
 */
function offerRequirementsExists(
  variantAlias: string,
  requirements: FacetOfferRequirements,
  now: Date,
): SQL {
  const parts: SQL[] = [
    sql`o.canonical_variant_id = ${sql.raw(variantAlias)}.id`,
    sql`o.status = 'active'`,
    sql`o.stale_at > ${instant(now)}`,
  ];
  if (requirements.availability !== undefined && requirements.availability.length > 0) {
    parts.push(sql`o.availability = any(${sql.param([...requirements.availability])}::text[])`);
  }
  if (requirements.conditionGroups !== undefined && requirements.conditionGroups.length > 0) {
    const keys = new Set<string>();
    for (const group of requirements.conditionGroups) {
      for (const key of conditionKeysInGroup(group)) keys.add(key);
    }
    parts.push(sql`o.condition = any(${sql.param([...keys])}::text[])`);
  }
  if (requirements.markets !== undefined && requirements.markets.length > 0) {
    parts.push(
      sql`(o.country is null or o.country = any(${sql.param([...requirements.markets])}::text[]))`,
    );
  }
  if (requirements.channels !== undefined && requirements.channels.length > 0) {
    parts.push(sql`${offerChannelPredicate(requirements.channels)}`);
  }
  if (requirements.priceBounds !== undefined && requirements.priceBounds.length > 0) {
    parts.push(priceBoundsPredicate(requirements.priceBounds));
  }
  return sql`exists (select 1 from offers o where ${sql.join(parts, sql` and `)})`;
}

/**
 * `native` versus `external` — #94's two-member {@link OfferChannelKind}, not
 * `offers.kind`'s four.
 *
 * `affiliate` and `informational` are both "this leaves Mercaria", which is the
 * distinction a shopper is drawing. Bucketing on the four-member column would
 * offer three chips for one question.
 */
function offerChannelPredicate(channels: readonly ('native' | 'external')[]): SQL {
  const wantsNative = channels.includes('native');
  const wantsExternal = channels.includes('external');
  if (wantsNative && wantsExternal) return sql`true`;
  if (wantsNative) return sql`o.kind = 'native'`;
  return sql`o.kind <> 'native'`;
}

/** The per-currency price bound, OR'd — an offer satisfies it in ITS currency. */
function priceBoundsPredicate(bounds: readonly FacetPriceBound[]): SQL {
  const perCurrency = bounds.map((bound) => {
    const parts: SQL[] = [
      sql`o.price_currency = ${bound.currency}`,
      sql`o.price_amount is not null`,
    ];
    if (bound.minMinor !== undefined) parts.push(sql`o.price_amount >= ${bound.minMinor}`);
    if (bound.maxMinor !== undefined) parts.push(sql`o.price_amount <= ${bound.maxMinor}`);
    return sql`(${sql.join(parts, sql` and `)})`;
  });
  return sql`(${sql.join(perCurrency, sql` or `)})`;
}

/**
 * THE conjunction: the scope, plus every requirement, correctly nested.
 *
 * Exported so the plan-regression suite and the isolation gate can both reach
 * it, and so that no other module in this repository has a reason to compose one
 * of these by hand.
 *
 * The nesting is the point and it has three cases:
 *
 * - no variant and no offer requirement → the product predicates alone;
 * - variant requirements → ONE `exists` over `canonical_variants` carrying all
 *   of them, so they are satisfied by one variant (SAME-VARIANT);
 * - offer requirements → an `exists` over `offers` carrying all of them, INSIDE
 *   the variant `exists` when there is one (SAME-VARIANT ⊗ SAME-OFFER) and over
 *   the product's variants when there is not.
 *
 * The offer clause is never a sibling of the variant clause. That is the whole
 * difference between "a red one exists and a cheap one exists" and "a cheap red
 * one exists".
 */
export function buildEntityPredicate(context: FacetQueryContext): SQL {
  const parts: SQL[] = [scopePredicate(context.scope)];
  const { requirements } = context;

  if (requirements.categoryIds !== undefined && requirements.categoryIds.length > 0) {
    parts.push(sql`p.category_id = any(${sql.param([...requirements.categoryIds])}::text[])`);
  }
  for (const requirement of requirements.product) {
    parts.push(productRequirementExists(requirement));
  }

  const wantsOffer = hasOfferRequirement(requirements.offer);
  if (requirements.variant.length > 0) {
    const inner: SQL[] = [sql`cv.product_id = p.id`, sql`cv.status = 'active'`];
    for (const requirement of requirements.variant) {
      inner.push(variantRequirementExists('cv', requirement));
    }
    if (wantsOffer) {
      inner.push(offerRequirementsExists('cv', requirements.offer, context.now));
    }
    parts.push(
      sql`exists (select 1 from canonical_variants cv where ${sql.join(inner, sql` and `)})`,
    );
  } else if (wantsOffer) {
    parts.push(
      sql`exists (select 1 from canonical_variants cv
                  where cv.product_id = p.id and cv.status = 'active'
                    and ${offerRequirementsExists('cv', requirements.offer, context.now)})`,
    );
  }

  return sql.join(parts, sql` and `);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The category subtree in scope, root first.
 *
 * `ancestor_ids` is the materialized path ADR 0007 D2 adopted, with its GIN
 * index — so a subtree is ONE indexed statement rather than a recursive CTE.
 * `lifecycle` narrows to what a shopper may be shown: a `draft`, `deprecated`,
 * `merged` or `suppressed` node is not somewhere to browse.
 */
export async function findFacetCategoryScope(
  db: DatabaseOrTransaction,
  categoryId: string,
  includeDescendants: boolean,
): Promise<string[]> {
  if (!includeDescendants) {
    const own = await db.execute<{ id: string }>(sql`
      select c.id from categories c
      where c.id = ${categoryId} and c.lifecycle = 'published'`);
    return [...own].map((row) => row.id);
  }
  const rows = await db.execute<{ id: string }>(sql`
    select c.id from categories c
    where c.lifecycle = 'published'
      and (c.id = ${categoryId} or c.ancestor_ids @> array[${categoryId}]::text[])
    order by cardinality(c.ancestor_ids), c.position, c.id`);
  return [...rows].map((row) => row.id);
}

/** One category's immediate children, in the taxonomy's own sibling order. */
export interface FacetChildCategoryRow extends Record<string, unknown> {
  id: string;
  name: string;
  position: number;
}

export async function findFacetChildCategories(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<FacetChildCategoryRow[]> {
  const rows = await db.execute<FacetChildCategoryRow>(sql`
    select c.id, c.name, c.position
    from categories c
    where c.parent_id = ${categoryId}
      and c.lifecycle = 'published' and c.selectable
    order by c.position, c.id`);
  return [...rows];
}

/** Distinct products satisfying every requirement — the headline number. */
export async function countFacetMatchedProducts(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from canonical_products p
    where ${buildEntityPredicate(context)}`);
  return rows[0]?.total ?? 0;
}

/** One bucket of one attribute facet, at whichever grain it was counted. */
export interface FacetAttributeBucketRow extends Record<string, unknown> {
  attributeKey: string;
  bucketValue: string;
  productCount: number;
}

/**
 * Bucket counts for PRODUCT-grain attributes, over the requirement set given.
 *
 * ONE statement for every key handed in, so an unfiltered first load costs one
 * aggregate rather than one per facet. The caller lifts a facet's OWN
 * requirement before asking — "how many are left if I also pick blue" is a
 * different question from "how many are left if I pick blue INSTEAD of red", and
 * the second is the one a multi-select rail asks.
 *
 * `count(distinct p.id)`, never `count(*)`: a `set`-cardinality attribute
 * legitimately stores several rows per product per key, and counting rows would
 * report a product with three recorded ports three times in one bucket.
 */
export async function countProductAttributeBuckets(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  attributeKeys: readonly string[],
): Promise<FacetAttributeBucketRow[]> {
  if (attributeKeys.length === 0) return [];
  const rows = await db.execute<FacetAttributeBucketRow>(sql`
    select av.attribute_key as "attributeKey",
           coalesce(av.normalized_text, case when av.normalized_boolean then 'true' else 'false' end)
             as "bucketValue",
           count(distinct p.id)::int as "productCount"
    from canonical_products p
    join canonical_attribute_values av on av.product_id = p.id
    where ${buildEntityPredicate(context)}
      and av.selection_state = 'selected'
      and av.attribute_key = any(${sql.param([...attributeKeys])}::text[])
      and (av.normalized_text is not null or av.normalized_boolean is not null)
    group by 1, 2`);
  return [...rows];
}

/**
 * Bucket counts for VARIANT-grain attributes.
 *
 * The union of the two variant tables, then one grouped count of DISTINCT
 * PRODUCTS. Two properties are worth stating because both are ways this could go
 * wrong quietly:
 *
 * - the union is over the VALUE rows, and the outer count is over products, so a
 *   product whose forty variants are all black contributes ONE to `black`;
 * - the variant the bucket is observed on must satisfy every OTHER variant
 *   requirement and, when there are offer requirements, must carry a qualifying
 *   offer. That is `buildEntityPredicate` with this facet's own requirement
 *   lifted, plus an inner correlation on `cv.id` — so the count beside "Red"
 *   is the number of products that have a red variant meeting the rest of the
 *   filter, not the number that have a red variant AND, separately, a size-43
 *   one.
 */
export async function countVariantAttributeBuckets(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  attributeKeys: readonly string[],
): Promise<FacetAttributeBucketRow[]> {
  if (attributeKeys.length === 0) return [];
  const keys = sql`${sql.param([...attributeKeys])}::text[]`;
  const { requirements } = context;
  const siblingChecks: SQL[] = requirements.variant.map((requirement) =>
    variantRequirementExists('cv', requirement),
  );
  if (hasOfferRequirement(requirements.offer)) {
    siblingChecks.push(offerRequirementsExists('cv', requirements.offer, context.now));
  }
  const siblings =
    siblingChecks.length === 0 ? sql`true` : sql.join(siblingChecks, sql` and `);

  const rows = await db.execute<FacetAttributeBucketRow>(sql`
    select vals.attribute_key as "attributeKey",
           vals.bucket_value as "bucketValue",
           count(distinct p.id)::int as "productCount"
    from canonical_products p
    join canonical_variants cv on cv.product_id = p.id and cv.status = 'active'
    join lateral (
      select av.attribute_key, av.normalized_text as bucket_value
      from canonical_attribute_values av
      where av.variant_id = cv.id and av.selection_state = 'selected'
        and av.attribute_key = any(${keys}) and av.normalized_text is not null
      union all
      select va.attribute_key, va.normalized_value as bucket_value
      from canonical_variant_attributes va
      where va.variant_id = cv.id and va.normalization_state = 'normalized'
        and va.attribute_key = any(${keys})
    ) as vals on true
    where ${buildEntityPredicate(context)} and ${siblings}
    group by 1, 2`);
  return [...rows];
}

/** The numeric span of one or more attributes, at either grain. */
export interface FacetAttributeRangeRow extends Record<string, unknown> {
  attributeKey: string;
  minValue: number | null;
  maxValue: number | null;
  productCount: number;
}

/** Numeric spans for PRODUCT-grain attributes. */
export async function measureProductAttributeRanges(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  attributeKeys: readonly string[],
): Promise<FacetAttributeRangeRow[]> {
  if (attributeKeys.length === 0) return [];
  const rows = await db.execute<FacetAttributeRangeRow>(sql`
    select av.attribute_key as "attributeKey",
           min(av.normalized_number) as "minValue",
           max(coalesce(av.normalized_number_max, av.normalized_number)) as "maxValue",
           count(distinct p.id)::int as "productCount"
    from canonical_products p
    join canonical_attribute_values av on av.product_id = p.id
    where ${buildEntityPredicate(context)}
      and av.selection_state = 'selected'
      and av.normalized_number is not null
      and av.attribute_key = any(${sql.param([...attributeKeys])}::text[])
    group by 1`);
  return [...rows];
}

/** Numeric spans for VARIANT-grain attributes, over the same union. */
export async function measureVariantAttributeRanges(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  attributeKeys: readonly string[],
): Promise<FacetAttributeRangeRow[]> {
  if (attributeKeys.length === 0) return [];
  const keys = sql`${sql.param([...attributeKeys])}::text[]`;
  const rows = await db.execute<FacetAttributeRangeRow>(sql`
    select vals.attribute_key as "attributeKey",
           min(vals.low) as "minValue",
           max(vals.high) as "maxValue",
           count(distinct p.id)::int as "productCount"
    from canonical_products p
    join canonical_variants cv on cv.product_id = p.id and cv.status = 'active'
    join lateral (
      select av.attribute_key,
             av.normalized_number as low,
             coalesce(av.normalized_number_max, av.normalized_number) as high
      from canonical_attribute_values av
      where av.variant_id = cv.id and av.selection_state = 'selected'
        and av.attribute_key = any(${keys}) and av.normalized_number is not null
      union all
      select va.attribute_key, va.normalized_number as low, va.normalized_number as high
      from canonical_variant_attributes va
      where va.variant_id = cv.id and va.normalization_state = 'normalized'
        and va.attribute_key = any(${keys}) and va.normalized_number is not null
    ) as vals on true
    where ${buildEntityPredicate(context)}
    group by 1`);
  return [...rows];
}

/**
 * Products that DO carry a value for each named key, at either grain — the
 * other half of every facet's `unknownCount`.
 *
 * ## This asks the POSITIVE question, and the first draft asked the negative one
 *
 * The obvious spelling is `not exists` over both tables, so the count is the
 * unknown one directly. It was written that way, and #61's harness measured it:
 * **1,621 ms p95, 763,336 rows scanned, 2.25 million buffers** at the `small`
 * scale — on a read every facet performs on every load. The shape is a
 * `CROSS JOIN UNNEST` of the key list against a doubly-correlated double
 * negation, and the planner has nothing to push down.
 *
 * Asking which products HAVE a value is the same fact and a completely
 * different plan: three indexed lookups per product inside one lateral, which is
 * what {@link countVariantAttributeBuckets} beside it already costs. The caller
 * subtracts from the matched count.
 *
 * ## The subtraction is exact, and the reason is the shared predicate
 *
 * `unknown = matched − present` is right exactly when both are taken over the
 * SAME requirement set — every product counted here satisfies
 * `buildEntityPredicate(context)`, so the present set is a subset of the matched
 * one by construction. What would make it drift is comparing a present count
 * taken with a facet's requirement LIFTED against a matched count taken with it
 * applied, and that is the caller's obligation: a facet's unknown count is
 * measured against the matched count of ITS OWN lifted context. The first draft
 * of this file avoided the subtraction on exactly that worry and paid 1.6
 * seconds for it; the worry is real and the answer is to pair the two counts,
 * not to ask the question backwards.
 */
export interface FacetPresenceRow extends Record<string, unknown> {
  attributeKey: string;
  productCount: number;
}

export async function countProductsWithAttribute(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  attributeKeys: readonly string[],
): Promise<FacetPresenceRow[]> {
  if (attributeKeys.length === 0) return [];
  const keys = sql`${sql.param([...attributeKeys])}::text[]`;
  const rows = await db.execute<FacetPresenceRow>(sql`
    select vals.attribute_key as "attributeKey", count(distinct p.id)::int as "productCount"
    from canonical_products p
    join lateral (
      select av.attribute_key
      from canonical_attribute_values av
      where av.product_id = p.id and av.selection_state = 'selected'
        and av.attribute_key = any(${keys})
      union all
      select av.attribute_key
      from canonical_attribute_values av
      join canonical_variants cv on cv.id = av.variant_id
      where cv.product_id = p.id and cv.status = 'active'
        and av.selection_state = 'selected' and av.attribute_key = any(${keys})
      union all
      select va.attribute_key
      from canonical_variant_attributes va
      join canonical_variants cv on cv.id = va.variant_id
      where cv.product_id = p.id and cv.status = 'active'
        and va.normalization_state = 'normalized' and va.attribute_key = any(${keys})
    ) as vals on true
    where ${buildEntityPredicate(context)}
    group by 1`);
  return [...rows];
}

/**
 * The commercial spellings observed under each canonical value — "Midnight" and
 * "Jet Black" under `black`.
 *
 * Scoped to the same product set, capped per bucket, and DISPLAY ONLY. This is
 * what makes a colour-family filter honest: the family is what a shopper picks,
 * and the seller's own name for it is still on the card. Collapsing the two —
 * showing only `black`, or only `Midnight` — is
 * `FACET_FORBIDDEN_EQUIVALENCES.colour_family_collapse`.
 */
export interface FacetObservedLabelRow extends Record<string, unknown> {
  attributeKey: string;
  bucketValue: string;
  observedLabel: string;
}

export async function listObservedValueLabels(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  attributeKeys: readonly string[],
  perBucket: number,
): Promise<FacetObservedLabelRow[]> {
  if (attributeKeys.length === 0) return [];
  const keys = sql`${sql.param([...attributeKeys])}::text[]`;
  const rows = await db.execute<FacetObservedLabelRow>(sql`
    select "attributeKey", "bucketValue", "observedLabel" from (
      select av.attribute_key as "attributeKey",
             av.normalized_text as "bucketValue",
             av.source_display_value as "observedLabel",
             row_number() over (
               partition by av.attribute_key, av.normalized_text
               order by av.source_display_value) as rn
      from canonical_products p
      join canonical_attribute_values av
        on av.product_id = p.id or av.variant_id in (
             select cv.id from canonical_variants cv
             where cv.product_id = p.id and cv.status = 'active')
      where ${buildEntityPredicate(context)}
        and av.selection_state = 'selected'
        and av.attribute_key = any(${keys})
        and av.normalized_text is not null
        and av.source_display_value <> av.normalized_text
    ) labelled
    where rn <= ${perBucket}`);
  return [...rows];
}

// ---------------------------------------------------------------------------
// Commerce aggregates — every one of them SAME-OFFER
// ---------------------------------------------------------------------------

/** One commerce bucket: the offer dimension, its value, and distinct products. */
export interface FacetCommerceBucketRow extends Record<string, unknown> {
  bucketValue: string;
  productCount: number;
}

/**
 * The offer-side aggregate, over offers that satisfy every OTHER offer
 * requirement on the SAME row.
 *
 * `requirementsWithoutOwn` is the caller's job: it hands down the offer
 * requirement set with the dimension being counted removed. The nesting is
 * unchanged — the offer `exists` still lives inside the variant one when variant
 * requirements are present — so a bucket count is "products having a variant
 * that meets the variant filter and an offer on it that meets the rest of the
 * offer filter and has this value", which is the number the checkbox will
 * actually produce.
 */
async function countOfferBuckets(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  bucketExpression: SQL,
): Promise<FacetCommerceBucketRow[]> {
  const { requirements } = context;
  const offerParts: SQL[] = [
    sql`o.canonical_variant_id = cv.id`,
    sql`o.status = 'active'`,
    sql`o.stale_at > ${instant(context.now)}`,
  ];
  const others = offerRequirementsExists('cv', requirements.offer, context.now);
  const variantChecks: SQL[] = requirements.variant.map((requirement) =>
    variantRequirementExists('cv', requirement),
  );
  const variantGuard =
    variantChecks.length === 0 ? sql`true` : sql.join(variantChecks, sql` and `);

  const rows = await db.execute<FacetCommerceBucketRow>(sql`
    select ${bucketExpression} as "bucketValue", count(distinct p.id)::int as "productCount"
    from canonical_products p
    join canonical_variants cv on cv.product_id = p.id and cv.status = 'active'
    join offers o on ${sql.join(offerParts, sql` and `)}
    where ${buildEntityPredicate(context)} and ${variantGuard} and ${others}
    group by 1`);
  return [...rows];
}

/** Availability buckets — the offer's own state, never derived from stock. */
export async function countOfferAvailabilityBuckets(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
): Promise<FacetCommerceBucketRow[]> {
  return countOfferBuckets(db, context, sql`o.availability`);
}

/**
 * Condition buckets, at the SEGMENT grain (#90).
 *
 * The mapping key → group is `CONDITION_KEY_GROUP` in shared-types and it is
 * applied in TypeScript by the caller, not spelled as a `CASE` here: a second
 * copy of that map in SQL is exactly the drift #90 warns about, and it would
 * come apart the first time a key is added.
 */
export async function countOfferConditionBuckets(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
): Promise<FacetCommerceBucketRow[]> {
  return countOfferBuckets(db, context, sql`o.condition`);
}

/** Market buckets. A NULL country is `*` — available everywhere, not nowhere. */
export async function countOfferMarketBuckets(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
): Promise<FacetCommerceBucketRow[]> {
  return countOfferBuckets(db, context, sql`coalesce(o.country, '*')`);
}

/** Channel buckets, collapsed to #94's two members rather than `kind`'s four. */
export async function countOfferChannelBuckets(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
): Promise<FacetCommerceBucketRow[]> {
  return countOfferBuckets(
    db,
    context,
    sql`case when o.kind = 'native' then 'native' else 'external' end`,
  );
}

/** The price span present in scope, PER CURRENCY — never a mixed-currency min. */
export interface FacetPriceSpanRow extends Record<string, unknown> {
  currency: string;
  minMinor: number;
  maxMinor: number;
  productCount: number;
}

/**
 * The price span, grouped by the offer's OWN currency.
 *
 * Grouped rather than aggregated because `min(price_amount)` across currencies
 * compares raw minor units, which is the cross-currency comparison every money
 * rule in this repository forbids. The service converts each currency's span
 * through `fx.convert` and reports the ones it could not.
 */
export async function measureOfferPriceSpans(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
): Promise<FacetPriceSpanRow[]> {
  const { requirements } = context;
  const others = offerRequirementsExists('cv', requirements.offer, context.now);
  const variantChecks: SQL[] = requirements.variant.map((requirement) =>
    variantRequirementExists('cv', requirement),
  );
  const variantGuard =
    variantChecks.length === 0 ? sql`true` : sql.join(variantChecks, sql` and `);

  const rows = await db.execute<FacetPriceSpanRow>(sql`
    select o.price_currency as currency,
           min(o.price_amount)::bigint as "minMinor",
           max(o.price_amount)::bigint as "maxMinor",
           count(distinct p.id)::int as "productCount"
    from canonical_products p
    join canonical_variants cv on cv.product_id = p.id and cv.status = 'active'
    join offers o on o.canonical_variant_id = cv.id and o.status = 'active'
      and o.stale_at > ${instant(context.now)}
      and o.price_amount is not null and o.price_currency is not null
    where ${buildEntityPredicate(context)} and ${variantGuard} and ${others}
    group by 1`);
  // `postgres.js` decodes `bigint` as a STRING while drizzle types it `number`
  // (`~/Oxy/AGENTS.md`), so every money value crossing this boundary is coerced
  // once, here, rather than arriving as a string that concatenates later.
  return [...rows].map((row) => ({
    ...row,
    minMinor: Number(row.minMinor),
    maxMinor: Number(row.maxMinor),
  }));
}

/** Distinct products refined into each child category — the taxonomy facet. */
export async function countCategoryBuckets(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  childCategoryIds: readonly string[],
): Promise<FacetCommerceBucketRow[]> {
  if (childCategoryIds.length === 0) return [];
  const rows = await db.execute<FacetCommerceBucketRow>(sql`
    select c.id as "bucketValue", count(distinct p.id)::int as "productCount"
    from canonical_products p
    join categories c
      on c.id = any(${sql.param([...childCategoryIds])}::text[])
     and (p.category_id = c.id or p.category_id in (
            select d.id from categories d where d.ancestor_ids @> array[c.id]::text[]))
    where ${buildEntityPredicate(context)}
    group by 1`);
  return [...rows];
}

/** Currencies present on in-scope offers — what a price bound must convert FROM. */
/**
 * The currencies offers in scope are priced in — RAW, never narrowed here.
 *
 * `string`, because `offers.price_currency` is constrained by SHAPE only
 * (ADR 0002 D18) and a code outside the presentment tuple is storable. This used
 * to answer `CurrencyCode[]` through an unchecked cast, which typed a value as
 * something it was not and left the caller unable to tell (#450). The caller
 * narrows, and reports what does not narrow.
 */
export async function listScopeOfferCurrencies(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
): Promise<string[]> {
  const rows = await db.execute<{ currency: string }>(sql`
    select distinct o.price_currency as currency
    from canonical_products p
    join canonical_variants cv on cv.product_id = p.id and cv.status = 'active'
    join offers o on o.canonical_variant_id = cv.id and o.status = 'active'
      and o.stale_at > ${instant(context.now)} and o.price_currency is not null
    where ${buildEntityPredicate(context)}`);
  return [...rows].map((row) => row.currency);
}

/** Re-exported so a caller never spells an offer kind's channel mapping twice. */
export function offerChannelOf(kind: OfferKind): 'native' | 'external' {
  return kind === 'native' ? 'native' : 'external';
}
