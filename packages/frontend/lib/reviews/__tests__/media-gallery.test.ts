import { describe, expect, it } from 'vitest';
import type { ReviewMediaItem } from '@mercaria/shared-types';
import { reviewMediaEntries, reviewMediaIndex } from '../media-gallery';

// Pure DTO tests; these IDs do not stand in for an uploaded image in a browser.
function entry(id: string): ReviewMediaItem {
  const media = { id, fileId: `file-${id}`, kind: 'image' as const, position: 0 };
  return {
    media,
    review: {
      id: `review-${id}`,
      authorOxyUserId: 'author',
      targetType: 'canonical_product',
      canonicalProductId: 'product',
      verification: 'verified_purchase',
      rating: 5,
      classificationState: 'native',
      incentiveDisclosure: 'none',
      status: 'published',
      media: [media],
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
  };
}

describe('review media gallery identity', () => {
  it('deduplicates overlapping pages without losing their review association', () => {
    const first = entry('first');
    const second = entry('second');
    expect(reviewMediaEntries([first, first, second])).toEqual([first, second]);
  });
  it('keeps selection on its attachment when an earlier page changes', () => {
    const first = entry('first');
    const second = entry('second');
    expect(reviewMediaIndex([first, second], second.media.id)).toBe(1);
    expect(reviewMediaIndex([second], second.media.id)).toBe(0);
    expect(reviewMediaIndex([first], second.media.id)).toBe(-1);
  });
  it('withholds external media, hidden/private parents and mismatched attachment ownership', () => {
    const external = entry('external');
    external.media.fileId = 'https://supplier.example/photo.jpg';
    const hidden = entry('hidden');
    hidden.review.status = 'hidden';
    const privateEntry = entry('private');
    privateEntry.review.targetType = 'order_item';
    const detached = entry('detached');
    detached.review.media = [];
    expect(reviewMediaEntries([external, hidden, privateEntry, detached])).toEqual([]);
  });
});
