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
 * ## "On sale" never reads the whole catalogue
 *
 * The shelf is a set of listings with a discounted variant.
 * `findOnSaleListings` is one statement with an `EXISTS` and a `LIMIT`.
 */

import type {
  Feed,
  FeedSection,
  StoreSummary,
  Category,
  CategoryTile,
  CategoryPill,
} from '@mercaria/shared-types';
import { findTopActiveStores } from '../db/stores/storeRepository.js';
import { findActiveCategories, type CategoryRecord } from '../db/catalog/categoryRepository.js';
import {
  findActiveListingsForStores,
  findListingChildren,
  type ListingImageRecord,
  type ListingRecord,
} from '../db/catalog/listingRepository.js';
import { toCategoryImage, toStoreSummary } from './catalog-hydration.service.js';
import { config } from '../config/index.js';
import { findShelfProducts } from './discovery/shelf-products.service.js';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { log } from '../lib/logger.js';

/** v5: the product shelves carry catalogue products after the listings (`catalogSlug`). */
const FEED_CACHE_VERSION = 'v5';

function feedCacheKey(viewerId: string | undefined): string {
  return `feed:home:${FEED_CACHE_VERSION}:${viewerId ?? 'anon'}`;
}

/** Build the top "category-pills" section from top-level categories. */
function buildCategoryPills(topLevel: CategoryRecord[]): CategoryPill[] {
  return topLevel.map((c) => {
    const pill: CategoryPill = { id: c.id, name: c.name, slug: c.slug };
    Object.assign(pill, toCategoryImage(c));
    return pill;
  });
}

/**
 * Build the "Shop by category" section: each top-level category with up to N
 * subcategory tiles.
 */
function buildShopByCategory(topLevel: CategoryRecord[], children: CategoryRecord[]): Category[] {
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
      .map((child) => {
        const tile: CategoryTile = { id: child.id, name: child.name, slug: child.slug };
        Object.assign(tile, toCategoryImage(child));
        return tile;
      });
    return { id: parent.id, name: parent.name, slug: parent.slug, subcategories: tiles };
  });
}

/** Build the "Worth the hype" merchant section from top stores. */
async function buildMerchants(): Promise<StoreSummary[]> {
  const stores = await findTopActiveStores(config.feed.merchantsSize);
  if (stores.length === 0) {
    return [];
  }

  // Exactly the thumbnails the card renders: `toStoreSummary` slices the
  // gallery to `storeCardThumbnails`, so anything beyond that was loaded and
  // dropped.
  const featured = await findActiveListingsForStores({
    storeIds: stores.map((s) => s.id),
    perStoreLimit: config.feed.storeCardThumbnails,
  });

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
    featured.length > 0 ? (await findListingChildren(featured.map((l) => l.id))).images : new Map();

  return stores.map((store) => toStoreSummary(store, featuredByStore.get(store.id) ?? [], images));
}

/** Assemble the feed from the database (no caching). */
async function buildFeedFromDb(): Promise<Feed> {
  const allCategories = await findActiveCategories();
  const topLevel = allCategories
    .filter((c) => c.parentId === null)
    .slice(0, config.feed.categoriesSize);
  const children = allCategories.filter((c) => c.parentId !== null);
  const activeCategoryIds = allCategories.map((c) => c.id);

  // A Mercaria store's listings first, then the catalogue's products
  // (`services/discovery/shelf-products.service.ts`).
  const [newArrivals, onSale, merchants] = await Promise.all([
    findShelfProducts({
      signal: 'new',
      scope: { kind: 'home', activeCategoryIds },
      limit: config.feed.newArrivalsSize,
      offset: 0,
    }),
    findShelfProducts({
      signal: 'on-sale',
      scope: { kind: 'home', activeCategoryIds },
      limit: config.feed.onSaleSize,
      offset: 0,
    }),
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
