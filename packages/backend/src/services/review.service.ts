/**
 * Review service — verified-purchase reviews + rating aggregates.
 *
 * `createReview` gates on a qualifying prior order (you can only review what you
 * have purchased), enforces one review per buyer per target, recomputes the
 * target's rating aggregate INLINE (so the immediate read is correct) and also
 * enqueues a drift-proof recompute, then fires a best-effort `review_received`
 * notification to the target owner. `recomputeAggregate` derives + persists the
 * denormalized `{ rating, reviewCount }` onto the listing / store / seller
 * profile. `listReviews` returns a hydrated, paginated page.
 *
 * ## Ported to Postgres — three things the database now decides
 *
 *  - **The target is exclusive by CONSTRAINT.** A review names a listing, a store
 *    or a seller, and `reviews_target_exclusivity_check` refuses a row naming two.
 *    Mongoose stated that in prose and enforced it nowhere. The audit that matters
 *    is of the WRITE paths, and there is exactly one: `createReview` resolves a
 *    single `targetId` from the input through {@link resolveTargetId} and hands it
 *    to the repository, which expands it into one set column and two NULLs. No
 *    existing path can produce a row the CHECK would now reject.
 *  - **The duplicate refusal is the constraint, not the pre-check.**
 *    `reviews_author_oxy_user_id_listing_id_key` is a partial unique index on
 *    (author, listing). The pre-check still runs because it produces a clean
 *    CONFLICT for the ordinary case, but two concurrent submissions both pass it
 *    and the index refuses the second — which is caught here and mapped to the
 *    same CONFLICT rather than surfacing as a 500. Store and seller uniqueness
 *    remains service-enforced, exactly as it was: making it a constraint needs a
 *    production duplicate audit first.
 *  - **`hidden` still blocks a second review.** The pre-check is deliberately not
 *    filtered by status, so a review a jury hid cannot be used to buy another
 *    attempt.
 *
 * ## There is no path here that can un-hide a review
 *
 * `reviews.status = 'hidden'` is written by moderation enforcement. This service
 * exposes create + two list functions and no update of any kind, so it has no
 * equivalent of the escape `catalog-write.service.updateListing` closes for
 * `restricted` — there is nothing for a seller to PATCH. Both list paths filter
 * `status = 'published'` and the aggregate counts only published rows, so a
 * hidden review is invisible to readers AND to the rating in one move.
 */

import type {
  CreateReviewInput,
  RatingAggregate,
  Review as ReviewDTO,
  ReviewAuthor,
  ReviewProduct,
  ReviewTargetType,
} from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import {
  aggregatePublishedReviews,
  authorHasReviewedTarget,
  findListingReviewsPage,
  findReviewsPage,
  insertReview,
  type ReviewRecord,
  type ReviewTarget,
} from '../db/buyers/reviewRepository.js';
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
import {
  buyerHasOrderForListing,
  buyerHasOrderFromSeller,
  findOrderById,
  type OrderRecord,
} from '../db/orders/orderRepository.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { enqueueRecomputeAggregate } from '../queue/producers.js';
import { sendNotification } from '../lib/notification-service.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Order statuses that count as a completed/qualifying purchase for a review. */
const PURCHASED_STATUSES = ['paid', 'processing', 'shipped', 'delivered'] as const;

/** Average rating rounded to ONE decimal place. */
function roundRating(avg: number): number {
  return Math.round(avg * 10) / 10;
}

/** Resolve + validate the required target id from the input for its target type. */
function resolveTargetId(input: CreateReviewInput): string {
  switch (input.targetType) {
    case 'listing':
      if (!input.listingId) throw validationError('listingId is required to review a listing');
      return input.listingId;
    case 'store':
      if (!input.storeId) throw validationError('storeId is required to review a store');
      return input.storeId;
    case 'seller':
      if (!input.sellerOxyUserId) {
        throw validationError('sellerOxyUserId is required to review a seller');
      }
      return input.sellerOxyUserId;
  }
}

