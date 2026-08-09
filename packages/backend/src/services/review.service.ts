/**
 * Review service — scoped reviews, eligibility-backed verification, and the
 * legacy rating aggregates (#76).
 *
 * ## The shape of a write, in order
 *
 * `createReview` → refuse a forbidden scope → refuse a dimension from another
 * scope → resolve the eligibility to spend → refuse a self-review (two
 * independent layers) → refuse a duplicate → SPEND the eligibility → write the
 * review and its dimensions → rebuild the scoped aggregate → notify the owner.
 *
 * The eligibility is spent BEFORE the review is written, and the two are
 * separate statements on purpose: the spend is a CAS on `state = 'open'`, so two
 * concurrent submissions produce exactly one winner even before the review
 * insert gets anywhere near `reviews_eligibility_id_key`. That index is the
 * second wall, not the first.
 *
 * ## Verified and unverified
 *
 * A review with no eligibility to spend is written `unverified` — labelled as
 * such, counted separately, and never blended into the headline rating (#76
 * verification rule 5). It is NOT refused: a review from somebody Mercaria has
 * no purchase record for is an opinion the platform may choose to publish, and
 * the aggregate is what keeps it from carrying the weight of a purchase.
 *
 * ## There is no path here that can un-hide a review, and none that can re-scope one
 *
 * `reviews.status` is written by moderation enforcement; `reviews.scope` by the
 * classification job and the merge/split paths. This service exposes create plus
 * read functions and no update of any kind, so neither has a seller-facing
 * escape to close — the review equivalent of the one
 * `catalog-write.service.updateListing` has to close for `restricted` does not
 * exist. Keep it that way: any future review-edit path must exclude `status` and
 * `scope`, or it becomes one.
 */

import type {
  CreateReviewInput,
  RatingAggregate,
  Review as ReviewDTO,
  ReviewAuthor,
  ReviewDimension,
  ReviewProduct,
  ReviewScope,
  ReviewTargetType,
  ScopedRatingAggregate,
} from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import {
  aggregatePublishedReviews,
  authorHasReviewedTarget,
  findDimensionsForReviews,
  findListingReviewsPage,
  findReviewsPage,
  findScopedReviewsPage,
  insertReview,
  type ReviewDimensionRecord,
  type ReviewRecord,
  type ReviewTarget,
} from '../db/reviews/reviewRepository.js';
import {
  consumeEligibility,
  type ReviewEligibilityRecord,
} from '../db/reviews/reviewEligibilityRepository.js';
import {
  findListingById,
  findListingChildren,
  findListingIdsByStore,
  findListingsByIds,
  setListingRating,
} from '../db/catalog/listingRepository.js';
import {
  findStoreById,
  findStoreByHandle,
  setStoreRating,
  type StoreMemberRecord,
} from '../db/stores/storeRepository.js';
import { setSellerRating } from '../db/buyers/sellerProfileRepository.js';
import { resolveEligibilityToSpend } from './reviews/review-eligibility.service.js';
import {
  getOrBuildScopedAggregate,
  rebuildScopedAggregate,
} from './reviews/review-aggregate.service.js';
import { assertNotSelfPurchase, assertNotSelfTarget } from './reviews/review-self-review.js';
import {
  assertDimensionsForScope,
  assertScopeAllowed,
  scopedTarget,
} from './reviews/review-scope.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { enqueueRecomputeAggregate } from '../queue/producers.js';
import { sendNotification } from '../lib/notification-service.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Average rating rounded to ONE decimal place. */
function roundRating(avg: number): number {
  return Math.round(avg * 10) / 10;
}

/** Resolve + validate the required target id from the input for its scope. */
function resolveTargetId(input: CreateReviewInput): string {
  switch (input.scope) {
    case 'product':
      if (!input.canonicalProductId) {
        throw validationError('canonicalProductId is required to review a product');
      }
      return input.canonicalProductId;
    case 'merchant':
      if (!input.merchantId) throw validationError('merchantId is required to review a merchant');
      return input.merchantId;
    case 'native_transaction':
      if (!input.orderItemId) {
        throw validationError('orderItemId is required to review a transaction');
      }
      return input.orderItemId;
    case 'p2p_listing':
      if (!input.listingId) throw validationError('listingId is required to review a listing');
      return input.listingId;
    case 'p2p_seller':
      if (!input.sellerOxyUserId) {
        throw validationError('sellerOxyUserId is required to review a seller');
      }
      return input.sellerOxyUserId;
  }
}

