/**
 * Unit tests for `review.service`.
 *
 * Every store the service touches is Postgres now, so the repositories are
 * mocked rather than a Mongoose model — `db/buyers/reviewRepository` in place of
 * `Review`, alongside the listing, store, order and seller-profile repositories.
 * The queue producer, the notification service and the Oxy/media hydration are
 * mocked too.
 *
 * These tests pin the service's LOGIC: the verified-purchase gate (no qualifying
 * order → FORBIDDEN; qualifying order → created), one-review-per-target (existing
 * review → CONFLICT, and the unique-index refusal mapped to the same CONFLICT),
 * that `createReview` hands the repository ONE target rather than three
 * half-filled columns, that `recomputeAggregate` derives + persists
 * `{rating, reviewCount}` per target, and that a store's review page builds each
 * card's product context from the listing ROW plus its images child table.
 *
 * What a mocked repository CANNOT see — that the target-exclusivity CHECK really
 * refuses a two-target row, and that the aggregate really excludes `hidden`
 * reviews rather than returning nothing at all — is in
 * `db/__tests__/buyers.realdb.test.ts` against a real server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const aggregatePublishedReviews = vi.fn();
const authorHasReviewedTarget = vi.fn();
const findListingReviewsPage = vi.fn();
const findReviewsPage = vi.fn();
const insertReview = vi.fn();
const buyerHasOrderForListing = vi.fn();
const buyerHasOrderFromSeller = vi.fn();
const findOrderById = vi.fn();
const setListingRating = vi.fn();
const findListingById = vi.fn();
const findListingIdsByStore = vi.fn();
const findListingsByIds = vi.fn();
const findListingChildren = vi.fn();
const setStoreRating = vi.fn();
const findStoreByHandle = vi.fn();
const findStoreById = vi.fn();
const setSellerRating = vi.fn();
const enqueueRecomputeAggregate = vi.fn();
const sendNotification = vi.fn();
const getProfiles = vi.fn();

vi.mock('../../db/buyers/reviewRepository.js', () => ({
  aggregatePublishedReviews: (...args: unknown[]) => aggregatePublishedReviews(...args),
  authorHasReviewedTarget: (...args: unknown[]) => authorHasReviewedTarget(...args),
  findListingReviewsPage: (...args: unknown[]) => findListingReviewsPage(...args),
  findReviewsPage: (...args: unknown[]) => findReviewsPage(...args),
  insertReview: (...args: unknown[]) => insertReview(...args),
}));

vi.mock('../../db/orders/orderRepository.js', () => ({
  buyerHasOrderForListing: (...args: unknown[]) => buyerHasOrderForListing(...args),
  buyerHasOrderFromSeller: (...args: unknown[]) => buyerHasOrderFromSeller(...args),
  findOrderById: (...args: unknown[]) => findOrderById(...args),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  setListingRating: (...args: unknown[]) => setListingRating(...args),
  findListingById: (...args: unknown[]) => findListingById(...args),
  findListingIdsByStore: (...args: unknown[]) => findListingIdsByStore(...args),
  findListingsByIds: (...args: unknown[]) => findListingsByIds(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  setStoreRating: (...args: unknown[]) => setStoreRating(...args),
  findStoreById: (...args: unknown[]) => findStoreById(...args),
  findStoreByHandle: (...args: unknown[]) => findStoreByHandle(...args),
}));

vi.mock('../../db/buyers/sellerProfileRepository.js', () => ({
  setSellerRating: (...args: unknown[]) => setSellerRating(...args),
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

/** Every row fixture carries the same timestamps; none of them is asserted on. */
const AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * A `reviews` ROW as the repository returns it: flat, `id` rather than `_id`, and
 * the two target columns this review does NOT name arriving as NULL rather than
 * absent — which is what the DTO serializer has to keep off the wire.
 */
