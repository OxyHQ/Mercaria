/**
 * Home feed service.
 *
 * Assembles the DB-backed home `Feed` in the SAME order and shape the frontend
 * already consumes (mirrors `lib/mock-products.ts`):
 *   1. category-pills  — top-level categories
 *   2. products        — "New arrivals"
 *   3. categories      — "Shop by category" (each card + 2×2 subcategory grid)
 *   4. merchants       — "Worth the hype"
 *   5. products        — "On sale"
 *
 * The assembled feed is cached in Redis with a short TTL keyed per viewer; on a
 * cache miss/absence (or any Redis error) it is built from the database and the
 * result cached. Redis failures fall back gracefully — they are logged, never
 * thrown. The caching is unchanged by the port.
 *
 * ## Ported to Postgres — "On sale" stopped reading the whole catalogue
 *
 * The shelf is a set of listings with a discounted variant. Mongo could not
 * express that in one query, so this service read EVERY active listing with a
 * non-zero price, then every `compareAtPrice`-carrying variant of those
 * listings, intersected the two sets in memory and sliced eight cards out of the
 * result. `findOnSaleListings` is one statement with an `EXISTS` and a `LIMIT`.
 */

import type {
  Feed,
  FeedSection,
  ProductSummary,
  MerchantSummary,
  Category,
  CategoryTile,
  CategoryPill,
} from '@mercaria/shared-types';
import { findStoresByIds, findTopActiveStores } from '../db/stores/storeRepository.js';
import {
  findActiveCategories,
  type CategoryRecord,
} from '../db/catalog/categoryRepository.js';
import {
  findActiveListingsForStores,
  findListingChildren,
  findNewestActiveListings,
  findOnSaleListings,
  type ListingImageRecord,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import {
  findVariantsByListingIds,
  type VariantRecord,
} from '../db/catalog/variantRepository.js';
import { toProductSummary, toMerchantSummary } from './catalog-hydration.service.js';
import { getProfiles } from './oxy-user.service.js';
import { config } from '../config/index.js';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { log } from '../lib/logger.js';

/** Bump when the assembled feed shape changes so stale cache entries are ignored. */
const FEED_CACHE_VERSION = 'v1';

function feedCacheKey(viewerId: string | undefined): string {
  return `feed:home:${FEED_CACHE_VERSION}:${viewerId ?? 'anon'}`;
}

/** Group a flat list of variants by their listing id. */
function groupVariants(variants: VariantRecord[]): Map<string, VariantRecord[]> {
  const map = new Map<string, VariantRecord[]>();
  for (const v of variants) {
    const bucket = map.get(v.listingId);
    if (bucket) {
      bucket.push(v);
    } else {
      map.set(v.listingId, [v]);
    }
  }
  return map;
}

/**
 * Resolve the brand label for a product card: the store name for store listings,
 * or the seller's Oxy display name for P2P listings.
 */
async function buildBrandResolver(
  listings: ListingRecord[],
): Promise<(listing: ListingRecord) => string> {
  const storeIds = [
    ...new Set(
      listings.flatMap((l) => (l.ownerType === 'store' && l.storeId ? [l.storeId] : [])),
    ),
  ];
  const userIds = [
    ...new Set(
      listings.flatMap((l) => (l.ownerType === 'user' && l.oxyUserId ? [l.oxyUserId] : [])),
    ),
  ];

  const [storeDocs, oxyProfiles] = await Promise.all([
    findStoresByIds(storeIds),
    getProfiles(userIds),
  ]);

  const storeNameById = new Map(storeDocs.map((s) => [s.id, s.name]));

  return (listing: ListingRecord): string => {
    if (listing.ownerType === 'store' && listing.storeId) {
      return storeNameById.get(listing.storeId) ?? '';
    }
    if (listing.ownerType === 'user' && listing.oxyUserId) {
      return oxyProfiles.get(listing.oxyUserId)?.displayName ?? '';
    }
    return '';
  };
}

/**
 * Build `ProductSummary[]` for a set of listings, loading their variants and
 * gallery images in two batched queries for the whole shelf.
 */
async function toProductSummaries(listings: ListingRecord[]): Promise<ProductSummary[]> {
  if (listings.length === 0) {
    return [];
  }
  const listingIds = listings.map((l) => l.id);
  const [variants, children, brandOf] = await Promise.all([
    findVariantsByListingIds(listingIds),
    findListingChildren(listingIds),
    buildBrandResolver(listings),
  ]);
  const variantsByListing = groupVariants(variants);

  return listings.map((listing) =>
    toProductSummary(
      listing,
      variantsByListing.get(listing.id) ?? [],
      brandOf(listing),
      children.images.get(listing.id) ?? [],
    ),
  );
}

/** Build the top "category-pills" section from top-level categories. */
function buildCategoryPills(topLevel: CategoryRecord[]): CategoryPill[] {
  return topLevel.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    imageUrl: c.imageUrl ?? '',
  }));
}

