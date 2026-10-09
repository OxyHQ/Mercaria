import { REVIEW_SEARCH_MAX_LENGTH, type ReviewListFilters } from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** Query-string boundary: arrays/objects are not silently coerced into text. */
export function parseReviewListFilters(query: unknown): ReviewListFilters {
  if (query === undefined) return {};
  if (typeof query !== 'string' || query.length > REVIEW_SEARCH_MAX_LENGTH) {
    throw validationError(`Review search must be a string of at most ${REVIEW_SEARCH_MAX_LENGTH} characters`);
  }
  const text = query.trim();
  return text ? { query: text } : {};
}
