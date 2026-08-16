/**
 * Generating the facet list from metadata (#367 Workstream 10, ADR 0007 D5).
 *
 * PURE. No database, no clock, no configuration. It takes what the registry
 * (#94) and the product type version (ADR D5) say and decides, for each
 * attribute in scope: is it offered at all, at which grain does its requirement
 * bind, what shape do its answers take, and where does it sit in the rail.
 *
 * ## There is no per-category filter list anywhere, and there cannot be one
 *
 * Every input here is a row somebody published. `filterable`, `sortable`,
 * `hardConstraintCapable` and `variantDefining` are #94 columns; `scope`,
 * `requirement`, `variantCapable`, `position` and the group are
 * `product_type_fields` columns, frozen with the version that declared them. The
 * only literals in this file are the value-type → shape mapping and the
 * refusals, both of which are statements about the TYPE SYSTEM rather than about
 * any particular category. `facet-isolation.test.ts` fails the build if a
 * category-keyed filter list appears in either package.
 *
 * ## An attribute the product type does not mention is still a facet
 *
 * The registry scoped it to this category deliberately
 * (`attribute_definition_categories`), and a deployment with no published
 * product type would otherwise have no filters at all — which is the state every
 * deployment is in today. It is offered, and it sorts AFTER every field the type
 * did name, because the type's order is a statement about prominence and the
 * absence of one is not.
 */

import type {
  AttributeCardinality,
  AttributeValueType,
  FacetLevel,
  FacetSuppressionReason,
  FacetValueShape,
  MissingDataPolicy,
} from '@mercaria/shared-types';

/** What #94 says about one attribute — the fields this domain reads. */
export interface FacetDefinitionInput {
  readonly definitionId: string;
  readonly key: string;
  readonly version: number;
  readonly baseLabel: string;
  readonly valueType: AttributeValueType;
  readonly cardinality: AttributeCardinality;
  readonly baseUnit: string | null;
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly hardConstraintCapable: boolean;
  readonly variantDefining: boolean;
}

/** What a published product type version says about one attribute. */
export interface FacetProductTypeFieldInput {
  readonly attributeKey: string;
  readonly scope: string;
  readonly requirement: string;
  readonly variantCapable: boolean;
  readonly fieldPosition: number;
  readonly groupKey: string | null;
  readonly groupLabel: string | null;
  readonly groupPosition: number;
}

/** One attribute's generated facet metadata, before any count is taken. */
export interface FacetPlanEntry {
  readonly key: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly baseLabel: string;
  readonly valueType: AttributeValueType;
  readonly cardinality: AttributeCardinality;
  readonly baseUnit: string | null;
  readonly level: FacetLevel;
  readonly shape: FacetValueShape;
  readonly multiSelect: boolean;
  readonly sortable: boolean;
  readonly hardConstraintCapable: boolean;
  readonly missingDataPolicy: MissingDataPolicy;
  readonly groupKey?: string;
  readonly groupLabel?: string;
  readonly groupPosition: number;
  readonly fieldPosition: number;
  /** Set exactly when the facet is NOT offered — never both. */
  readonly suppression?: FacetSuppressionReason;
}

/**
 * Where an attribute the product type did not name sorts.
 *
 * Beyond every real group position, so a typed rail keeps its published order
 * and untyped attributes follow it alphabetically. A number rather than a
 * nullable position because the comparator must be total.
 */
export const FACET_UNTYPED_GROUP_POSITION = Number.MAX_SAFE_INTEGER;

/**
 * Value type → answer shape.
 *
 * A `Record` over the whole union rather than a `switch` with a default: a value
 * type added to #94 without a decision here is a compile error, where a default
 * branch would silently absorb it into whichever shape the author picked. Two
 * members are `null`, meaning "this domain cannot face it", and both refusals
 * are deliberate:
 *
 * - `date` — its normalized value lives in `normalized_date`, not
 *   `normalized_number`, so a numeric range facet over it would aggregate an
 *   always-NULL column and report an empty span for an attribute that is fully
 *   recorded. A date facet is a real thing and it needs its own aggregate and
 *   its own client control; refusing it is honest where an empty slider is not.
 * - `structured` — a structured value is several NAMED AXES (#94 normalization
 *   rule 7), and one span across them compares a width against a height. Facing
 *   it means facing each axis, which needs `component_axis` in the facet key —
 *   a vocabulary decision, not an aggregate.
 */
export const FACET_SHAPE_BY_VALUE_TYPE: Readonly<
  Record<AttributeValueType, FacetValueShape | null>
> = Object.freeze({
  boolean: 'buckets',
  integer: 'range',
  decimal: 'range',
  string: 'buckets',
  enum: 'buckets',
  date: null,
  money: 'money_range',
  measurement: 'range',
  structured: null,
});

/**
 * The product-type requirements that WITHHOLD a facet.
 *
 * `hidden` and `forbidden` are the version's own statement that this attribute
 * is not part of the conversation for this kind of product. Offering it as a
 * filter would let a shopper build a requirement the authoring flow refuses to
 * record, so every result would be an `unknown`.
 */
