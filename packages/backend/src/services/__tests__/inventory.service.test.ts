/**
 * Unit tests for `inventory.service` — the P2P (scalar) stock path.
 *
 * The repositories are mocked, so what is under test here is the ROUTING and the
 * CONTRACT: that a P2P variant's stock goes to the scalar mutators and never to a
 * level, that a refusal reported by rowcount becomes `OUT_OF_STOCK`, that an
 * untracked variant short-circuits, and that facets are resynced after exactly the
 * operations that can flip availability.
 *
 * What a mock CANNOT check is whether the guarded UPDATE is really race-safe —
 * that lives in `db/__tests__/catalog.realdb.test.ts`, against a real server, and
 * is the reason these mocks are allowed to be this simple. The store (level) path
 * lives in `inventory-level.service.test.ts`.
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

import { reserve, commit, release, setAvailable } from '../inventory.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const VARIANT_ID = '000000000000000000000010';
const LISTING_ID = '000000000000000000000020';

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

/** A `listings` row carrying an ownership. */
function listingRow(ownerType: 'user' | 'store', storeId: string | null = null): unknown {
  return { id: LISTING_ID, ownerType, storeId };
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
  resolveDefaultLocationId.mockReset();
});

describe('inventory.service.reserve (P2P scalar path)', () => {
  it('decrements available and raises committed when the guard admits it', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(listingRow('user'));
    reserveVariantScalar.mockResolvedValueOnce(true);
    // The low-stock alert re-reads the variant afterwards.
    findVariantById.mockResolvedValueOnce(variantRow(true, 3));
    findListingById.mockResolvedValueOnce(listingRow('user'));

    await reserve(VARIANT_ID, 2);

    expect(reserveVariantScalar).toHaveBeenCalledWith(VARIANT_ID, 2);
    expect(reserveAtLocation).not.toHaveBeenCalled();
    expect(recomputeVariantScalarFromLevels).not.toHaveBeenCalled();
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('throws OUT_OF_STOCK when the guard refuses — a `false` is never "nothing to do"', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(listingRow('user'));
    reserveVariantScalar.mockResolvedValueOnce(false);

    await expect(reserve(VARIANT_ID, 5)).rejects.toSatisfy((err: unknown) => {
      return isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK;
    });
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('short-circuits (no write) for an untracked variant', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(false));
    findListingById.mockResolvedValueOnce(listingRow('user'));

    await reserve(VARIANT_ID, 99);

    expect(reserveVariantScalar).not.toHaveBeenCalled();
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('raises NOT_FOUND for a missing variant, which is NOT the untracked case', async () => {
    findVariantById.mockResolvedValueOnce(null);

    await expect(reserve(VARIANT_ID, 1)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
  });

  it('is a no-op for non-positive quantities', async () => {
    await reserve(VARIANT_ID, 0);
    expect(findVariantById).not.toHaveBeenCalled();
    expect(reserveVariantScalar).not.toHaveBeenCalled();
  });
});

describe('inventory.service.release (P2P scalar path)', () => {
  it('restores available and drops committed', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(listingRow('user'));

    await release(VARIANT_ID, 3);

    expect(adjustVariantScalar).toHaveBeenCalledWith(VARIANT_ID, {
      available: 3,
      committed: -3,
    });
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('short-circuits for an untracked variant', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(false));
    findListingById.mockResolvedValueOnce(listingRow('user'));
    await release(VARIANT_ID, 3);
    expect(adjustVariantScalar).not.toHaveBeenCalled();
  });
});

describe('inventory.service.commit (P2P scalar path)', () => {
  it('reduces committed only (available untouched)', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(true));
    findListingById.mockResolvedValueOnce(listingRow('user'));

    await commit(VARIANT_ID, 4);

    expect(adjustVariantScalar).toHaveBeenCalledWith(VARIANT_ID, { committed: -4 });
    // commit does not flip availability — no facet resync.
    expect(syncListingFacets).not.toHaveBeenCalled();
  });

  it('short-circuits for an untracked variant', async () => {
    findVariantById.mockResolvedValueOnce(variantRow(false));
    findListingById.mockResolvedValueOnce(listingRow('user'));
    await commit(VARIANT_ID, 4);
    expect(adjustVariantScalar).not.toHaveBeenCalled();
  });
});

describe('inventory.service.setAvailable (P2P scalar path)', () => {
  const LOCATION_ID = '000000000000000000000030';

  it('absolute-sets available on a tracked P2P variant and resyncs facets', async () => {
    findVariantInListing.mockResolvedValueOnce(variantRow(true, 1));
    findListingById.mockResolvedValueOnce(listingRow('user'));

    await setAvailable(VARIANT_ID, LISTING_ID, LOCATION_ID, 25);

    expect(findVariantInListing).toHaveBeenCalledWith(LISTING_ID, VARIANT_ID);
    expect(setVariantScalarAvailable).toHaveBeenCalledWith(VARIANT_ID, 25);
    // P2P writes the scalar directly — never the level.
    expect(setLevelAvailable).not.toHaveBeenCalled();
    expect(recomputeVariantScalarFromLevels).not.toHaveBeenCalled();
    expect(syncListingFacets).toHaveBeenCalledWith(LISTING_ID);
  });

  it('rejects a negative or non-integer available before any lookup', async () => {
    await expect(setAvailable(VARIANT_ID, LISTING_ID, LOCATION_ID, -1)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );
    await expect(setAvailable(VARIANT_ID, LISTING_ID, LOCATION_ID, 1.5)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );
    expect(findVariantInListing).not.toHaveBeenCalled();
  });

  it('IDOR regression: a variant on a DIFFERENT listing is NOT_FOUND with NO stock write', async () => {
    const OTHER_LISTING_ID = '000000000000000000000099';
    // The scoping to `listingId` IS the authorization — the repository query
    // matches nothing for another store's listing.
    findVariantInListing.mockResolvedValueOnce(null);

    await expect(setAvailable(VARIANT_ID, OTHER_LISTING_ID, LOCATION_ID, 25)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );

    expect(findVariantInListing).toHaveBeenCalledWith(OTHER_LISTING_ID, VARIANT_ID);
    expect(setVariantScalarAvailable).not.toHaveBeenCalled();
    expect(setLevelAvailable).not.toHaveBeenCalled();
    expect(syncListingFacets).not.toHaveBeenCalled();
  });
});
