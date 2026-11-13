/**
 * The products of one discovery shelf: a Mercaria store's listings FIRST, then
 * the catalogue's products, one page at a time.
 *
 * Every product is one row of `canonical_products` and every way to buy it one
 * row of `offers`; a native offer is a Mercaria store's listing. The home, the
 * explore, category and deals pages and their "see all" pages read shelves
 * here, so a shelf is no longer just the few products Mercaria's stores sell:
 * after them come the catalogue's (`db/discovery/catalogShelfRepository.ts`
 * says which qualify and in what order), with the owner's ordering — what can
 * be bought IN Mercaria first.
 *
 * ## One page across two sources
 *
 * The listings for `offset + limit` are read first (a handful of rows: stores'
 * listings are few). If they fill the page, the catalogue is not read; if not,
 * their count is exact, so the catalogue page starts at `offset` minus that
 * count. A listing's card links to the listing; a catalogue card carries
 * `catalogSlug` and links to the product page, priced at its lowest CURRENT
 * offer through the same projection search uses (`buildSearchOfferContexts`).
 */

import { isOxyFileId, type DiscoverySignal, type ProductSummary } from '@mercaria/shared-types';
import { findBrandsByIds } from '../../db/canonical/brandRepository.js';
import { findCanonicalProductsByIds } from '../../db/canonical/canonicalProductRepository.js';
import {
  findCatalogCompareAtPrices,
  findCatalogProductIdsBySignal,
} from '../../db/discovery/catalogShelfRepository.js';
import { findListingsBySignal } from '../../db/discovery/discoveryReadRepository.js';
import {
  findNewestActiveListings,
  findOnSaleListings,
  type ListingRecord,
} from '../../db/catalog/listingRepository.js';
import { getDb } from '../../db/postgres.js';
import { loadPrimaryProductImages } from '../../db/search/searchCandidateRepository.js';
import { toProductSummaries } from '../catalog-hydration.service.js';
import { resolveMedia } from '../catalog-media/urls.js';
import { asCurrencyCode } from '../fx-exclusions.js';
import { buildSearchOfferContexts } from '../search/offer-context.js';

/**
 * Where a shelf reads.
 *
 * - `home` — the home's shelves: every active listing as the home always read
 *   them, then the catalogue under the active taxonomy or under no category;
 * - `root` — explore's root "see all": the listings under the active taxonomy,
 *   then the same catalogue;
 * - `categories` — one category subtree, listings and catalogue alike.
 *
 * A product the catalogue has filed under no category is shown wherever the
 * whole marketplace is (most of the catalogue is not classified yet); one filed
 * under a SUPPRESSED category never is, like that category's listings.
 */
export type ShelfScope =
  | { readonly kind: 'home'; readonly activeCategoryIds: readonly string[] }
  | { readonly kind: 'root'; readonly activeCategoryIds: readonly string[] }
  | { readonly kind: 'categories'; readonly categoryIds: readonly string[] };

export interface FindShelfProductsInput {
  readonly signal: DiscoverySignal;
  readonly scope: ShelfScope;
  readonly limit: number;
  readonly offset: number;
}

/** One page of a shelf: listings first, then catalogue products. */
export async function findShelfProducts(input: FindShelfProductsInput): Promise<ProductSummary[]> {
  if (input.limit < 1) return [];
  const wanted = input.offset + input.limit;
  const listings = await findShelfListings(input.signal, input.scope, wanted);
  const pageListings = listings.slice(input.offset, wanted);
  const products = await toProductSummaries(pageListings);
  const remaining = input.limit - pageListings.length;
  // The listings filled the page: there may be more of them, and no catalogue yet.
  if (remaining === 0 || listings.length >= wanted) return products;

  const catalogIds = await findCatalogProductIdsBySignal({
    signal: input.signal,
    categoryIds:
      input.scope.kind === 'categories' ? input.scope.categoryIds : input.scope.activeCategoryIds,
    includeUncategorized: input.scope.kind !== 'categories',
    limit: remaining,
    offset: Math.max(0, input.offset - listings.length),
  });
  return [...products, ...(await toCatalogProductSummaries(catalogIds))];
}

/** The listings of a shelf, first `limit` of them. */
async function findShelfListings(
  signal: DiscoverySignal,
  scope: ShelfScope,
  limit: number,
): Promise<ListingRecord[]> {
  if (scope.kind === 'home') {
    // The home's two shelves read every active listing, exactly as they did
    // before the catalogue joined them.
    if (signal === 'new') return findNewestActiveListings(limit);
    if (signal === 'on-sale') return findOnSaleListings({ limit });
  }
  const categoryIds = scope.kind === 'categories' ? scope.categoryIds : scope.activeCategoryIds;
  return findListingsBySignal({ signal, categoryIds: [...categoryIds], limit, offset: 0 });
}

/**
 * Catalogue product ids → cards, in the given order. A product whose current
 * offers no longer price it in a known currency, or that lost its image since
 * the page was chosen, is left out rather than shown blank or unpriced.
 */
export async function toCatalogProductSummaries(
  productIds: readonly string[],
): Promise<ProductSummary[]> {
  if (productIds.length === 0) return [];
  const db = getDb();
  const now = new Date();
  const [products, images, compareAt] = await Promise.all([
    findCanonicalProductsByIds(db, productIds),
    loadPrimaryProductImages(db, productIds),
    findCatalogCompareAtPrices(productIds, db),
  ]);
  const productById = new Map(products.map((product) => [product.id, product]));
  const brandIds = [
    ...new Set(products.flatMap((product) => (product.brandId ? [product.brandId] : []))),
  ];
  const [brands, offers] = await Promise.all([
    findBrandsByIds(db, brandIds),
    buildSearchOfferContexts(db, {
      products: products.map((product) => ({
        canonicalProductId: product.id,
        brandId: product.brandId,
      })),
      filters: {},
      now,
    }),
  ]);
  const brandName = new Map(brands.map((brand) => [brand.id, brand.name]));
  const imageByProduct = new Map(images.map((image) => [image.productId, image]));

  const cards: ProductSummary[] = [];
  for (const id of productIds) {
    const product = productById.get(id);
    const image = imageByProduct.get(id);
    const lowest = offers.byProductId.get(id)?.summary?.lowestPrice;
    const currency = lowest === undefined ? null : asCurrencyCode(lowest.currency);
    if (!product || !image || !isOxyFileId(image.fileId) || !lowest || currency === null) {
      continue;
    }
    const card: ProductSummary = {
      id: product.id,
      catalogSlug: product.slug,
      title: product.name,
      brand: product.brandId ? (brandName.get(product.brandId) ?? '') : '',
      imageFileId: image.fileId,
      rating: product.rating,
      reviewCount: product.ratingCount,
      price: { amount: lowest.amount, currency },
    };
    const imageUrl = resolveMedia(image.fileId);
    if (imageUrl) card.imageUrl = imageUrl;
    // The compare-at of the offer the card is priced at, never another seller's.
    const sale = compareAt.get(id);
    if (sale && sale.price === lowest.amount && sale.currency === lowest.currency) {
      card.compareAtPrice = { amount: sale.compareAt, currency };
    }
    cards.push(card);
  }
  return cards;
}
