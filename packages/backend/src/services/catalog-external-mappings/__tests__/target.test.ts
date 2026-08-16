/**
 * The discriminated target, both directions (#367 Workstream 11).
 *
 * The property that matters is the ROUND TRIP: columns written from a target and
 * read back must produce the same target. Two translations of one shape can
 * disagree, and the direction they disagree in is the dangerous one — a writer
 * that put a column in the wrong place is refused by
 * `catalog_external_mappings_target_shape_check`, loudly, while a READER that
 * looked at the wrong column quietly answers with somebody else's concept.
 */

import { describe, expect, it } from 'vitest';
import {
  CATALOG_EXTERNAL_MAPPING_DIMENSIONS,
  type CatalogExternalTarget,
} from '@mercaria/shared-types';
import { columnsToTarget, targetToColumns, targetsAgree } from '../target.js';

/** One target per dimension — the census the round-trip test runs over. */
const SAMPLES: Readonly<Record<string, CatalogExternalTarget>> = {
  product_type: { dimension: 'product_type', productTypeKey: 'smartphone' },
  attribute: { dimension: 'attribute', attributeKey: 'ram_capacity' },
  controlled_value: {
    dimension: 'controlled_value',
    attributeKey: 'colour',
    controlledValue: 'black',
  },
  unit: { dimension: 'unit', unitFamily: 'digital_storage', unitCode: 'GB' },
  size_system: { dimension: 'size_system', sizeSystemKey: 'shoe.eu' },
};

describe('every dimension round-trips', () => {
  it('covers all five — the census floor', () => {
    // A round-trip test over four of five dimensions passes and says nothing
    // about the fifth, so the coverage is asserted rather than assumed.
    expect(Object.keys(SAMPLES).sort()).toEqual([...CATALOG_EXTERNAL_MAPPING_DIMENSIONS].sort());
  });

  it('columns written from a target read back as that target', () => {
    for (const dimension of CATALOG_EXTERNAL_MAPPING_DIMENSIONS) {
      const target = SAMPLES[dimension];
      expect(target, `no sample for '${dimension}'`).toBeDefined();
      if (target === undefined) continue;
      const columns = targetToColumns(target);
      expect(columnsToTarget(dimension, columns), `'${dimension}' did not round-trip`).toEqual(
        target,
      );
    }
  });

  it('sets exactly the columns its dimension owns, and every other is NULL', () => {
    // Written as a census rather than "exactly one", because two dimensions
    // legitimately set a PAIR: a controlled value names the attribute it belongs
    // to, and a unit names the family its code lives in. Both are what
    // `catalog_external_mappings_target_shape_check` permits, and stating the
    // expected count per dimension is what makes this assert agreement with the
    // CHECK rather than a rule of thumb that happens to hold for four of six.
    const expectedColumns: Readonly<Record<string, number>> = {
      product_type: 1,
      attribute: 1,
      controlled_value: 2,
      unit: 2,
      size_system: 1,
    };
    expect(Object.keys(expectedColumns).sort()).toEqual(
      [...CATALOG_EXTERNAL_MAPPING_DIMENSIONS].sort(),
    );
    for (const dimension of CATALOG_EXTERNAL_MAPPING_DIMENSIONS) {
      const target = SAMPLES[dimension];
      if (target === undefined) continue;
      const set = Object.values(targetToColumns(target)).filter((value) => value !== null);
      expect(set.length, `'${dimension}' set ${set.length} columns`).toBe(
        expectedColumns[dimension],
      );
    }
  });

  it('a product-type target carries a KEY and no version, because a version is not the target', () => {
    // The mapping says "this source's item type MEANS Mercaria's `smartphone`",
    // which is a statement about the concept and not about one publication of
    // its schema. Pinning a version here would make every schema publication
    // require re-approving every source mapping. Which version an operator was
    // looking at is `reviewed_product_type_definition_id` on the ROW — provenance
    // that is never applied — and it is deliberately absent from this union.
    const target = SAMPLES['product_type'] as CatalogExternalTarget;
    expect(columnsToTarget('product_type', targetToColumns(target))).toEqual({
      dimension: 'product_type',
      productTypeKey: 'smartphone',
    });
    expect(Object.keys(target)).toEqual(['dimension', 'productTypeKey']);
  });
});

describe('a row whose columns contradict its dimension reads as unresolvable', () => {
  it('returns null rather than throwing or picking a column', () => {
    const columns = targetToColumns(SAMPLES['attribute'] as CatalogExternalTarget);
    // A `unit` row carrying a category id cannot exist through the repository —
    // the shape CHECK refuses it — but a future migration widening that CHECK
    // must produce an unresolvable read rather than crashing the page that found
    // it, or one bad row takes a whole comparison surface down.
    expect(columnsToTarget('unit', columns)).toBeNull();
  });
});

describe('targetsAgree compares FIELDS, never a serialization', () => {
  it('two product-type targets agree on the key alone', () => {
    expect(
      targetsAgree(
        { dimension: 'product_type', productTypeKey: 'smartphone' },
        { dimension: 'product_type', productTypeKey: 'smartphone' },
      ),
    ).toBe(true);
    expect(
      targetsAgree(
        { dimension: 'product_type', productTypeKey: 'smartphone' },
        { dimension: 'product_type', productTypeKey: 'tablet' },
      ),
    ).toBe(false);
  });

  it('different dimensions never agree, even with the same string', () => {
    expect(
      targetsAgree(
        { dimension: 'attribute', attributeKey: 'colour' },
        { dimension: 'controlled_value', attributeKey: 'colour', controlledValue: 'black' },
      ),
    ).toBe(false);
  });

  it('a controlled value differs from another value of the same attribute', () => {
    expect(
      targetsAgree(
        { dimension: 'controlled_value', attributeKey: 'colour', controlledValue: 'black' },
        { dimension: 'controlled_value', attributeKey: 'colour', controlledValue: 'white' },
      ),
    ).toBe(false);
  });

  it('a unit code in the wrong family does not agree', () => {
    expect(
      targetsAgree(
        { dimension: 'unit', unitFamily: 'digital_storage', unitCode: 'GB' },
        { dimension: 'unit', unitFamily: 'mass', unitCode: 'GB' },
      ),
    ).toBe(false);
  });
});
