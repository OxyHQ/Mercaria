/**
 * Unit tests for `review.service`.
 *
 * Reviews, orders, stores and seller profiles are still Mongo, so those models
 * are mocked; the LISTING side moved to Postgres, so `db/catalog/listingRepository`
 * is mocked in place of the `Listing` model. The queue producer, the notification
 * service and the Oxy/media hydration are mocked too.
 *
 * Tests assert the F5 contract: the verified-purchase gate (no qualifying order →
 * FORBIDDEN; qualifying order → created), one-review-per-target (existing review →
 * CONFLICT), that `recomputeAggregate` derives + persists `{rating, reviewCount}`
 * per target, and that a store's review page builds each card's product context
 * from the listing ROW plus its images child table.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const reviewFindOne = vi.fn();
const reviewCreate = vi.fn();
const reviewAggregate = vi.fn();
const reviewFind = vi.fn();
const reviewCountDocuments = vi.fn();
const orderFindOne = vi.fn();
const orderFindById = vi.fn();
const setListingRating = vi.fn();
const findListingById = vi.fn();
const findListingIdsByStore = vi.fn();
const findListingsByIds = vi.fn();
const findListingChildren = vi.fn();
const storeUpdateOne = vi.fn();
const storeFindOne = vi.fn();
const storeFindById = vi.fn();
const sellerProfileUpdateOne = vi.fn();
const enqueueRecomputeAggregate = vi.fn();
const sendNotification = vi.fn();
const getProfiles = vi.fn();

vi.mock('../../models/review.js', () => ({
  Review: {
    findOne: (...args: unknown[]) => reviewFindOne(...args),
    create: (...args: unknown[]) => reviewCreate(...args),
    aggregate: (...args: unknown[]) => reviewAggregate(...args),
    find: (...args: unknown[]) => reviewFind(...args),
    countDocuments: (...args: unknown[]) => reviewCountDocuments(...args),
  },
}));

vi.mock('../../models/order.js', () => ({
  Order: {
    findOne: (...args: unknown[]) => orderFindOne(...args),
    findById: (...args: unknown[]) => orderFindById(...args),
  },
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  setListingRating: (...args: unknown[]) => setListingRating(...args),
  findListingById: (...args: unknown[]) => findListingById(...args),
  findListingIdsByStore: (...args: unknown[]) => findListingIdsByStore(...args),
  findListingsByIds: (...args: unknown[]) => findListingsByIds(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));

vi.mock('../../models/store.js', () => ({
  Store: {
    updateOne: (...args: unknown[]) => storeUpdateOne(...args),
    findById: (...args: unknown[]) => storeFindById(...args),
    findOne: (...args: unknown[]) => storeFindOne(...args),
  },
}));

vi.mock('../../models/seller-profile.js', () => ({
  SellerProfile: { updateOne: (...args: unknown[]) => sellerProfileUpdateOne(...args) },
}));

vi.mock('../../queue/producers.js', () => ({
  enqueueRecomputeAggregate: (...args: unknown[]) => enqueueRecomputeAggregate(...args),
}));

vi.mock('../../lib/notification-service.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}));

vi.mock('../oxy-user.service.js', () => ({
  getProfiles: (...args: unknown[]) => getProfiles(...args),
}));

vi.mock('../catalog-hydration.service.js', () => ({
  // The variant is part of the chokepoint's contract, so it is carried into the
  // returned value rather than dropped — a thumbnail asked for at full size is
  // exactly the kind of regression a bare pass-through cannot see.
  resolveMedia: (value: string, variant?: string) => (variant ? `${value}:${variant}` : value),
}));

import { createReview, recomputeAggregate, listReviewsForStoreHandle } from '../review.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

/** A lean-query stub: `.lean()` resolves to `value`. */
function leanResolving(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

/** A `.select(...).lean()` chain stub resolving to `value`. */
function selectLeanResolving(value: unknown) {
  return { select: vi.fn().mockReturnValue(leanResolving(value)) };
}

/** The `Review.find(...).sort().skip().limit().lean()` chain. */
interface FindChain {
  sort: () => FindChain;
  skip: () => FindChain;
  limit: () => FindChain;
  lean: () => Promise<unknown>;
}

function findChainResolving(value: unknown): FindChain {
  const chain: FindChain = {
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: () => Promise.resolve(value),
  };
  return chain;
}

/** Empty `findListingChildren` result — images/options/memberships, keyed by listing id. */
function noChildren() {
  return { images: new Map(), options: new Map(), collectionIds: new Map() };
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueueRecomputeAggregate.mockResolvedValue(undefined);
  sendNotification.mockResolvedValue(undefined);
  getProfiles.mockResolvedValue(new Map());
  // recompute aggregate (called inline by createReview) — empty by default.
  reviewAggregate.mockResolvedValue([]);
  setListingRating.mockResolvedValue(undefined);
  storeUpdateOne.mockResolvedValue(undefined);
  sellerProfileUpdateOne.mockResolvedValue(undefined);
  // Default: target-owner notification lookups resolve to nothing.
  findListingById.mockResolvedValue(null);
  findListingChildren.mockResolvedValue(noChildren());
});

