import { describe, expect, it } from 'vitest';
import { REVIEW_SEARCH_MAX_LENGTH } from '@mercaria/shared-types';
import { parseReviewListFilters } from '../review-list-query.js';

describe('review search query boundary', () => {
  it('normalizes empty and surrounding whitespace without rewriting literal search text', () => {
    expect(parseReviewListFilters(undefined)).toEqual({});
    expect(parseReviewListFilters('  ')).toEqual({});
    expect(parseReviewListFilters('  100%_Coverage\\  ')).toEqual({ query: '100%_Coverage\\' });
    expect(parseReviewListFilters('a'.repeat(REVIEW_SEARCH_MAX_LENGTH)).query).toHaveLength(REVIEW_SEARCH_MAX_LENGTH);
  });

  it.each([null, 123, ['one', 'two'], { term: 'glow' }, 'a'.repeat(REVIEW_SEARCH_MAX_LENGTH + 1)])('refuses malformed or oversized query %j', query => {
    expect(() => parseReviewListFilters(query)).toThrow(expect.objectContaining({ httpStatus: 400 }));
  });
});
