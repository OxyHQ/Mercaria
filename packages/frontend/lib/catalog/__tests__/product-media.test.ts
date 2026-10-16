import { describe, expect, it } from 'vitest';
import type { ListingMedia } from '@mercaria/shared-types';
import { listingGalleryMedia } from '../product-media';

const photo = { fileId: 'product-photo', position: 0 };
const video: ListingMedia = { kind: 'video', fileId: 'product-video', position: 1 };
const media: ListingMedia[] = [{ ...photo, kind: 'image' }, video];

describe('listing gallery media', () => {
  it('retains the mixed order for a variant with listing fallback', () => {
    expect(
      listingGalleryMedia(
        { images: [photo], media, variants: [] },
        { source: 'listing_fallback', images: [photo] },
      ),
    ).toEqual(media);
  });

  it('retains common media while removing other configurations and duplicate selected photos', () => {
    const blue = { fileId: 'blue-photo', position: 0 };
    const red = { fileId: 'red-photo', position: 2 };
    const selected = { source: 'variant' as const, images: [blue] };
    expect(
      listingGalleryMedia(
        {
          images: [blue, photo, red],
          media: [{ ...blue, kind: 'image' }, ...media, { ...red, kind: 'image' }],
          variants: [
            { images: selected },
            { images: { source: 'variant', images: [red] } },
            { images: { source: 'listing_fallback', images: [blue, photo, red] } },
          ],
        },
        selected,
      ),
    ).toEqual([{ ...blue, kind: 'image' }, { ...photo, kind: 'image' }, video]);
  });

  it('supports existing cached image-only payloads without inventing videos', () => {
    expect(listingGalleryMedia({ images: [photo], variants: [] })).toEqual([
      { ...photo, kind: 'image' },
    ]);
  });

  it('does not resurrect removed media from an older image projection', () => {
    expect(listingGalleryMedia({ images: [photo], media: [], variants: [] })).toEqual([]);
  });

  it('does not rewrite canonical positions or mutate query data', () => {
    const ordered = Object.freeze([video, Object.freeze({ ...photo, kind: 'image' as const })]);
    const result = listingGalleryMedia({ images: [photo], media: ordered, variants: [] });
    expect(result).toEqual(ordered);
    expect(result).not.toBe(ordered);
    expect(result.map((item) => item.position)).toEqual([1, 0]);
  });
});
