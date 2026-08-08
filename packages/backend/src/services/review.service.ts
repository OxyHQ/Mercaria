/**
 * Review service — verified-purchase reviews + rating aggregates.
 *
 * `createReview` gates on a qualifying prior order (you can only review what you
 * have purchased), enforces one review per buyer per target, recomputes the
 * target's rating aggregate INLINE (so the immediate read is correct) and also
 * enqueues a drift-proof recompute, then fires a best-effort `review_received`
 * notification to the target owner. `recomputeAggregate` derives + persists the
 * denormalized `{ rating, reviewCount }` onto the `Listing` / `Store` /
 * `SellerProfile`. `listReviews` returns a hydrated, paginated page.
 *
 * Cross-collection ids (`listingId`, `storeId`, `orderId`) are stored/queried as
 * `String`, consistent with the rest of the codebase.
 */

import mongoose from 'mongoose';
import type {
  CreateReviewInput,
  RatingAggregate,
  Review as ReviewDTO,
  ReviewAuthor,
  ReviewProduct,
  ReviewTargetType,
} from '@mercaria/shared-types';
import { Review, type IReview } from '../models/review.js';
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

/** A Mongo filter document (Mongoose 9 dropped the `FilterQuery` export). */
type ReviewFilter = Record<string, unknown>;

/** Average rating rounded to ONE decimal place. */
function roundRating(avg: number): number {
  return Math.round(avg * 10) / 10;
}

/** The persisted target-id field name for a target type. */
function targetIdField(targetType: ReviewTargetType): 'listingId' | 'storeId' | 'sellerOxyUserId' {
  switch (targetType) {
    case 'listing':
      return 'listingId';
    case 'store':
      return 'storeId';
    case 'seller':
      return 'sellerOxyUserId';
  }
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
 * Map a persisted review doc + the resolved author profile to the `Review` DTO.
 *
 * `products` is an optional map of `listingId → ReviewProduct` used only by the
 * store-reviews serializer to attach minimal product context to each card; it is
 * absent (so `dto.product` stays undefined) on a listing's own reviews page.
 */
function toReviewDTO(
  doc: IReview,
  authorProfiles: Map<string, OxyProfile>,
  products?: Map<string, ReviewProduct>,
): ReviewDTO {
  const authorOxyUserId = String(doc.authorOxyUserId);
  const dto: ReviewDTO = {
    id: String((doc as { _id: mongoose.Types.ObjectId })._id),
    authorOxyUserId,
    targetType: doc.targetType,
    rating: doc.rating,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
  const author = toReviewAuthor(authorProfiles.get(authorOxyUserId));
  if (author) {
    dto.author = author;
  }
  if (doc.listingId) dto.listingId = String(doc.listingId);
  if (doc.storeId) dto.storeId = String(doc.storeId);
  if (doc.sellerOxyUserId) dto.sellerOxyUserId = String(doc.sellerOxyUserId);
  if (doc.orderId) dto.orderId = String(doc.orderId);
  if (doc.title) dto.title = doc.title;
  if (doc.body) dto.body = doc.body;
  if (products && doc.listingId) {
    const product = products.get(String(doc.listingId));
    if (product) {
      dto.product = product;
    }
  }
  return dto;
}

/**
 * Recompute a review target's `{ rating, reviewCount }` from its PUBLISHED
 * reviews and persist it onto the target model. Returns the new aggregate.
 */
export async function recomputeAggregate(
  targetType: ReviewTargetType,
  targetId: string,
): Promise<RatingAggregate> {
  const match: Record<string, unknown> = {
    targetType,
    [targetIdField(targetType)]: targetId,
    status: 'published',
  };

  const [group] = await Review.aggregate<{ avg: number; count: number }>([
    { $match: match },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);

  const reviewCount = group?.count ?? 0;
  const rating = group && reviewCount > 0 ? roundRating(group.avg) : 0;

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
  doc: IReview,
  input: CreateReviewInput,
  targetId: string,
  authorOxyUserId: string,
): Promise<void> {
  try {
    const recipients = new Set<string>();

    if (input.targetType === 'listing') {
      const listing = await findListingById(targetId);
      if (listing?.ownerType === 'user' && listing.oxyUserId) {
        recipients.add(String(listing.oxyUserId));
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
        body: `You received a ${doc.rating}-star review.`,
        data: {
          reviewId: String((doc as { _id: mongoose.Types.ObjectId })._id),
          targetType: input.targetType,
          rating: doc.rating,
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

  await assertVerifiedPurchase(authorOxyUserId, input, targetId);

  const existing = await Review.findOne({
    authorOxyUserId,
    targetType: input.targetType,
    [targetIdField(input.targetType)]: targetId,
  }).lean<IReview | null>();
  if (existing) {
    throw conflict('You have already reviewed this item');
  }

  const createDoc: Record<string, unknown> = {
    authorOxyUserId,
    targetType: input.targetType,
    [targetIdField(input.targetType)]: targetId,
    rating: input.rating,
    status: 'published',
  };
  if (input.orderId) createDoc.orderId = input.orderId;
  if (input.title) createDoc.title = input.title;
  if (input.body) createDoc.body = input.body;

  let doc: IReview;
  try {
    const created = await Review.create(createDoc);
    doc = created.toObject<IReview>();
  } catch (err) {
    // Belt-and-suspenders: the listing partial-unique index can race past the
    // pre-check; map the duplicate-key error to the same clean conflict.
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
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

  await notifyTargetOwner(doc, input, targetId, authorOxyUserId);

  const authorProfiles = await getProfiles([authorOxyUserId]);
  return toReviewDTO(doc, authorProfiles);
}

/** Target descriptor for a review list. */
interface ReviewTarget {
  targetType: ReviewTargetType;
  targetId: string;
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
  { targetType, targetId }: ReviewTarget,
  { page, limit }: ReviewListParams,
): Promise<ReviewPage> {
  const filter: ReviewFilter = {
    targetType,
    [targetIdField(targetType)]: targetId,
    status: 'published',
  };

  const [docs, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IReview[]>(),
    Review.countDocuments(filter),
  ]);

  const authorIds = [...new Set(docs.map((d) => String(d.authorOxyUserId)))];
  const authorProfiles = await getProfiles(authorIds);

  return { data: docs.map((d) => toReviewDTO(d, authorProfiles)), total };
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

  const storeId = store.id;
  const listingIds = await findListingIdsByStore(storeId);

  if (listingIds.length === 0) {
    return { data: [], total: 0 };
  }

  const filter: ReviewFilter = {
    targetType: 'listing',
    listingId: { $in: listingIds },
    status: 'published',
  };

  const [docs, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IReview[]>(),
    Review.countDocuments(filter),
  ]);

  const authorIds = [...new Set(docs.map((d) => String(d.authorOxyUserId)))];
  const reviewedListingIds = [
    ...new Set(docs.map((d) => (d.listingId ? String(d.listingId) : '')).filter(Boolean)),
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

  return { data: docs.map((d) => toReviewDTO(d, authorProfiles, products)), total };
}
