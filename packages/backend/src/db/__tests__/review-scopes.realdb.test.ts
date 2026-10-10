/**
 * Review scopes against a REAL PostgreSQL database — #76's acceptance criteria,
 * every one of which is held by a CHECK, a partial unique index, a generated
 * column or a trigger that does not exist under a mocked repository.
 *
 * A mocked `insert` accepts any statement, including one the server rejects
 * outright, so everything in this file is a property of the DDL rather than of
 * the code that happens to call it:
 *
 *  - **a scope and its target cannot disagree** — the CHECK pair, exercised by
 *    writing a product review that names a merchant;
 *  - **one review per author per scoped target** — the partial unique on the
 *    GENERATED `target_key`, which a plain multi-column unique could not hold
 *    because Postgres treats NULLs as distinct (acceptance 6, duplicates);
 *  - **an eligibility is granted once per (line, author, scope) and spent once**
 *    — two uniques, exercised as a replay and as a race (acceptance 3, 9, 11);
 *  - **a verified review must name its evidence, and an unverified one must
 *    not** — the biconditional CHECK, both directions;
 *  - **a claimed-guest eligibility cannot exist without a claim id** — the
 *    CHECK that makes the #109 seam structural (acceptance 8, 10);
 *  - **a hidden review leaves the aggregate** — through the real rebuild
 *    (acceptance 6, hidden review);
 *  - **a product merge rehomes reviews and rebuilds both aggregates**
 *    (acceptance 5), and a duplicate author is left rather than deleted;
 *  - **aggregate DRIFT is detected and corrected** — by corrupting a stored
 *    aggregate behind the service's back and re-deriving;
 *  - **the migration log refuses UPDATE and DELETE** — the append-only trigger.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every id this file writes carries a per-run suffix and
 * teardown deletes exactly what it created — children first, and the
 * append-only migration rows are deliberately NOT deleted (the trigger refuses),
 * so they are scoped by review id and left behind, the `ledger.realdb.test.ts`
 * rule.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { listings } from '../schema/catalog.js';
import { canonicalProducts } from '../schema/canonicalCatalog.js';
import { merchants } from '../schema/merchants.js';
import { orderItems, orders } from '../schema/orders.js';
import { stores } from '../schema/stores.js';
import { deleteTestStores } from './store-teardown.js';
import {
  reviewAggregates,
  reviewDimensionAggregates,
  reviewDimensions,
  reviewEligibilities,
  reviewHelpfulVotes,
  reviews,
  reviewTargetMigrations,
} from '../schema/reviews.js';
import {
  insertReview,
  setReviewStatusIfIn,
  readReviewRatingSummary,
  findReviewsPage,
  findScopedReviewsPage,
  findListingReviewsPage,
} from '../reviews/reviewRepository.js';
import { consumeEligibility, insertEligibility } from '../reviews/reviewEligibilityRepository.js';
import { findPurchasedVariantsForReviews } from '../reviews/reviewPurchaseContextRepository.js';
import { findReviewHelpfulness } from '../reviews/reviewHelpfulnessRepository.js';
import { updateReviewHelpfulness } from '../../services/reviews/review-helpfulness.service.js';
import { recordTargetMigration } from '../reviews/reviewMigrationRepository.js';
import { rebuildScopedAggregate } from '../../services/reviews/review-aggregate.service.js';
import { deleteTestCanonicalRows } from './canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdReviewIds: string[] = [];
/**
 * Reviews an append-only `review_target_migrations` row points at. The trigger
 * refuses to delete that row and the foreign key is RESTRICT, so these reviews
 * are UNDELETABLE by construction — which is the property under test. They are
 * scoped by the per-run id and left behind, the `ledger.realdb.test.ts` rule.
 */
const undeletableReviewIds = new Set<string>();
const createdProductIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];
const createdOrderIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  const deletableReviewIds = createdReviewIds.filter((id) => !undeletableReviewIds.has(id));
  if (deletableReviewIds.length > 0) {
    await db.delete(reviewDimensions).where(inArray(reviewDimensions.reviewId, deletableReviewIds));
    await db.delete(reviews).where(inArray(reviews.id, deletableReviewIds));
  }
  if (createdOrderIds.length > 0) {
    await db
      .delete(reviewEligibilities)
      .where(inArray(reviewEligibilities.orderId, createdOrderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, createdOrderIds));
    await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  }
  // `inArray`, never `= any(${jsArray})`: the latter binds a TUPLE and Postgres
  // refuses it with `op ANY/ALL (array) requires array on right side`, and an
  // EMPTY array renders `= any()`, a syntax error — CONVENTIONS.md, Naming.
  const aggregateIds: string[] = [];
  if (
    createdProductIds.length > 0 ||
    createdMerchantIds.length > 0 ||
    createdListingIds.length > 0
  ) {
    const rows = await db
      .select({ id: reviewAggregates.id })
      .from(reviewAggregates)
      .where(
        or(
          createdProductIds.length > 0
            ? inArray(reviewAggregates.canonicalProductId, createdProductIds)
            : undefined,
          createdMerchantIds.length > 0
            ? inArray(reviewAggregates.merchantId, createdMerchantIds)
            : undefined,
          createdListingIds.length > 0
            ? inArray(reviewAggregates.listingId, createdListingIds)
            : undefined,
        ),
      );
    aggregateIds.push(...rows.map((row) => row.id));
  }
  if (aggregateIds.length > 0) {
    await db
      .delete(reviewDimensionAggregates)
      .where(inArray(reviewDimensionAggregates.aggregateId, aggregateIds));
    await db.delete(reviewAggregates).where(inArray(reviewAggregates.id, aggregateIds));
  }
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  if (createdProductIds.length > 0) {
    // A product an UNDELETABLE review still points at cannot go either — the FK
    // is RESTRICT, which is the property the migration-log test is exercising
    // one table over. Ask which ones survived rather than assuming.
    const stillReferenced = new Set(
      (
        await db
          .select({ id: reviews.canonicalProductId })
          .from(reviews)
          .where(inArray(reviews.canonicalProductId, createdProductIds))
      ).flatMap((row) => (row.id ? [row.id] : [])),
    );
    const deletableProductIds = createdProductIds.filter((id) => !stillReferenced.has(id));
    // The `reviews` filter above is this file's OWN pin; a sibling's match
    // decision is a second, different one, and only the helper can see it.
    await deleteTestCanonicalRows(db, { productIds: deletableProductIds });
  }
  if (createdMerchantIds.length > 0) {
    await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  }
  await deleteTestStores(db, createdStoreIds);
  // `review_target_migrations` is append-only by trigger: it cannot be cleaned
  // up, which is the point. Rows are scoped by a per-run review id and left.
  await closePostgres();
});

