import { SHOPPER_VISIBLE_CATALOG_STATUSES, type Listing } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { findActiveLinksForListing } from '../db/offers/nativeListingLinkRepository.js';
import { findCanonicalVariantsByIds } from '../db/canonical/canonicalVariantRepository.js';
import { findCanonicalProductsByIds } from '../db/canonical/canonicalProductRepository.js';

/** Expose the persisted attachment, never infer a configuration from an option
 * label or a product-level barcode match. No matcher evidence reaches the DTO. */
export async function readListingCatalogIdentities(
  listingId: string,
  variantIds: readonly string[],
): Promise<NonNullable<Listing['catalogIdentityByVariant']>> {
  if (variantIds.length === 0) return {};
  const db = getDb();
  const owned = new Set(variantIds);
  const links = (await findActiveLinksForListing(db, listingId)).filter((link) =>
    owned.has(link.productVariantId),
  );
  const variants = new Map(
    (
      await findCanonicalVariantsByIds(
        db,
        links.map((link) => link.canonicalVariantId),
      )
    )
      .filter((variant) => SHOPPER_VISIBLE_CATALOG_STATUSES.includes(variant.status))
      .map((variant) => [variant.id, variant]),
  );
  const products = new Map(
    (
      await findCanonicalProductsByIds(db, [
        ...new Set([...variants.values()].map((variant) => variant.productId)),
      ])
    )
      .filter((product) => SHOPPER_VISIBLE_CATALOG_STATUSES.includes(product.status))
      .map((product) => [product.id, product]),
  );
  const result: NonNullable<Listing['catalogIdentityByVariant']> = {};
  for (const link of links) {
    const variant = variants.get(link.canonicalVariantId);
    const product = variant && products.get(variant.productId);
    if (!variant || !product) continue;
    result[link.productVariantId] = {
      productId: product.id,
      variantId: variant.id,
      ...(product.categoryId ? { categoryId: product.categoryId } : {}),
    };
  }
  return result;
}
