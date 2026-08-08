/**
 * Unit tests for `inventory.service` — the STORE (multi-location) stock path.
 *
 * The repositories are mocked, so what is under test is the ROUTING: that a store
 * variant's stock goes to the LEVEL mutators and never to the scalar, that the
 * location is the explicit one or the store's default, that the rollup runs after
 * every level change, and that a refusal becomes `OUT_OF_STOCK`.
 *
 * The level guard's actual race-safety, and the fact that an absolute set
 * PRESERVES an existing row's `committed`, are checked against a real server in
 * `db/__tests__/catalog.realdb.test.ts` — a mock would accept any update document
 * and could not tell the two apart. The P2P path lives in `inventory.service.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findVariantById = vi.fn();
const findVariantInListing = vi.fn();
const reserveVariantScalar = vi.fn();
const adjustVariantScalar = vi.fn().mockResolvedValue(undefined);
const setVariantScalarAvailable = vi.fn().mockResolvedValue(undefined);
const findListingById = vi.fn();
const reserveAtLocation = vi.fn();
const adjustLevel = vi.fn().mockResolvedValue(undefined);
const setLevelAvailable = vi.fn().mockResolvedValue(undefined);
const syncListingFacets = vi.fn().mockResolvedValue(undefined);
const recomputeVariantScalarFromLevels = vi.fn().mockResolvedValue(undefined);
const resolveDefaultLocationId = vi.fn();

vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantById: (...args: unknown[]) => findVariantById(...args),
  findVariantInListing: (...args: unknown[]) => findVariantInListing(...args),
  reserveVariantScalar: (...args: unknown[]) => reserveVariantScalar(...args),
  adjustVariantScalar: (...args: unknown[]) => adjustVariantScalar(...args),
  setVariantScalarAvailable: (...args: unknown[]) => setVariantScalarAvailable(...args),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => findListingById(...args),
}));

vi.mock('../../db/catalog/inventoryLevelRepository.js', () => ({
  reserveAtLocation: (...args: unknown[]) => reserveAtLocation(...args),
  adjustLevel: (...args: unknown[]) => adjustLevel(...args),
  setLevelAvailable: (...args: unknown[]) => setLevelAvailable(...args),
}));

vi.mock('../catalog-write.service.js', () => ({
  syncListingFacets: (...args: unknown[]) => syncListingFacets(...args),
  recomputeVariantScalarFromLevels: (...args: unknown[]) =>
    recomputeVariantScalarFromLevels(...args),
  resolveDefaultLocationId: (...args: unknown[]) => resolveDefaultLocationId(...args),
}));

import { reserve, commit, release, restock, setAvailable } from '../inventory.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const VARIANT_ID = '000000000000000000000010';
const LISTING_ID = '000000000000000000000020';
const STORE_ID = '000000000000000000000040';
const DEFAULT_LOCATION_ID = '000000000000000000000050';
const EXPLICIT_LOCATION_ID = '000000000000000000000051';

/** A `product_variants` row as the repository returns it. */
function variantRow(tracked: boolean, available = 5): unknown {
  return {
    id: VARIANT_ID,
    listingId: LISTING_ID,
    title: 'Default Title',
    inventoryTracked: tracked,
    inventoryAvailable: available,
    inventoryCommitted: 0,
  };
}

/** A STORE-owned `listings` row. */
function storeListingRow(): unknown {
  return { id: LISTING_ID, ownerType: 'store', storeId: STORE_ID };
}

/** Queue the reads the low-stock alert makes after a successful reserve. */
function queueLowStockReads(): void {
  findVariantById.mockResolvedValueOnce(variantRow(true, 99));
  findListingById.mockResolvedValueOnce(storeListingRow());
}

beforeEach(() => {
  findVariantById.mockReset();
  findVariantInListing.mockReset();
  reserveVariantScalar.mockReset();
  adjustVariantScalar.mockClear();
  setVariantScalarAvailable.mockClear();
  findListingById.mockReset();
  reserveAtLocation.mockReset();
  adjustLevel.mockClear();
  setLevelAvailable.mockClear();
  syncListingFacets.mockClear();
  recomputeVariantScalarFromLevels.mockClear();
  resolveDefaultLocationId.mockReset().mockResolvedValue(DEFAULT_LOCATION_ID);
});

