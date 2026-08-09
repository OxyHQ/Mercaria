/**
 * Validating a constraint set against the registry, BEFORE search runs
 * (#94 API rule 3, hard-constraint rules 7 and 8).
 *
 * Two jobs, and the second is the one that matters:
 *
 * 1. Reject constraints that cannot mean anything — an attribute nobody defined,
 *   a `>=` on a boolean, inches against a mass attribute, a colour value the
 *   enum does not admit, a range whose bounds are inverted. "Category
 *   compatibility rules can reject meaningless constraints before search"
 *   (rule 7): a filter for screen size on a category with no screens is a
 *   question with no answer, and returning zero results says something false
 *   about the catalogue.
 *
 * 2. Produce the {@link ValidatedConstraintSet} the evaluator consumes — the
 *   ONLY way one can be made. It is partitioned into two typed lists, `hard` and
 *   `preferences`, and those two types are genuinely different, so nothing
 *   downstream can move a constraint between them without a compile error. That
 *   is #94 hard-constraint rule 4 ("cannot quietly downgrade a hard requirement
 *   to a preference to produce more results") expressed as a type rather than as
 *   a promise.
 *
 * ## Every issue at once, not the first
 *
 * A shopper who asked for three impossible things is told about three. Bailing
 * on the first turns a single correction round into three, and an interpreter
 * (#95) re-planning against one error at a time will loop.
 */

