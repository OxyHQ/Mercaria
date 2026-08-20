/**
 * Carrying an attribute definition forward into a NEW version (#568).
 *
 * A published attribute version is immutable — `mercaria_attribute_enum_frozen`
 * refuses to touch the value vocabulary of any definition that has left `draft`,
 * and its own message names the remedy: "publish a new version instead". So
 * adding a controlled value to a live attribute means drafting version N+1 that
 * carries everything the active version had, plus the new value.
 *
 * ## Why the dispositions are DATA and not a function nobody re-reads
 *
 * The carry-forward reconstructs a {@link DraftAttributeDefinitionInput} from a
 * stored row — twenty-odd fields. A field the mapping forgets is silently
 * dropped from the new version: no error, no failing test, and the loss is
 * invisible until somebody notices that a filterable attribute stopped being
 * filterable. Worse, **a column added to `attribute_definitions` next year is
 * not carried and nothing fails**.
 *
 * So {@link ATTRIBUTE_VERSION_CARRY_FORWARD} states a disposition for EVERY
 * column, and `attribute-version-carry-forward.test.ts` walks the drizzle table
 * and asserts the map covers exactly that set — the `merge-plan-census.test.ts`
 * device from #59. A new column fails the build until somebody decides what a
 * version carry-forward does with it, which is the point.
 *
 * `not_carried` always states a REASON. Silence is not a disposition: #59's
 * census accepts `untouched` WITH a reason and nothing else, because "we thought
 * about this and it must not move" and "we forgot" are indistinguishable
 * otherwise.
 */

import type {
  AttributeComponentAxis,
  AttributeValueType,
  CurrencyCode,
  UnitFamily,
} from '@mercaria/shared-types';
import { ATTRIBUTE_COMPONENT_AXES } from '@mercaria/shared-types';
import type {
  DraftAttributeDefinitionInput,
  ResolvedAttributeDefinition,
} from './definition-registry.service.js';

/** What a version carry-forward does with one column of `attribute_definitions`. */
export type AttributeColumnDisposition = 'carried' | { readonly notCarried: string };

/**
 * Every column of `attribute_definitions`, and what a carry-forward does with it.
 *
 * Keyed by the drizzle PROPERTY name, which is what the census reads off the
 * table — a hand-written list of column names would drift from the schema in
 * exactly the direction that makes the census pass while covering less.
 */
export const ATTRIBUTE_VERSION_CARRY_FORWARD: Readonly<
  Record<string, AttributeColumnDisposition>
> = Object.freeze({
  // ── Identity of the NEW row, never the old one's ────────────────────────
  id: { notCarried: 'The new version is a new row; copying the id would be the same row.' },
  version: { notCarried: 'The whole point: the new row is max(existing) + 1.' },
  lifecycleState: {
    notCarried:
      'A new version starts `draft`. Carrying `active` forward would publish it implicitly, ' +
      'which is the global act #568 deliberately split out into a separate operator step.',
  },
  createdAt: { notCarried: "The new row's own birthday, stamped by the column default." },
  updatedAt: { notCarried: "The new row's own, stamped by the column default." },

  // ── Publication facts, which the new version has not earned ─────────────
  publishedAt: { notCarried: 'The new version is unpublished; a date here would assert it is not.' },
  publishedByOxyUserId: {
    notCarried: 'Nobody has published the new version. Naming the previous publisher would ' +
      'attribute an act they did not perform.',
  },
  deprecatedAt: {
    notCarried:
      'A deprecation applies to the version it was recorded against. A fresh draft has not ' +
      'been deprecated, and carrying the date would make it born retired.',
  },
  createdByOxyUserId: {
    notCarried:
      'The actor drafting THIS version — the approving operator — not whoever created the ' +
      'original. Supplied by the caller.',
  },

  // ── Derived rather than copied ──────────────────────────────────────────
  baseUnit: {
    notCarried:
      'DERIVED from `unitFamily` by `draftAttributeDefinition`, which is what stops two ' +
      'definitions claiming to be normalized in different units. Carrying it would let a ' +
      'stale pair through.',
  },

  // ── Everything that IS the attribute's meaning ──────────────────────────
  key: 'carried',
  label: 'carried',
  description: 'carried',
  valueType: 'carried',
  cardinality: 'carried',
  objectivity: 'carried',
  unitFamily: 'carried',
  ratingScaleMax: 'carried',
  currency: 'carried',
  componentAxes: 'carried',
  minValue: 'carried',
  maxValue: 'carried',
  decimalPlaces: 'carried',
  maxLength: 'carried',
  implausibleAbove: 'carried',
  implausibleBelow: 'carried',
  variantDefining: 'carried',
  filterable: 'carried',
  sortable: 'carried',
  comparable: 'carried',
  hardConstraintCapable: 'carried',
  displayPolicy: 'carried',
  evidencePolicy: 'carried',
});

