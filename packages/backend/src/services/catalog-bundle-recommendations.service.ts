import type { Listing, ListingBundleRecommendation } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { findListingBundleCandidates } from '../db/catalog/bundleRecommendationsRepository.js';
import { findListingsByIds } from '../db/catalog/listingRepository.js';
import { hydrateListings } from './catalog-hydration.service.js';
import { readPublicBundleContentsForVariants } from './canonical/bundle-contents.service.js';

/** Detail-only: real packs containing this exact configuration, sold by the
 * same seller. All candidate listings and pack compositions are read in batches. */
export async function readListingBundleRecommendations(listing: {
  id: Listing['id'];
  variants: readonly Pick<Listing['variants'][number], 'id'>[];
}): Promise<Record<string, ListingBundleRecommendation[]>> {
  const candidates = await findListingBundleCandidates(
    getDb(),
    listing.id,
    listing.variants.map((variant) => variant.id),
  );
  if (candidates.length === 0) return {};
  const [rows, compositions] = await Promise.all([
    findListingsByIds([...new Set(candidates.map((candidate) => candidate.listingId))]),
    readPublicBundleContentsForVariants([
      ...new Set(candidates.map((candidate) => candidate.canonicalVariantId)),
    ]),
  ]);
  const hydrated = await hydrateListings(rows.filter((row) => row.status === 'active'));
  const byId = new Map(hydrated.map((item) => [item.id, item]));
  const result: Record<string, ListingBundleRecommendation[]> = {};
  for (const candidate of candidates) {
    if (compositions.get(candidate.canonicalVariantId)?.status !== 'available') continue;
    const pack = byId.get(candidate.listingId);
    if (!pack || pack.itemCondition.details.some((detail) => detail.kind === 'missing_accessory'))
      continue;
    const variant = pack.variants.find((item) => item.id === candidate.variantId);
    if (!variant?.inStock) continue;
    const image = variant.images?.images[0] ?? pack.images[0];
    const compareAtPrice = variant.compareAtPrice;
    const card: ListingBundleRecommendation = {
      listingId: pack.id,
      variantId: variant.id,
      title: pack.title,
      price: variant.price,
      ...(compareAtPrice &&
      compareAtPrice.currency === variant.price.currency &&
      compareAtPrice.amount > variant.price.amount
        ? { compareAtPrice }
        : {}),
      ...(image ? { image } : {}),
      action: pack.variants.length === 1 ? 'add_to_cart' : 'view_bundle',
    };
    (result[candidate.sourceVariantId] ??= []).push(card);
  }
  return result;
}
