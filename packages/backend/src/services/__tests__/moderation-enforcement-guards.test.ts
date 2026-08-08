/**
 * The two places an enforcement could be escaped through EXISTING commerce code.
 *
 * Both guards sit in code that predates CrowdSource and would otherwise happily
 * undo a jury's decision without erroring or logging anything. They are tested
 * apart from the moderation services precisely because they do not live there —
 * a reviewer reading `services/moderation/` would never see them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const listingFindById = vi.fn();
const updateListingColumns = vi.fn().mockResolvedValue(null);
const recomputeListingFacets = vi.fn().mockResolvedValue(undefined);
const replaceListingImages = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => listingFindById(...args),
  updateListingColumns: (...args: unknown[]) => updateListingColumns(...args),
  recomputeListingFacets: (...args: unknown[]) => recomputeListingFacets(...args),
  replaceListingImages: (...args: unknown[]) => replaceListingImages(...args),
  insertListing: vi.fn(),
}));

const orderFindOneAndUpdate = vi.fn();

vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantsByListing: vi.fn(async () => []),
  countVariants: vi.fn(async () => 1),
  insertVariants: vi.fn(async () => []),
  updateVariant: vi.fn(async () => null),
  deleteVariant: vi.fn(async () => false),
  recomputeVariantRollup: vi.fn(async () => undefined),
}));

vi.mock('../../db/catalog/inventoryLevelRepository.js', () => ({
  insertLevels: vi.fn(async () => undefined),
  setLevelAvailable: vi.fn(async () => undefined),
}));

vi.mock('../../db/catalog/categoryRepository.js', () => ({
  findCategoryBySlug: vi.fn(async () => null),
}));

vi.mock('../../db/stores/locationRepository.js', () => ({
  findDefaultLocationId: vi.fn(async () => null),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  adjustStoreProductCount: vi.fn(async () => undefined),
}));
vi.mock('../../models/order.js', () => ({
  Order: { findOneAndUpdate: (...args: unknown[]) => orderFindOneAndUpdate(...args) },
}));
vi.mock('../../models/store.js', () => ({ Store: { updateOne: vi.fn() } }));
vi.mock('../../models/seller-profile.js', () => ({ SellerProfile: { updateOne: vi.fn() } }));
vi.mock('../../models/refund.js', () => ({
  Refund: { find: () => ({ lean: async () => [] }) },
}));
vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: vi.fn(async () => undefined),
  enqueueFulfillmentPush: vi.fn(async () => undefined),
  enqueueOrderEventNotification: vi.fn(async () => undefined),
  enqueueRecomputeAggregate: vi.fn(async () => undefined),
}));
vi.mock('../inventory.service.js', () => ({
  commit: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
  restock: vi.fn(async () => undefined),
  rollupVariant: vi.fn(async () => undefined),
}));
vi.mock('../customer.service.js', () => ({ upsertOnPaid: vi.fn(async () => undefined) }));
vi.mock('../order-hydration.service.js', () => ({
  hydrateOrders: vi.fn(async () => []),
  summarizeOrders: vi.fn(async () => []),
}));
vi.mock('../fx.service.js', () => ({ convertToFair: vi.fn(async () => undefined) }));

const { updateListing } = await import('../catalog-write.service.js');
const { transition } = await import('../order.service.js');

const LISTING_ID = new Types.ObjectId().toHexString();

/** A listing ROW as the repository returns it — the shape `updateListing` reads. */
function listingRow(status: string): Record<string, unknown> {
  return {
    id: LISTING_ID,
    ownerType: 'user',
    oxyUserId: 'seller-1',
    storeId: null,
    status,
    publishedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateListingColumns.mockResolvedValue(null);
  // The CAS gate in `transition`; a returned doc means this caller won it.
  orderFindOneAndUpdate.mockResolvedValue({ _id: new Types.ObjectId(), status: 'processing' });
});

