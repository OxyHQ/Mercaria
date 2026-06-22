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
  ReviewTargetType,
} from '@mercaria/shared-types';
import { Review, type IReview } from '../models/review.js';
import { Order, type IOrder } from '../models/order.js';
import { Listing, type IListing } from '../models/listing.js';
import { Store, type IStore } from '../models/store.js';
import { SellerProfile } from '../models/seller-profile.js';
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
function orderMatchesTarget(order: IOrder, input: CreateReviewInput, targetId: string): boolean {
  switch (input.targetType) {
    case 'listing':
      return order.items.some((item) => String(item.listingId) === targetId);
    case 'store':
      return order.sellerType === 'store' && String(order.storeId) === targetId;
    case 'seller':
      return order.sellerType === 'user' && String(order.sellerOxyUserId) === targetId;
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
    const order = await Order.findById(input.orderId).lean<IOrder | null>();
    const qualifies =
      order !== null &&
      String(order.buyerOxyUserId) === authorOxyUserId &&
      (PURCHASED_STATUSES as readonly string[]).includes(order.status) &&
      orderMatchesTarget(order, input, targetId);
    if (!qualifies) {
      throw forbidden('Order does not qualify for this review');
    }
    return;
  }

  const baseFilter = {
    buyerOxyUserId: authorOxyUserId,
    status: { $in: PURCHASED_STATUSES as readonly string[] },
  };
  const filter: Record<string, unknown> =
    input.targetType === 'listing'
      ? { ...baseFilter, 'items.listingId': targetId }
      : input.targetType === 'store'
        ? { ...baseFilter, sellerType: 'store', storeId: targetId }
        : { ...baseFilter, sellerType: 'user', sellerOxyUserId: targetId };

  const found = await Order.findOne(filter).lean<IOrder | null>();
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

/** Map a persisted review doc + the resolved author profile to the `Review` DTO. */
function toReviewDTO(doc: IReview, authorProfiles: Map<string, OxyProfile>): ReviewDTO {
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
  const update = { $set: { rating, reviewCount } };

  switch (targetType) {
    case 'listing':
      await Listing.updateOne({ _id: targetId }, update);
      break;
    case 'store':
      await Store.updateOne({ _id: targetId }, update);
      break;
    case 'seller':
      await SellerProfile.updateOne({ oxyUserId: targetId }, update, { upsert: true });
      break;
  }

  return { rating, reviewCount };
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
      const listing = await Listing.findById(targetId)
        .select('ownerType oxyUserId storeId')
        .lean<Pick<IListing, 'ownerType' | 'oxyUserId' | 'storeId'> | null>();
      if (listing?.ownerType === 'user' && listing.oxyUserId) {
        recipients.add(String(listing.oxyUserId));
      } else if (listing?.ownerType === 'store' && listing.storeId) {
        const store = await Store.findById(listing.storeId).select('members').lean<Pick<IStore, 'members'> | null>();
        for (const member of store?.members ?? []) {
          if (member.role === 'owner') recipients.add(member.oxyUserId);
        }
      }
    } else if (input.targetType === 'store') {
      const store = await Store.findById(targetId).select('members').lean<Pick<IStore, 'members'> | null>();
      for (const member of store?.members ?? []) {
        if (member.role === 'owner') recipients.add(member.oxyUserId);
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
  const filter = {
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
 * List a store's reviews by its public handle. Resolves the store first (404 if
 * none), then delegates to {@link listReviews}.
 */
export async function listReviewsForStoreHandle(
  handle: string,
  pagination: ReviewListParams,
): Promise<ReviewPage> {
  const store = await Store.findOne({ handle }).select('_id').lean<{ _id: mongoose.Types.ObjectId } | null>();
  if (!store) {
    throw notFound('Store not found');
  }
  return listReviews({ targetType: 'store', targetId: String(store._id) }, pagination);
}
