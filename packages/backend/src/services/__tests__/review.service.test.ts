/**
 * Unit tests for `review.service`.
 *
 * `mongodb-memory-server` is not available, so the Review/Order/Listing/Store/
 * SellerProfile models, the queue producer, the notification service, and the
 * Oxy/media hydration are mocked. Tests assert the F5 contract: the
 * verified-purchase gate (no qualifying order → FORBIDDEN; qualifying order →
 * created), one-review-per-target (existing review → CONFLICT), and that
 * `recomputeAggregate` derives + persists `{ rating, reviewCount }` per target.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const reviewFindOne = vi.fn();
const reviewCreate = vi.fn();
const reviewAggregate = vi.fn();
const reviewFind = vi.fn();
const reviewCountDocuments = vi.fn();
const orderFindOne = vi.fn();
const orderFindById = vi.fn();
const listingUpdateOne = vi.fn();
const listingFindById = vi.fn();
const storeUpdateOne = vi.fn();
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

vi.mock('../../models/listing.js', () => ({
  Listing: {
    updateOne: (...args: unknown[]) => listingUpdateOne(...args),
    findById: (...args: unknown[]) => listingFindById(...args),
  },
}));

vi.mock('../../models/store.js', () => ({
  Store: {
    updateOne: (...args: unknown[]) => storeUpdateOne(...args),
    findById: vi.fn(),
    findOne: vi.fn(),
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
  resolveMedia: (value: string) => value,
}));

import { createReview, recomputeAggregate } from '../review.service.js';
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

beforeEach(() => {
  vi.clearAllMocks();
  enqueueRecomputeAggregate.mockResolvedValue(undefined);
  sendNotification.mockResolvedValue(undefined);
  getProfiles.mockResolvedValue(new Map());
  // recompute aggregate (called inline by createReview) — empty by default.
  reviewAggregate.mockResolvedValue([]);
  listingUpdateOne.mockResolvedValue(undefined);
  storeUpdateOne.mockResolvedValue(undefined);
  sellerProfileUpdateOne.mockResolvedValue(undefined);
  // Default: target-owner notification lookups resolve to nothing.
  listingFindById.mockReturnValue(selectLeanResolving(null));
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
    // owner notification: a user-owned listing → notify owner.
    listingFindById.mockReturnValue(
      selectLeanResolving({ ownerType: 'user', oxyUserId: 'seller-9' }),
    );

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
    expect(listingUpdateOne).toHaveBeenCalledWith(
      { _id: 'listing-1' },
      { $set: { rating: 4.5, reviewCount: 2 } },
    );
  });

  it('writes to the store for a store target', async () => {
    reviewAggregate.mockResolvedValue([{ avg: 4, count: 3 }]);

    const result = await recomputeAggregate('store', 'store-1');

    expect(result).toEqual({ rating: 4, reviewCount: 3 });
    expect(storeUpdateOne).toHaveBeenCalledWith(
      { _id: 'store-1' },
      { $set: { rating: 4, reviewCount: 3 } },
    );
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
    expect(listingUpdateOne).toHaveBeenCalledWith(
      { _id: 'listing-empty' },
      { $set: { rating: 0, reviewCount: 0 } },
    );
  });
});