/** True when the order matches the review target. */
function orderMatchesTarget(
  order: OrderRecord,
  input: CreateReviewInput,
  targetId: string,
): boolean {
  switch (input.targetType) {
    case 'listing':
      return order.items.some((item) => item.listingId === targetId);
    case 'store':
      return order.sellerType === 'store' && order.storeId === targetId;
    case 'seller':
      return order.sellerType === 'user' && order.sellerOxyUserId === targetId;
  }
}

/**
 * Assert the author has a qualifying purchase for the target. When `orderId` is
 * given, that specific order must belong to the author, be in a purchased state,
 * and match the target; otherwise any qualifying order is accepted.
 */
async function assertVerifiedPurchase(
  authorOxyUserId: string,
  input: CreateReviewInput,
  targetId: string,
): Promise<void> {
  if (input.orderId) {
    const order = await findOrderById(input.orderId);
    const qualifies =
      order !== null &&
      order.buyerOxyUserId === authorOxyUserId &&
      (PURCHASED_STATUSES as readonly string[]).includes(order.status) &&
      orderMatchesTarget(order, input, targetId);
    if (!qualifies) {
      throw forbidden('Order does not qualify for this review');
    }
    return;
  }

  // The listing case joins `order_items`; the other two read `orders` alone.
  // Splitting them is what lets each use the index it was built for, rather than
  // one filter shape trying to serve a line-level and an order-level question.
  const found =
    input.targetType === 'listing'
      ? await buyerHasOrderForListing(authorOxyUserId, targetId, PURCHASED_STATUSES)
      : await buyerHasOrderFromSeller(
          authorOxyUserId,
          input.targetType === 'store'
            ? { storeId: targetId }
            : { sellerOxyUserId: targetId },
          PURCHASED_STATUSES,
        );
  if (!found) {
    throw forbidden('You can only review items you have purchased');
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
 * The three target columns arrive NULL rather than absent, which is why each is
 * copied under a truthiness guard: the DTO's optional fields must stay ABSENT for
 * a target this review does not name, not present and null.
 *
 * `products` is an optional map of `listingId → ReviewProduct` used only by the
 * store-reviews serializer to attach minimal product context to each card; it is
 * absent (so `dto.product` stays undefined) on a listing's own reviews page.
 */
function toReviewDTO(
  row: ReviewRecord,
  authorProfiles: Map<string, OxyProfile>,
  products?: Map<string, ReviewProduct>,
): ReviewDTO {
  const dto: ReviewDTO = {
    id: row.id,
    authorOxyUserId: row.authorOxyUserId,
    targetType: row.targetType,
    rating: row.rating,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  const author = toReviewAuthor(authorProfiles.get(row.authorOxyUserId));
  if (author) {
    dto.author = author;
  }
  if (row.listingId) dto.listingId = row.listingId;
  if (row.storeId) dto.storeId = row.storeId;
  if (row.sellerOxyUserId) dto.sellerOxyUserId = row.sellerOxyUserId;
  if (row.orderId) dto.orderId = row.orderId;
  if (row.title) dto.title = row.title;
  if (row.body) dto.body = row.body;
  if (products && row.listingId) {
    const product = products.get(row.listingId);
    if (product) {
      dto.product = product;
    }
  }
  return dto;
}

/**
 * Recompute a review target's `{ rating, reviewCount }` from its PUBLISHED
 * reviews and persist it onto the target row. Returns the new aggregate.
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
 */
async function notifyTargetOwner(
  row: ReviewRecord,
  input: CreateReviewInput,
  targetId: string,
  authorOxyUserId: string,
): Promise<void> {
  try {
    const recipients = new Set<string>();

    if (input.targetType === 'listing') {
      const listing = await findListingById(targetId);
      if (listing?.ownerType === 'user' && listing.oxyUserId) {
        recipients.add(listing.oxyUserId);
      } else if (listing?.ownerType === 'store' && listing.storeId) {
        for (const ownerId of await storeOwnerIds(listing.storeId)) {
          recipients.add(ownerId);
        }
      }
    } else if (input.targetType === 'store') {
      for (const ownerId of await storeOwnerIds(targetId)) {
        recipients.add(ownerId);
      }
    } else {
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
          targetType: input.targetType,
          rating: row.rating,
        },
      });
    }
  } catch (err) {
    log.general.warn({ err, targetType: input.targetType }, 'review_received notification failed (best-effort)');
  }
}