function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-1',
    authorOxyUserId: 'buyer-1',
    targetType: 'listing',
    listingId: 'listing-1',
    storeId: null,
    sellerOxyUserId: null,
    orderId: null,
    rating: 5,
    title: null,
    body: null,
    status: 'published',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** Empty `findListingChildren` result — images/options/memberships, keyed by listing id. */
function noChildren() {
  return { images: new Map(), options: new Map(), collectionIds: new Map() };
}

/** The driver error a partial unique index raises, as postgres.js surfaces it. */
function uniqueViolation(constraint: string): Error & { code: string; constraint_name: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint_name: constraint,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueueRecomputeAggregate.mockResolvedValue(undefined);
  sendNotification.mockResolvedValue(undefined);
  getProfiles.mockResolvedValue(new Map());
  // recompute aggregate (called inline by createReview) — an unrated target by
  // default: no published reviews, so no average to round.
  aggregatePublishedReviews.mockResolvedValue({ average: null, count: 0 });
  setListingRating.mockResolvedValue(undefined);
  setStoreRating.mockResolvedValue(undefined);
  setSellerRating.mockResolvedValue(undefined);
  // Default: the buyer has no qualifying purchase; each test opts in.
  buyerHasOrderForListing.mockResolvedValue(false);
  buyerHasOrderFromSeller.mockResolvedValue(false);
  // Default: the buyer has not reviewed this target before.
  authorHasReviewedTarget.mockResolvedValue(false);
  // Default: target-owner notification lookups resolve to nothing.
  findListingById.mockResolvedValue(null);
  findListingChildren.mockResolvedValue(noChildren());
});

