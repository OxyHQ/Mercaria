/**
 * `review-migration.service` — the classification job's decision table.
 *
 * The load-bearing property is not what it classifies; it is what it REFUSES to
 * classify. #76 migration rule 1 asks for classification "without guessing
 * ambiguous records", and the two cases most tempting to guess are the ones
 * pinned hardest here:
 *
 *  - a **listing** review is NOT promoted to `product`. Mercaria cannot know
 *    whether the author meant the model or the copy that arrived, and reading it
 *    as a product review would put "arrived scratched" on a canonical product's
 *    quality rating — acceptance criterion 1, failed by exactly that inference;
 *  - a **store** review with no merchant link is LEFT where it is, with the
 *    missing fact recorded, and the legacy read path keeps serving it unchanged.
 *
 * Every decision appends a `review_target_migrations` row in the same
 * transaction as the change, so this also asserts that the audit and the move
 * travel together.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const classifyReview = vi.fn();
const markReviewAmbiguous = vi.fn();
const findUnclassifiedLegacyReviews = vi.fn();
const findAmbiguousReviews = vi.fn();
const assignReviewToCanonicalProduct = vi.fn();
const recordTargetMigration = vi.fn();
const findMerchantIdForStore = vi.fn();
const rebuildScopedAggregate = vi.fn();
const transaction = vi.fn();

vi.mock('../../../db/reviews/reviewRepository.js', () => ({
  classifyReview: (...args: unknown[]) => classifyReview(...args),
  markReviewAmbiguous: (...args: unknown[]) => markReviewAmbiguous(...args),
  findUnclassifiedLegacyReviews: (...args: unknown[]) => findUnclassifiedLegacyReviews(...args),
  findAmbiguousReviews: (...args: unknown[]) => findAmbiguousReviews(...args),
  assignReviewToCanonicalProduct: (...args: unknown[]) => assignReviewToCanonicalProduct(...args),
}));

vi.mock('../../../db/reviews/reviewMigrationRepository.js', () => ({
  recordTargetMigration: (...args: unknown[]) => recordTargetMigration(...args),
}));

vi.mock('../../../db/reviews/reviewTargetResolver.js', () => ({
  findMerchantIdForStore: (...args: unknown[]) => findMerchantIdForStore(...args),
}));

vi.mock('../review-aggregate.service.js', () => ({
  rebuildScopedAggregate: (...args: unknown[]) => rebuildScopedAggregate(...args),
}));

vi.mock('../../../db/postgres.js', () => ({
  getDb: () => ({ transaction: (...args: unknown[]) => transaction(...args) }),
}));

/**
 * The transaction handle the pass-through mock hands the code under test.
 *
 * A plain string would not satisfy `DatabaseOrTransaction`, and these tests are
 * about WHICH handle each write receives — that the audit row and the change go
 * through the SAME one — rather than about what it can do. A named sentinel
 * keeps that assertion readable and keeps the mock honestly typed.
 */
const TX = { __tx: 'review-migration-test' } as unknown as DatabaseOrTransaction;

import {
  assignReviewOnSplit,
  classifyLegacyReviews,
} from '../review-migration.service.js';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';
import { isMercariaError } from '../../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../../utils/api-response.js';

const AT = new Date('2026-01-01T00:00:00.000Z');

/** A LEGACY review row, unclassified, as the repository returns it. */
function legacyReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-1',
    authorOxyUserId: 'buyer-1',
    targetType: 'listing',
    scope: null,
    listingId: 'listing-1',
    storeId: null,
    sellerOxyUserId: null,
    canonicalProductId: null,
    merchantId: null,
    orderItemId: null,
    orderId: null,
    eligibilityId: null,
    verification: 'unverified',
    rating: 4,
    title: null,
    body: null,
    locale: null,
    incentiveDisclosure: 'none',
    status: 'published',
    editedAt: null,
    classificationState: 'unclassified',
    ambiguityReason: null,
    targetKey: 'listing-1|||||',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The transaction is a pass-through: these tests are about the DECISION, and
  // that the audit row is written with the same handle as the change.
  transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  classifyReview.mockResolvedValue(true);
  markReviewAmbiguous.mockResolvedValue(true);
  recordTargetMigration.mockResolvedValue({});
  rebuildScopedAggregate.mockResolvedValue({ aggregate: {}, drift: null });
  findAmbiguousReviews.mockResolvedValue([]);
});

