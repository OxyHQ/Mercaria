import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxy.so/db';
import { parseReviewHelpfulnessIds, reviewHelpfulnessBodySchema } from '../review-helpfulness.service.js';

describe('review helpfulness request boundary', () => {
  it('accepts both live id shapes, deduplicates and bounds the batch', () => {
    const id = uuidv7();
    const legacy = 'abcdef0123456789abcdef01';
    expect(parseReviewHelpfulnessIds({ ids: `${id},${legacy},${id}` })).toEqual([id, legacy]);
    expect(parseReviewHelpfulnessIds({ ids: Array.from({ length: 50 }, () => uuidv7()).join(',') })).toHaveLength(50);
  });
  it.each([undefined, {}, { ids: '' }, { ids: 'missing' }, { ids: ['abcdef0123456789abcdef01'] },
    { ids: `${uuidv7()},` }, { ids: uuidv7(), oxyUserId: 'spoofed' },
    { ids: Array.from({ length: 51 }, () => uuidv7()).join(',') }])('refuses malformed or oversized batch %j', query => {
    expect(() => parseReviewHelpfulnessIds(query)).toThrow(expect.objectContaining({ httpStatus: 400 }));
  });
  it('accepts desired boolean state and refuses voter identity or counters supplied by the caller', () => {
    expect(reviewHelpfulnessBodySchema.parse({ helpful: true })).toEqual({ helpful: true });
    expect(reviewHelpfulnessBodySchema.parse({ helpful: false })).toEqual({ helpful: false });
    for (const body of [{}, { helpful: 'true' }, { helpful: 1 }, { helpful: true, oxyUserId: 'spoofed' }, { helpful: true, helpfulnessCount: 100 }]) {
      expect(reviewHelpfulnessBodySchema.safeParse(body).success).toBe(false);
    }
  });
});
