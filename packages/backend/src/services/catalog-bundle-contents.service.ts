import type { ConditionDetailDTO, ProductBundleContents } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { findActiveLinksForListing } from '../db/offers/nativeListingLinkRepository.js';
import { readPublicBundleContentsForVariants } from './canonical/bundle-contents.service.js';

/** Detail-only composition, keyed by the listing's own variant ids. The caller
 * has admitted the public listing and supplies its hydrated variants. Product
 * identity alone cannot establish which pack configuration is being sold. */
export async function readListingBundleContents(
  listingId: string,
  variantIds: readonly string[],
  conditionDetails: readonly Pick<ConditionDetailDTO, 'kind'>[],
): Promise<Record<string, ProductBundleContents>> {
  const ownedVariants = new Set(variantIds);
  const links = (await findActiveLinksForListing(getDb(), listingId)).filter((link) =>
    ownedVariants.has(link.productVariantId),
  );
  const contents = await readPublicBundleContentsForVariants(
    links.map((link) => link.canonicalVariantId),
  );
  const entries: [string, ProductBundleContents][] = [];
  // The catalog describes a complete pack. A seller's disclosed missing parts
  // prevent presenting that original composition as the contents of this copy.
  const incomplete = conditionDetails.some((detail) => detail.kind === 'missing_accessory');
  for (const link of links) {
    const composition = contents.get(link.canonicalVariantId);
    if (composition)
      entries.push([
        link.productVariantId,
        incomplete ? { status: 'withheld', variantId: link.canonicalVariantId } : composition,
      ]);
  }
  return Object.fromEntries(entries);
}