describe('classifyLegacyReviews — the decision table', () => {
  it('classifies a SELLER review as p2p_seller — the target IS an Oxy seller id', async () => {
    findUnclassifiedLegacyReviews.mockResolvedValue([
      legacyReview({ targetType: 'seller', listingId: null, sellerOxyUserId: 'seller-9' }),
    ]);

    const report = await classifyLegacyReviews();

    expect(classifyReview).toHaveBeenCalledWith(
      'review-1',
      { scope: 'p2p_seller', targetType: 'seller', targetId: 'seller-9' },
      TX,
    );
    expect(report.classified).toBe(1);
    expect(report.ambiguous).toBe(0);
  });

  it('classifies a LISTING review as p2p_listing and NEVER as product', async () => {
    // The guess this job exists not to make. A legacy listing review was written
    // about one seller's item; reading it as a product review is how "arrived
    // scratched" would become a defect of the model (acceptance criterion 1).
    findUnclassifiedLegacyReviews.mockResolvedValue([legacyReview()]);

    await classifyLegacyReviews();

    expect(classifyReview).toHaveBeenCalledTimes(1);
    const target = classifyReview.mock.calls[0][1];
    expect(target.scope).toBe('p2p_listing');
    expect(target.scope).not.toBe('product');
    expect(target.targetType).toBe('listing');
  });

  it('classifies a STORE review as merchant when an ACTIVE link resolves it', async () => {
    findUnclassifiedLegacyReviews.mockResolvedValue([
      legacyReview({ targetType: 'store', listingId: null, storeId: 'store-1' }),
    ]);
    findMerchantIdForStore.mockResolvedValue('merch-1');

    await classifyLegacyReviews();

    expect(classifyReview).toHaveBeenCalledWith(
      'review-1',
      { scope: 'merchant', targetType: 'merchant', targetId: 'merch-1' },
      TX,
    );
    // The audit row records WHERE it came from — the store — which is the only
    // record left once `store_id` is cleared by the same statement.
    expect(recordTargetMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'classify',
        fromTargetType: 'store',
        fromTargetRef: 'store-1',
        toScope: 'merchant',
        toTargetRef: 'merch-1',
        actorKind: 'migration',
      }),
      TX,
    );
  });

  it('REFUSES a store review with no merchant link, and leaves it on its legacy target', async () => {
    // #76 migration rule 3. The review keeps reading exactly as it does today;
    // what changes is that the missing FACT is now recorded.
    findUnclassifiedLegacyReviews.mockResolvedValue([
      legacyReview({ targetType: 'store', listingId: null, storeId: 'store-1' }),
    ]);
    findMerchantIdForStore.mockResolvedValue(null);

    const report = await classifyLegacyReviews();

    expect(classifyReview).not.toHaveBeenCalled();
    expect(markReviewAmbiguous).toHaveBeenCalledWith(
      'review-1',
      'store_has_no_linked_merchant',
      TX,
    );
    expect(recordTargetMigration).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refuse_ambiguous', reason: 'store_has_no_linked_merchant' }),
      TX,
    );
    expect(report.ambiguous).toBe(1);
    expect(report.classified).toBe(0);
  });

  it('rebuilds each touched aggregate ONCE, after the classifications', async () => {
    // A classified review has moved between two aggregates; both are wrong until
    // they are derived again. Twice on the same target would be wasted work on a
    // shared Postgres, and the dedupe is what makes a 500-review batch bounded.
    findUnclassifiedLegacyReviews.mockResolvedValue([
      legacyReview({ id: 'r1', targetType: 'seller', listingId: null, sellerOxyUserId: 'seller-9' }),
      legacyReview({ id: 'r2', targetType: 'seller', listingId: null, sellerOxyUserId: 'seller-9' }),
    ]);

    await classifyLegacyReviews();

    expect(rebuildScopedAggregate).toHaveBeenCalledTimes(1);
    expect(rebuildScopedAggregate).toHaveBeenCalledWith('p2p_seller', 'seller-9');
  });

  it('reports hasMore when the batch filled its ceiling — the resumable half', async () => {
    findUnclassifiedLegacyReviews.mockResolvedValue([legacyReview()]);

    const report = await classifyLegacyReviews({ batchSize: 1 });

    expect(report.hasMore).toBe(true);
    expect(report.scanned).toBe(1);
  });

  it('does not stop the batch when one review fails', async () => {
    findUnclassifiedLegacyReviews.mockResolvedValue([
      legacyReview({ id: 'r1' }),
      legacyReview({ id: 'r2' }),
    ]);
    classifyReview.mockRejectedValueOnce(new Error('transient'));

    const report = await classifyLegacyReviews();

    // The failure left `r1` unclassified — nothing marked it done — so the next
    // run retries it, and `r2` was not held hostage by it.
    expect(report.classified).toBe(1);
  });

  it('a CAS that lost writes no audit row', async () => {
    // Two runs of the job racing: the loser's `classification_state` predicate
    // no longer matches, and it must not append a decision it did not make.
    findUnclassifiedLegacyReviews.mockResolvedValue([legacyReview()]);
    classifyReview.mockResolvedValue(false);

    const report = await classifyLegacyReviews();

    expect(recordTargetMigration).not.toHaveBeenCalled();
    expect(report.classified).toBe(0);
  });
});

