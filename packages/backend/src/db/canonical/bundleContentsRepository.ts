import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { SHOPPER_VISIBLE_CATALOG_STATUSES } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { bundleComponents, canonicalImages, canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';

/** Keep all relationships here so the service can distinguish withheld from empty. */
export async function readBundleIdentities(db: DatabaseOrTransaction, variantIds: readonly string[]) {
  if (variantIds.length === 0) return [];
  const parentVariant = alias(canonicalVariants, 'bundle_parent_variant');
  const parentProduct = alias(canonicalProducts, 'bundle_parent_product');
  return db.select({
    bundleVariantId: bundleComponents.bundleVariantId,
    productId: canonicalProducts.id,
    productSlug: canonicalProducts.slug,
    productStatus: canonicalProducts.status,
    name: canonicalProducts.name,
    variantId: canonicalVariants.id,
    variantStatus: canonicalVariants.status,
    variantName: canonicalVariants.name,
    quantity: bundleComponents.quantity,
  }).from(bundleComponents)
    .innerJoin(parentVariant, eq(parentVariant.id, bundleComponents.bundleVariantId))
    .innerJoin(parentProduct, eq(parentProduct.id, parentVariant.productId))
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, bundleComponents.componentVariantId))
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalVariants.productId))
    .where(and(
      inArray(bundleComponents.bundleVariantId, [...variantIds]),
      inArray(parentVariant.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
      inArray(parentProduct.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
    ))
    .orderBy(asc(bundleComponents.position), asc(bundleComponents.id));
}

/** One batched image read, ordered by the catalog's own display order. */
export async function readBundleImages(db: DatabaseOrTransaction, productIds: string[], variantIds: string[]) {
  if (productIds.length === 0 || variantIds.length === 0) return [];
  return db.select({
    productId: canonicalImages.productId,
    variantId: canonicalImages.variantId,
    sourceUrl: canonicalImages.sourceUrl,
    fileId: canonicalImages.fileId,
    alt: canonicalImages.alt,
  }).from(canonicalImages).where(and(
    eq(canonicalImages.status, 'active'),
    or(inArray(canonicalImages.productId, productIds), inArray(canonicalImages.variantId, variantIds)),
  )).orderBy(asc(canonicalImages.position), asc(canonicalImages.id));
}