/** A controlled value being added to the new version. */
export interface CarriedForwardAddition {
  readonly value: string;
  readonly label: string;
  /** The submitter's verbatim spelling, when it differs from the key. */
  readonly aliases?: readonly string[];
}

/**
 * Only the members the registry declares.
 *
 * The stored column is a bare `text[]`, so its row type is `string[]` while the
 * input wants the union. Filtering against the tuple rather than casting means a
 * value the registry no longer declares is dropped loudly at the census rather
 * than carried into a new version that cannot validate.
 */
function componentAxesOf(stored: readonly string[]): AttributeComponentAxis[] {
  const declared = new Set<string>(ATTRIBUTE_COMPONENT_AXES);
  return stored.filter((axis): axis is AttributeComponentAxis => declared.has(axis));
}

/**
 * The input that drafts version N+1 of `active`, with `additions` appended.
 *
 * Pure: it reads a resolved definition and returns an input. Nothing here
 * writes, so the carry-forward can be unit-tested against a fixture without a
 * database, and the census can walk it without one either.
 *
 * The existing vocabulary keeps its ORDER and its position numbers by being
 * emitted first — a new value is appended, never interleaved, because a
 * position is what a merchant's form renders by and reordering it would move
 * every option under somebody who only asked to add one.
 */
export function buildNextVersionInput(
  active: ResolvedAttributeDefinition,
  additions: readonly CarriedForwardAddition[],
  actorOxyUserId: string,
): DraftAttributeDefinitionInput {
  const row = active.row;

  // `aliases` is normalized-alias -> canonical value; the input wants them per
  // value, so it is inverted once here rather than scanned per value.
  const aliasesByValue = new Map<string, string[]>();
  for (const [alias, value] of active.aliases) {
    const list = aliasesByValue.get(value) ?? [];
    list.push(alias);
    aliasesByValue.set(value, list);
  }

  const carriedValues = active.enumValues.map((enumValue) => ({
    value: enumValue.value,
    label: enumValue.label,
    aliases: aliasesByValue.get(enumValue.value) ?? [],
  }));

  return {
    key: row.key,
    label: row.label,
    ...(row.description === null ? {} : { description: row.description }),
    valueType: row.valueType as AttributeValueType,
    cardinality: row.cardinality,
    objectivity: row.objectivity,
    ...(row.unitFamily === null ? {} : { unitFamily: row.unitFamily as UnitFamily }),
    ...(row.ratingScaleMax === null ? {} : { ratingScaleMax: row.ratingScaleMax }),
    ...(row.currency === null ? {} : { currency: row.currency as CurrencyCode }),
    componentAxes: componentAxesOf(row.componentAxes),
    ...(row.minValue === null ? {} : { minValue: row.minValue }),
    ...(row.maxValue === null ? {} : { maxValue: row.maxValue }),
    ...(row.decimalPlaces === null ? {} : { decimalPlaces: row.decimalPlaces }),
    ...(row.maxLength === null ? {} : { maxLength: row.maxLength }),
    ...(row.implausibleAbove === null ? {} : { implausibleAbove: row.implausibleAbove }),
    ...(row.implausibleBelow === null ? {} : { implausibleBelow: row.implausibleBelow }),
    variantDefining: row.variantDefining,
    filterable: row.filterable,
    sortable: row.sortable,
    comparable: row.comparable,
    hardConstraintCapable: row.hardConstraintCapable,
    displayPolicy: row.displayPolicy,
    evidencePolicy: row.evidencePolicy,
    enumValues: [
      ...carriedValues,
      ...additions.map((addition) => ({
        value: addition.value,
        label: addition.label,
        aliases: [...(addition.aliases ?? [])],
      })),
    ],
    labels: active.labels.map((entry) => ({
      locale: entry.locale,
      label: entry.label,
      ...(entry.description === undefined ? {} : { description: entry.description }),
    })),
    categoryScopes: active.categoryScopes.map((scope) => ({
      categoryId: scope.categoryId,
      includeDescendants: scope.includeDescendants,
    })),
    actorOxyUserId,
  };
}