/**
 * Create a review: verified-purchase gate → one-per-target → persist →
 * recompute aggregate (inline + enqueued backstop) → notify owner → return the
 * hydrated DTO.
 */
export async function createReview(
  authorOxyUserId: string,
  input: CreateReviewInput,
): Promise<ReviewDTO> {
  const targetId = resolveTargetId(input);
  const target: ReviewTarget = { targetType: input.targetType, targetId };

  await assertVerifiedPurchase(authorOxyUserId, input, targetId);

  if (await authorHasReviewedTarget(authorOxyUserId, target)) {
    throw conflict('You have already reviewed this item');
  }

  let row: ReviewRecord;
  try {
    row = await insertReview({
      ...target,
      authorOxyUserId,
      rating: input.rating,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.body ? { body: input.body } : {}),
    });
  } catch (err) {
    // The pre-check above is the nice error; this is the one that actually holds.
    // Two concurrent submissions both pass the read, and the partial unique index
    // refuses the second — the same conflict, raised a layer lower.
    if (isUniqueViolation(err, 'reviews_author_oxy_user_id_listing_id_key')) {
      throw conflict('You have already reviewed this item');
    }
    throw err;
  }

  // Recompute the aggregate inline so the immediate read is correct.
  await recomputeAggregate(input.targetType, targetId);

  // Durable, drift-proof backstop. The inline recompute already ran, so a
  // producer throw here is non-fatal — log and continue.
  try {
    await enqueueRecomputeAggregate({ targetType: input.targetType, targetId });
  } catch (err) {
    log.general.warn({ err, targetType: input.targetType, targetId }, 'Failed to enqueue aggregate recompute');
  }

  await notifyTargetOwner(row, input, targetId, authorOxyUserId);

  const authorProfiles = await getProfiles([authorOxyUserId]);
  return toReviewDTO(row, authorProfiles);
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

/**
 * List a target's PUBLISHED reviews (newest first), hydrating authors in ONE
 * batched `getProfiles` call. Returns the page + total count.
 */
export async function listReviews(
  target: ReviewTarget,
  { page, limit }: ReviewListParams,
): Promise<ReviewPage> {
  const { rows, total } = await findReviewsPage(target, page, limit);

  const authorIds = [...new Set(rows.map((row) => row.authorOxyUserId))];
  const authorProfiles = await getProfiles(authorIds);

  return { data: rows.map((row) => toReviewDTO(row, authorProfiles)), total };
}

/**
 * List a store's PRODUCT reviews by its public handle (the Shopify-style store
 * sheet shows the reviews of the store's LISTINGS, each card carrying a product
 * thumbnail + title — NOT the rare `targetType: 'store'` reviews).
 *
 * Resolves the store (404 if none) → its listing ids → the published
 * `targetType: 'listing'` reviews on those listings (newest first, paginated) →
 * hydrates each review's author AND its minimal product context. Listings are
 * fetched ONCE into a `listingId → ReviewProduct` map (no N+1) and the first
 * image is resolved through the media chokepoint.
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

  const authorIds = [...new Set(rows.map((row) => row.authorOxyUserId))];
  // Every row here has a listing id — the query filtered on `targetType` — but
  // the column is nullable, so the narrowing is done rather than asserted.
  const reviewedListingIds = [
    ...new Set(rows.flatMap((row) => (row.listingId ? [row.listingId] : []))),
  ];

  const [authorProfiles, listingDocs, children] = await Promise.all([
    getProfiles(authorIds),
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

  return { data: rows.map((row) => toReviewDTO(row, authorProfiles, products)), total };
}
