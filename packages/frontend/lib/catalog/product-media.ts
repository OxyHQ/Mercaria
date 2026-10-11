import type {
  ListingImage,
  ListingMedia,
  ProductVariantDTO,
  VariantImageResolution,
} from '@mercaria/shared-types';

/** Variant photos describe one configuration; product videos remain common.
 * Older cached payloads have only images. An explicitly empty media collection
 * is authoritative and must not resurrect removed items from that projection. */
export function listingGalleryMedia(
  listing: {
    images: readonly ListingImage[];
    media?: readonly ListingMedia[];
    variants: readonly Pick<ProductVariantDTO, 'images'>[];
  },
  variant?: VariantImageResolution,
): ListingMedia[] {
  const media: readonly ListingMedia[] =
    listing.media ?? listing.images.map((image) => ({ ...image, kind: 'image' }));
  if (variant?.source !== 'variant') return [...media];
  // Shared product photos remain useful (size guides, packaging, details), but
  // a photo explicitly assigned to another configuration must not follow the
  // chosen swatch. A fallback is not an assignment of every listing photo.
  const assignedIds = new Set(variant.images.map((image) => image.fileId));
  for (const candidate of listing.variants) {
    if (candidate.images?.source === 'variant') {
      for (const image of candidate.images.images) assignedIds.add(image.fileId);
    }
  }
  return [
    ...variant.images.map((image): ListingMedia => ({ ...image, kind: 'image' })),
    ...media.filter((item) => item.kind === 'video' || !assignedIds.has(item.fileId)),
  ];
}