describe('inventory.service.reserve (store level path)', () => {
  it('reserves at the level grain and rolls up the scalar', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(storeListingRow());
    reserveAtLocation.mockResolvedValueOnce(true);
    queueLowStockReads();

    await reserve(VARIANT_ID, 2);

    // No scalar write; the level row took the guarded decrement.
    expect(reserveVariantScalar).not.toHaveBeenCalled();
    expect(reserveAtLocation).toHaveBeenCalledWith(VARIANT_ID, DEFAULT_LOCATION_ID, 2);
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('resolves the DEFAULT location when no locationId is supplied (checkout path)', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(storeListingRow());
    reserveAtLocation.mockResolvedValueOnce(true);
    queueLowStockReads();

    await reserve(VARIANT_ID, 1);

    expect(resolveDefaultLocationId).toHaveBeenCalledWith(STORE_ID);
    expect(reserveAtLocation).toHaveBeenCalledWith(VARIANT_ID, DEFAULT_LOCATION_ID, 1);
  });

  it('uses an explicit locationId without resolving the default', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(storeListingRow());
    reserveAtLocation.mockResolvedValueOnce(true);
    queueLowStockReads();

    await reserve(VARIANT_ID, 1, EXPLICIT_LOCATION_ID);

    expect(resolveDefaultLocationId).not.toHaveBeenCalled();
    expect(reserveAtLocation).toHaveBeenCalledWith(VARIANT_ID, EXPLICIT_LOCATION_ID, 1);
  });

  it('throws OUT_OF_STOCK when the level guard refuses', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(storeListingRow());
    reserveAtLocation.mockResolvedValueOnce(false);

    await expect(reserve(VARIANT_ID, 5)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );
    expect(recomputeVariantScalarFromLevels).not.toHaveBeenCalled();
    expect(syncListingFacets).not.toHaveBeenCalled();
  });
});

describe('inventory.service.release/restock/commit (store level path)', () => {
  it('release raises available and drops committed at the level, then rolls up', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(storeListingRow());

    await release(VARIANT_ID, 3);

    expect(adjustLevel).toHaveBeenCalledWith(VARIANT_ID, DEFAULT_LOCATION_ID, {
      available: 3,
      committed: -3,
    });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('restock raises available ONLY at the level, then rolls up', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(storeListingRow());

    await restock(VARIANT_ID, 4);

    // `committed` must be absent, not zero: `commit` already zeroed it on a paid
    // order, and moving it again would double-count the units.
    expect(adjustLevel).toHaveBeenCalledWith(VARIANT_ID, DEFAULT_LOCATION_ID, { available: 4 });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('commit drops committed only, rolls up, and does NOT resync facets', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(storeListingRow());

    await commit(VARIANT_ID, 2);

    expect(adjustLevel).toHaveBeenCalledWith(VARIANT_ID, DEFAULT_LOCATION_ID, { committed: -2 });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    // commit does not flip availability — no facet resync.
    expect(syncListingFacets).not.toHaveBeenCalled();
  });
});

describe('inventory.service.setAvailable (store level path)', () => {
  it('absolute-sets the level and recomputes the scalar from the levels', async () => {
    findVariantInListing.mockResolvedValueOnce(variantRow(true, 1));
    findListingById.mockResolvedValueOnce(storeListingRow());

    await setAvailable(VARIANT_ID, LISTING_ID, EXPLICIT_LOCATION_ID, 25);

    expect(findVariantInListing).toHaveBeenCalledWith(LISTING_ID, VARIANT_ID);
    // The store path writes the level; the scalar is DERIVED, never set directly.
    expect(setVariantScalarAvailable).not.toHaveBeenCalled();
    expect(setLevelAvailable).toHaveBeenCalledWith({
      variantId: VARIANT_ID,
      listingId: LISTING_ID,
      locationId: EXPLICIT_LOCATION_ID,
      available: 25,
    });
    expect(recomputeVariantScalarFromLevels).toHaveBeenCalledWith(VARIANT_ID);
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });
});