describe('review.service.createReview — verified-purchase gate', () => {
  it('rejects a listing review with NO matching order (FORBIDDEN)', async () => {
    orderFindOne.mockReturnValue(leanResolving(null));

    await expect(
      createReview('buyer-1', { targetType: 'listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );

    expect(reviewCreate).not.toHaveBeenCalled();
  });

  it('creates a listing review WITH a matching qualifying order', async () => {
    orderFindOne.mockReturnValue(leanResolving({ _id: 'order-1', buyerOxyUserId: 'buyer-1' }));
    reviewFindOne.mockReturnValue(leanResolving(null));
    const now = new Date();
    reviewCreate.mockResolvedValue({
      toObject: () => ({
        _id: 'review-1',
        authorOxyUserId: 'buyer-1',
        targetType: 'listing',
        listingId: 'listing-1',
        rating: 5,
        status: 'published',
        createdAt: now,
        updatedAt: now,
      }),
    });
    // owner notification: a user-owned listing → notify owner. A repository ROW,
    // flat and with `oxyUserId` NULL-able rather than absent.
    findListingById.mockResolvedValue({
      id: 'listing-1',
      ownerType: 'user',
      oxyUserId: 'seller-9',
      storeId: null,
      title: 'A thing',
    });

    const dto = await createReview('buyer-1', {
      targetType: 'listing',
      listingId: 'listing-1',
      rating: 5,
    });

    expect(reviewCreate).toHaveBeenCalledTimes(1);
    expect(dto.id).toBe('review-1');
    expect(dto.rating).toBe(5);
    expect(dto.targetType).toBe('listing');
    // drift-proof recompute enqueued.
    expect(enqueueRecomputeAggregate).toHaveBeenCalledWith({
      targetType: 'listing',
      targetId: 'listing-1',
    });
    // review_received fired to the listing owner (not the author).
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'seller-9', type: 'review_received' }),
    );
  });

  it('rejects a specific orderId that does not qualify (FORBIDDEN)', async () => {
    orderFindById.mockReturnValue(
      leanResolving({ _id: 'order-9', buyerOxyUserId: 'someone-else', status: 'paid', items: [] }),
    );

    await expect(
      createReview('buyer-1', {
        targetType: 'listing',
        listingId: 'listing-1',
        orderId: 'order-9',
        rating: 4,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
  });
});

describe('review.service.createReview — one review per target', () => {
  it('rejects when the buyer already reviewed the target (CONFLICT)', async () => {
    orderFindOne.mockReturnValue(leanResolving({ _id: 'order-1', buyerOxyUserId: 'buyer-1' }));
    reviewFindOne.mockReturnValue(leanResolving({ _id: 'existing-review' }));

    await expect(
      createReview('buyer-1', { targetType: 'listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    expect(reviewCreate).not.toHaveBeenCalled();
  });
});

describe('review.service.recomputeAggregate', () => {
  it('computes a rounded average + count and writes to the listing', async () => {
    reviewAggregate.mockResolvedValue([{ avg: 4.5, count: 2 }]);

    const result = await recomputeAggregate('listing', 'listing-1');

    expect(result).toEqual({ rating: 4.5, reviewCount: 2 });
    // The listing write is no longer a `{$set: …}` update document — the
    // repository takes the two values as arguments, so the assertion is about
    // WHICH values the service derived and handed over.
    expect(setListingRating).toHaveBeenCalledWith('listing-1', 4.5, 2);
  });

  it('writes to the store for a store target', async () => {
    reviewAggregate.mockResolvedValue([{ avg: 4, count: 3 }]);

    const result = await recomputeAggregate('store', 'store-1');

    expect(result).toEqual({ rating: 4, reviewCount: 3 });
    expect(storeUpdateOne).toHaveBeenCalledWith(
      { _id: 'store-1' },
      { $set: { rating: 4, reviewCount: 3 } },
    );
    // Stores are still Mongo, so a store target must NOT reach the listing write.
    expect(setListingRating).not.toHaveBeenCalled();
  });

  it('upserts the seller profile for a seller target', async () => {
    reviewAggregate.mockResolvedValue([{ avg: 3.33, count: 6 }]);

    const result = await recomputeAggregate('seller', 'seller-1');

    expect(result).toEqual({ rating: 3.3, reviewCount: 6 });
    expect(sellerProfileUpdateOne).toHaveBeenCalledWith(
      { oxyUserId: 'seller-1' },
      { $set: { rating: 3.3, reviewCount: 6 } },
      { upsert: true },
    );
  });

  it('returns a zero aggregate when there are no published reviews', async () => {
    reviewAggregate.mockResolvedValue([]);

    const result = await recomputeAggregate('listing', 'listing-empty');

    expect(result).toEqual({ rating: 0, reviewCount: 0 });
    expect(setListingRating).toHaveBeenCalledWith('listing-empty', 0, 0);
  });
});

describe('review.service.listReviewsForStoreHandle', () => {
  it('builds each card from the listing ROW and its images child table', async () => {
    /**
     * The store review page is where the listing's new shape shows: the store's
     * listing ids come from `findListingIdsByStore`, the rows come back FLAT
     * (`id`, not `_id`) and carry no `images` at all — the gallery is a child
     * table read once for the whole page by `findListingChildren`.
     */
    const now = new Date();
    storeFindOne.mockReturnValue(selectLeanResolving({ _id: 'store-1' }));
    findListingIdsByStore.mockResolvedValue(['listing-1', 'listing-2']);
    reviewFind.mockReturnValue(
      findChainResolving([
        {
          _id: 'review-1',
          authorOxyUserId: 'buyer-1',
          targetType: 'listing',
          listingId: 'listing-1',
          rating: 5,
          status: 'published',
          createdAt: now,
          updatedAt: now,
        },
      ]),
    );
    reviewCountDocuments.mockResolvedValue(1);
    findListingsByIds.mockResolvedValue([{ id: 'listing-1', title: 'A thing' }]);
    findListingChildren.mockResolvedValue({
      // Deliberately NOT position 0 first — the service picks the lowest position
      // rather than trusting the array order it happened to get.
      images: new Map([
        [
          'listing-1',
          [
            { listingId: 'listing-1', fileId: 'file-second', alt: null, position: 1 },
            { listingId: 'listing-1', fileId: 'file-first', alt: null, position: 0 },
          ],
        ],
      ]),
      options: new Map(),
      collectionIds: new Map(),
    });

    const page = await listReviewsForStoreHandle('a-store', { page: 1, limit: 20 });

    expect(findListingIdsByStore).toHaveBeenCalledWith('store-1');
    expect(findListingChildren).toHaveBeenCalledWith(['listing-1']);
    expect(page.total).toBe(1);
    expect(page.data[0].product).toEqual({
      id: 'listing-1',
      title: 'A thing',
      // Through the media chokepoint, at the thumbnail variant.
      imageUrl: 'file-first:thumb',
    });
  });

  it('rejects an unknown handle with NOT_FOUND', async () => {
    storeFindOne.mockReturnValue(selectLeanResolving(null));

    await expect(
      listReviewsForStoreHandle('no-such-store', { page: 1, limit: 20 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
    expect(findListingIdsByStore).not.toHaveBeenCalled();
  });

  it('returns an empty page when the store has no listings (no review query)', async () => {
    storeFindOne.mockReturnValue(selectLeanResolving({ _id: 'store-empty' }));
    findListingIdsByStore.mockResolvedValue([]);

    const page = await listReviewsForStoreHandle('a-store', { page: 1, limit: 20 });

    expect(page).toEqual({ data: [], total: 0 });
    expect(reviewFind).not.toHaveBeenCalled();
  });
});