/**
 * Build the "Shop by category" section: each top-level category with up to N
 * subcategory tiles.
 */
function buildShopByCategory(
  topLevel: CategoryRecord[],
  children: CategoryRecord[],
): Category[] {
  const childrenByParent = new Map<string, CategoryRecord[]>();
  for (const child of children) {
    if (!child.parentId) {
      continue;
    }
    const bucket = childrenByParent.get(child.parentId);
    if (bucket) {
      bucket.push(child);
    } else {
      childrenByParent.set(child.parentId, [child]);
    }
  }

  return topLevel.map((parent) => {
    const tiles: CategoryTile[] = (childrenByParent.get(parent.id) ?? [])
      .slice(0, config.feed.categoryTilesPerCard)
      .map((child) => ({
        id: child.id,
        name: child.name,
        slug: child.slug,
        imageUrl: child.imageUrl ?? '',
      }));
    return { id: parent.id, name: parent.name, slug: parent.slug, subcategories: tiles };
  });
}

/** Build the "Worth the hype" merchant section from top stores. */
async function buildMerchants(): Promise<MerchantSummary[]> {
  const stores = await findTopActiveStores(config.feed.merchantsSize);
  if (stores.length === 0) {
    return [];
  }

  const featured = await findActiveListingsForStores(stores.map((s) => s.id));

  const featuredByStore = new Map<string, ListingRecord[]>();
  for (const l of featured) {
    if (!l.storeId) continue;
    const bucket = featuredByStore.get(l.storeId);
    if (bucket) {
      bucket.push(l);
    } else {
      featuredByStore.set(l.storeId, [l]);
    }
  }

  // The card thumbnails come from the featured listings' galleries, batched once
  // for every store on the shelf rather than per store.
  const images: Map<string, ListingImageRecord[]> =
    featured.length > 0
      ? (await findListingChildren(featured.map((l) => l.id))).images
      : new Map();

  return stores.map((store) =>
    toMerchantSummary(store, featuredByStore.get(store.id) ?? [], images),
  );
}

/** Assemble the feed from the database (no caching). */
async function buildFeedFromDb(): Promise<Feed> {
  const allCategories = await findActiveCategories();
  const topLevel = allCategories
    .filter((c) => c.parentId === null)
    .slice(0, config.feed.categoriesSize);
  const children = allCategories.filter((c) => c.parentId !== null);

  const [newArrivalsListings, onSaleListings] = await Promise.all([
    findNewestActiveListings(config.feed.newArrivalsSize),
    findOnSaleListings(config.feed.onSaleSize),
  ]);

  const [newArrivals, onSale, merchants] = await Promise.all([
    toProductSummaries(newArrivalsListings),
    toProductSummaries(onSaleListings),
    buildMerchants(),
  ]);

  const sections: FeedSection[] = [
    { kind: 'category-pills', id: 'category-pills', pills: buildCategoryPills(topLevel) },
    { kind: 'products', id: 'new-arrivals', title: 'New arrivals', products: newArrivals },
    {
      kind: 'categories',
      id: 'shop-by-category',
      categories: buildShopByCategory(topLevel, children),
    },
    { kind: 'merchants', id: 'worth-the-hype', title: 'Worth the hype', merchants },
    { kind: 'products', id: 'on-sale', title: 'On sale', products: onSale },
  ];

  return { sections };
}

/**
 * Get the home feed for a viewer, served from Redis when warm. Cache absence or
 * any Redis error falls back to building from the database; cache writes are best
 * effort and never block the response.
 */
export async function getFeed(viewerId?: string): Promise<Feed> {
  const redis = getRedisClient();
  const key = feedCacheKey(viewerId);

  if (redis) {
    try {
      const cached = await withRedisTimeout(redis.get(key));
      if (cached) {
        return JSON.parse(cached) as Feed;
      }
    } catch (err) {
      log.general.warn({ err }, 'Feed cache read failed — building from DB');
    }
  }

  const feed = await buildFeedFromDb();

  if (redis) {
    try {
      await withRedisTimeout(
        redis.set(key, JSON.stringify(feed), 'EX', config.feed.cacheTtlSeconds),
      );
    } catch (err) {
      log.general.warn({ err }, 'Feed cache write failed (continuing)');
    }
  }

  return feed;
}
