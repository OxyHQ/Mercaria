import { describe, expect, it } from 'vitest';
import { REVIEW_SEARCH_MAX_LENGTH } from '@mercaria/shared-types';
import { parseReviewListFilters } from '../review-list-query.js';

describe('review search query boundary', () => {
  it('normalizes empty and surrounding whitespace without rewriting literal search text', () => {
    expect(parseReviewListFilters(undefined)).toEqual({});
    expect(parseReviewListFilters({ query: '  ' })).toEqual({});
    expect(parseReviewListFilters({ query: '  100%_Coverage\\  ' })).toEqual({
      query: '100%_Coverage\\',
    });
    expect(
      parseReviewListFilters({ query: 'a'.repeat(REVIEW_SEARCH_MAX_LENGTH) }).query,
    ).toHaveLength(REVIEW_SEARCH_MAX_LENGTH);
  });

  it.each([null, 123, ['one', 'two'], { term: 'glow' }, 'a'.repeat(REVIEW_SEARCH_MAX_LENGTH + 1)])(
    'refuses malformed or oversized query %j',
    (query) => {
      expect(() => parseReviewListFilters({ query })).toThrow(
        expect.objectContaining({ httpStatus: 400 }),
      );
    },
  );
});

describe('review rating and order boundary', () => {
  it('normalizes a multi-rating selection and accepts explicit order', () => {
    expect(parseReviewListFilters({ ratings: '5,1,5', sortBy: 'rating_asc' })).toEqual({
      ratings: [1, 5],
      sortBy: 'rating_asc',
    });
  });
  it.each(['', '0', '6', '1.5', '5,', '1,2,3,4,5,1', ['5'], { value: '5' }, 5])(
    'refuses malformed ratings %j',
    (ratings) => {
      expect(() => parseReviewListFilters({ ratings })).toThrow(
        expect.objectContaining({ httpStatus: 400 }),
      );
    },
  );
  it.each(['recommended', '', ['newest'], 1])(
    'refuses unknown or malformed ordering %j',
    (sortBy) => {
      expect(() => parseReviewListFilters({ sortBy })).toThrow(
        expect.objectContaining({ httpStatus: 400 }),
      );
    },
  );
});
