/**
 * Version diff for product-type and attribute definitions (#367 Workstream 12).
 *
 * Pure. No database, no clock, no configuration — the two hydrated versions go
 * in and the differences come out, so every case is a table test and the
 * function that a publication preview shows is byte-identical to the one a
 * post-hoc comparison shows.
 *
 * ## Why `breaking` is per-entry and derived, never a headline somebody sets
 *
 * `breakingCount` is computed from the entries. A separately maintained count
 * is two representations of one fact, and the direction it goes wrong in is
 * always the flattering one: a publication preview showing "0 breaking changes"
 * over a list containing a removed required field is exactly the report that
 * gets approved.
 *
 * ## What counts as breaking, and the asymmetry that matters
 *
 * A change is breaking when data written under the OLD version can stop being
 * valid under the NEW one. That is directional:
 *
 * - `optional` → `required` is breaking; the reverse is not.
 * - Removing a field is breaking; adding an optional one is not.
 * - Adding an enum value is not breaking; the registry cannot remove one from a
 *   live definition at all (`mercaria_attribute_enum_frozen`), so a removal
 *   here only ever appears between two DRAFTS and is still reported.
 * - Narrowing a bound is breaking; widening it is not.
 * - A relabelled group, a reordered field and a changed help text are not
 *   breaking — #367 step 3 deliberately leaves `name` and `description`
 *   unfrozen precisely because they carry no semantics.
 *
 * Getting the direction backwards would report every relaxation as dangerous
 * and every tightening as safe, which is worse than reporting nothing.
 */

import type {
  CatalogDefinitionDiff,
  CatalogDefinitionDiffEntry,
  CatalogGovernanceSubjectKind,
  ProductTypeFieldRequirement,
} from '@mercaria/shared-types';

/** The shape of one product-type field a diff reads. */
export interface DiffableProductTypeField {
  readonly attributeKey: string;
  readonly scope: string;
  readonly flow: string;
  readonly requirement: ProductTypeFieldRequirement;
  readonly valuePolicy: string;
  readonly variantCapable: boolean;
  readonly attributeDefinitionVersion: number;
  readonly groupKey: string | null;
}

/** One version of a product type, as much of it as a diff needs. */
export interface DiffableProductTypeVersion {
  readonly version: number;
  readonly fields: readonly DiffableProductTypeField[];
  readonly categoryIds: readonly string[];
}

/**
 * Requirement levels ordered from most permissive to most demanding.
 *
 * `forbidden` sits at the top rather than the bottom deliberately: a field that
 * goes from `optional` to `forbidden` invalidates every draft that filled it,
 * which is the same kind of breakage as making it required. Treating it as the
 * most permissive value — the reading its name invites — would report the one
 * transition that empties data as safe.
 */
const REQUIREMENT_STRICTNESS: Record<ProductTypeFieldRequirement, number> = {
  hidden: 0,
  optional: 1,
  recommended: 2,
  required: 3,
  forbidden: 4,
};

function requirementTightened(
  before: ProductTypeFieldRequirement,
  after: ProductTypeFieldRequirement,
): boolean {
  return REQUIREMENT_STRICTNESS[after] > REQUIREMENT_STRICTNESS[before];
}

/**
 * The identity of a field WITHIN a version.
 *
 * `(attributeKey, flow, scope)` and not the row id: a field's id is minted per
 * version, so diffing on ids reports every field as removed-and-added and the
 * diff says nothing. The uniqueness of this triple is
 * `product_type_fields_flow_attribute_key`'s own, one column narrower.
 */
function fieldKey(field: DiffableProductTypeField): string {
  return `${field.flow}:${field.scope}:${field.attributeKey}`;
}