describe('a seller cannot escape a moderation restriction', () => {
  it('REFUSES to republish a restricted listing', async () => {
    listingFindById.mockResolvedValue(listingRow('restricted'));

    /**
     * The escape this closes: `updateListing` assigned `patch.status` straight
     * onto the document, so a seller whose counterfeit listing a jury delisted
     * could PATCH `{status:'active'}` and put it back on sale. Nothing would
     * error, nothing would log, and the audit trail would still show the
     * restriction being applied — because it was.
     */
    await expect(
      updateListing(LISTING_ID, { status: 'active' }),
    ).rejects.toThrow(/restricted pending a moderation decision/i);

    // Nothing was written: the guard runs BEFORE any column patch is assembled.
    expect(updateListingColumns).not.toHaveBeenCalled();
  });

  it('refuses EVERY status change on a restricted listing, not just active', async () => {
    listingFindById.mockResolvedValue(listingRow('restricted'));

    // `draft` would look harmless and is not: it hands the seller an editable
    // copy of material a jury removed.
    await expect(updateListing(LISTING_ID, { status: 'draft' })).rejects.toThrow(
      /restricted pending a moderation decision/i,
    );
  });

  it('refuses to IMPOSE a restriction from a request', async () => {
    listingFindById.mockResolvedValue(listingRow('active'));

    // The narrowed input type keeps `restricted` out of the payload, but a type
    // is erased at runtime and this service is exported to callers that never
    // saw the route's validation.
    await expect(
      updateListing(LISTING_ID, { status: 'restricted' as never }),
    ).rejects.toThrow(/cannot be set directly/i);
  });

  it('still allows an ordinary status change on an unrestricted listing', async () => {
    listingFindById.mockResolvedValue(listingRow('draft'));

    /**
     * The vacuity guard. A guard that refused everything would satisfy the tests
     * above and break the catalogue; this proves the normal path still works —
     * and that the new status really reaches the write, rather than the call
     * merely resolving.
     */
    await expect(updateListing(LISTING_ID, { status: 'active' })).resolves.toBeUndefined();
    expect(updateListingColumns).toHaveBeenCalledTimes(1);
    expect(updateListingColumns.mock.calls[0][1]).toMatchObject({ status: 'active' });
  });
});

describe('a frozen order cannot move', () => {
  /** An order document with the mongoose surface `transition` touches. */
  function orderDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      _id: new Types.ObjectId(),
      status: 'paid',
      payment: { status: 'paid' },
      statusHistory: [],
      items: [],
      moderationHold: true,
      ...overrides,
    };
  }

  it('refuses to advance an order held by a freeze_transaction decision', async () => {
    /**
     * This is what makes `freeze_transaction` real rather than a recorded
     * intention. Restricting a listing stops NEW orders; without this an order
     * placed yesterday would be packed and shipped while its case is still open.
     */
    await expect(
      transition(orderDoc() as never, 'processing', { actorOxyUserId: 'seller-1' }),
    ).rejects.toThrow(/held pending a moderation decision/i);
  });

  it('STILL allows a cancellation, so a buyer is never trapped', async () => {
    /**
     * A freeze stops goods and money moving FORWARD. Refusing a cancellation too
     * would trap a buyer's funds in exactly the transaction a jury is
     * questioning, which is the opposite of what the freeze is for.
     */
    await expect(
      transition(orderDoc() as never, 'cancelled', { actorOxyUserId: 'buyer-1' }),
    ).resolves.toBeDefined();
    expect(orderFindOneAndUpdate).toHaveBeenCalled();
  });

  it('does not interfere with an order that carries no hold', async () => {
    /**
     * The vacuity guard. A check that refused every transition would satisfy the
     * test above and stop the marketplace; this proves the hold discriminates.
     */
    await expect(
      transition(orderDoc({ moderationHold: undefined }) as never, 'processing', {
        actorOxyUserId: 'seller-1',
      }),
    ).resolves.toBeDefined();
    expect(orderFindOneAndUpdate).toHaveBeenCalled();
  });
});