export const FACET_WITHHOLDING_REQUIREMENTS: readonly string[] = ['hidden', 'forbidden'];

/**
 * The grain a requirement binds at.
 *
 * `compatibility` is not a grain — it is a relationship (ADR 0007 D8), a brake
 * pad fits a thousand vehicles and stays one variant — so it is refused rather
 * than mapped onto `product`. Mapping it would put a year range in a facet whose
 * count is over products, which is the exact false equivalence D8 exists to
 * prevent.
 */
function levelFor(
  definition: FacetDefinitionInput,
  field: FacetProductTypeFieldInput | undefined,
): FacetLevel | 'refused' {
  if (field === undefined) return definition.variantDefining ? 'variant' : 'product';
  if (field.scope === 'compatibility') return 'refused';
  if (field.scope === 'variant' || field.variantCapable) return 'variant';
  return 'product';
}

/**
 * The missing-data policy a facet reports.
 *
 * `exclude_when_unknown`, always, and it is #94's own vocabulary rather than a
 * third value invented here. Picking an answer means "I want this one", so a
 * product Mercaria holds no value for is not one it may return — that is the
 * whole of "missing data never satisfies a hard constraint" at the filter rail.
 * The count of what that excludes is reported separately, on every facet, so the
 * exclusion is visible rather than merely correct.
 */
export const FACET_MISSING_DATA_POLICY: MissingDataPolicy = 'exclude_when_unknown';

/**
 * Generate the facet plan for one scope.
 *
 * Deterministic and total: every definition handed in produces exactly one
 * entry, offered or suppressed with a reason. Returning fewer would make "this
 * attribute has no facet" and "this attribute was never looked at" the same
 * observation, which is the vacuity the suppression list exists to prevent.
 */
export function planFacets(
  definitions: readonly FacetDefinitionInput[],
  fields: readonly FacetProductTypeFieldInput[],
): FacetPlanEntry[] {
  const fieldByKey = new Map<string, FacetProductTypeFieldInput>();
  for (const field of fields) fieldByKey.set(field.attributeKey, field);

  const plan: FacetPlanEntry[] = [];
  for (const definition of definitions) {
    const field = fieldByKey.get(definition.key);
    const shape = FACET_SHAPE_BY_VALUE_TYPE[definition.valueType];
    const level = levelFor(definition, field);

    const base = {
      key: definition.key,
      definitionId: definition.definitionId,
      // The ACTIVE definition's version, not the version the product type
      // pinned — the precedent is `catalog-attributes.controller.ts`, which
      // reads `displayPolicy` off the active definition and states why: whether
      // an attribute may be SHOWN is a decision about now, and a value recorded
      // under a version that permitted it must not keep that permission after
      // the policy changed. The same is true of `filterable`. What the pinned
      // version governs is AUTHORING, which is ADR 0007 D5's subject and not
      // this rail's.
      definitionVersion: definition.version,
      baseLabel: definition.baseLabel,
      valueType: definition.valueType,
      cardinality: definition.cardinality,
      baseUnit: definition.baseUnit,
      // A refused level still needs a value for the DTO; `product` is the
      // inert one, and the entry carries a suppression so nothing counts it.
      level: level === 'refused' ? ('product' as FacetLevel) : level,
      shape: shape ?? ('buckets' as FacetValueShape),
      multiSelect: shape === 'buckets',
      sortable: definition.sortable,
      hardConstraintCapable: definition.hardConstraintCapable,
      missingDataPolicy: FACET_MISSING_DATA_POLICY,
      ...(field?.groupKey == null ? {} : { groupKey: field.groupKey }),
      ...(field?.groupLabel == null ? {} : { groupLabel: field.groupLabel }),
      groupPosition: field === undefined ? FACET_UNTYPED_GROUP_POSITION : field.groupPosition,
      fieldPosition: field === undefined ? 0 : field.fieldPosition,
    };

    const suppression = suppressionFor(definition, field, shape, level);
    plan.push(suppression === undefined ? base : { ...base, suppression });
  }
  return plan;
}

/**
 * Why this attribute is not offered, or `undefined` when it is.
 *
 * The order of the tests is the order a reader would want the reason in: the
 * registry's own refusal first, then the product type's, then the shape. A
 * `filterable: false` attribute that also has no facetable shape should report
 * the decision somebody made, not the one the code noticed.
 */
function suppressionFor(
  definition: FacetDefinitionInput,
  field: FacetProductTypeFieldInput | undefined,
  shape: FacetValueShape | null,
  level: FacetLevel | 'refused',
): FacetSuppressionReason | undefined {
  if (!definition.filterable) return 'not_filterable';
  if (field !== undefined && FACET_WITHHOLDING_REQUIREMENTS.includes(field.requirement)) {
    return 'hidden_by_product_type';
  }
  if (level === 'refused') return 'compatibility_scope';
  if (shape === null) return 'unsupported_value_type';
  return undefined;
}
