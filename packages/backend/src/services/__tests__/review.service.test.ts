/**
 * Unit tests for `review.service` after #76.
 *
 * Every store the service touches is Postgres, so the repositories are mocked —
 * `db/reviews/*` alongside the listing, store, order and seller-profile ones.
 * The queue producer, the notification service and the Oxy/media hydration are
 * mocked too.
 *
 * These tests pin the service's LOGIC: that a scoped write spends the right
 * eligibility and is written `verified_purchase`, that a write with none is
 * written `unverified` rather than refused, that a self-review is refused
 * through BOTH detection layers, that one review per scoped target holds through
 * the pre-check AND through the index refusal, that a forbidden scope and a
 * cross-scope dimension are both refused BY NAME, and that a store's review page
 * builds each card's product context from the listing ROW plus its images child
 * table.
 *
 * What a mocked repository CANNOT see — that the exclusivity CHECK really
 * refuses a two-target row, that the partial uniques really refuse a duplicate,
 * that the append-only trigger really refuses an UPDATE — is in
 * `db/__tests__/review-scopes.realdb.test.ts` against a real server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const aggregatePublishedReviews = vi.fn();
const authorHasReviewedTarget = vi.fn();
const findDimensionsForReviews = vi.fn();
const findListingReviewsPage = vi.fn();
const findReviewsPage = vi.fn();
const findScopedReviewsPage = vi.fn();
const insertReview = vi.fn();
const consumeEligibility = vi.fn();
const resolveEligibilityToSpend = vi.fn();
const rebuildScopedAggregate = vi.fn();
const getOrBuildScopedAggregate = vi.fn();
const assertNotSelfPurchase = vi.fn();
const assertNotSelfTarget = vi.fn();
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

vi.mock('../../db/reviews/reviewRepository.js', () => ({
  aggregatePublishedReviews: (...args: unknown[]) => aggregatePublishedReviews(...args),
  authorHasReviewedTarget: (...args: unknown[]) => authorHasReviewedTarget(...args),
  findDimensionsForReviews: (...args: unknown[]) => findDimensionsForReviews(...args),
  findListingReviewsPage: (...args: unknown[]) => findListingReviewsPage(...args),
  findReviewsPage: (...args: unknown[]) => findReviewsPage(...args),
  findScopedReviewsPage: (...args: unknown[]) => findScopedReviewsPage(...args),
  insertReview: (...args: unknown[]) => insertReview(...args),
}));

vi.mock('../../db/reviews/reviewEligibilityRepository.js', () => ({
  consumeEligibility: (...args: unknown[]) => consumeEligibility(...args),
}));

vi.mock('../reviews/review-eligibility.service.js', () => ({
  resolveEligibilityToSpend: (...args: unknown[]) => resolveEligibilityToSpend(...args),
}));

vi.mock('../reviews/review-aggregate.service.js', () => ({
  rebuildScopedAggregate: (...args: unknown[]) => rebuildScopedAggregate(...args),
  getOrBuildScopedAggregate: (...args: unknown[]) => getOrBuildScopedAggregate(...args),
}));

vi.mock('../reviews/review-self-review.js', () => ({
  assertNotSelfPurchase: (...args: unknown[]) => assertNotSelfPurchase(...args),
  assertNotSelfTarget: (...args: unknown[]) => assertNotSelfTarget(...args),
}));

vi.mock('../../db/orders/orderRepository.js', () => ({
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
 * A `reviews` ROW as the repository returns it: flat, `id` rather than `_id`,
 * and the five target columns this review does NOT name arriving as NULL rather
 * than absent — which is what the DTO serializer has to keep off the wire.
 */
function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-1',
    authorOxyUserId: 'buyer-1',
    targetType: 'listing',
    scope: 'p2p_listing',
    listingId: 'listing-1',
    storeId: null,
    sellerOxyUserId: null,
    canonicalProductId: null,
    merchantId: null,
    orderItemId: null,
    orderId: null,
    eligibilityId: null,
    verification: 'unverified',
    rating: 5,
    title: null,
    body: null,
    locale: null,
    incentiveDisclosure: 'none',
    status: 'published',
    publishedAt: AT,
    editedAt: null,
    classificationState: 'native',
    ambiguityReason: null,
    targetKey: 'listing-1|||||',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** An OPEN eligibility for a `p2p_listing` target, as the repository returns it. */
function eligibilityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'elig-1',
    oxyUserId: 'buyer-1',
    orderId: 'order-1',
    orderItemId: 'line-1',
    scope: 'p2p_listing',
    targetType: 'listing',
    listingId: 'listing-1',
    storeId: null,
    sellerOxyUserId: null,
    canonicalProductId: null,
    merchantId: null,
    targetOrderItemId: null,
    evidenceType: 'authenticated_purchase',
    claimId: null,
    state: 'open',
    consumedAt: null,
    revokedAt: null,
    revokedReason: null,
    disputedAt: null,
    policyVersion: '2026-08-09.1',
    createdAt: AT,
    updatedAt: AT,
    targetKey: 'listing-1|||||',
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
  findDimensionsForReviews.mockResolvedValue([]);
  rebuildScopedAggregate.mockResolvedValue({ aggregate: {}, drift: null });
  assertNotSelfPurchase.mockResolvedValue(undefined);
  assertNotSelfTarget.mockResolvedValue(undefined);
  consumeEligibility.mockResolvedValue(true);
  // Default: the buyer has NO eligibility for this target. Each test opts in.
  resolveEligibilityToSpend.mockResolvedValue(null);
  // Legacy recompute (still reachable from the sweep) — an unrated target.
  aggregatePublishedReviews.mockResolvedValue({ average: null, count: 0 });
  setListingRating.mockResolvedValue(undefined);
  setStoreRating.mockResolvedValue(undefined);
  setSellerRating.mockResolvedValue(undefined);
  authorHasReviewedTarget.mockResolvedValue(false);
  findListingById.mockResolvedValue(null);
  findListingChildren.mockResolvedValue(noChildren());
});

