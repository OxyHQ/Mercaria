/**
 * Mercaria reviews, as universal material.
 *
 * A review is the one place in a marketplace where a BUYER writes prose, so it is
 * the subject whose allegations look most like a social network's — harassment in
 * a review body, a competitor's fake one-star, a slur aimed at a seller.
 *
 * The rating travels with the text as context, because it changes what the words
 * mean: the same sentence is ordinary criticism attached to two stars and
 * plausible retaliation attached to one from an account with no order behind it.
 * `verifiedPurchase` is included for the same reason — it is the single strongest
 * signal for the "fake review" allegation, and it is a fact Mercaria owns rather
 * than an inference it is making on the jury's behalf.
 *
 * The reviewed OBJECT is not included. A jury judging a review is judging what the
 * reviewer wrote, and pulling in the listing they wrote it about would expose a
 * second person's material to answer a question about the first — more exposure
 * than the question needs.
 */

import mongoose from 'mongoose';
import { Review, type IReview } from '../../../models/review.js';
import { config } from '../../../config/index.js';
import type {
  ModerationContextResource,
  ModerationResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types.js';

const MAX_TEXT_LENGTH = 4_000;

const SNAPSHOT_PROJECTION =
  'authorOxyUserId targetType listingId storeId sellerOxyUserId orderId rating title body status createdAt';

type SnapshotReview = Pick<
  IReview,
  | '_id'
  | 'authorOxyUserId'
  | 'targetType'
  | 'listingId'
  | 'rating'
  | 'title'
  | 'body'
  | 'orderId'
  | 'createdAt'
>;

async function loadReview(reviewId: string): Promise<SnapshotReview | null> {
  if (!mongoose.isValidObjectId(reviewId)) return null;
  return await Review.findById(reviewId)
    .select(SNAPSHOT_PROJECTION)
    .lean<SnapshotReview | null>();
}

/**
 * The review body.
 *
 * `null` when the reviewer left only stars. A star rating is not material a jury
 * can judge for harassment or hate, and a report about one is answerable only as
 * `insufficient_context` — so the snapshot says what the review consisted of
 * rather than sending an empty text resource, which the contract rejects anyway.
 */
function reviewText(review: SnapshotReview): string | null {
  const title = review.title?.trim() ?? '';
  const body = review.body?.trim() ?? '';
  if (!title && !body) return null;
  const text = title && body ? `${title}\n\n${body}` : title || body;
  return text.slice(0, MAX_TEXT_LENGTH);
}

function ratingOnlySubject(review: SnapshotReview): ModerationResource {
  return {
    type: 'metadata',
    data: {
      bodyText: 'absent',
      rating: review.rating,
      evidenceAttached: false,
    },
  };
}

function ratingContext(review: SnapshotReview): ModerationContextResource {
  return {
    role: 'context',
    type: 'metadata',
    data: {
      rating: review.rating,
      targetType: review.targetType,
      /**
       * Whether an order backs this review. `Review.orderId` is set by the
       * verified-purchase path, so its ABSENCE is the fake-review signal — stated
       * as the fact Mercaria holds, not as a verdict about the reviewer.
       */
      verifiedPurchase: review.orderId !== undefined,
    },
  };
}

/**
 * Where Mercaria's own users see it.
 *
 * A review has no page of its own; it is read on the listing it is about. A
 * listing-scoped review therefore points at that product, and one that is not
 * (a store or seller review) has no permalink at all rather than a fabricated
 * one — an unresolvable link is worse than none, because it looks like evidence
 * somebody could go and check.
 */
function permalink(review: SnapshotReview): string | undefined {
  return review.listingId === undefined
    ? undefined
    : `${config.web.origin}/products/${review.listingId}`;
}

export function createReviewSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: 'review',
    subjectType: 'commerce.review',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      const review = await loadReview(reportedId);
      if (!review) return null;

      const text = reviewText(review);
      const link = permalink(review);

      const content: ModerationResource =
        text === null
          ? ratingOnlySubject(review)
          : {
              type: 'text',
              data: { text },
              ...(review.createdAt === undefined
                ? {}
                : { createdAt: new Date(review.createdAt) }),
            };

      return {
        subject: {
          externalId: review._id.toHexString(),
          type: 'commerce.review',
          ...(link === undefined ? {} : { permalink: link }),
          author: { oxyUserId: review.authorOxyUserId },
        },
        content,
        context: [ratingContext(review)],
      };
    },
  };
}