describe('review.service.createReview — verified-purchase gate', () => {
  it('rejects a listing review with NO matching order (FORBIDDEN)', async () => {
    // The listing case is a join to `order_items`, answered as a boolean rather
    // than by materializing an order the caller never reads.
    buyerHasOrderForListing.mockResolvedValue(false);

    await expect(
      createReview('buyer-1', { targetType: 'listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );

    expect(insertReview).not.toHaveBeenCalled();
  });

  it('creates a listing review WITH a matching qualifying order', async () => {
    buyerHasOrderForListing.mockResolvedValue(true);
    insertReview.mockResolvedValue(reviewRow());
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

    // ONE target, not three columns: `reviews_target_exclusivity_check` refuses a
    // row naming two, so the service must never hand the repository more than it
    // resolved from the input.
    expect(insertReview).toHaveBeenCalledTimes(1);
    expect(insertReview).toHaveBeenCalledWith({
      authorOxyUserId: 'buyer-1',
      targetType: 'listing',
      targetId: 'listing-1',
      rating: 5,
    });

    expect(dto.id).toBe('review-1');
    expect(dto.rating).toBe(5);
    expect(dto.targetType).toBe('listing');
    // The NULL target columns stay OFF the DTO rather than arriving as nulls.
    expect(dto.storeId).toBeUndefined();
    expect(dto.sellerOxyUserId).toBeUndefined();
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
    findOrderById.mockResolvedValue({
      id: 'order-9',
      buyerOxyUserId: 'someone-else',
      status: 'paid',
      items: [],
    });

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
    buyerHasOrderForListing.mockResolvedValue(true);
    authorHasReviewedTarget.mockResolvedValue(true);

    await expect(
      createReview('buyer-1', { targetType: 'listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    expect(insertReview).not.toHaveBeenCalled();
    // The pre-check reads the target as a whole, not a status-filtered slice: a
    // review a jury HID still counts as already-reviewed.
    expect(authorHasReviewedTarget).toHaveBeenCalledWith('buyer-1', {
      targetType: 'listing',
      targetId: 'listing-1',
    });
  });

  it('maps the partial unique index refusal to the same CONFLICT', async () => {
    // Two concurrent submissions both pass the pre-check; the index refuses the
    // second. Without this mapping that arrives as a 500 on an ordinary
    // double-submit.
    buyerHasOrderForListing.mockResolvedValue(true);
    insertReview.mockRejectedValue(uniqueViolation('reviews_author_oxy_user_id_listing_id_key'));

    await expect(
      createReview('buyer-1', { targetType: 'listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
  });

  it('does NOT swallow an unrelated constraint violation', async () => {
    // The mapping above is scoped to one constraint on purpose: a foreign-key
    // refusal on `order_id` is a different bug and must not read as "already
    // reviewed".
    buyerHasOrderForListing.mockResolvedValue(true);
    const other = uniqueViolation('reviews_something_else_key');
    insertReview.mockRejectedValue(other);

    await expect(
      createReview('buyer-1', { targetType: 'listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toBe(other);
  });
});

describe('review.service.recomputeAggregate', () => {
  it('computes a rounded average + count and writes to the listing', async () => {
    aggregatePublishedReviews.mockResolvedValue({ average: 4.5, count: 2 });

    const result = await recomputeAggregate('listing', 'listing-1');

    expect(result).toEqual({ rating: 4.5, reviewCount: 2 });
    // The aggregate is asked for ONE target, by type and id — the repository owns
    // which of the three columns that is.
    expect(aggregatePublishedReviews).toHaveBeenCalledWith({
      targetType: 'listing',
      targetId: 'listing-1',
    });
    // The listing write takes the two values as arguments, so the assertion is
    // about WHICH values the service derived and handed over.
    expect(setListingRating).toHaveBeenCalledWith('listing-1', 4.5, 2);
  });

  it('writes to the store for a store target', async () => {
    aggregatePublishedReviews.mockResolvedValue({ average: 4, count: 3 });

    const result = await recomputeAggregate('store', 'store-1');

    expect(result).toEqual({ rating: 4, reviewCount: 3 });
    expect(setStoreRating).toHaveBeenCalledWith('store-1', 4, 3);
    // A store target must NOT reach the listing write.
    expect(setListingRating).not.toHaveBeenCalled();
  });

  it('upserts the seller profile for a seller target', async () => {
    aggregatePublishedReviews.mockResolvedValue({ average: 3.33, count: 6 });

    const result = await recomputeAggregate('seller', 'seller-1');

    expect(result).toEqual({ rating: 3.3, reviewCount: 6 });
    // Upserting: a seller's first review can arrive before anything else has
    // created their profile, which the repository's ON CONFLICT handles.
    expect(setSellerRating).toHaveBeenCalledWith('seller-1', 3.3, 6);
  });

  it('returns a zero aggregate when there are no published reviews', async () => {
    // `average: null` is how the repository says "nothing to average", which is
    // NOT the same fact as an average of zero — the zero written here is the
    // service's decision, not an aggregate result.
    aggregatePublishedReviews.mockResolvedValue({ average: null, count: 0 });

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
    findStoreByHandle.mockResolvedValue({ id: 'store-1', handle: 'a-store' });
    findListingIdsByStore.mockResolvedValue(['listing-1', 'listing-2']);
    findListingReviewsPage.mockResolvedValue({ rows: [reviewRow()], total: 1 });
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
    // The whole store's listing ids go to the review query in ONE `inArray`; only
    // the listings actually reviewed are hydrated afterwards.
    expect(findListingReviewsPage).toHaveBeenCalledWith(['listing-1', 'listing-2'], 1, 20);
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
    findStoreByHandle.mockResolvedValue(null);

    await expect(
      listReviewsForStoreHandle('no-such-store', { page: 1, limit: 20 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
    expect(findListingIdsByStore).not.toHaveBeenCalled();
  });

  it('returns an empty page when the store has no listings (no review query)', async () => {
    findStoreByHandle.mockResolvedValue({ id: 'store-empty', handle: 'empty-store' });
    findListingIdsByStore.mockResolvedValue([]);

    const page = await listReviewsForStoreHandle('a-store', { page: 1, limit: 20 });

    expect(page).toEqual({ data: [], total: 0 });
    expect(findListingReviewsPage).not.toHaveBeenCalled();
  });
});
