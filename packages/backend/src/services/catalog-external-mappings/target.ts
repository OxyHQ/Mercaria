/**
 * Translating between a mapping row's discriminated target columns and the
 * `CatalogExternalTarget` union (#367 Workstream 11).
 *
 * Pure, in one place, and in BOTH directions from the same `switch`. Two
 * translations of one shape can disagree, and the direction they disagree in is
 * always the permissive one: a writer that forgot to NULL a column the row's
 * dimension does not use would be refused by
 * `catalog_external_mappings_target_shape_check` — loudly — while a READER that
 * looked at the wrong column would quietly answer with somebody else's concept.
 *
 * Both functions switch on the dimension with no `default` branch, so a seventh
 * dimension added to `CATALOG_EXTERNAL_MAPPING_DIMENSIONS` fails `tsc` here
 * before it can fail a CHECK in production.
 */

import type {
  CatalogExternalMappingDimension,
  CatalogExternalTarget,
  UnitFamily,
} from '@mercaria/shared-types';

/** The target columns of a mapping row, as they come back from the database. */
export interface TargetColumns {
  readonly targetProductTypeKey: string | null;
  readonly targetAttributeKey: string | null;
  readonly targetControlledValue: string | null;
  /** Typed from the registry's tuple, not `string`: the column's `enum` is that tuple. */
  readonly targetUnitFamily: UnitFamily | null;
  readonly targetUnitCode: string | null;
  readonly targetSizeSystemKey: string | null;
}

/** Every target column NULL — the base a writer overlays exactly one field onto. */
const NO_TARGET: TargetColumns = Object.freeze({
  targetProductTypeKey: null,
  targetAttributeKey: null,
  targetControlledValue: null,
  targetUnitFamily: null,
  targetUnitCode: null,
  targetSizeSystemKey: null,
});

/**
 * A target, as columns.
 *
 * Every branch spreads {@link NO_TARGET} first, so a column belonging to another
 * dimension cannot survive from a previous value — which is what makes the
 * shape CHECK a redundancy rather than the only thing standing between a
 * category mapping and a stray unit code.
 */
export function targetToColumns(target: CatalogExternalTarget): TargetColumns {
  switch (target.dimension) {
    case 'product_type':
      return { ...NO_TARGET, targetProductTypeKey: target.productTypeKey };
    case 'attribute':
      return { ...NO_TARGET, targetAttributeKey: target.attributeKey };
    case 'controlled_value':
      return {
        ...NO_TARGET,
        targetAttributeKey: target.attributeKey,
        targetControlledValue: target.controlledValue,
      };
    case 'unit':
      return { ...NO_TARGET, targetUnitFamily: target.unitFamily, targetUnitCode: target.unitCode };
    case 'size_system':
      return { ...NO_TARGET, targetSizeSystemKey: target.sizeSystemKey };
  }
}

/**
 * Columns, as a target.
 *
 * Returns `null` for a row whose columns do not satisfy its own dimension. That
 * cannot happen through the repository (the shape CHECK refuses it), and the
 * branch is here rather than as a thrown assertion because a mapping written by
 * a future migration against a widened CHECK should read as unresolvable rather
 * than crash the read that found it.
 */
export function columnsToTarget(
  dimension: CatalogExternalMappingDimension,
  columns: TargetColumns,
): CatalogExternalTarget | null {
  switch (dimension) {
    case 'product_type':
      return columns.targetProductTypeKey === null
        ? null
        : { dimension, productTypeKey: columns.targetProductTypeKey };
    case 'attribute':
      return columns.targetAttributeKey === null
        ? null
        : { dimension, attributeKey: columns.targetAttributeKey };
    case 'controlled_value':
      return columns.targetAttributeKey === null || columns.targetControlledValue === null
        ? null
        : {
            dimension,
            attributeKey: columns.targetAttributeKey,
            controlledValue: columns.targetControlledValue,
          };
    case 'unit':
      return columns.targetUnitFamily === null || columns.targetUnitCode === null
        ? null
        : { dimension, unitFamily: columns.targetUnitFamily, unitCode: columns.targetUnitCode };
    case 'size_system':
      return columns.targetSizeSystemKey === null
        ? null
        : { dimension, sizeSystemKey: columns.targetSizeSystemKey };
  }
}

/**
 * Whether two targets name the same Mercaria concept.
 *
 * Used by the reprocessing run to tell `unchanged` from `retargeted`, and by the
 * fan-out check to tell a duplicate proposal from a genuine second target. It
 * compares FIELDS rather than serializing, because a product-type target with an
 * explicit version 1 and one with no version are the same concept today and
 * would serialize differently.
 */
export function targetsAgree(a: CatalogExternalTarget, b: CatalogExternalTarget): boolean {
  if (a.dimension !== b.dimension) return false;
  switch (a.dimension) {
    case 'product_type':
      return b.dimension === 'product_type' && a.productTypeKey === b.productTypeKey;
    case 'attribute':
      return b.dimension === 'attribute' && a.attributeKey === b.attributeKey;
    case 'controlled_value':
      return (
        b.dimension === 'controlled_value' &&
        a.attributeKey === b.attributeKey &&
        a.controlledValue === b.controlledValue
      );
    case 'unit':
      return b.dimension === 'unit' && a.unitFamily === b.unitFamily && a.unitCode === b.unitCode;
    case 'size_system':
      return b.dimension === 'size_system' && a.sizeSystemKey === b.sizeSystemKey;
  }
}

/*
 * There is deliberately NO JavaScript `normalizeExternalKey` here, and the
 * absence is load-bearing.
 *
 * `external_key_normalized` is `lower(btrim(external_key))`, computed by
 * Postgres. The obvious TypeScript mirror — `key.trim().toLowerCase()` — is NOT
 * the same function: `btrim` with one argument strips ASCII SPACES only, while
 * `String.prototype.trim` strips every Unicode whitespace character, and `lower`
 * follows the database collation where `toLowerCase` follows the ECMAScript
 * default case-folding table. A token carrying a tab, a non-breaking space or a
 * dotted capital I would therefore be STORED under one key and LOOKED UP under
 * another, and the failure is a silent miss that reads exactly like "this source
 * has never published that value".
 *
 * So every lookup in `externalMappingRepository.ts` compares the indexed
 * generated column against `lower(btrim($1))` — the same expression, evaluated
 * by the same engine, on both sides. The index is still used, because the
 * right-hand side is a constant to the planner. In-memory grouping only ever
 * runs over values that already came back from the database, and is therefore
 * already normalized by that one authority.
 */