import {
  CONSTRAINT_EVALUATION_VERSION,
  MAX_CONSTRAINTS_PER_SET,
  MAX_CONSTRAINT_VALUES_PER_OPERATOR,
  MAX_OR_GROUPS_PER_SET,
  MAX_OR_GROUP_MEMBERS,
  RESERVED_OFFER_FACT_KEYS,
  type AttributeConstraint,
  type AttributePredicate,
  type AttributeValueType,
  type ConstraintSet,
  type ConstraintSetValidation,
  type ConstraintValidationIssue,
  type ConstraintValue,
  type HardConstraint,
  type LeafConstraint,
  type PreferenceConstraint,
  type ProductConstraint,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { BASE_UNITS, resolveUnit, toBaseUnit, unitFamilyOf } from '../canonical/units.js';
import {
  resolveActiveDefinition,
  resolveDefinitionsForCategory,
  type ResolvedAttributeDefinition,
} from './definition-registry.service.js';
import { offerFactsAvailable } from './offer-facts.port.js';

export interface ValidateConstraintSetOptions {
  /**
   * The category the search is scoped to, when it is scoped to one. Supplying it
   * turns on the compatibility check: an attribute outside the category's scope
   * is refused rather than silently matching nothing.
   */
  readonly categoryId?: string;
}

/**
 * Which operators each value type admits.
 *
 * A table rather than a switch, for the reason `claim-methods.ts` is a table one
 * domain over: the question "may this operator apply to this type" is asked from
 * three places, and three switches drift. `exists` and `missing` are legal on
 * every type and are therefore not listed — they ask about the FACT, not its
 * value.
 */
const OPERATORS_BY_TYPE: Readonly<Record<AttributeValueType, readonly AttributePredicate['op'][]>> =
  Object.freeze({
    boolean: ['eq', 'ne', 'is'],
    integer: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in'],
    decimal: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in'],
    // No ordering on free text: `>` on a string is a collation accident, not a
    // requirement anybody means.
    string: ['eq', 'ne', 'in', 'not_in'],
    enum: ['eq', 'ne', 'in', 'not_in'],
    date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'],
    money: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'],
    measurement: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in'],
    // A structured value is constrained through one of its AXES, and the axis
    // carries a measurement — so the operators are the measurement ones.
    structured: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'],
  });

/** The value types each {@link ConstraintValue} discriminant may satisfy. */
const VALUE_TYPE_COMPATIBILITY: Readonly<Record<ConstraintValue['type'], readonly AttributeValueType[]>> =
  Object.freeze({
    string: ['string', 'enum'],
    boolean: ['boolean'],
    integer: ['integer', 'decimal'],
    decimal: ['decimal'],
    date: ['date'],
    money: ['money'],
    measurement: ['measurement', 'structured'],
  });

/**
 * Check a constraint set against the registry and partition it.
 *
 * @returns Either the validated set (with any non-fatal warnings) or every
 *   reason it was refused.
 */
export async function validateConstraintSet(
  db: DatabaseOrTransaction,
  set: ConstraintSet,
  options: ValidateConstraintSetOptions = {},
): Promise<ConstraintSetValidation> {
  const issues: ConstraintValidationIssue[] = [];
  const warnings: ConstraintValidationIssue[] = [];

  if (set.constraints.length > MAX_CONSTRAINTS_PER_SET) {
    issues.push({
      constraintId: '*',
      code: 'too_many_constraints',
      message: `A constraint set holds at most ${MAX_CONSTRAINTS_PER_SET} constraints; this one has ${set.constraints.length}.`,
    });
  }

  const groups = set.constraints.filter((constraint) => constraint.kind === 'any_of');
  if (groups.length > MAX_OR_GROUPS_PER_SET) {
    issues.push({
      constraintId: '*',
      code: 'too_many_or_groups',
      message: `A constraint set holds at most ${MAX_OR_GROUPS_PER_SET} "any of" groups; this one has ${groups.length}.`,
    });
  }

  const seenIds = new Set<string>();
  for (const constraint of set.constraints) {
    if (seenIds.has(constraint.id)) {
      issues.push({
        constraintId: constraint.id,
        code: 'duplicate_constraint_id',
        message: `Two constraints share the id '${constraint.id}'; an explanation could not tell them apart.`,
      });
    }
    seenIds.add(constraint.id);
  }

  // The category's own attribute scope, resolved once. Absent when the search is
  // not category-scoped, in which case compatibility is checked against the
  // registry alone (an attribute must exist; it need not apply here).
  const scopedKeys =
    options.categoryId === undefined
      ? undefined
      : new Set(
          (await resolveDefinitionsForCategory(db, options.categoryId)).map(
            (definition) => definition.row.key,
          ),
        );

  const definitionVersions: Record<string, number> = {};

  for (const constraint of set.constraints) {
    const leaves: LeafConstraint[] =
      constraint.kind === 'any_of' ? [...constraint.members] : [constraint];

    if (constraint.kind === 'any_of') {
      if (constraint.members.length === 0) {
        issues.push({
          constraintId: constraint.id,
          code: 'empty_or_group',
          message: `The "any of" group '${constraint.id}' has no members, so nothing can satisfy it.`,
        });
      }
      if (constraint.members.length > MAX_OR_GROUP_MEMBERS) {
        issues.push({
          constraintId: constraint.id,
          code: 'or_group_too_wide',
          message: `An "any of" group holds at most ${MAX_OR_GROUP_MEMBERS} members; '${constraint.id}' has ${constraint.members.length}.`,
        });
      }
    }

    for (const leaf of leaves) {
      await validateLeaf(db, leaf, constraint.id, scopedKeys, definitionVersions, issues, warnings);
    }
  }

  if (issues.length > 0) return { valid: false, issues };

  // The partition. `hard` and `preferences` are different TYPES, so nothing
  // downstream can move a member between them — see the module header.
  const hard: HardConstraint[] = [];
  const preferences: PreferenceConstraint[] = [];
  for (const constraint of set.constraints) {
    if (isHard(constraint)) hard.push(constraint);
    else if (isPreference(constraint)) preferences.push(constraint);
  }

  return {
    valid: true,
    warnings,
    set: {
      hard,
      preferences,
      evaluationVersion: CONSTRAINT_EVALUATION_VERSION,
      definitionVersions,
      brand: 'validated-constraint-set',
    },
  };
}

/**
 * The two type predicates that make the partition load-bearing.
 *
 * Both are narrowings, not casts: a constraint enters a list only after its
 * OWN `strength` field has been read, so the two lists cannot be populated from
 * anywhere but the constraint's declared strength. There is deliberately no
 * function anywhere that produces a `HardConstraint` from a
 * `PreferenceConstraint` or the reverse — that absence is #94 hard-constraint
 * rule 4, and `hard-constraint-isolation.test.ts` fails the build if one appears.
 */
function isHard(constraint: ProductConstraint): constraint is HardConstraint {
  return constraint.strength === 'hard';
}

function isPreference(constraint: ProductConstraint): constraint is PreferenceConstraint {
  return constraint.strength === 'preference';
}

async function validateLeaf(
  db: DatabaseOrTransaction,
  leaf: LeafConstraint,
  reportedId: string,
  scopedKeys: ReadonlySet<string> | undefined,
  definitionVersions: Record<string, number>,
  issues: ConstraintValidationIssue[],
  warnings: ConstraintValidationIssue[],
): Promise<void> {
  switch (leaf.kind) {
    case 'attribute':
      await validateAttributeConstraint(
        db,
        leaf,
        reportedId,
        scopedKeys,
        definitionVersions,
        issues,
        warnings,
      );
      return;
    case 'commerce':
      // A commerce constraint reaches live offers or it reaches nothing. Warning
      // rather than refusing: the request is well-formed, the DATA is missing,
      // and the evaluator's named policy is what decides what that means. An
      // error here would make the same query legal or illegal depending on
      // whether a sibling issue had shipped.
      if (!offerFactsAvailable()) {
        warnings.push({
          constraintId: reportedId,
          code: 'offer_facts_unavailable',
          message:
            'No live offer source is configured, so price, availability, condition, market and proximity constraints evaluate as unknown.',
        });
      }
      return;
    case 'taxonomy':
      if (leaf.ids.length === 0) {
        issues.push({
          constraintId: reportedId,
          code: 'empty_value_list',
          message: `The ${leaf.subject} constraint '${reportedId}' names no ids.`,
        });
      }
      if (leaf.ids.length > MAX_CONSTRAINT_VALUES_PER_OPERATOR) {
        issues.push({
          constraintId: reportedId,
          code: 'too_many_values',
          message: `A set-membership constraint holds at most ${MAX_CONSTRAINT_VALUES_PER_OPERATOR} values.`,
        });
      }
      return;
    case 'text':
      if (leaf.query.trim().length === 0) {
        issues.push({
          constraintId: reportedId,
          code: 'empty_value_list',
          message: `The text preference '${reportedId}' is empty.`,
        });
      }
      return;
  }
}

async function validateAttributeConstraint(
  db: DatabaseOrTransaction,
  constraint: AttributeConstraint,
  reportedId: string,
  scopedKeys: ReadonlySet<string> | undefined,
  definitionVersions: Record<string, number>,
  issues: ConstraintValidationIssue[],
  warnings: ConstraintValidationIssue[],
): Promise<void> {
  const key = constraint.attributeKey;

  // The reserved-key refusal is checked here as well as at definition time. The
  // registry cannot hold such a key, so this can only fire on a constraint
  // naming one that never existed — and the message is the useful part: it
  // points at the commerce facets instead of saying "unknown attribute".
  if (RESERVED_OFFER_FACT_KEYS.includes(key)) {
    issues.push({
      constraintId: reportedId,
      code: 'reserved_offer_fact_key',
      message: `'${key}' names a fact about a current offer, not a product attribute. Use the matching commerce constraint facet.`,
    });
    return;
  }

  const definition = await resolveActiveDefinition(db, key);
  if (!definition) {
    issues.push({
      constraintId: reportedId,
      code: 'unknown_attribute',
      message: `No active attribute is defined for '${key}'.`,
    });
    return;
  }
  const { row } = definition;
  definitionVersions[key] = row.version;

  if (row.lifecycleState === 'retired') {
    issues.push({
      constraintId: reportedId,
      code: 'definition_retired',
      message: `The attribute '${key}' is retired and no longer filterable.`,
    });
    return;
  }
  if (row.lifecycleState === 'deprecated') {
    warnings.push({
      constraintId: reportedId,
      code: 'definition_retired',
      message: `The attribute '${key}' is deprecated; stored values still resolve but new ones are not being recorded.`,
    });
  }

  if (scopedKeys !== undefined && !scopedKeys.has(key)) {
    issues.push({
      constraintId: reportedId,
      code: 'attribute_not_in_category',
      message: `'${key}' does not apply to this category, so a filter on it has no answer here.`,
    });
    return;
  }

  if (!row.filterable) {
    issues.push({
      constraintId: reportedId,
      code: 'attribute_not_filterable',
      message: `'${key}' is not a filterable attribute.`,
    });
    return;
  }
  if (constraint.strength === 'hard' && !row.hardConstraintCapable) {
    issues.push({
      constraintId: reportedId,
      code: 'attribute_not_hard_constraint_capable',
      message: `'${key}' may not be used as a hard requirement — it can rank results but must not exclude them.`,
    });
    return;
  }

  if (constraint.axis !== undefined && !row.componentAxes.includes(constraint.axis)) {
    issues.push({
      constraintId: reportedId,
      code: 'axis_not_declared',
      message: `'${key}' declares no '${constraint.axis}' component.`,
    });
    return;
  }
  if (constraint.axis === undefined && row.valueType === 'structured') {
    issues.push({
      constraintId: reportedId,
      code: 'axis_not_declared',
      message: `'${key}' is a structured attribute; a constraint on it must name one of its components (${row.componentAxes.join(', ')}).`,
    });
    return;
  }

  const allowed = OPERATORS_BY_TYPE[row.valueType];
  const op = constraint.predicate.op;
  if (op !== 'exists' && op !== 'missing' && !allowed.includes(op)) {
    issues.push({
      constraintId: reportedId,
      code: 'operator_not_supported_for_type',
      message: `'${op}' is not a comparison a ${row.valueType} attribute supports.`,
    });
    return;
  }

  for (const value of valuesOf(constraint.predicate)) {
    validateValue(value, definition, reportedId, issues);
  }

  if (constraint.predicate.op === 'between') {
    const lower = numericOf(constraint.predicate.lower.value, definition);
    const upper = numericOf(constraint.predicate.upper.value, definition);
    if (lower !== undefined && upper !== undefined && lower > upper) {
      issues.push({
        constraintId: reportedId,
        code: 'range_bounds_inverted',
        message: `The range on '${key}' starts above where it ends.`,
      });
    }
  }
  if (constraint.predicate.op === 'in' || constraint.predicate.op === 'not_in') {
    if (constraint.predicate.values.length === 0) {
      issues.push({
        constraintId: reportedId,
        code: 'empty_value_list',
        message: `The set-membership constraint on '${key}' names no values.`,
      });
    }
    if (constraint.predicate.values.length > MAX_CONSTRAINT_VALUES_PER_OPERATOR) {
      issues.push({
        constraintId: reportedId,
        code: 'too_many_values',
        message: `A set-membership constraint holds at most ${MAX_CONSTRAINT_VALUES_PER_OPERATOR} values.`,
      });
    }
  }
  if (constraint.strength === 'preference' && !row.comparable) {
    warnings.push({
      constraintId: reportedId,
      code: 'attribute_not_filterable',
      message: `'${key}' is not marked comparable, so this preference can be evaluated but should not be presented as a comparison.`,
    });
  }
}

/** Every literal a predicate carries, flattened. */
function valuesOf(predicate: AttributePredicate): ConstraintValue[] {
  switch (predicate.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return [predicate.value];
    case 'between':
      return [predicate.lower.value, predicate.upper.value];
    case 'in':
    case 'not_in':
      return [...predicate.values];
    case 'exists':
    case 'missing':
    case 'is':
      return [];
  }
}

function validateValue(
  value: ConstraintValue,
  definition: ResolvedAttributeDefinition,
  reportedId: string,
  issues: ConstraintValidationIssue[],
): void {
  const { row } = definition;
  const compatible = VALUE_TYPE_COMPATIBILITY[value.type];
  if (!compatible.includes(row.valueType)) {
    issues.push({
      constraintId: reportedId,
      code: 'value_type_mismatch',
      message: `'${row.key}' is a ${row.valueType} attribute; a ${value.type} value cannot be compared against it.`,
    });
    return;
  }

  if (value.type === 'measurement') {
    const unit = resolveUnit(value.unit);
    if (unit === null) {
      issues.push({
        constraintId: reportedId,
        code: 'unknown_unit',
        message: `'${value.unit}' is not a unit this catalogue knows.`,
      });
      return;
    }
    const family = unitFamilyOf(unit);
    if (family === null || BASE_UNITS[family] !== row.baseUnit) {
      issues.push({
        constraintId: reportedId,
        code: 'unit_not_in_family',
        message: `'${value.unit}' measures a different dimension from '${row.key}' (${String(row.unitFamily)}).`,
      });
    }
    return;
  }

  if (value.type === 'money' && value.currency !== row.currency) {
    issues.push({
      constraintId: reportedId,
      code: 'currency_mismatch',
      message: `'${row.key}' is recorded in ${String(row.currency)}; a ${value.currency} amount is not comparable with it.`,
    });
    return;
  }

  if (value.type === 'string' && row.valueType === 'enum') {
    const folded = value.value.trim().replace(/\s+/gu, ' ').toLowerCase();
    if (!definition.aliases.has(folded)) {
      issues.push({
        constraintId: reportedId,
        code: 'enum_value_not_allowed',
        message: `'${value.value}' is not one of the values '${row.key}' admits.`,
      });
    }
  }
}

/** The comparable magnitude of a value, in the definition's base unit. */
function numericOf(
  value: ConstraintValue,
  definition: ResolvedAttributeDefinition,
): number | undefined {
  switch (value.type) {
    case 'integer':
    case 'decimal':
      return value.value;
    case 'money':
      return value.amountMinor;
    case 'date':
      return Date.parse(value.value);
    case 'measurement': {
      const unit = resolveUnit(value.unit);
      if (unit === null) return undefined;
      const family = unitFamilyOf(unit);
      if (family === null || BASE_UNITS[family] !== definition.row.baseUnit) return undefined;
      return toBaseUnit(value.magnitude, unit) ?? undefined;
    }
    case 'string':
    case 'boolean':
      return undefined;
  }
}
