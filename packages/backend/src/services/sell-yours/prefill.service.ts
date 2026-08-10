/**
 * What a canonical product may tell a seller about the thing they are selling
 * (#91 canonical prefill 1–6).
 *
 * ## The whole of this module's job is a provenance label
 *
 * Prefilling is the point of the issue — a person selling a phone should not
 * retype the brand, the model, the storage or the category. What must not happen
 * is that the saving quietly turns into Mercaria asserting things on the
 * seller's behalf. So every value leaves here inside a `SellerPrefillField`
 * carrying `origin: 'canonical'` and `confirmed: false`, and the draft stores
 * NOTHING of it: a read composes the prefill from the live canonical rows and
 * whatever the seller typed on top.
 *
 * That storage decision is the load-bearing one. A copied title on the draft
 * would survive a merge, a rename and a correction, so a seller who came back a
 * week later would be shown — and would publish — a product name the catalogue
 * no longer uses, with nothing anywhere saying it was stale.
 *
 * ## The reference image identifies the MODEL and is never evidence
 *
 * It is carried as a bare `fileId` beside `SELLER_REFERENCE_IMAGE_NOTICE`, is
 * never copied into `seller_draft_images`, and could not be: that table's
 * provenance vocabulary has only seller-owned members, and both #90's trigger
 * and this domain's own refuse a file id a `canonical_images` row claims.
 */

import type { SellerCanonicalPrefill, SellerPrefillField } from '@mercaria/shared-types';
import { SELLER_REFERENCE_IMAGE_NOTICE } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { listCanonicalImages } from '../../db/canonical/attributeRepository.js';
import { findBrandById } from '../../db/canonical/brandRepository.js';
import { findCanonicalProductById } from '../../db/canonical/canonicalProductRepository.js';
import {
  findCanonicalVariantById,
  listVariantAttributes,
} from '../../db/canonical/canonicalVariantRepository.js';
import { listIdentifiersForVariant } from '../../db/canonical/productIdentifierRepository.js';
import { findCategoryById } from '../../db/catalog/categoryRepository.js';

/** Every prefilled value looks the same: inherited, unconfirmed, and labelled. */
function inherited<T>(value: T): SellerPrefillField<T> {
  return { value, origin: 'canonical', confirmed: false };
}

/**
 * Compose the prefill for a draft's declared product and variant.
 *
 * Returns `undefined` for an unmatched draft, for a product that has since been
 * merged away, and for one that no longer exists — three different facts with
 * one honest answer, because in all three there is nothing the catalogue can
 * tell the seller.
 */
export async function buildCanonicalPrefill(input: {
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
}): Promise<SellerCanonicalPrefill | undefined> {
  if (!input.canonicalProductId) return undefined;

  const db = getDb();
  const product = await findCanonicalProductById(db, input.canonicalProductId);
  if (!product || product.status !== 'active') return undefined;

  const [brand, category, variant] = await Promise.all([
    product.brandId ? findBrandById(db, product.brandId) : Promise.resolve(undefined),
    product.categoryId ? findCategoryById(product.categoryId) : Promise.resolve(null),
    input.canonicalVariantId
      ? findCanonicalVariantById(db, input.canonicalVariantId)
      : Promise.resolve(undefined),
  ]);

  const [attributes, identifiers, productImages, variantImages] = await Promise.all([
    variant ? listVariantAttributes(db, variant.id) : Promise.resolve([]),
    variant ? listIdentifiersForVariant(db, variant.id) : Promise.resolve([]),
    listCanonicalImages(db, { kind: 'product', id: product.id }),
    variant
      ? listCanonicalImages(db, { kind: 'variant', id: variant.id })
      : Promise.resolve([]),
  ]);

  // The variant's own picture where there is one, else the product's. A variant
  // image is the more specific identification and is what a seller who chose a
  // colour expects to see.
  const referenceImage =
    variantImages.find((image) => image.status === 'active' && image.fileId) ??
    productImages.find((image) => image.status === 'active' && image.fileId);

  return {
    canonicalProductId: product.id,
    ...(variant ? { canonicalVariantId: variant.id } : {}),
    title: inherited(product.name),
    ...(brand ? { brand: inherited(brand.name) } : {}),
    ...(product.modelCode ? { model: inherited(product.modelCode) } : {}),
    /**
     * Identifiers are shown so the seller can CHECK them against the object in
     * their hands — which is exactly why they are inherited and unconfirmed. A
     * barcode the seller never looked at is the single most dangerous thing to
     * treat as their assertion: it is what the matcher reads, and #58's whole
     * conflicting-identifier guard rests on the subject's identifiers being
     * observations of the actual item.
     */
    identifiers: identifiers
      .filter((identifier) => identifier.status === 'active')
      .map((identifier) =>
        inherited(`${identifier.scheme}:${identifier.canonicalValue ?? identifier.normalizedValue}`),
      ),
    variantAttributes: attributes.map((attribute) =>
      inherited({ key: attribute.attributeKey, value: attribute.displayValue }),
    ),
    ...(category ? { category: inherited(category.slug) } : {}),
    ...(referenceImage?.fileId ? { referenceImageFileId: referenceImage.fileId } : {}),
    referenceImageNotice: SELLER_REFERENCE_IMAGE_NOTICE,
  };
}