/** Build a `ReviewAuthor` from an Oxy profile (avatar resolved through the chokepoint). */
function toReviewAuthor(profile: OxyProfile | undefined): ReviewAuthor | undefined {
  if (!profile) {
    return undefined;
  }
  const author: ReviewAuthor = {
    displayName: profile.displayName,
    username: profile.username,
  };
  author.avatar = profile.avatar ? resolveMedia(profile.avatar) : (profile.avatar ?? null);
  return author;
}

/**
 * Map a persisted review row + the resolved author profile to the `Review` DTO.
 *
 * The six target columns arrive NULL rather than absent, which is why each is
 * copied under a truthiness guard: the DTO's optional fields must stay ABSENT
 * for a target this review does not name, not present and null.
 *
 * NOTE what is not copied, from a row that has no column for it either: any
 * buyer email, phone, checkout token or portal token. The evidence a review
 * carries out to the wire is `eligibilityId` — an opaque Mercaria id whose own
 * DTO exposes a verification state and never a contact detail (#76 privacy 3).
 *
 * `products` is an optional map of `listingId → ReviewProduct` used only by the
 * store-reviews serializer to attach minimal product context to each card; it is
 * absent (so `dto.product` stays undefined) on a listing's own reviews page.
 */
function toReviewDTO(
  row: ReviewRecord,
  authorProfiles: Map<string, OxyProfile>,
  dimensions?: Map<string, ReviewDimension[]>,
  products?: Map<string, ReviewProduct>,
): ReviewDTO {
  const dto: ReviewDTO = {
    id: row.id,
    authorOxyUserId: row.authorOxyUserId,
    targetType: row.targetType,
    verification: row.verification,
    incentiveDisclosure: row.incentiveDisclosure,
    classificationState: row.classificationState,
    rating: row.rating,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  const author = toReviewAuthor(authorProfiles.get(row.authorOxyUserId));
  if (author) {
    dto.author = author;
  }
  if (row.scope) dto.scope = row.scope;
  if (row.listingId) dto.listingId = row.listingId;
  if (row.storeId) dto.storeId = row.storeId;
  if (row.sellerOxyUserId) dto.sellerOxyUserId = row.sellerOxyUserId;
  if (row.canonicalProductId) dto.canonicalProductId = row.canonicalProductId;
  if (row.merchantId) dto.merchantId = row.merchantId;
  if (row.orderItemId) dto.orderItemId = row.orderItemId;
  if (row.orderId) dto.orderId = row.orderId;
  if (row.eligibilityId) dto.eligibilityId = row.eligibilityId;
  if (row.title) dto.title = row.title;
  if (row.body) dto.body = row.body;
  if (row.locale) dto.locale = row.locale;
  // DERIVED, not stored: a review has no draft state in Mercaria, so it became
  // visible the moment it was written. See the note on `editedAt` in the schema.
  dto.publishedAt = row.createdAt.toISOString();
  if (row.editedAt) dto.editedAt = row.editedAt.toISOString();
  if (row.ambiguityReason) dto.ambiguityReason = row.ambiguityReason;
  const rowDimensions = dimensions?.get(row.id);
  if (rowDimensions && rowDimensions.length > 0) {
    dto.dimensions = rowDimensions;
  }
  if (products && row.listingId) {
    const product = products.get(row.listingId);
    if (product) {
      dto.product = product;
    }
  }
  return dto;
}

/** `reviewId → dimensions`, for hydrating a page in one extra read. */
function groupDimensions(rows: ReviewDimensionRecord[]): Map<string, ReviewDimension[]> {
  const map = new Map<string, ReviewDimension[]>();
  for (const row of rows) {
    const existing = map.get(row.reviewId) ?? [];
    existing.push({ key: row.key, rating: row.rating });
    map.set(row.reviewId, existing);
  }
  return map;
}

/**
 * Recompute a LEGACY review target's `{ rating, reviewCount }` from its
 * PUBLISHED reviews and persist it onto the target row.
 *
 * This is the pre-#76 path and it stays exactly as it was, for exactly as long
 * as unclassified legacy reviews exist. It covers `listing`, `store` and
 * `seller` targets ONLY, and `findPublishedReviewTargets` — its work list —
 * excludes every scoped row, so a review never has two rebuild paths writing two
 * tables from two different queries. That separation is the whole reason the two
 * can coexist through the compatibility window without drifting.
 *
 * The repository reports `average: null` for a target with no published reviews,
 * which is why the zero here is written deliberately rather than inherited from
 * an aggregate that could not distinguish "no reviews" from "an average of zero".
 * The write is an absolute SET: this derived both figures, so it is the whole
 * answer and not a delta.
 */
export async function recomputeAggregate(
  targetType: ReviewTargetType,
  targetId: string,
): Promise<RatingAggregate> {
  const { average, count } = await aggregatePublishedReviews({ targetType, targetId });

  const reviewCount = count;
  const rating = average !== null && reviewCount > 0 ? roundRating(average) : 0;

  switch (targetType) {
    case 'listing':
      await setListingRating(targetId, rating, reviewCount);
      break;
    case 'store':
      await setStoreRating(targetId, rating, reviewCount);
      break;
    case 'seller':
      // Upserting: a seller's first review can arrive before anything else has
      // created their profile, exactly as the Mongo `upsert: true` allowed.
      await setSellerRating(targetId, rating, reviewCount);
      break;
    case 'canonical_product':
    case 'merchant':
    case 'order_item':
      // A scoped target's aggregate lives in `review_aggregates` and is derived
      // by `rebuildScopedAggregate`. Reaching one of these here would mean the
      // legacy work list had started returning scoped rows, which is a bug in
      // that query rather than a case to handle — so it is recorded loudly and
      // nothing is written from the wrong query.
      log.general.warn(
        { targetType, targetId },
        'Legacy aggregate recompute reached a scoped target; skipping (see rebuildScopedAggregate)',
      );
      break;
  }

  return { rating, reviewCount };
}

/** The Oxy accounts that OWN a store — who a review notification reaches. */
async function storeOwnerIds(storeId: string): Promise<string[]> {
  const store = await findStoreById(storeId);
  const owners: StoreMemberRecord[] = (store?.members ?? []).filter((m) => m.role === 'owner');
  return owners.map((member) => member.oxyUserId);
}

/**
 * Notify the target owner that a review was received (best-effort; never
 * throws). The author is never notified about their own review.
 *
 * A `product` review notifies nobody: a canonical product belongs to no seller
 * (ADR 0002 D6), so there is no owner to tell. A `merchant` or
 * `native_transaction` review notifies nobody either — walking the merchant's
 * staff would push a notification at people who never asked to hear about it,
 * and those surfaces are read from the dashboard rather than an inbox.
 */
async function notifyTargetOwner(
  row: ReviewRecord,
  scope: ReviewScope,
  targetId: string,
  authorOxyUserId: string,
): Promise<void> {
  try {
    const recipients = new Set<string>();

    if (scope === 'p2p_listing') {
      const listing = await findListingById(targetId);
      if (listing?.ownerType === 'user' && listing.oxyUserId) {
        recipients.add(listing.oxyUserId);
      } else if (listing?.ownerType === 'store' && listing.storeId) {
        for (const ownerId of await storeOwnerIds(listing.storeId)) {
          recipients.add(ownerId);
        }
      }
    } else if (scope === 'p2p_seller') {
      recipients.add(targetId);
    }

    recipients.delete(authorOxyUserId);

    for (const userId of recipients) {
      await sendNotification({
        userId,
        type: 'review_received',
        title: 'New review',
        body: `You received a ${row.rating}-star review.`,
        data: {
          reviewId: row.id,
          scope,
          rating: row.rating,
        },
      });
    }
  } catch (err) {
    log.general.warn({ err, scope }, 'review_received notification failed (best-effort)');
  }
}

/**
 * Create a scoped review: scope gate → dimension gate → eligibility →
 * self-review gate → one-per-target → spend → persist → rebuild → notify.
 */
export async function createReview(
  authorOxyUserId: string,
  input: CreateReviewInput,
): Promise<ReviewDTO> {
  assertScopeAllowed(input.scope);
  assertDimensionsForScope(input.scope, input.dimensions);

  const targetId = resolveTargetId(input);
  const target = scopedTarget(input.scope, targetId);

  const eligibility: ReviewEligibilityRecord | null = await resolveEligibilityToSpend(
    authorOxyUserId,
    target.scope,
    target.targetType,
    target.targetId,
    input.eligibilityId,
  );

  // Layer 1 covers every scope through the purchase; layer 2 covers ownership of
  // the target and is what still holds for an unverified review, which has no
  // order to read. Both, always — neither substitutes for the other.
  if (eligibility) {
    await assertNotSelfPurchase(authorOxyUserId, eligibility.orderId);
  }
  await assertNotSelfTarget(authorOxyUserId, target.scope, target.targetId);

  const legacyTarget: ReviewTarget = {
    targetType: target.targetType,
    targetId: target.targetId,
  };
  if (await authorHasReviewedTarget(authorOxyUserId, legacyTarget)) {
    throw conflict('You have already reviewed this item');
  }

  // Spend BEFORE writing. The CAS on `state = 'open'` is what makes two
  // concurrent submissions produce one winner; the review's own unique index on
  // `eligibility_id` is the second, independent wall.
  if (eligibility && !(await consumeEligibility(eligibility.id))) {
    throw conflict('That review eligibility has already been used');
  }

  let row: ReviewRecord;
  try {
    row = await insertReview({
      ...legacyTarget,
      scope: target.scope,
      authorOxyUserId,
      verification: eligibility ? 'verified_purchase' : 'unverified',
      classificationState: 'native',
      incentiveDisclosure: input.incentiveDisclosure ?? 'none',
      rating: input.rating,
      ...(eligibility ? { orderId: eligibility.orderId, eligibilityId: eligibility.id } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.body ? { body: input.body } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.dimensions ? { dimensions: input.dimensions } : {}),
    });
  } catch (err) {
    // The pre-check above is the nice error; these are the ones that actually
    // hold. Two concurrent submissions both pass the read, and the index refuses
    // the second — the same conflict, raised a layer lower.
    if (
      isUniqueViolation(err, 'reviews_author_oxy_user_id_listing_id_key') ||
      isUniqueViolation(err, 'reviews_author_scope_target_key')
    ) {
      throw conflict('You have already reviewed this item');
    }
    if (isUniqueViolation(err, 'reviews_eligibility_id_key')) {
      throw conflict('That review eligibility has already been used');
    }
    throw err;
  }

  // Derive the scoped aggregate inline so the immediate read is correct. It is
  // idempotent, so the sweep re-deriving it later changes nothing.
  await rebuildScopedAggregate(target.scope, target.targetId);

  // Durable, drift-proof backstop for the LEGACY projection of the same target
  // (a `p2p_listing` review also moves `listings.rating`). The inline rebuild
  // already ran, so a producer throw here is non-fatal — log and continue.
  try {
    await enqueueRecomputeAggregate({
      targetType: target.targetType,
      targetId: target.targetId,
    });
  } catch (err) {
    log.general.warn(
      { err, scope: target.scope, targetId: target.targetId },
      'Failed to enqueue aggregate recompute',
    );
  }

  await notifyTargetOwner(row, target.scope, target.targetId, authorOxyUserId);

  const authorProfiles = await getProfiles([authorOxyUserId]);
  const dimensionRows = await findDimensionsForReviews([row.id]);
  return toReviewDTO(row, authorProfiles, groupDimensions(dimensionRows));
}

/** Offset-pagination parameters. */
interface ReviewListParams {
  page: number;
  limit: number;
}

/** A page of review DTOs plus the total matching count (controller paginates). */
interface ReviewPage {
  data: ReviewDTO[];
  total: number;
}

/** Hydrate a page of rows: authors + dimensions in two batched reads. */
async function hydrate(
  rows: ReviewRecord[],
  total: number,
  products?: Map<string, ReviewProduct>,
): Promise<ReviewPage> {
  const authorIds = [...new Set(rows.map((row) => row.authorOxyUserId))];
  const [authorProfiles, dimensionRows] = await Promise.all([
    getProfiles(authorIds),
    findDimensionsForReviews(rows.map((row) => row.id)),
  ]);
  const dimensions = groupDimensions(dimensionRows);
  return {
    data: rows.map((row) => toReviewDTO(row, authorProfiles, dimensions, products)),
    total,
  };
}

/**
 * List a LEGACY target's PUBLISHED reviews (newest first).
 *
 * Kept for the compatibility window: `GET /listings/:id/reviews` and
 * `GET /stores/:handle/reviews` are what today's clients call, and #76 migration
 * rule 2 requires them to keep working through the change.
 */
export async function listReviews(
  target: ReviewTarget,
  { page, limit }: ReviewListParams,
): Promise<ReviewPage> {
  const { rows, total } = await findReviewsPage(target, page, limit);
  return hydrate(rows, total);
}

/** List a SCOPED target's PUBLISHED reviews (newest first). */
export async function listScopedReviews(
  scope: ReviewScope,
  targetId: string,
  { page, limit }: ReviewListParams,
): Promise<ReviewPage> {
  const target = scopedTarget(scope, targetId);
  const { rows, total } = await findScopedReviewsPage(target, page, limit);
  return hydrate(rows, total);
}

/**
 * A scoped target's reviews PLUS the aggregate the page displays.
 *
 * One call, so the stars and the list a page renders come from the same read —
 * which is what #75's structured data will mirror, and what its acceptance
 * ("uses only the rating aggregate matching the visible page and target")
 * requires. Deriving the average from the first page of reviews, as the product
 * page did before #76, cannot satisfy that: page one of twelve is not the
 * aggregate.
 */
export async function listScopedReviewsWithAggregate(
  scope: ReviewScope,
  targetId: string,
  params: ReviewListParams,
): Promise<ReviewPage & { aggregate: ScopedRatingAggregate }> {
  const [page, aggregate] = await Promise.all([
    listScopedReviews(scope, targetId, params),
    getOrBuildScopedAggregate(scope, targetId),
  ]);
  return { ...page, aggregate };
}

/**
 * List a store's PRODUCT reviews by its public handle (the Shopify-style store
 * sheet shows the reviews of the store's LISTINGS, each card carrying a product
 * thumbnail + title — NOT the rare store-level reviews).
 *
 * Resolves the store (404 if none) → its listing ids → the published
 * listing-target reviews on those listings (newest first, paginated) → hydrates
 * each review's author AND its minimal product context. Listings are fetched
 * ONCE into a `listingId → ReviewProduct` map (no N+1) and the first image is
 * resolved through the media chokepoint.
 */
export async function listReviewsForStoreHandle(
  handle: string,
  { page, limit }: ReviewListParams,
): Promise<ReviewPage> {
  const store = await findStoreByHandle(handle);
  if (!store) {
    throw notFound('Store not found');
  }

  const listingIds = await findListingIdsByStore(store.id);

  if (listingIds.length === 0) {
    return { data: [], total: 0 };
  }

  const { rows, total } = await findListingReviewsPage(listingIds, page, limit);

  // Every row here has a listing id — the query filtered on `targetType` — but
  // the column is nullable, so the narrowing is done rather than asserted.
  const reviewedListingIds = [
    ...new Set(rows.flatMap((row) => (row.listingId ? [row.listingId] : []))),
  ];

  const [listingDocs, children] = await Promise.all([
    findListingsByIds(reviewedListingIds),
    findListingChildren(reviewedListingIds),
  ]);

  const products = new Map<string, ReviewProduct>();
  for (const listing of listingDocs) {
    const gallery = children.images.get(listing.id) ?? [];
    const firstImage = gallery.find((img) => img.position === 0) ?? gallery[0];
    products.set(listing.id, {
      id: listing.id,
      title: listing.title,
      imageUrl: firstImage ? resolveMedia(firstImage.fileId, 'thumb') : '',
    });
  }

  return hydrate(rows, total, products);
}