/** A per-run Oxy account id — no such table exists, so any string is one. */
function userId(label: string): string {
  return `rs-${label}-${RUN}-${uuidv7().slice(-8)}`;
}

async function makeCanonicalProduct(): Promise<string> {
  const id = uuidv7();
  const suffix = `${RUN}-${id.slice(-8)}`;
  await db.insert(canonicalProducts).values({
    id,
    slug: `rs-product-${suffix}`,
    name: `RS Product ${suffix}`,
    normalizedName: `rs product ${suffix}`,
  });
  createdProductIds.push(id);
  return id;
}

async function makeMerchant(): Promise<string> {
  const id = uuidv7();
  const suffix = `${RUN}-${id.slice(-8)}`;
  await db.insert(merchants).values({ id, slug: `rs-merchant-${suffix}`, name: `RS ${suffix}` });
  createdMerchantIds.push(id);
  return id;
}

async function makeStore(): Promise<string> {
  const id = uuidv7();
  const suffix = `${RUN}-${id.slice(-8)}`;
  await db.insert(stores).values({
    oxyAccountId: 'oxy-account-fixture',
    id,
    name: `RS Store ${suffix}`,
    handle: `rs-store-${suffix}`,
    description: '',
    brandColor: '#112233',
  });
  createdStoreIds.push(id);
  return id;
}

async function makeListing(storeId: string): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: `RS Listing ${RUN}`,
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);
  return listing.id;
}

/** A paid order with ONE line — the evidence an eligibility points at. */
async function makeOrderWithLine(
  storeId: string,
  buyerOxyUserId: string,
  variantTitle = 'Default',
): Promise<{
  orderId: string;
  lineId: string;
}> {
  const orderId = uuidv7();
  const lineId = uuidv7();
  const money = {
    unitPriceShopAmount: 1000,
    unitPriceShopCurrency: 'EUR' as const,
    unitPricePresentmentAmount: 1000,
    unitPricePresentmentCurrency: 'EUR' as const,
    lineTotalShopAmount: 1000,
    lineTotalShopCurrency: 'EUR' as const,
    lineTotalPresentmentAmount: 1000,
    lineTotalPresentmentCurrency: 'EUR' as const,
  };
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `RS-${RUN}-${orderId.slice(-6)}`,
    buyerOxyUserId,
    sellerType: 'store',
    storeId,
    shippingAddressLine1: '1 Test St',
    shippingAddressCity: 'Barcelona',
    shippingAddressPostalCode: '08001',
    shippingAddressCountry: 'ES',
    shippingAddressRecipientName: 'Test Buyer',
    shippingMethod: 'standard',
    shippingLabel: 'Standard',
    shippingCostShopAmount: 0,
    shippingCostShopCurrency: 'EUR',
    shippingCostPresentmentAmount: 0,
    shippingCostPresentmentCurrency: 'EUR',
    totalsSubtotalShopAmount: 1000,
    totalsSubtotalShopCurrency: 'EUR',
    totalsSubtotalPresentmentAmount: 1000,
    totalsSubtotalPresentmentCurrency: 'EUR',
    totalsDiscountTotalShopAmount: 0,
    totalsDiscountTotalShopCurrency: 'EUR',
    totalsDiscountTotalPresentmentAmount: 0,
    totalsDiscountTotalPresentmentCurrency: 'EUR',
    totalsShippingShopAmount: 0,
    totalsShippingShopCurrency: 'EUR',
    totalsShippingPresentmentAmount: 0,
    totalsShippingPresentmentCurrency: 'EUR',
    totalsTaxShopAmount: 0,
    totalsTaxShopCurrency: 'EUR',
    totalsTaxPresentmentAmount: 0,
    totalsTaxPresentmentCurrency: 'EUR',
    totalsGrandTotalShopAmount: 1000,
    totalsGrandTotalShopCurrency: 'EUR',
    totalsGrandTotalPresentmentAmount: 1000,
    totalsGrandTotalPresentmentCurrency: 'EUR',
    status: 'paid',
  });
  createdOrderIds.push(orderId);
  await db.insert(orderItems).values({
    id: lineId,
    orderId,
    listingId: uuidv7(),
    variantId: uuidv7(),
    title: 'A thing',
    variantTitle,
    quantity: 1,
    ...money,
  });
  return { orderId, lineId };
}

