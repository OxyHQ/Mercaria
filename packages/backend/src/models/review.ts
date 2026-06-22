/**
 * Review model — a verified buyer's review of ONE target.
 *
 * A review targets a `listing`, a `store`, or a P2P `seller`; exactly the
 * matching target-id field is set. Cross-collection references (`listingId`,
 * `storeId`, `orderId`) are stored as `String` — consistent with the rest of
 * the codebase (`order.listingId/storeId`, `listing.storeId`,
 * `product-variant.listingId`); no mongoose `ref` is used for these, matching
 * the existing convention. `rating` is bounded 1–5. A partial unique index
 * enforces one review per buyer per listing; store/seller uniqueness is
 * enforced in the service layer.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { ReviewTargetType } from '@mercaria/shared-types';

const TARGET_TYPES: readonly ReviewTargetType[] = ['listing', 'store', 'seller'];
const REVIEW_STATUSES = ['published', 'hidden'] as const;

/** Lowest allowed star rating. */
const MIN_RATING = 1;
/** Highest allowed star rating. */
const MAX_RATING = 5;

export interface IReview {
  _id: mongoose.Types.ObjectId;
  authorOxyUserId: string;
  targetType: ReviewTargetType;
  listingId?: string;
  storeId?: string;
  sellerOxyUserId?: string;
  orderId?: string;
  rating: number;
  title?: string;
  body?: string;
  status: (typeof REVIEW_STATUSES)[number];
  createdAt: Date;
  updatedAt: Date;
}

const ReviewSchema = new Schema<IReview>(
  {
    authorOxyUserId: { type: String, required: true },
    targetType: { type: String, enum: TARGET_TYPES as string[], required: true },
    listingId: { type: String },
    storeId: { type: String },
    sellerOxyUserId: { type: String },
    orderId: { type: String },
    rating: { type: Number, required: true, min: MIN_RATING, max: MAX_RATING },
    title: { type: String },
    body: { type: String },
    status: { type: String, enum: REVIEW_STATUSES as unknown as string[], default: 'published' },
  },
  { timestamps: true },
);

// Per-target read indexes (filter by target + published, newest first).
ReviewSchema.index({ targetType: 1, listingId: 1, status: 1, createdAt: -1 });
ReviewSchema.index({ targetType: 1, storeId: 1, status: 1, createdAt: -1 });
ReviewSchema.index({ targetType: 1, sellerOxyUserId: 1, status: 1, createdAt: -1 });

// One review per buyer per listing (only when a listing id is present).
ReviewSchema.index(
  { authorOxyUserId: 1, listingId: 1 },
  { unique: true, partialFilterExpression: { listingId: { $exists: true } } },
);

export const Review: Model<IReview> =
  mongoose.models.Review || mongoose.model<IReview>('Review', ReviewSchema);
