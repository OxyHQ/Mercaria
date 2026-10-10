import { REVIEW_SEARCH_MAX_LENGTH, REVIEW_SORT_ORDERS, type ReviewListFilters, type ReviewSortOrder } from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** Query-string boundary: arrays/objects are not silently coerced into text. */
export function parseReviewListFilters({ query, sortBy, ratings }: {
  query?: unknown;
  sortBy?: unknown;
  ratings?: unknown;
} = {}): ReviewListFilters {
  const filters: ReviewListFilters = {};
  if (query !== undefined && (typeof query !== 'string' || query.length > REVIEW_SEARCH_MAX_LENGTH)) {
    throw validationError(`Review search must be a string of at most ${REVIEW_SEARCH_MAX_LENGTH} characters`);
  }
  const text = typeof query === 'string' ? query.trim() : '';
  if (text) filters.query = text;
  if (sortBy !== undefined) {
    if (typeof sortBy !== 'string' || !REVIEW_SORT_ORDERS.includes(sortBy as ReviewSortOrder)) {
      throw validationError('Invalid review sort order');
    }
    filters.sortBy = sortBy as ReviewSortOrder;
  }
  if (ratings !== undefined) {
    // One comma-separated parameter avoids Express/HTTP-client array ambiguity.
    if (typeof ratings !== 'string' || !/^[1-5](,[1-5]){0,4}$/.test(ratings)) {
      throw validationError('Review ratings must be up to five comma-separated stars from 1 to 5');
    }
    filters.ratings = [...new Set(ratings.split(',').map(Number))].sort();
  }
  return filters;
}