/** Diff two product-type versions. */
export function diffProductTypeVersions(
  from: DiffableProductTypeVersion,
  to: DiffableProductTypeVersion,
): CatalogDefinitionDiff {
  const entries: CatalogDefinitionDiffEntry[] = [];
  const before = new Map(from.fields.map((field) => [fieldKey(field), field]));
  const after = new Map(to.fields.map((field) => [fieldKey(field), field]));

  for (const [key, field] of before) {
    if (after.has(key)) continue;
    entries.push({
      change: 'removed',
      key,
      // Every removal is breaking: a value written against this field has
      // nowhere to be read from in the new version, whatever its requirement
      // was. `hidden` is not an exception — a hidden field still holds data.
      breaking: true,
      before: field.requirement,
    });
  }

  for (const [key, field] of after) {
    if (before.has(key)) continue;
    entries.push({
      change: 'added',
      key,
      // A new REQUIRED field invalidates every draft that predates it; an
      // optional one does not.
      breaking: field.requirement === 'required',
      after: field.requirement,
    });
  }

  for (const [key, previous] of before) {
    const next = after.get(key);
    if (!next) continue;

    if (previous.requirement !== next.requirement) {
      entries.push({
        change: 'changed',
        key,
        property: 'requirement',
        before: previous.requirement,
        after: next.requirement,
        breaking: requirementTightened(previous.requirement, next.requirement),
      });
    }
    if (previous.valuePolicy !== next.valuePolicy) {
      entries.push({
        change: 'changed',
        key,
        property: 'valuePolicy',
        before: previous.valuePolicy,
        after: next.valuePolicy,
        // A value policy decides what a stored value IS — a controlled value, a
        // reference, a scalar. Any move re-interprets what is already written.
        breaking: true,
      });
    }
    if (previous.variantCapable !== next.variantCapable) {
      entries.push({
        change: 'changed',
        key,
        property: 'variantCapable',
        before: String(previous.variantCapable),
        after: String(next.variantCapable),
        // Withdrawing variant capability strands every listing that declared an
        // axis on it; granting it strands nothing.
        breaking: previous.variantCapable && !next.variantCapable,
      });
    }
    if (previous.attributeDefinitionVersion !== next.attributeDefinitionVersion) {
      entries.push({
        change: 'changed',
        key,
        property: 'attributeDefinitionVersion',
        before: String(previous.attributeDefinitionVersion),
        after: String(next.attributeDefinitionVersion),
        // A re-pin onto a newer attribute version means values written under the
        // old one cite a version this type no longer names.
        breaking: true,
      });
    }
    if (previous.groupKey !== next.groupKey) {
      entries.push({
        change: 'changed',
        key,
        property: 'groupKey',
        before: previous.groupKey ?? '',
        after: next.groupKey ?? '',
        // Presentation only. #367 step 3 leaves labels unfrozen for this reason.
        breaking: false,
      });
    }
  }

  for (const categoryId of from.categoryIds) {
    if (to.categoryIds.includes(categoryId)) continue;
    entries.push({
      change: 'removed',
      key: `category:${categoryId}`,
      // A withdrawn scope makes the type unusable where it was usable, which is
      // an authoring path disappearing under whoever was mid-draft in it.
      breaking: true,
    });
  }
  for (const categoryId of to.categoryIds) {
    if (from.categoryIds.includes(categoryId)) continue;
    entries.push({ change: 'added', key: `category:${categoryId}`, breaking: false });
  }

  return finish('product_type_definition', from.version, to.version, entries);
}

/** One attribute definition version, as much of it as a diff needs. */
export interface DiffableAttributeVersion {
  readonly version: number;
  readonly valueType: string;
  readonly cardinality: string;
  readonly unitFamily: string | null;
  readonly baseUnit: string | null;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly decimalPlaces: number | null;
  readonly variantDefining: boolean;
  readonly filterable: boolean;
  readonly hardConstraintCapable: boolean;
  readonly enumValues: readonly string[];
  readonly categoryIds: readonly string[];
}

