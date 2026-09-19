/**
 * The PUBLIC projection (#1017) — how Mercaria's own read models become the
 * shapes `@mercaria/shared-types` `public-api.ts` publishes.
 *
 * ## Field by field, and never a spread
 *
 * Every function here names each output field and the one input it comes from.
 * None spreads a `Listing`, a `StoreRow` or a `CollectionRow`, and none returns
 * an input object: the storefront DTOs carry connector provenance, variant SKUs
 * and barcodes, tags, vendor and product-type strings, a manual collection's raw
 * member ids and its automation rules, and raw Oxy file ids — and the public
 * contract's whole premise is that a field added to one of those tomorrow does
 * not reach another application unless somebody adds it HERE on purpose. That is
 * `docs/house-invariants.md`'s "DTOs are ALLOW-lists that REFUSE", applied to a
 * wire boundary; `public-api.realdb.test.ts` asserts every response's key set
 * against the contract recursively, and that the private sentinels it seeds
 * appear nowhere in any serialized body.
 *
 * ## Why the product half starts from the hydrated `Listing`
 *
 * Price derivation (the cheapest priced variant, the unpriced fallback, the
 * range across priced variants), gallery ordering, media resolution, the
 * condition projection and the viewer's `saved` flag are each decided ONCE, in
 * `catalog-hydration.service`. Re-deriving any of them from rows here would be a
 * second spelling of a rule that can drift from the product page a shopper sees
 * — so this module READS those decisions and copies only the allowed facts.
 *
 * Every function is pure: no database, no config, no clock.
 */

import type {
  Listing,
  MercariaCollection,
  MercariaImage,
  MercariaProduct,
  MercariaProductAvailability,
  MercariaProductSummary,
  MercariaPurchaseOption,
  MercariaSeller,
  MercariaStore,
  Money,
  ProductVariantDTO,
} from '@mercaria/shared-types';
import type { StoreRow } from '../../db/stores/storeRepository.js';
import type { CollectionRow } from '../../db/merchandising/collectionRepository.js';
import { collectionWebUrl, productWebUrl, storeWebUrl } from './urls.js';

/**
 * Resolves an Oxy media file id (or an already-absolute URL) to an absolute URL.
 * Injected rather than imported so this module stays pure; production passes
 * `resolveMedia`, the ONE sanctioned resolver.
 */
export type MediaResolver = (fileIdOrUrl: string) => string;

/** A money value, copied field by field. */
function money(value: Money): Money {
  return { amount: value.amount, currency: value.currency };
}

/** An already-resolved image URL plus its alt text, `null` when absent or blank. */
function image(url: string, alt: string | undefined | null): MercariaImage {
  return { url, alt: typeof alt === 'string' && alt.trim() !== '' ? alt : null };
}

