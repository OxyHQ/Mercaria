/**
 * `review-self-review` — #76 verification rule 6, and the honest boundary of it.
 *
 * Two independent layers, and the tests are arranged to prove they ARE
 * independent: layer 1 catches a seller rating their own sale whatever scope the
 * review claims, and layer 2 catches ownership of the target for a review with
 * no purchase behind it at all.
 *
 * The refusal message is asserted to be UNIFORM. Naming which relation was found
 * would tell an author which of their accounts Mercaria has associated with
 * which store — a fact about somebody else's membership as often as about their
 * own.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOrderById = vi.fn();
const findListingById = vi.fn();
const findStoreById = vi.fn();
const findActiveLinkByMerchant = vi.fn();
const findMerchantById = vi.fn();

vi.mock('../../../db/orders/orderRepository.js', () => ({
  findOrderById: (...args: unknown[]) => findOrderById(...args),
}));
vi.mock('../../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => findListingById(...args),
}));
vi.mock('../../../db/stores/storeRepository.js', () => ({
  findStoreById: (...args: unknown[]) => findStoreById(...args),
}));
vi.mock('../../../db/commerce-graph/nativeStoreLinkRepository.js', () => ({
  findActiveLinkByMerchant: (...args: unknown[]) => findActiveLinkByMerchant(...args),
}));
vi.mock('../../../db/commerce-graph/merchantRepository.js', () => ({
  findMerchantById: (...args: unknown[]) => findMerchantById(...args),
}));
vi.mock('../../../db/postgres.js', () => ({ getDb: () => ({}) }));

import { assertNotSelfPurchase, assertNotSelfTarget } from '../review-self-review.js';
import { isMercariaError } from '../../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../../utils/api-response.js';

/** The one message every branch raises. */
const UNIFORM = 'You cannot review your own listing, store, merchant or sale';

beforeEach(() => {
  vi.clearAllMocks();
  findOrderById.mockResolvedValue(null);
  findListingById.mockResolvedValue(null);
  findStoreById.mockResolvedValue(null);
  findActiveLinkByMerchant.mockResolvedValue(undefined);
  findMerchantById.mockResolvedValue(null);
});

describe('layer 1 — the author is the seller on the order', () => {
  it('refuses a P2P seller who bought from themselves', async () => {
    findOrderById.mockResolvedValue({
      id: 'order-1',
      sellerType: 'user',
      sellerOxyUserId: 'me',
      storeId: null,
    });

    await expect(assertNotSelfPurchase('me', 'order-1')).rejects.toSatisfy(
      (err: unknown) =>
        isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN && err.message === UNIFORM,
    );
  });

  it('refuses a STORE MEMBER who bought from their own store — the related account', async () => {
    // `store_members` is the "related accounts where detectable" signal Mercaria
    // actually has. A person who can act for a store is not an arm's-length
    // reviewer of it, whichever account they bought with.
    findOrderById.mockResolvedValue({
      id: 'order-1',
      sellerType: 'store',
      sellerOxyUserId: null,
      storeId: 'store-1',
    });
    findStoreById.mockResolvedValue({
      id: 'store-1',
      members: [{ oxyUserId: 'me', role: 'staff' }],
    });

    await expect(assertNotSelfPurchase('me', 'order-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.message === UNIFORM,
    );
  });

  it('permits an ordinary buyer', async () => {
    // Without this the assertions above pass against a guard that refuses
    // everything, which would block every legitimate review on the platform.
    findOrderById.mockResolvedValue({
      id: 'order-1',
      sellerType: 'store',
      sellerOxyUserId: null,
      storeId: 'store-1',
    });
    findStoreById.mockResolvedValue({ id: 'store-1', members: [{ oxyUserId: 'someone-else' }] });

    await expect(assertNotSelfPurchase('me', 'order-1')).resolves.toBeUndefined();
  });

  it('covers a PRODUCT review, which has no ownership relation of its own', async () => {
    // A canonical product belongs to nobody (ADR 0002 D6), so layer 2 has
    // nothing to test — the purchase is the only handle, which is exactly why
    // layer 1 runs for every scope.
    findOrderById.mockResolvedValue({
      id: 'order-1',
      sellerType: 'user',
      sellerOxyUserId: 'me',
      storeId: null,
    });

    await expect(assertNotSelfPurchase('me', 'order-1')).rejects.toThrow();
    await expect(assertNotSelfTarget('me', 'product', 'prod-1')).resolves.toBeUndefined();
  });
});

describe('layer 2 — the author owns, or can act for, the target', () => {
  it('refuses a P2P seller reviewing themselves', async () => {
    await expect(assertNotSelfTarget('me', 'p2p_seller', 'me')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.message === UNIFORM,
    );
  });

  it('refuses the owner of a P2P listing', async () => {
    findListingById.mockResolvedValue({
      id: 'listing-1',
      ownerType: 'user',
      oxyUserId: 'me',
      storeId: null,
    });

    await expect(assertNotSelfTarget('me', 'p2p_listing', 'listing-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.message === UNIFORM,
    );
  });

  it('refuses a member of the store that owns the listing', async () => {
    findListingById.mockResolvedValue({
      id: 'listing-1',
      ownerType: 'store',
      oxyUserId: null,
      storeId: 'store-1',
    });
    findStoreById.mockResolvedValue({ id: 'store-1', members: [{ oxyUserId: 'me' }] });

    await expect(assertNotSelfTarget('me', 'p2p_listing', 'listing-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.message === UNIFORM,
    );
  });

  it("refuses a merchant's VERIFIED claimant", async () => {
    // #83 established that this person operates the merchant. Reviewing it is
    // the clearest self-review there is.
    findMerchantById.mockResolvedValue({ id: 'merch-1', claimedByOxyUserId: 'me' });

    await expect(assertNotSelfTarget('me', 'merchant', 'merch-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.message === UNIFORM,
    );
  });

  it("refuses a member of the merchant's linked native store", async () => {
    // Several verified OPERATORS reach a merchant through `store_members` after
    // linkage (ADR 0002 D4), never through a second verified claim — so the
    // claimant check alone would miss the staff.
    findMerchantById.mockResolvedValue({ id: 'merch-1', claimedByOxyUserId: 'someone-else' });
    findActiveLinkByMerchant.mockResolvedValue({ merchantId: 'merch-1', storeId: 'store-1' });
    findStoreById.mockResolvedValue({ id: 'store-1', members: [{ oxyUserId: 'me' }] });

    await expect(assertNotSelfTarget('me', 'merchant', 'merch-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.message === UNIFORM,
    );
  });

  it('permits an unrelated reviewer of a merchant', async () => {
    findMerchantById.mockResolvedValue({ id: 'merch-1', claimedByOxyUserId: 'someone-else' });
    findActiveLinkByMerchant.mockResolvedValue({ merchantId: 'merch-1', storeId: 'store-1' });
    findStoreById.mockResolvedValue({ id: 'store-1', members: [{ oxyUserId: 'staff-1' }] });

    await expect(assertNotSelfTarget('me', 'merchant', 'merch-1')).resolves.toBeUndefined();
  });

  it('permits a review of a listing that no longer exists', async () => {
    // Fail-open here is correct: there is no owner to be, and refusing would
    // block a legitimate review over a deleted row.
    findListingById.mockResolvedValue(null);

    await expect(assertNotSelfTarget('me', 'p2p_listing', 'gone')).resolves.toBeUndefined();
  });
});