/** Diff two attribute definition versions. */
export function diffAttributeVersions(
  from: DiffableAttributeVersion,
  to: DiffableAttributeVersion,
): CatalogDefinitionDiff {
  const entries: CatalogDefinitionDiffEntry[] = [];

  const scalar = (
    property: string,
    before: string | null,
    after: string | null,
    breaking: boolean,
  ): void => {
    if (before === after) return;
    entries.push({
      change: 'changed',
      key: property,
      property,
      before: before ?? '',
      after: after ?? '',
      breaking,
    });
  };

  // A value type or cardinality move re-interprets every stored value — this is
  // the class of change #94's `post` migration performed once, deliberately, as
  // a clean cut.
  scalar('valueType', from.valueType, to.valueType, true);
  scalar('cardinality', from.cardinality, to.cardinality, true);
  scalar('unitFamily', from.unitFamily, to.unitFamily, true);
  scalar('baseUnit', from.baseUnit, to.baseUnit, true);

  // A bound is breaking only when it NARROWS. Widening one admits values that
  // were previously refused and invalidates nothing already stored.
  if (from.minValue !== to.minValue) {
    entries.push({
      change: 'changed',
      key: 'minValue',
      property: 'minValue',
      before: from.minValue === null ? '' : String(from.minValue),
      after: to.minValue === null ? '' : String(to.minValue),
      breaking: narrowedLowerBound(from.minValue, to.minValue),
    });
  }
  if (from.maxValue !== to.maxValue) {
    entries.push({
      change: 'changed',
      key: 'maxValue',
      property: 'maxValue',
      before: from.maxValue === null ? '' : String(from.maxValue),
      after: to.maxValue === null ? '' : String(to.maxValue),
      breaking: narrowedUpperBound(from.maxValue, to.maxValue),
    });
  }
  if (from.decimalPlaces !== to.decimalPlaces) {
    entries.push({
      change: 'changed',
      key: 'decimalPlaces',
      property: 'decimalPlaces',
      before: from.decimalPlaces === null ? '' : String(from.decimalPlaces),
      after: to.decimalPlaces === null ? '' : String(to.decimalPlaces),
      // Fewer places re-rounds every stored value; more does not.
      breaking:
        from.decimalPlaces !== null &&
        to.decimalPlaces !== null &&
        to.decimalPlaces < from.decimalPlaces,
    });
  }

  // Withdrawing a capability strands whatever used it; granting one strands
  // nothing. `filterable` is presentation and is neither.
  capability('variantDefining', from.variantDefining, to.variantDefining, entries);
  capability('hardConstraintCapable', from.hardConstraintCapable, to.hardConstraintCapable, entries);
  if (from.filterable !== to.filterable) {
    entries.push({
      change: 'changed',
      key: 'filterable',
      property: 'filterable',
      before: String(from.filterable),
      after: String(to.filterable),
      breaking: false,
    });
  }

  for (const value of from.enumValues) {
    if (to.enumValues.includes(value)) continue;
    // A stored value citing a removed controlled value has nothing to resolve
    // to. `mercaria_attribute_enum_frozen` means this only appears between
    // drafts, which is exactly when somebody can still change their mind.
    entries.push({ change: 'removed', key: `value:${value}`, breaking: true });
  }
  for (const value of to.enumValues) {
    if (from.enumValues.includes(value)) continue;
    entries.push({ change: 'added', key: `value:${value}`, breaking: false });
  }

  for (const categoryId of from.categoryIds) {
    if (to.categoryIds.includes(categoryId)) continue;
    entries.push({ change: 'removed', key: `category:${categoryId}`, breaking: true });
  }
  for (const categoryId of to.categoryIds) {
    if (from.categoryIds.includes(categoryId)) continue;
    entries.push({ change: 'added', key: `category:${categoryId}`, breaking: false });
  }

  return finish('attribute_definition', from.version, to.version, entries);
}

function capability(
  property: string,
  before: boolean,
  after: boolean,
  entries: CatalogDefinitionDiffEntry[],
): void {
  if (before === after) return;
  entries.push({
    change: 'changed',
    key: property,
    property,
    before: String(before),
    after: String(after),
    breaking: before && !after,
  });
}

/** A lower bound narrows when it appears, or rises. */
function narrowedLowerBound(before: number | null, after: number | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  return after > before;
}

/** An upper bound narrows when it appears, or falls. */
function narrowedUpperBound(before: number | null, after: number | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  return after < before;
}

function finish(
  subjectKind: CatalogGovernanceSubjectKind,
  fromVersion: number,
  toVersion: number,
  entries: readonly CatalogDefinitionDiffEntry[],
): CatalogDefinitionDiff {
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    subjectKind,
    fromVersion,
    toVersion,
    entries: sorted,
    // Derived, never supplied. See the file doc.
    breakingCount: sorted.filter((entry) => entry.breaking).length,
  };
}