/** `null` for an absent or blank string. */
function nullIfBlank(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * A product's availability.
 *
 * `sold` is the listing's own status; otherwise it is live and buyable exactly
 * when at least one purchase option is — the variant's `inStock`, which
 * hydration derives as "not inventory-tracked, or stock above zero".
 */
export function productAvailability(listing: Listing): MercariaProductAvailability {
  if (listing.status === 'sold') return 'sold';
  return listing.variants.some((variant) => variant.inStock) ? 'in_stock' : 'out_of_stock';
}

/**
 * One purchase option. A SOLD product's options are all `out_of_stock`: the
 * item is never buyable again, whatever a variant's stale counter says.
 */
function purchaseOption(
  listing: Listing,
  variant: ProductVariantDTO,
): MercariaPurchaseOption {
  return {
    ref: { kind: 'variant', productId: listing.id, variantId: variant.id },
    title: variant.title,
    price: money(variant.price),
    compareAtPrice: variant.compareAtPrice ? money(variant.compareAtPrice) : null,
    availability: listing.status !== 'sold' && variant.inStock ? 'in_stock' : 'out_of_stock',
  };
}

/**
 * Who sells the product.
 *
 * A store seller is built from the store ROW the service already loaded to gate
 * the read, not from `Listing.store` — that summary carries thumbnails of other
 * listings and a text tone, and the gate and the label must describe the same
 * store. A person seller copies the hydrated Oxy identity, whose avatar
 * hydration has already resolved.
 *
 * @throws when a store-owned listing arrives without its store, or a
 * person-owned one without its seller — a caller defect, never a shape to guess.
 */
export function projectSeller(
  listing: Listing,
  store: StoreRow | undefined,
  resolveMedia: MediaResolver,
): MercariaSeller {
  if (listing.ownerType === 'store') {
    if (!store) throw new Error(`public projection: store-owned listing ${listing.id} has no store`);
    return {
      kind: 'store',
      store: { kind: 'store', id: store.id },
      handle: store.handle,
      name: store.name,
      logoUrl: store.logoFileId ? resolveMedia(store.logoFileId) : null,
    };
  }
  const seller = listing.seller;
  if (!seller) throw new Error(`public projection: person-owned listing ${listing.id} has no seller`);
  return {
    kind: 'person',
    oxyUserId: seller.oxyUserId,
    displayName: seller.displayName,
    username: seller.username,
    avatarUrl: nullIfBlank(seller.avatar),
    isVerified: seller.isVerified,
  };
}

/** A product card. */
export function projectProductSummary(
  listing: Listing,
  store: StoreRow | undefined,
  webOrigin: string,
  resolveMedia: MediaResolver,
): MercariaProductSummary {
  // `Listing.images` is already in gallery position order and already resolved
  // through the media chokepoint by hydration.
  const [first] = listing.images;
  const range = listing.priceRange;
  const flatRange =
    !range ||
    (range.min.amount === range.max.amount && range.min.currency === range.max.currency);
  return {
    ref: { kind: 'product', id: listing.id },
    title: listing.title,
    primaryImage: first ? image(first.fileId, first.alt) : null,
    price: money(listing.price),
    compareAtPrice: listing.compareAtPrice ? money(listing.compareAtPrice) : null,
    priceRange: flatRange ? null : { min: money(range.min), max: money(range.max) },
    availability: productAvailability(listing),
    condition: { key: listing.itemCondition.key, group: listing.itemCondition.group },
    seller: projectSeller(listing, store, resolveMedia),
    url: productWebUrl(webOrigin, listing.id),
  };
}

/**
 * A product detail. `viewerSaved` is `undefined` for an anonymous read, which
 * the contract serializes as `viewer: null` — never `{ saved: false }`, which
 * would claim a fact about a caller nobody identified.
 */
export function projectProduct(
  listing: Listing,
  store: StoreRow | undefined,
  webOrigin: string,
  resolveMedia: MediaResolver,
  viewerSaved: boolean | undefined,
): MercariaProduct {
  const summary = projectProductSummary(listing, store, webOrigin, resolveMedia);
  return {
    ref: summary.ref,
    title: summary.title,
    primaryImage: summary.primaryImage,
    price: summary.price,
    compareAtPrice: summary.compareAtPrice,
    priceRange: summary.priceRange,
    availability: summary.availability,
    condition: summary.condition,
    seller: summary.seller,
    url: summary.url,
    description: listing.description,
    images: listing.images.map((entry) => image(entry.fileId, entry.alt)),
    purchaseOptions: listing.variants.map((variant) => purchaseOption(listing, variant)),
    updatedAt: listing.updatedAt,
    viewer: viewerSaved === undefined ? null : { saved: viewerSaved },
  };
}

/** The rating a store shows: the resolved source's figures, `null` with no reviews. */
export interface PublicStoreRating {
  readonly rating: number;
  readonly reviewCount: number;
}

/** A storefront. */
export function projectStore(
  store: StoreRow,
  rating: PublicStoreRating,
  webOrigin: string,
  resolveMedia: MediaResolver,
): MercariaStore {
  return {
    ref: { kind: 'store', id: store.id },
    handle: store.handle,
    name: store.name,
    description: nullIfBlank(store.description),
    logoUrl: store.logoFileId ? resolveMedia(store.logoFileId) : null,
    coverImageUrl: store.coverFileId ? resolveMedia(store.coverFileId) : null,
    brandColor: store.brandColor,
    rating: rating.reviewCount > 0 ? rating.rating : null,
    reviewCount: rating.reviewCount,
    url: storeWebUrl(webOrigin, store.handle),
  };
}

/**
 * A collection. Its rules, its type, its member ids and its SEO overrides are
 * never read — the row carries the first three's scalars and none is copied.
 */
export function projectCollection(
  collection: CollectionRow,
  storeHandle: string,
  webOrigin: string,
  resolveMedia: MediaResolver,
): MercariaCollection {
  return {
    ref: { kind: 'collection', id: collection.id },
    store: { kind: 'store', id: collection.storeId },
    title: collection.title,
    description: nullIfBlank(collection.description),
    image: collection.imageFileId ? image(resolveMedia(collection.imageFileId), null) : null,
    url: collectionWebUrl(webOrigin, storeHandle, collection.id),
  };
}