describe('review.service.createReview — scope and dimension gates', () => {
  it('refuses a brand rating BY NAME, and never reaches the repository', async () => {
    // The prohibition #76 is built around: a brand rating computed by averaging
    // product reviews. The refusal has to name it, because "unrecognized value"
    // reads like a typo and teaches whoever hit it to look for one.
    await expect(
      createReview('buyer-1', {
        // A caller reaching for a scope that does not exist. The union forbids it
        // at compile time, which is the point — this asserts the RUNTIME refusal
        // an untyped HTTP body would hit.
        scope: 'brand' as unknown as 'product',
        canonicalProductId: 'prod-1',
        rating: 5,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMercariaError(err) &&
        err.code === ErrorCodes.VALIDATION_ERROR &&
        err.message.includes('brand'),
    );

    expect(insertReview).not.toHaveBeenCalled();
  });

  it("refuses a merchant dimension on a product review, naming the scope's own set", async () => {
    // Acceptance criterion 1, at the sub-rating grain: a delivery complaint has
    // nowhere to land on a product's quality.
    await expect(
      createReview('buyer-1', {
        scope: 'product',
        canonicalProductId: 'prod-1',
        rating: 5,
        dimensions: [{ key: 'delivery_speed', rating: 1 }],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMercariaError(err) &&
        err.code === ErrorCodes.VALIDATION_ERROR &&
        err.message.includes('delivery_speed') &&
        err.message.includes('quality'),
    );

    expect(insertReview).not.toHaveBeenCalled();
  });

  it('accepts a dimension that DOES belong to the scope', async () => {
    // The negative above is only meaningful beside this: a gate that refused
    // every dimension would pass that test and be useless.
    insertReview.mockResolvedValue(reviewRow({ scope: 'product', targetType: 'canonical_product' }));

    await createReview('buyer-1', {
      scope: 'product',
      canonicalProductId: 'prod-1',
      rating: 5,
      dimensions: [{ key: 'quality', rating: 5 }],
    });

    expect(insertReview).toHaveBeenCalledTimes(1);
    expect(insertReview.mock.calls[0][0]).toMatchObject({
      dimensions: [{ key: 'quality', rating: 5 }],
    });
  });
});

describe('review.service.createReview — eligibility and verification', () => {
  it('spends the eligibility and writes the review VERIFIED', async () => {
    resolveEligibilityToSpend.mockResolvedValue(eligibilityRow());
    insertReview.mockResolvedValue(
      reviewRow({ verification: 'verified_purchase', eligibilityId: 'elig-1', orderId: 'order-1' }),
    );

    const dto = await createReview('buyer-1', {
      scope: 'p2p_listing',
      listingId: 'listing-1',
      rating: 5,
    });

    // Spent BEFORE the write: the CAS is what makes two concurrent submissions
    // produce one winner, and the index is only the second wall.
    expect(consumeEligibility).toHaveBeenCalledWith('elig-1');
    expect(insertReview).toHaveBeenCalledTimes(1);
    expect(insertReview.mock.calls[0][0]).toMatchObject({
      scope: 'p2p_listing',
      targetType: 'listing',
      targetId: 'listing-1',
      verification: 'verified_purchase',
      eligibilityId: 'elig-1',
      orderId: 'order-1',
      classificationState: 'native',
    });
    expect(dto.verification).toBe('verified_purchase');
    // The scoped aggregate is derived inline so the immediate read is correct.
    expect(rebuildScopedAggregate).toHaveBeenCalledWith('p2p_listing', 'listing-1');
  });

  it('writes UNVERIFIED — not a refusal — when there is no eligibility', async () => {
    // Policy: an opinion from somebody Mercaria has no purchase record for may be
    // published, and the AGGREGATE is what keeps it from carrying a purchase's
    // weight (#76 verification rule 5). Refusing it here would put that weighting
    // decision in the wrong place.
    resolveEligibilityToSpend.mockResolvedValue(null);
    insertReview.mockResolvedValue(reviewRow({ verification: 'unverified' }));

    const dto = await createReview('buyer-1', {
      scope: 'p2p_listing',
      listingId: 'listing-1',
      rating: 5,
    });

    expect(consumeEligibility).not.toHaveBeenCalled();
    expect(insertReview.mock.calls[0][0]).toMatchObject({ verification: 'unverified' });
    expect(insertReview.mock.calls[0][0].eligibilityId).toBeUndefined();
    expect(dto.verification).toBe('unverified');
  });

  it('refuses when the eligibility was spent between resolve and consume', async () => {
    resolveEligibilityToSpend.mockResolvedValue(eligibilityRow());
    consumeEligibility.mockResolvedValue(false);

    await expect(
      createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    expect(insertReview).not.toHaveBeenCalled();
  });

  it('runs BOTH self-review layers, and the target layer even with no eligibility', async () => {
    resolveEligibilityToSpend.mockResolvedValue(null);
    insertReview.mockResolvedValue(reviewRow());

    await createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 });

    // No order to read, so layer 1 is skipped — and layer 2 still runs, which is
    // the whole reason the two are independent.
    expect(assertNotSelfPurchase).not.toHaveBeenCalled();
    expect(assertNotSelfTarget).toHaveBeenCalledWith('buyer-1', 'p2p_listing', 'listing-1');
  });

  it('runs the purchase layer when there IS an eligibility', async () => {
    resolveEligibilityToSpend.mockResolvedValue(eligibilityRow());
    insertReview.mockResolvedValue(reviewRow());

    await createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 });

    expect(assertNotSelfPurchase).toHaveBeenCalledWith('buyer-1', 'order-1');
    expect(assertNotSelfTarget).toHaveBeenCalledWith('buyer-1', 'p2p_listing', 'listing-1');
  });

  it('does not write when the self-review guard refuses', async () => {
    resolveEligibilityToSpend.mockResolvedValue(eligibilityRow());
    assertNotSelfTarget.mockRejectedValue(
      Object.assign(new Error('nope'), { code: ErrorCodes.FORBIDDEN, status: 403 }),
    );

    await expect(
      createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toThrow();

    // The eligibility must NOT be spent by a refused write — a self-review
    // attempt that burned the buyer's grant would cost them a legitimate one.
    expect(consumeEligibility).not.toHaveBeenCalled();
    expect(insertReview).not.toHaveBeenCalled();
  });
});

describe('review.service.createReview — one review per scoped target', () => {
  it('rejects when the buyer already reviewed the target (CONFLICT)', async () => {
    authorHasReviewedTarget.mockResolvedValue(true);

    await expect(
      createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 }),
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

  it('maps the SCOPED partial unique index refusal to the same CONFLICT', async () => {
    // Two concurrent submissions both pass the pre-check; the index refuses the
    // second. Without this mapping that arrives as a 500 on a double-submit.
    insertReview.mockRejectedValue(uniqueViolation('reviews_author_scope_target_key'));

    await expect(
      createReview('buyer-1', { scope: 'product', canonicalProductId: 'prod-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
  });

  it('maps the LEGACY listing index refusal to the same CONFLICT', async () => {
    // Still live: a `p2p_listing` review does not move `listing_id`, so both
    // indexes cover the row and either can be the one that fires.
    insertReview.mockRejectedValue(uniqueViolation('reviews_author_oxy_user_id_listing_id_key'));

    await expect(
      createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
  });

  it('maps the eligibility index refusal to its OWN conflict message', async () => {
    resolveEligibilityToSpend.mockResolvedValue(eligibilityRow());
    insertReview.mockRejectedValue(uniqueViolation('reviews_eligibility_id_key'));

    await expect(
      createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMercariaError(err) &&
        err.code === ErrorCodes.CONFLICT &&
        err.message.includes('eligibility'),
    );
  });

  it('does NOT swallow an unrelated constraint violation', async () => {
    // The mapping above is scoped to named constraints on purpose: a foreign-key
    // refusal on `order_id` is a different bug and must not read as "already
    // reviewed".
    const other = uniqueViolation('reviews_something_else_key');
    insertReview.mockRejectedValue(other);

    await expect(
      createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 }),
    ).rejects.toBe(other);
  });
});

describe('review.service.createReview — notifications', () => {
  it('notifies a P2P listing owner and never the author', async () => {
    insertReview.mockResolvedValue(reviewRow());
    findListingById.mockResolvedValue({
      id: 'listing-1',
      ownerType: 'user',
      oxyUserId: 'seller-9',
      storeId: null,
      title: 'A thing',
    });

    await createReview('buyer-1', { scope: 'p2p_listing', listingId: 'listing-1', rating: 5 });

    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'seller-9', type: 'review_received' }),
    );
  });

  it('notifies NOBODY for a product review — a canonical product has no owner', async () => {
    insertReview.mockResolvedValue(reviewRow({ scope: 'product', targetType: 'canonical_product' }));

    await createReview('buyer-1', { scope: 'product', canonicalProductId: 'prod-1', rating: 5 });

    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe('review.service.recomputeAggregate — the LEGACY path', () => {
  it('computes a rounded average + count and writes to the listing', async () => {
    aggregatePublishedReviews.mockResolvedValue({ average: 4.5, count: 2 });

    const result = await recomputeAggregate('listing', 'listing-1');

    expect(result).toEqual({ rating: 4.5, reviewCount: 2 });
    // The aggregate is asked for ONE target, by type and id — the repository owns
    // which of the six columns that is.
    expect(aggregatePublishedReviews).toHaveBeenCalledWith({
      targetType: 'listing',
      targetId: 'listing-1',
    });
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
    expect(setSellerRating).toHaveBeenCalledWith('seller-1', 3.3, 6);
  });

  it('writes NOTHING for a scoped target type', async () => {
    // The legacy work list excludes scoped rows, so reaching this is a bug in
    // that query. It must not write from the wrong query — a canonical product's
    // rating derived by the legacy aggregate would be the drift #76 exists to
    // prevent, dressed as a repair.
    aggregatePublishedReviews.mockResolvedValue({ average: 5, count: 9 });

    await recomputeAggregate('canonical_product', 'prod-1');

    expect(setListingRating).not.toHaveBeenCalled();
    expect(setStoreRating).not.toHaveBeenCalled();
    expect(setSellerRating).not.toHaveBeenCalled();
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
     * The store review page is where the listing's shape shows: the store's
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
