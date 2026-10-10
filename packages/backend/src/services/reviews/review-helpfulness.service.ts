import { z } from 'zod';
import { isLiveEntityId } from '@oxy.so/db';
import { REVIEW_HELPFULNESS_BATCH_LIMIT } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findReviewHelpfulness,
  lockPublicReviewForHelpfulness,
  setReviewHelpfulVote,
} from '../../db/reviews/reviewHelpfulnessRepository.js';
import { forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';

export const reviewHelpfulnessBodySchema = z.strictObject({ helpful: z.boolean() });
const batchQuerySchema = z.strictObject({
  ids: z.string().max(REVIEW_HELPFULNESS_BATCH_LIMIT * 37).transform(value => value.split(','))
    .pipe(z.array(z.string().refine(isLiveEntityId)).min(1).max(REVIEW_HELPFULNESS_BATCH_LIMIT)),
});

export function parseReviewHelpfulnessIds(query: unknown): string[] {
  const result = batchQuerySchema.safeParse(query);
  if (!result.success) throw validationError('Expected up to 50 comma-separated review ids.');
  return [...new Set(result.data.ids)];
}

export async function listReviewHelpfulness(oxyUserId: string, reviewIds: string[]) {
  if (!oxyUserId) throw forbidden('Sign in to read your review votes.');
  if (reviewIds.length > REVIEW_HELPFULNESS_BATCH_LIMIT) throw validationError('Too many review ids.');
  return findReviewHelpfulness(reviewIds, oxyUserId);
}

export async function updateReviewHelpfulness(oxyUserId: string, reviewId: string, helpful: boolean) {
  if (!oxyUserId) throw forbidden('Sign in to mark a review helpful.');
  return getDb().transaction(async tx => {
    const review = await lockPublicReviewForHelpfulness(reviewId, tx);
    if (!review) throw notFound('Review not found.');
    if (review.authorOxyUserId === oxyUserId) throw forbidden('You cannot vote on your own review.');
    await setReviewHelpfulVote(reviewId, oxyUserId, helpful, tx);
    return (await findReviewHelpfulness([reviewId], oxyUserId, tx))[0];
  });
}
