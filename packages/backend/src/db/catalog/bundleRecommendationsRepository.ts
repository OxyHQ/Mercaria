import { and, asc, eq, gt, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { SHOPPER_VISIBLE_CATALOG_STATUSES } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { listings, productVariants } from '../schema/catalog.js';
import { bundleComponents, canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { nativeListingLinks } from '../schema/offers.js';

/** Reverse the exact component relationship, within the same seller. The cap
 * applies PER source configuration, so a large option set cannot crowd out its
 * later variants. Stock and prices belong to the pack, never its components. */
export async function findListingBundleCandidates(db: DatabaseOrTransaction, listingId: string, variantIds: readonly string[]) {
  if (variantIds.length === 0) return [];
  const componentLink = alias(nativeListingLinks, 'component_link');
  const componentNative = alias(productVariants, 'component_native');
  const componentListing = alias(listings, 'component_listing');
  const componentVariant = alias(canonicalVariants, 'component_variant');
  const componentProduct = alias(canonicalProducts, 'component_product');
  const candidates = db.select({
    sourceVariantId: sql<string>`${componentLink.productVariantId}`.as('source_variant_id'),
    listingId: sql<string>`${listings.id}`.as('bundle_listing_id'),
    variantId: sql<string>`${productVariants.id}`.as('bundle_native_variant_id'),
    canonicalVariantId: sql<string>`${canonicalVariants.id}`.as('bundle_canonical_variant_id'),
    rank: sql<number>`row_number() over (partition by ${componentLink.productVariantId} order by ${listings.createdAt} desc, ${productVariants.id})`.as('candidate_rank'),
  }).from(componentLink)
    .innerJoin(componentNative, and(eq(componentNative.id, componentLink.productVariantId), eq(componentNative.listingId, listingId)))
    .innerJoin(componentListing, eq(componentListing.id, componentNative.listingId))
    .innerJoin(componentVariant, eq(componentVariant.id, componentLink.canonicalVariantId))
    .innerJoin(componentProduct, eq(componentProduct.id, componentVariant.productId))
    .innerJoin(bundleComponents, eq(bundleComponents.componentVariantId, componentLink.canonicalVariantId))
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, bundleComponents.bundleVariantId))
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalVariants.productId))
    .innerJoin(nativeListingLinks, and(eq(nativeListingLinks.canonicalVariantId, canonicalVariants.id), eq(nativeListingLinks.status, 'active')))
    .innerJoin(productVariants, and(eq(productVariants.id, nativeListingLinks.productVariantId), eq(productVariants.listingId, nativeListingLinks.listingId)))
    .innerJoin(listings, eq(listings.id, productVariants.listingId))
    .where(and(
      eq(componentLink.listingId, listingId), eq(componentLink.status, 'active'),
      inArray(componentLink.productVariantId, [...variantIds]),
      inArray(componentListing.status, ['active', 'sold']),
      inArray(componentProduct.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
      inArray(componentVariant.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
      inArray(canonicalProducts.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
      inArray(canonicalVariants.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
      ne(listings.id, listingId), eq(listings.status, 'active'),
      or(
        and(eq(listings.ownerType, 'store'), eq(componentListing.ownerType, 'store'), eq(listings.storeId, componentListing.storeId)),
        and(eq(listings.ownerType, 'user'), eq(componentListing.ownerType, 'user'), eq(listings.oxyUserId, componentListing.oxyUserId)),
      ),
      or(eq(productVariants.inventoryTracked, false), gt(productVariants.inventoryAvailable, 0)),
      isNotNull(productVariants.priceAmount), isNotNull(productVariants.priceCurrency),
    )).as('bundle_candidates');
  return db.select({
    sourceVariantId: candidates.sourceVariantId, listingId: candidates.listingId,
    variantId: candidates.variantId, canonicalVariantId: candidates.canonicalVariantId,
  }).from(candidates).where(lte(candidates.rank, 12)).orderBy(asc(candidates.sourceVariantId), asc(candidates.rank));
}
