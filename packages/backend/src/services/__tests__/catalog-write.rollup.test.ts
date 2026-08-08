/**
 * Unit test for `catalog-write.service`'s two shared helpers — the variant stock
 * rollup and the store-location resolver.
 *
 * The repositories are mocked, so what is under test is the SEAM: that both
 * helpers delegate to exactly one implementation and neither grows a second,
 * subtly different copy. The rollup's SQL — the correlated aggregate that returns
 * zero with no error when written the obvious way — is checked against a real
 * server in `db/__tests__/catalog.realdb.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recomputeVariantRollup = vi.fn().mockResolvedValue(undefined);
const findDefaultLocationId = vi.fn();

vi.mock('../../db/catalog/variantRepository.js', () => ({
  recomputeVariantRollup: (...args: unknown[]) => recomputeVariantRollup(...args),
  countVariants: vi.fn(),
  deleteVariant: vi.fn(),
  findVariantsByListing: vi.fn(),
  insertVariants: vi.fn(),
  updateVariant: vi.fn(),
}));

vi.mock('../../db/stores/locationRepository.js', () => ({
  findDefaultLocationId: (...args: unknown[]) => findDefaultLocationId(...args),
}));

import {
  recomputeVariantScalarFromLevels,
  resolveDefaultLocationId,
} from '../catalog-write.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const VARIANT_ID = '000000000000000000000010';
const STORE_ID = '000000000000000000000040';

beforeEach(() => {
  recomputeVariantRollup.mockClear();
  findDefaultLocationId.mockReset();
});

describe('recomputeVariantScalarFromLevels', () => {
  it('delegates to the ONE rollup implementation', async () => {
    await recomputeVariantScalarFromLevels(VARIANT_ID);
    expect(recomputeVariantRollup).toHaveBeenCalledWith(VARIANT_ID);
  });
});

describe('resolveDefaultLocationId', () => {
  it('returns the store default the repository resolves', async () => {
    findDefaultLocationId.mockResolvedValueOnce('loc-default');
    expect(await resolveDefaultLocationId(STORE_ID)).toBe('loc-default');
    expect(findDefaultLocationId).toHaveBeenCalledWith(STORE_ID);
  });

  it('turns "this store has no location" into NOT_FOUND', async () => {
    // The repository answers `null`, because absence is a fact about the data;
    // NOT_FOUND is this service's contract for it, and every caller — checkout,
    // draft orders, the connector import — depends on the throw rather than
    // silently stocking at `null`.
    findDefaultLocationId.mockResolvedValueOnce(null);

    await expect(resolveDefaultLocationId(STORE_ID)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
  });
});