/** A scoped review, through the repository — the only writer the service uses. */
async function writeReview(values: {
  authorOxyUserId: string;
  scope: 'product' | 'merchant' | 'p2p_listing';
  targetType: 'canonical_product' | 'merchant' | 'listing';
  targetId: string;
  rating: number;
  title?: string;
  body?: string;
  verification?: 'verified_purchase' | 'unverified';
  eligibilityId?: string;
  orderId?: string;
  dimensions?: {
    key: 'quality' | 'delivery_speed' | 'condition_accuracy';
    rating: number;
  }[];
}): Promise<string> {
  const row = await insertReview({
    authorOxyUserId: values.authorOxyUserId,
    scope: values.scope,
    targetType: values.targetType,
    targetId: values.targetId,
    rating: values.rating,
    title: values.title,
    body: values.body,
    verification: values.verification ?? 'unverified',
    incentiveDisclosure: 'none',
    classificationState: 'native',
    ...(values.eligibilityId ? { eligibilityId: values.eligibilityId } : {}),
    ...(values.orderId ? { orderId: values.orderId } : {}),
    ...(values.dimensions ? { dimensions: values.dimensions } : {}),
  });
  createdReviewIds.push(row.id);
  return row.id;
}

describe('the scope and its target cannot disagree', () => {
  it('refuses a product review that ALSO names a merchant', async () => {
    // BOTH targets set, which is the shape the CHECK exists to refuse and the
    // only one that discriminates: a row naming ONLY the merchant fails on the
    // missing product id whatever the CHECK says about the other five columns,
    // so it would pass against a version that had stopped NULLing them.
    // (Found by mutation-testing the migration: weakening every scoped branch to
    // `"<own column>" is not null` left the single-target form still refused.)
    const merchantId = await makeMerchant();
    const productId = await makeCanonicalProduct();

    // Written RAW, bypassing the repository's own expansion — a mocked insert
    // would accept this happily and the CHECK is the only thing that does not.
    await expect(
      db.insert(reviews).values({
        authorOxyUserId: userId('buyer'),
        scope: 'product',
        targetType: 'canonical_product',
        canonicalProductId: productId,
        merchantId,
        verification: 'unverified',
        incentiveDisclosure: 'none',
        classificationState: 'native',
        rating: 5,
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolation(err, 'reviews_target_exclusivity_check'),
    );
  });

  it('refuses a scoped review naming NO target at all', async () => {
    // The other side of the same CHECK: the `is not null` half. Together the two
    // tests pin both halves of every scoped branch, which is what the single
    // original test did not do.
    await expect(
      db.insert(reviews).values({
        authorOxyUserId: userId('buyer'),
        scope: 'product',
        targetType: 'canonical_product',
        verification: 'unverified',
        incentiveDisclosure: 'none',
        classificationState: 'native',
        rating: 5,
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolation(err, 'reviews_target_exclusivity_check'),
    );
  });

  it('refuses a scope paired with the wrong target TYPE', async () => {
    const productId = await makeCanonicalProduct();

    await expect(
      db.insert(reviews).values({
        authorOxyUserId: userId('buyer'),
        scope: 'product',
        // The right column, the wrong declared type. The two-column tie is what
        // makes this unrepresentable rather than merely wrong.
        targetType: 'merchant',
        canonicalProductId: productId,
        verification: 'unverified',
        incentiveDisclosure: 'none',
        classificationState: 'native',
        rating: 5,
      }),
    ).rejects.toSatisfy((err: unknown) => isCheckViolation(err, 'reviews_scope_target_type_check'));
  });

  it('still accepts a LEGACY unscoped row — the compatibility window', async () => {
    // The other half of the same CHECK, and the half that matters for a
    // migration: a pre-#76 row must keep being writable and readable.
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    const row = await insertReview({
      authorOxyUserId: userId('buyer'),
      targetType: 'listing',
      targetId: listingId,
      rating: 4,
      verification: 'unverified',
      incentiveDisclosure: 'none',
      classificationState: 'unclassified',
    });
    createdReviewIds.push(row.id);

    expect(row.scope).toBeNull();
    expect(row.classificationState).toBe('unclassified');
  });

  it('refuses a scoped row whose classification state says otherwise', async () => {
    const productId = await makeCanonicalProduct();

    await expect(
      db.insert(reviews).values({
        authorOxyUserId: userId('buyer'),
        scope: 'product',
        targetType: 'canonical_product',
        canonicalProductId: productId,
        verification: 'unverified',
        incentiveDisclosure: 'none',
        // A scope and a classification state are one decision seen twice.
        classificationState: 'unclassified',
        rating: 5,
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolation(err, 'reviews_classification_consistency_check'),
    );
  });
});

describe('one review per author per scoped target', () => {
  it('refuses a second product review by the same author', async () => {
    // The GENERATED `target_key` is what makes this work: a plain unique over
    // six nullable columns admits the duplicate, because Postgres treats NULLs
    // as distinct.
    const productId = await makeCanonicalProduct();
    const author = userId('buyer');

    await writeReview({
      authorOxyUserId: author,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
    });

    await expect(
      writeReview({
        authorOxyUserId: author,
        scope: 'product',
        targetType: 'canonical_product',
        targetId: productId,
        rating: 1,
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err, 'reviews_author_scope_target_key'),
    );
  });

  it('PERMITS the same author reviewing the same product at a DIFFERENT scope', async () => {
    // The half that matters: the index must not collapse the scopes. A buyer
    // may rate the product AND the merchant who sold it, and those are two
    // different questions.
    const productId = await makeCanonicalProduct();
    const merchantId = await makeMerchant();
    const author = userId('buyer');

    await writeReview({
      authorOxyUserId: author,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
    });
    const second = await writeReview({
      authorOxyUserId: author,
      scope: 'merchant',
      targetType: 'merchant',
      targetId: merchantId,
      rating: 2,
    });

    expect(second).toBeTruthy();
  });

  it('PERMITS two different authors on one product', async () => {
    const productId = await makeCanonicalProduct();
    await writeReview({
      authorOxyUserId: userId('a'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
    });
    const second = await writeReview({
      authorOxyUserId: userId('b'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 3,
    });
    expect(second).toBeTruthy();
  });
});

describe('eligibility: granted once, spent once', () => {
  it('a REPLAY of the same grant writes nothing new', async () => {
    // #76 verification rule 11, as DDL: UNIQUE(order_item_id, oxy_user_id, scope)
    // plus ON CONFLICT DO NOTHING. The empty vs one-row RETURNING set IS the
    // "already granted" answer.
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();

    const grant = {
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product' as const,
      targetType: 'canonical_product' as const,
      targetId: productId,
      evidenceType: 'authenticated_purchase' as const,
      policyVersion: 'test',
    };

    const first = await insertEligibility(grant);
    const second = await insertEligibility(grant);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const rows = await db
      .select({ id: reviewEligibilities.id })
      .from(reviewEligibilities)
      .where(eq(reviewEligibilities.orderItemId, lineId));
    expect(rows).toHaveLength(1);
  });

  it('CONCURRENT grants converge on exactly one row', async () => {
    // The mocked form of this test cannot exist: two concurrent inserts is
    // precisely what a single-threaded mock cannot reproduce.
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();

    const grant = {
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product' as const,
      targetType: 'canonical_product' as const,
      targetId: productId,
      evidenceType: 'authenticated_purchase' as const,
      policyVersion: 'test',
    };

    const results = await Promise.all([insertEligibility(grant), insertEligibility(grant)]);

    expect(results.filter((row) => row !== null)).toHaveLength(1);
  });

  it('is spent exactly ONCE under two concurrent consumes', async () => {
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();

    const granted = await insertEligibility({
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      evidenceType: 'authenticated_purchase',
      policyVersion: 'test',
    });
    expect(granted).not.toBeNull();
    const eligibilityId = granted?.id ?? '';

    const [a, b] = await Promise.all([
      consumeEligibility(eligibilityId),
      consumeEligibility(eligibilityId),
    ]);

    // Exactly one winner — the CAS on `state = 'open'`.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('refuses a SECOND review spending one eligibility', async () => {
    // The independent second wall: even if the CAS were removed, the review's
    // own partial unique on `eligibility_id` refuses the duplicate.
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productA = await makeCanonicalProduct();

    const granted = await insertEligibility({
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productA,
      evidenceType: 'authenticated_purchase',
      policyVersion: 'test',
    });
    const eligibilityId = granted?.id ?? '';

    await writeReview({
      authorOxyUserId: buyer,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productA,
      rating: 5,
      verification: 'verified_purchase',
      eligibilityId,
      orderId,
    });

    // A DIFFERENT product, same eligibility — the only shape the target unique
    // would not already refuse, which is what makes this index load-bearing.
    const productB = await makeCanonicalProduct();
    await expect(
      writeReview({
        authorOxyUserId: buyer,
        scope: 'product',
        targetType: 'canonical_product',
        targetId: productB,
        rating: 5,
        verification: 'verified_purchase',
        eligibilityId,
        orderId,
      }),
    ).rejects.toSatisfy((err: unknown) => isUniqueViolation(err, 'reviews_eligibility_id_key'));
  });

  it('refuses a claimed-guest eligibility with NO claim id — the #109 seam', async () => {
    // Acceptance criteria 8 and 10, at the storage layer: a guest-origin
    // eligibility is unrepresentable without the claim record, so no code path
    // and no hand-written statement can invent one.
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();

    await expect(
      db.insert(reviewEligibilities).values({
        oxyUserId: buyer,
        orderId,
        orderItemId: lineId,
        scope: 'product',
        targetType: 'canonical_product',
        canonicalProductId: productId,
        evidenceType: 'claimed_guest_purchase',
        policyVersion: 'test',
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolation(err, 'review_eligibilities_claim_check'),
    );
  });

  it('refuses an AUTHENTICATED eligibility carrying a claim id', async () => {
    // The other direction of the same biconditional: an ordinary purchase must
    // not be able to masquerade as a claimed one.
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();

    await expect(
      db.insert(reviewEligibilities).values({
        oxyUserId: buyer,
        orderId,
        orderItemId: lineId,
        scope: 'product',
        targetType: 'canonical_product',
        canonicalProductId: productId,
        evidenceType: 'authenticated_purchase',
        claimId: 'claim-1',
        policyVersion: 'test',
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolation(err, 'review_eligibilities_claim_check'),
    );
  });
});

describe('verification and its evidence travel together', () => {
  it('refuses a verified review with no eligibility', async () => {
    const productId = await makeCanonicalProduct();

    await expect(
      db.insert(reviews).values({
        authorOxyUserId: userId('buyer'),
        scope: 'product',
        targetType: 'canonical_product',
        canonicalProductId: productId,
        verification: 'verified_purchase',
        incentiveDisclosure: 'none',
        classificationState: 'native',
        rating: 5,
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolation(err, 'reviews_verification_evidence_check'),
    );
  });

  it('refuses an unverified review carrying one', async () => {
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();
    const granted = await insertEligibility({
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      evidenceType: 'authenticated_purchase',
      policyVersion: 'test',
    });

    await expect(
      db.insert(reviews).values({
        authorOxyUserId: buyer,
        scope: 'product',
        targetType: 'canonical_product',
        canonicalProductId: productId,
        verification: 'unverified',
        eligibilityId: granted?.id ?? '',
        incentiveDisclosure: 'none',
        classificationState: 'native',
        rating: 5,
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolation(err, 'reviews_verification_evidence_check'),
    );
  });
});

describe('aggregates: verified and unverified never blend', () => {
  it('searches titles and bodies before pagination without widening targets or changing the aggregate', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    const otherListingId = await makeListing(storeId);
    const target = { targetType: 'listing' as const, targetId: listingId };
    const first = await writeReview({
      authorOxyUserId: userId('search-a'),
      scope: 'p2p_listing',
      ...target,
      rating: 5,
      title: 'Lovely GLOW',
      body: 'Lasts all day.',
    });
    const second = await writeReview({
      authorOxyUserId: userId('search-b'),
      scope: 'p2p_listing',
      ...target,
      rating: 4,
      title: 'My favourite',
      body: 'Soft glow, 100%_coverage\\finish.',
    });
    await writeReview({
      authorOxyUserId: userId('search-other-text'),
      scope: 'p2p_listing',
      ...target,
      rating: 1,
      body: 'Wrong shade.',
    });
    const hidden = await writeReview({
      authorOxyUserId: userId('search-hidden'),
      scope: 'p2p_listing',
      ...target,
      rating: 2,
      body: 'Glow hidden.',
    });
    await setReviewStatusIfIn(hidden, 'hidden', ['published']);
    await writeReview({
      authorOxyUserId: userId('search-other-target'),
      scope: 'p2p_listing',
      targetType: 'listing',
      targetId: otherListingId,
      rating: 5,
      body: 'Glow elsewhere.',
    });
    const before = await readReviewRatingSummary(target);
    const page1 = await findReviewsPage(target, 1, 1, { query: 'glow' });
    const page2 = await findReviewsPage(target, 2, 1, { query: 'glow' });
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect(new Set([...page1.rows, ...page2.rows].map((row) => row.id))).toEqual(
      new Set([first, second]),
    );
    expect(
      new Set(
        (
          await findScopedReviewsPage({ ...target, scope: 'p2p_listing' }, 1, 20, { query: 'GLOW' })
        ).rows.map((row) => row.id),
      ),
    ).toEqual(new Set([first, second]));
    expect((await findListingReviewsPage([listingId], 1, 20, { query: 'glow' })).total).toBe(2);
    for (const query of ['%', '_', '\\', '100%_coverage\\finish']) {
      const result = await findReviewsPage(target, 1, 20, { query });
      expect(result.total).toBe(1);
      expect(result.rows.map((row) => row.id)).toEqual([second]);
    }
    expect((await findReviewsPage(target, 1, 20, { query: 'not in any review' })).total).toBe(0);
    expect((await findReviewsPage(target, 1, 20, { query: '   ' })).total).toBe(3);
    const low = await findReviewsPage(target, 1, 1, {
      query: 'glow',
      ratings: [4, 5],
      sortBy: 'rating_asc',
    });
    const high = await findReviewsPage(target, 2, 1, {
      query: 'glow',
      ratings: [4, 5],
      sortBy: 'rating_asc',
    });
    expect(low.total).toBe(2);
    expect(low.rows.map((row) => row.id)).toEqual([second]);
    expect(high.rows.map((row) => row.id)).toEqual([first]);
    expect(
      (await findReviewsPage(target, 1, 20, { ratings: [5, 4], sortBy: 'rating_desc' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([first, second]);
    expect(
      (
        await findScopedReviewsPage({ ...target, scope: 'p2p_listing' }, 1, 20, { ratings: [4] })
      ).rows.map((row) => row.id),
    ).toEqual([second]);
    expect(
      (await findListingReviewsPage([listingId], 1, 20, { ratings: [4] })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([second]);
    expect((await findReviewsPage(target, 1, 20, { ratings: [2] })).total).toBe(0);
    // Same timestamp makes the UUID tiebreaker observable across pages.
    await db
      .update(reviews)
      .set({ createdAt: new Date('2025-01-01T00:00:00Z') })
      .where(inArray(reviews.id, [first, second]));
    const orderedIds = [first, second].sort();
    expect(
      (await findReviewsPage(target, 1, 1, { query: 'glow', sortBy: 'oldest' })).rows[0].id,
    ).toBe(orderedIds[0]);
    expect(
      (await findReviewsPage(target, 2, 1, { query: 'glow', sortBy: 'oldest' })).rows[0].id,
    ).toBe(orderedIds[1]);
    expect(
      (await findReviewsPage(target, 1, 1, { query: 'glow', sortBy: 'newest' })).rows[0].id,
    ).toBe(orderedIds[1]);
    expect(before.reviewCount).toBe(3);
    expect(await readReviewRatingSummary(target)).toEqual(before);
  });

  it('reads all published rating buckets independently of pagination and excludes other targets and hidden rows', async () => {
    const storeId = await makeStore();
    const listingId = await makeListing(storeId);
    const otherListingId = await makeListing(storeId);
    const target = { targetType: 'listing' as const, targetId: listingId };
    for (let index = 0; index < 14; index++) {
      await writeReview({
        authorOxyUserId: userId(`hist-${index}`),
        scope: 'p2p_listing',
        ...target,
        rating: index === 0 ? 1 : 5,
      });
    }
    const hidden = await writeReview({
      authorOxyUserId: userId('hidden'),
      scope: 'p2p_listing',
      ...target,
      rating: 2,
    });
    await setReviewStatusIfIn(hidden, 'hidden', ['published']);
    await writeReview({
      authorOxyUserId: userId('unrelated'),
      scope: 'p2p_listing',
      targetType: 'listing',
      targetId: otherListingId,
      rating: 3,
    });
    expect((await findReviewsPage(target, 1, 12)).rows).toHaveLength(12);
    expect(await readReviewRatingSummary(target)).toEqual({
      rating: 4.7,
      reviewCount: 14,
      verifiedOnly: false,
      distribution: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 13 },
    });
    expect(
      await readReviewRatingSummary({
        ...target,
        targetId: await makeListing(storeId),
      }),
    ).toEqual({
      rating: 0,
      reviewCount: 0,
      verifiedOnly: false,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
  });

  it('counts them apart, and the headline rating is the VERIFIED one', async () => {
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();

    const granted = await insertEligibility({
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      evidenceType: 'authenticated_purchase',
      policyVersion: 'test',
    });

    // One verified 5, one unverified 1. A blended average would be 3.
    await writeReview({
      authorOxyUserId: buyer,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
      verification: 'verified_purchase',
      eligibilityId: granted?.id ?? '',
      orderId,
    });
    await writeReview({
      authorOxyUserId: userId('other'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 1,
    });

    const { aggregate } = await rebuildScopedAggregate('product', productId);

    expect(aggregate.rating).toBe(5);
    expect(aggregate.reviewCount).toBe(1);
    expect(aggregate.unverified.rating).toBe(1);
    expect(aggregate.unverified.count).toBe(1);
    expect(
      await readReviewRatingSummary({
        scope: 'product',
        targetType: 'canonical_product',
        targetId: productId,
      }),
    ).toEqual({
      rating: 5,
      reviewCount: 1,
      verifiedOnly: true,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
    });
    // And the DTO offers no combined total to reach for.
    expect(Object.keys(aggregate)).not.toContain('totalCount');
  });

  it('a HIDDEN review leaves the aggregate through the rebuild', async () => {
    // #76 moderation rule 3. The rebuild is idempotent, which is what lets
    // enforcement call it without knowing whether the sweep already did.
    const productId = await makeCanonicalProduct();
    const reviewId = await writeReview({
      authorOxyUserId: userId('buyer'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 1,
    });

    const before = await rebuildScopedAggregate('product', productId);
    expect(before.aggregate.unverified.count).toBe(1);

    const hidden = await setReviewStatusIfIn(reviewId, 'hidden', ['published']);
    expect(hidden).toBe(true);

    const after = await rebuildScopedAggregate('product', productId);
    expect(after.aggregate.unverified.count).toBe(0);
    expect(after.aggregate.unverified.rating).toBe(0);
    expect(after.aggregate.reviewCount).toBe(0);
  });

  it('the projection lands on the canonical product row', async () => {
    // The aggregate is the authority and `canonical_products.rating` is its
    // projection — written by the same call, from the same figures.
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();
    const granted = await insertEligibility({
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      evidenceType: 'authenticated_purchase',
      policyVersion: 'test',
    });
    await writeReview({
      authorOxyUserId: buyer,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 4,
      verification: 'verified_purchase',
      eligibilityId: granted?.id ?? '',
      orderId,
    });

    await rebuildScopedAggregate('product', productId);

    const [row] = await db
      .select({
        rating: canonicalProducts.rating,
        ratingCount: canonicalProducts.ratingCount,
      })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, productId));
    expect(row?.rating).toBe(4);
    expect(row?.ratingCount).toBe(1);
  });

  it('DETECTS drift when a stored aggregate disagrees with the reviews', async () => {
    // Corrupt the stored figures behind the service's back — a lost write, a
    // half-applied repair — and confirm the rebuild both NOTICES and CORRECTS.
    const productId = await makeCanonicalProduct();
    await writeReview({
      authorOxyUserId: userId('buyer'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 3,
    });
    await rebuildScopedAggregate('product', productId);

    await db
      .update(reviewAggregates)
      .set({ rating: 5, reviewCount: 99 })
      .where(
        and(
          eq(reviewAggregates.scope, 'product'),
          eq(reviewAggregates.canonicalProductId, productId),
        ),
      );

    const { drift, aggregate } = await rebuildScopedAggregate('product', productId);

    expect(drift).not.toBeNull();
    expect(drift?.storedReviewCount).toBe(99);
    expect(drift?.derivedReviewCount).toBe(0);
    // …and it converged: the stored figures now match the reviews.
    expect(aggregate.reviewCount).toBe(0);
  });

  it('reports NO drift on a clean re-derive — the gate is not always-on', () => {
    // Without this the assertion above passes against a rebuild that reports
    // drift unconditionally, which would make the signal worthless.
    return (async () => {
      const productId = await makeCanonicalProduct();
      await writeReview({
        authorOxyUserId: userId('buyer'),
        scope: 'product',
        targetType: 'canonical_product',
        targetId: productId,
        rating: 3,
      });
      await rebuildScopedAggregate('product', productId);
      const { drift } = await rebuildScopedAggregate('product', productId);
      expect(drift).toBeNull();
    })();
  });

  it('derives per-dimension averages from VERIFIED reviews only', async () => {
    const storeId = await makeStore();
    const buyer = userId('buyer');
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer);
    const productId = await makeCanonicalProduct();
    const granted = await insertEligibility({
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      evidenceType: 'authenticated_purchase',
      policyVersion: 'test',
    });

    await writeReview({
      authorOxyUserId: buyer,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 4,
      verification: 'verified_purchase',
      eligibilityId: granted?.id ?? '',
      orderId,
      dimensions: [{ key: 'quality', rating: 4 }],
    });
    // An UNVERIFIED review with the same dimension at 1 — it must not move the
    // dimension average, which is the finest-grained public claim there is.
    await writeReview({
      authorOxyUserId: userId('other'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 1,
      dimensions: [{ key: 'quality', rating: 1 }],
    });

    const { aggregate } = await rebuildScopedAggregate('product', productId);

    expect(aggregate.dimensions).toEqual([{ key: 'quality', rating: 4, count: 1 }]);
  });
});

/**
 * Assert that `run` was refused BY THE TRIGGER.
 *
 * drizzle wraps a driver error in a `Failed query: …` envelope and hangs the
 * real one off `cause`, so matching the top-level message alone would pass
 * against ANY failure — a syntax error, a missing table, a dead connection.
 * Walking the cause chain is what makes this check able to tell the trigger
 * from everything else; and because a missing trigger means the statement
 * SUCCEEDS, the `did not throw` branch is the one that catches its absence.
 */
async function expectRefusedByTrigger(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'the statement succeeded — is the trigger installed?').toBeDefined();
  const messages: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(' | ')).toMatch(/append-only/);
}

describe('the migration log is append-only', () => {
  it('refuses an UPDATE and a DELETE', async () => {
    const productId = await makeCanonicalProduct();
    const reviewId = await writeReview({
      authorOxyUserId: userId('buyer'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
    });

    undeletableReviewIds.add(reviewId);
    const recorded = await recordTargetMigration({
      reviewId,
      action: 'rehome_merge',
      fromScope: 'product',
      fromTargetType: 'canonical_product',
      fromTargetRef: 'old-product',
      toScope: 'product',
      toTargetType: 'canonical_product',
      toTargetRef: productId,
      reason: 'test',
      actorKind: 'migration',
    });
    expect(recorded).not.toBeNull();

    await expectRefusedByTrigger(() =>
      db
        .update(reviewTargetMigrations)
        .set({ reason: 'rewritten' })
        .where(eq(reviewTargetMigrations.id, recorded?.id ?? '')),
    );

    await expectRefusedByTrigger(() =>
      db.delete(reviewTargetMigrations).where(eq(reviewTargetMigrations.id, recorded?.id ?? '')),
    );
  });

  it('converges a replayed decision instead of growing the log', async () => {
    const productId = await makeCanonicalProduct();
    const reviewId = await writeReview({
      authorOxyUserId: userId('buyer'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
    });

    undeletableReviewIds.add(reviewId);
    const values = {
      reviewId,
      action: 'classify' as const,
      fromTargetType: 'listing' as const,
      fromTargetRef: 'listing-x',
      toScope: 'product' as const,
      toTargetType: 'canonical_product' as const,
      toTargetRef: productId,
      reason: 'test',
      actorKind: 'migration' as const,
    };

    const first = await recordTargetMigration(values);
    const second = await recordTargetMigration(values);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const rows = await db
      .select({ id: reviewTargetMigrations.id })
      .from(reviewTargetMigrations)
      .where(eq(reviewTargetMigrations.reviewId, reviewId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a destination on a REFUSAL and demands one otherwise', async () => {
    const productId = await makeCanonicalProduct();
    const reviewId = await writeReview({
      authorOxyUserId: userId('buyer'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
    });

    await expect(
      db.insert(reviewTargetMigrations).values({
        reviewId,
        action: 'refuse_ambiguous',
        fromTargetType: 'store',
        fromTargetRef: 'store-x',
        toScope: 'merchant',
        toTargetType: 'merchant',
        toTargetRef: 'merch-x',
        reason: 'test',
        actorKind: 'migration',
        at: new Date(),
      }),
    ).rejects.toSatisfy((err: unknown) =>
      isCheckViolation(err, 'review_target_migrations_destination_check'),
    );

    await expect(
      db.insert(reviewTargetMigrations).values({
        reviewId,
        action: 'assign_split',
        fromTargetType: 'canonical_product',
        fromTargetRef: 'old',
        reason: 'test',
        // An operator decision with no operator.
        actorKind: 'operator',
        at: new Date(),
      }),
    ).rejects.toSatisfy((err: unknown) => isCheckViolation(err));
  });
});

describe('a dimension belongs to exactly one review, once', () => {
  it('refuses the same dimension key twice on one review', async () => {
    const productId = await makeCanonicalProduct();
    const reviewId = await writeReview({
      authorOxyUserId: userId('buyer'),
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
      dimensions: [{ key: 'quality', rating: 5 }],
    });

    await expect(
      db.insert(reviewDimensions).values({ reviewId, key: 'quality', rating: 1 }),
    ).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err, 'review_dimensions_review_id_key_key'),
    );
  });
});

describe('public review purchase context', () => {
  async function purchasedReview(variantTitle: string, mismatchedAuthor = false) {
    const buyer = `variant-buyer-${uuidv7()}`;
    const storeId = await makeStore();
    const productId = await makeCanonicalProduct();
    const { orderId, lineId } = await makeOrderWithLine(storeId, buyer, variantTitle);
    const grant = await insertEligibility({
      oxyUserId: buyer,
      orderId,
      orderItemId: lineId,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      evidenceType: 'authenticated_purchase',
      policyVersion: 'test',
    });
    expect(grant).not.toBeNull();
    await consumeEligibility(grant!.id);
    const reviewId = await writeReview({
      authorOxyUserId: mismatchedAuthor ? `another-${buyer}` : buyer,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: productId,
      rating: 5,
      verification: 'verified_purchase',
      eligibilityId: grant!.id,
      orderId,
    });
    return { reviewId, productId };
  }

  it('reads each exact purchased variant even when its catalog listing is absent', async () => {
    const first = await purchasedReview('Black / M');
    const second = await purchasedReview('Blue / XL');
    const context = await findPurchasedVariantsForReviews([first.reviewId, second.reviewId]);
    expect(context.size).toBe(2);
    expect(context.get(first.reviewId)).toBe('Black / M');
    expect(context.get(second.reviewId)).toBe('Blue / XL');
    // A scoped read cannot expose another review's purchase context.
    expect(await findPurchasedVariantsForReviews([first.reviewId])).toEqual(
      new Map([[first.reviewId, 'Black / M']]),
    );
    expect(await findPurchasedVariantsForReviews([])).toEqual(new Map());
  });

  it('omits missing evidence, hidden reviews and an eligibility owned by another author', async () => {
    const valid = await purchasedReview('Red / S');
    const hidden = await purchasedReview('Private / L');
    await setReviewStatusIfIn(hidden.reviewId, 'hidden', ['published']);
    const mismatched = await purchasedReview('Other buyer / XL', true);
    const unverified = await writeReview({
      authorOxyUserId: `unverified-${uuidv7()}`,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: valid.productId,
      rating: 4,
    });
    const context = await findPurchasedVariantsForReviews([
      valid.reviewId,
      hidden.reviewId,
      mismatched.reviewId,
      unverified,
    ]);
    expect(context.size).toBe(1);
    expect(context).toEqual(new Map([[valid.reviewId, 'Red / S']]));
  });

  it('does not expose blank or no-option variant placeholders', async () => {
    const blank = await purchasedReview('   ');
    const defaultVariant = await purchasedReview('Default Title');
    expect(
      await findPurchasedVariantsForReviews([blank.reviewId, defaultVariant.reviewId]),
    ).toEqual(new Map());
  });
});

describe('published review helpfulness', () => {
  async function voteReview(author = userId('helpful-author')) {
    return writeReview({
      authorOxyUserId: author,
      scope: 'product',
      targetType: 'canonical_product',
      targetId: await makeCanonicalProduct(),
      rating: 4,
    });
  }

  it('concurrent retries create one vote; distinct readers count separately and removal is replay-safe', async () => {
    const id = await voteReview();
    const reader = userId('helpful-reader');
    const other = userId('helpful-other');
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => updateReviewHelpfulness(reader, id, true)),
    );
    expect(replies.every((row) => row.helpfulnessCount === 1 && row.markedAsHelpfulByMe)).toBe(
      true,
    );
    expect(await updateReviewHelpfulness(other, id, true)).toMatchObject({
      helpfulnessCount: 2,
      markedAsHelpfulByMe: true,
    });
    expect(await updateReviewHelpfulness(reader, id, false)).toMatchObject({
      helpfulnessCount: 1,
      markedAsHelpfulByMe: false,
    });
    expect(await updateReviewHelpfulness(reader, id, false)).toMatchObject({
      helpfulnessCount: 1,
      markedAsHelpfulByMe: false,
    });
    const votes = await db
      .select({ voter: reviewHelpfulVotes.oxyUserId })
      .from(reviewHelpfulVotes)
      .where(eq(reviewHelpfulVotes.reviewId, id));
    expect(votes).toEqual([{ voter: other }]);
    expect((await findReviewHelpfulness([id], other))[0]).toMatchObject({
      markedAsHelpfulByMe: true,
      helpfulnessCount: 1,
    });
    expect((await findReviewHelpfulness([id]))[0]).toMatchObject({
      markedAsHelpfulByMe: false,
      canUpdateHelpfulness: false,
      helpfulnessCount: 1,
    });
  });

  it('keeps votes isolated by review and account and refuses an author voting on their own text', async () => {
    const author = userId('helpful-self');
    const first = await voteReview(author);
    const second = await voteReview();
    const reader = userId('helpful-scoped');
    await updateReviewHelpfulness(reader, first, true);
    const rows = await findReviewHelpfulness([first, second], author);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.reviewId === first)).toMatchObject({
      helpfulnessCount: 1,
      markedAsHelpfulByMe: false,
      canUpdateHelpfulness: false,
    });
    expect(rows.find((row) => row.reviewId === second)).toMatchObject({
      helpfulnessCount: 0,
      markedAsHelpfulByMe: false,
      canUpdateHelpfulness: true,
    });
    await expect(updateReviewHelpfulness(author, first, true)).rejects.toMatchObject({
      httpStatus: 403,
    });
    expect((await findReviewHelpfulness([first], reader))[0].helpfulnessCount).toBe(1);
  });

  it('hidden or missing reviews expose no vote state and reject mutations', async () => {
    const id = await voteReview();
    const reader = userId('helpful-moderated');
    await updateReviewHelpfulness(reader, id, true);
    await setReviewStatusIfIn(id, 'hidden', ['published']);
    const missing = uuidv7();
    expect(await findReviewHelpfulness([id, missing], reader)).toEqual([]);
    await expect(updateReviewHelpfulness(reader, id, true)).rejects.toMatchObject({
      httpStatus: 404,
    });
    await expect(updateReviewHelpfulness(reader, missing, false)).rejects.toMatchObject({
      httpStatus: 404,
    });
    const stored = await db
      .select({ id: reviewHelpfulVotes.id })
      .from(reviewHelpfulVotes)
      .where(eq(reviewHelpfulVotes.reviewId, id));
    expect(stored).toHaveLength(1);
  });

  it('private transaction reviews have no public helpfulness surface', async () => {
    const author = userId('helpful-private');
    const { lineId } = await makeOrderWithLine(await makeStore(), author);
    const row = await insertReview({
      authorOxyUserId: author,
      scope: 'native_transaction',
      targetType: 'order_item',
      targetId: lineId,
      rating: 5,
      verification: 'unverified',
      incentiveDisclosure: 'none',
      classificationState: 'native',
    });
    createdReviewIds.push(row.id);
    const reader = userId('helpful-private-other');
    expect(await findReviewHelpfulness([row.id], reader)).toEqual([]);
    await expect(updateReviewHelpfulness(reader, row.id, true)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('the database refuses duplicate votes even outside the service and deletes votes with their review', async () => {
    const id = await voteReview();
    const reader = userId('helpful-unique');
    await updateReviewHelpfulness(reader, id, true);
    await expect(
      db.insert(reviewHelpfulVotes).values({ reviewId: id, oxyUserId: reader }),
    ).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err, 'review_helpful_votes_review_user_key'),
    );
    await db.delete(reviews).where(eq(reviews.id, id));
    expect(
      await db
        .select({ id: reviewHelpfulVotes.id })
        .from(reviewHelpfulVotes)
        .where(eq(reviewHelpfulVotes.reviewId, id)),
    ).toEqual([]);
  });
});
