import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ReviewHelpfulness } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../postgres.js';
import { reviewHelpfulVotes, reviews } from '../schema/reviews.js';

/** Hidden reviews and private order-line feedback have no public vote surface. */
const publicReview = () =>
  and(eq(reviews.status, 'published'), ne(reviews.targetType, 'order_item'));

export async function findReviewHelpfulness(
  reviewIds: string[],
  oxyUserId?: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewHelpfulness[]> {
  if (!reviewIds.length) return [];
  const rows = await db
    .select({
      reviewId: reviews.id,
      authorOxyUserId: reviews.authorOxyUserId,
      helpfulnessCount: sql<number>`count(${reviewHelpfulVotes.id})::int`,
      markedAsHelpfulByMe: oxyUserId
        ? sql<boolean>`coalesce(bool_or(${reviewHelpfulVotes.oxyUserId} = ${oxyUserId}), false)`
        : sql<boolean>`false`,
    })
    .from(reviews)
    .leftJoin(reviewHelpfulVotes, eq(reviewHelpfulVotes.reviewId, reviews.id))
    .where(and(inArray(reviews.id, reviewIds), publicReview()))
    .groupBy(reviews.id, reviews.authorOxyUserId);
  return rows.map(({ authorOxyUserId, ...row }) => ({
    ...row,
    canUpdateHelpfulness: Boolean(oxyUserId && authorOxyUserId !== oxyUserId),
  }));
}

/** The lock serializes votes with moderation and makes the returned count exact
 * for this mutation. The caller owns the transaction through the final read. */
export async function lockPublicReviewForHelpfulness(reviewId: string, tx: Transaction) {
  const [review] = await tx
    .select({ id: reviews.id, authorOxyUserId: reviews.authorOxyUserId })
    .from(reviews)
    .where(and(eq(reviews.id, reviewId), publicReview()))
    .for('update');
  return review;
}

/** Desired-state writes are replay-safe; neither retries nor double taps toggle. */
export async function setReviewHelpfulVote(
  reviewId: string,
  oxyUserId: string,
  helpful: boolean,
  tx: Transaction,
) {
  if (helpful) {
    await tx
      .insert(reviewHelpfulVotes)
      .values({ reviewId, oxyUserId })
      .onConflictDoNothing({
        target: [reviewHelpfulVotes.reviewId, reviewHelpfulVotes.oxyUserId],
      });
  } else {
    await tx
      .delete(reviewHelpfulVotes)
      .where(
        and(eq(reviewHelpfulVotes.reviewId, reviewId), eq(reviewHelpfulVotes.oxyUserId, oxyUserId)),
      );
  }
}