/**
 * The `rehomeReviewsForProductMerge` block was DELETED with the function, whose
 * only caller was #56's direct `mergeCanonicalProducts` (#36 completion
 * criterion 4). #76 migration rule 4 still holds and is enforced one domain
 * over: `services/curation/merge-plan.ts` moves `reviews.canonical_product_id`
 * in the `reviews` phase and `merge-plan-census.test.ts` fails the build if that
 * column ever loses its disposition.
 *
 * Migration rule 5's MERGE half went with it and came back in #333: a review the
 * guard leaves on the tombstone is recorded by `runReviewsPhase` under
 * `rehome_merge`, so the duplicate-author case is findable rather than silent.
 * Its SPLIT half is `assignReviewOnSplit` below, which is still this domain's.
 */

describe('assignReviewOnSplit — #76 migration rule 5', () => {
  it('moves ONE review and records the OPERATOR who decided', async () => {
    // A split cannot be inferred, so the only record that it happened is a row
    // naming the person who said so.
    assignReviewToCanonicalProduct.mockResolvedValue(true);

    await assignReviewOnSplit({
      reviewId: 'r1',
      fromCanonicalProductId: 'old',
      toCanonicalProductId: 'new',
      actorOxyUserId: 'operator-1',
      reason: 'the review describes the 512GB model',
    });

    expect(recordTargetMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'assign_split',
        actorKind: 'operator',
        actorOxyUserId: 'operator-1',
        fromTargetRef: 'old',
        toTargetRef: 'new',
      }),
      TX,
    );
    // BOTH products' aggregates are now wrong; deriving them again is the repair.
    expect(rebuildScopedAggregate).toHaveBeenCalledWith('product', 'old');
    expect(rebuildScopedAggregate).toHaveBeenCalledWith('product', 'new');
  });

  it('refuses an assignment with no stated reason', async () => {
    await expect(
      assignReviewOnSplit({
        reviewId: 'r1',
        fromCanonicalProductId: 'old',
        toCanonicalProductId: 'new',
        actorOxyUserId: 'operator-1',
        reason: '   ',
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.VALIDATION_ERROR,
    );
    expect(assignReviewToCanonicalProduct).not.toHaveBeenCalled();
  });

  it('refuses a stale decision — the review is no longer on the named product', async () => {
    // An operator acting on a page rendered before somebody else moved the
    // review must change nothing.
    assignReviewToCanonicalProduct.mockResolvedValue(false);

    await expect(
      assignReviewOnSplit({
        reviewId: 'r1',
        fromCanonicalProductId: 'old',
        toCanonicalProductId: 'new',
        actorOxyUserId: 'operator-1',
        reason: 'moved',
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
    expect(recordTargetMigration).not.toHaveBeenCalled();
    expect(rebuildScopedAggregate).not.toHaveBeenCalled();
  });
});
