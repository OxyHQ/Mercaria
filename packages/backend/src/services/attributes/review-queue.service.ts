/**
 * The review queue for values a person has to settle (#94 coverage rule 2).
 *
 * Thin on purpose. Opening a review is the observation path's job (it is the
 * only place that knows a conflict just happened, and it must write the review
 * in the SAME transaction as the conflict); this module is the operator side —
 * read the queue, resolve an entry.
 *
 * Resolving is deliberately TWO acts that a caller composes: choosing which
 * recorded value becomes the selected one
 * ({@link import('./attribute-observation.service.js').selectAttributeValue}),
 * and closing the review. Fusing them would make "dismiss this, none of these
 * values is right" unrepresentable, and that is a real and common outcome — a
 * conflict whose correct resolution is that both sources are wrong and the
 * attribute stays empty.
 */

import type { AttributeReviewState } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  closeAttributeReview,
  findAttributeReviewById,
  listOpenAttributeReviews,
  type AttributeValueReviewRow,
} from '../../db/attributes/attributeOpsRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { selectAttributeValue } from './attribute-observation.service.js';

export interface ListReviewsOptions {
  attributeKey?: string;
  limit?: number;
  offset?: number;
}

/** The open queue, highest priority and oldest first. */
export async function listAttributeReviewQueue(
  options: ListReviewsOptions = {},
): Promise<AttributeValueReviewRow[]> {
  return listOpenAttributeReviews(getDb(), {
    ...(options.attributeKey === undefined ? {} : { attributeKey: options.attributeKey }),
    limit: Math.min(Math.max(options.limit ?? 50, 1), 200),
    offset: Math.max(options.offset ?? 0, 0),
  });
}

export interface ResolveReviewInput {
  reviewId: string;
  actorOxyUserId: string;
  /** The recorded value to show. Omit to DISMISS — see the module header. */
  selectedValueId?: string;
  state: AttributeReviewState & ('resolved' | 'dismissed');
}

/**
 * Close one review, optionally selecting the value that settles it.
 *
 * The selection runs FIRST and in its own transaction, because it is the act
 * with consequences (it moves what a product page shows and enqueues a reindex);
 * closing the review is bookkeeping about a decision already taken. Doing them
 * in the other order would leave a closed review with no selection if the
 * selection then failed — a resolved-looking queue entry over an unresolved
 * conflict, which is the one state an operator must never be shown.
 */
export async function resolveAttributeReview(
  input: ResolveReviewInput,
): Promise<AttributeValueReviewRow> {
  if (input.actorOxyUserId.trim().length === 0) {
    throw validationError('resolveAttributeReview: an actor is required.');
  }
  if (input.state === 'resolved' && input.selectedValueId === undefined) {
    throw validationError(
      'Resolving a review names the value that settles it; to close one without choosing a value, dismiss it.',
    );
  }

  const existing = await findAttributeReviewById(getDb(), input.reviewId);
  if (!existing) throw notFound(`Attribute review ${input.reviewId} does not exist.`);
  if (existing.state !== 'open') {
    throw conflict(`Attribute review ${input.reviewId} is already '${existing.state}'.`);
  }

  if (input.selectedValueId !== undefined) {
    await selectAttributeValue(input.selectedValueId, input.actorOxyUserId);
  }

  const closed = await closeAttributeReview(getDb(), input.reviewId, {
    state: input.state,
    resolvedByOxyUserId: input.actorOxyUserId,
    ...(input.selectedValueId === undefined ? {} : { resolvedValueId: input.selectedValueId }),
  });
  if (!closed) {
    // The CAS lost: another operator closed it between the read and the write.
    // A conflict rather than a silent success, because the two operators made
    // two different decisions and only one of them is recorded.
    throw conflict(`Attribute review ${input.reviewId} was closed by somebody else.`);
  }
  return closed;
}
