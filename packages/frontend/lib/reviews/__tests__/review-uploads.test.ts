import { describe, expect, it } from 'vitest';
import {
  reviewMediaKind,
  REVIEW_IMAGE_MAX_BYTES,
  REVIEW_VIDEO_MAX_BYTES,
} from '@mercaria/shared-types';
import { reviewAttachmentFromAsset } from '../review-uploads';

// Metadata boundary tests, not evidence that an upload exists in Oxy storage.
const asset = {
  id: 'uploaded-file',
  ownerUserId: 'author',
  status: 'active' as const,
  visibility: 'public' as const,
  mime: 'image/jpeg',
  size: 123,
};

describe('review upload acceptance', () => {
  it('uses the Oxy ID and media kind after the metadata read', () => {
    expect(reviewAttachmentFromAsset(asset, 'author', asset.id, 'photo.jpg')).toEqual({
      fileId: asset.id,
      name: 'photo.jpg',
      kind: 'image',
    });
    expect(
      reviewAttachmentFromAsset({ ...asset, mime: 'video/webm' }, 'author', asset.id, 'clip.webm')
        ?.kind,
    ).toBe('video');
  });

  it.each([
    { id: 'https://external.invalid/photo.jpg' },
    { id: 'another-file' },
    { ownerUserId: 'other-account' },
    { visibility: 'private' as const },
    { visibility: 'unlisted' as const },
    { visibility: undefined },
    { status: 'trash' as const },
    { status: 'deleted' as const },
    { status: undefined },
    { mime: 'image/svg+xml' },
    { size: 0 },
    { size: REVIEW_IMAGE_MAX_BYTES + 1 },
  ])('withholds unavailable, private, foreign or malformed metadata: %j', (override) => {
    expect(
      reviewAttachmentFromAsset({ ...asset, ...override }, 'author', asset.id, 'photo.jpg'),
    ).toBeUndefined();
  });

  it('uses distinct image/video ceilings and rejects unknown or invalid sizes', () => {
    expect(reviewMediaKind('image/avif', REVIEW_IMAGE_MAX_BYTES)).toBe('image');
    expect(reviewMediaKind('video/mp4', REVIEW_VIDEO_MAX_BYTES)).toBe('video');
    expect(reviewMediaKind('video/mp4', REVIEW_VIDEO_MAX_BYTES + 1)).toBeUndefined();
    for (const size of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(reviewMediaKind('image/png', size)).toBeUndefined();
    }
    expect(reviewMediaKind('application/pdf', 100)).toBeUndefined();
  });
});
