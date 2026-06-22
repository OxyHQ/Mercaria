/**
 * Review DTOs for the Mercaria reviews + ratings flow.
 *
 * A review is written by a verified buyer against ONE target — a `listing`, a
 * `store`, or an individual `seller` — and is gated on a qualifying prior order
 * (you can only review what you have purchased). Reviews drive the denormalized
 * `rating` / `reviewCount` aggregates persisted on the target (`Listing`,
 * `Store`, `SellerProfile`), recomputed whenever a review is created.
 */

import type { Timestamps } from './common';

/** What a review is written against: a single listing, a store, or a P2P seller. */
export type ReviewTargetType = 'listing' | 'store' | 'seller';

/** Minimal author identity rendered on a review (from the Oxy profile). */
export interface ReviewAuthor {
  /** Canonical display name (`name.displayName` from the Oxy profile). */
  displayName: string;
  /** Oxy username. */
  username: string;
  /** Resolved avatar URL, when present. */
  avatar?: string | null;
}

/**
 * A published (or hidden) review of a listing/store/seller, with the relevant
 * target id set and the author hydrated for display.
 */
export interface Review extends Timestamps {
  /** Stable review id. */
  id: string;
  /** Oxy user id of the review author (the buyer). */
  authorOxyUserId: string;
  /** Hydrated author identity, when the Oxy profile resolves. */
  author?: ReviewAuthor;
  /** What this review targets. */
  targetType: ReviewTargetType;
  /** The reviewed listing id, for `targetType: 'listing'`. */
  listingId?: string;
  /** The reviewed store id, for `targetType: 'store'`. */
  storeId?: string;
  /** The reviewed P2P seller's Oxy user id, for `targetType: 'seller'`. */
  sellerOxyUserId?: string;
  /** The qualifying order the review was written against, when supplied. */
  orderId?: string;
  /** Star rating, 1–5. */
  rating: number;
  /** Optional short title. */
  title?: string;
  /** Optional free-text body. */
  body?: string;
  /** Moderation state. `hidden` reviews are excluded from public reads + aggregates. */
  status: 'published' | 'hidden';
}

/** Body for `POST /reviews` — write a review against one target. */
export interface CreateReviewInput {
  /** What to review. */
  targetType: ReviewTargetType;
  /** Required when `targetType` is `'listing'`. */
  listingId?: string;
  /** Required when `targetType` is `'store'`. */
  storeId?: string;
  /** Required when `targetType` is `'seller'`. */
  sellerOxyUserId?: string;
  /** Optional specific qualifying order; otherwise any qualifying order is used. */
  orderId?: string;
  /** Star rating, 1–5. */
  rating: number;
  /** Optional short title. */
  title?: string;
  /** Optional free-text body. */
  body?: string;
}

/** The denormalized rating aggregate persisted on a review target. */
export interface RatingAggregate {
  /** Average star rating (0 when there are no published reviews). */
  rating: number;
  /** Number of published reviews. */
  reviewCount: number;
}
