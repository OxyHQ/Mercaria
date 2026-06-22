/**
 * Unit test for `catalog-write.service.recomputeVariantScalarFromLevels` — the
 * ONE place a store variant's scalar `inventory.{available,committed}` is rolled
 * up from its `InventoryLevel` rows. `mongodb-memory-server` is unavailable, so
 * `InventoryLevel.aggregate` and `ProductVariant.updateOne` are mocked: the test
 * asserts the rollup SUMS the level rows and persists them to the scalar, and that
 * an empty level set rolls up to zeros.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const levelAggregate = vi.fn();
const variantUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

vi.mock('../../models/inventory-level.js', () => ({
  InventoryLevel: {
    aggregate: (...args: unknown[]) => levelAggregate(...args),
  },
}));

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: {
    updateOne: (...args: unknown[]) => variantUpdateOne(...args),
  },
}));

import { recomputeVariantScalarFromLevels } from '../catalog-write.service.js';

const VARIANT_ID = '000000000000000000000010';

beforeEach(() => {
  levelAggregate.mockReset();
  variantUpdateOne.mockClear();
});

describe('recomputeVariantScalarFromLevels', () => {
  it('sums the level rows into the variant scalar', async () => {
    // Two locations: 8 + 4 available, 1 + 2 committed.
    levelAggregate.mockResolvedValueOnce([{ available: 12, committed: 3 }]);

    await recomputeVariantScalarFromLevels(VARIANT_ID);

    const [matchStage, groupStage] = levelAggregate.mock.calls[0][0];
    expect(matchStage).toEqual({ $match: { variantId: VARIANT_ID } });
    expect(groupStage).toEqual({
      $group: { _id: null, available: { $sum: '$available' }, committed: { $sum: '$committed' } },
    });

    expect(variantUpdateOne).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { 'inventory.available': 12, 'inventory.committed': 3 } },
    );
  });

  it('rolls up to zeros when the variant has no level rows', async () => {
    levelAggregate.mockResolvedValueOnce([]);

    await recomputeVariantScalarFromLevels(VARIANT_ID);

    expect(variantUpdateOne).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { 'inventory.available': 0, 'inventory.committed': 0 } },
    );
  });
});
