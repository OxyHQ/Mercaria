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
 * cache miss/absence (or any Redis error) it is built from the DB and the result
 * cached. Redis failures fall back gracefully — they are logged, never thrown.
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
import { Category as CategoryModel, type ICategory } from '../models/category.js';
import { Store as StoreModel, type IStore } from '../models/store.js';
import { Listing, type IListing } from '../models/listing.js';
import { ProductVariant, type IProductVariant } from '../models/product-variant.js';
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

/** Resolve a category's display image URL (file id resolved at hydration via the card). */
function categoryImage(category: ICategory): string | undefined {
  if (category.imageUrl) {
    return category.imageUrl;
  }
  return undefined;
}

/** Group a flat list of variants by their listing id. */
function groupVariants(variants: IProductVariant[]): Map<string, IProductVariant[]> {
  const map = new Map<string, IProductVariant[]>();
  for (const v of variants) {
    const key = String(v.listingId);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(v);
    } else {
      map.set(key, [v]);
    }
  }
  return map;
}

/**
 * Resolve the brand label for a product card: the store name for store listings,
 * or the seller's Oxy display name for P2P listings.
 */
async function buildBrandResolver(listings: IListing[]): Promise<(listing: IListing) => string> {
  const storeIds = [
    ...new Set(listings.filter((l) => l.ownerType === 'store' && l.storeId).map((l) => String(l.storeId))),
  ];
  const userIds = [
    ...new Set(listings.filter((l) => l.ownerType === 'user' && l.oxyUserId).map((l) => String(l.oxyUserId))),
  ];

  const [storeDocs, oxyProfiles] = await Promise.all([
    storeIds.length > 0 ? StoreModel.find({ _id: { $in: storeIds } }).lean<IStore[]>() : Promise.resolve([] as IStore[]),
    getProfiles(userIds),
  ]);

  const storeNameById = new Map<string, string>();
  for (const s of storeDocs) {
    storeNameById.set(String((s as { _id: unknown })._id), s.name);
  }

  return (listing: IListing): string => {
    if (listing.ownerType === 'store' && listing.storeId) {
      return storeNameById.get(String(listing.storeId)) ?? '';
    }
    if (listing.ownerType === 'user' && listing.oxyUserId) {
      return oxyProfiles.get(String(listing.oxyUserId))?.displayName ?? '';
    }
    return '';
  };
}

/** Build `ProductSummary[]` for a set of listings (loads + groups their variants). */
async function toProductSummaries(listings: IListing[]): Promise<ProductSummary[]> {
  if (listings.length === 0) {
    return [];
  }
  const listingIds = listings.map((l) => String((l as { _id: unknown })._id));
  const [variants, brandOf] = await Promise.all([
    ProductVariant.find({ listingId: { $in: listingIds } })
      .sort({ listingId: 1, position: 1 })
      .lean<IProductVariant[]>(),
    buildBrandResolver(listings),
  ]);
  const variantsByListing = groupVariants(variants);

  return listings.map((listing) => {
    const id = String((listing as { _id: unknown })._id);
    return toProductSummary(listing, variantsByListing.get(id) ?? [], brandOf(listing));
  });
}

/** Build the top "category-pills" section from top-level categories. */
function buildCategoryPills(topLevel: ICategory[]): CategoryPill[] {
  return topLevel.map((c) => {
    const pill: CategoryPill = {
      id: String((c as { _id: unknown })._id),
      name: c.name,
      slug: c.slug,
      imageUrl: categoryImage(c) ?? '',
    };
    return pill;
  });
}

/**
 * Build the "Shop by category" section: each top-level category with up to N
 * subcategory tiles.
 */
function buildShopByCategory(topLevel: ICategory[], children: ICategory[]): Category[] {
  const childrenByParent = new Map<string, ICategory[]>();
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
    const parentId = String((parent as { _id: unknown })._id);
    const tiles: CategoryTile[] = (childrenByParent.get(parentId) ?? [])
      .sort((a, b) => a.position - b.position)
      .slice(0, config.feed.categoryTilesPerCard)
      .map((child) => ({
        id: String((child as { _id: unknown })._id),
        name: child.name,
        slug: child.slug,
        imageUrl: categoryImage(child) ?? '',
      }));
    return { id: parentId, name: parent.name, slug: parent.slug, subcategories: tiles };
  });
}

/** Build the "Worth the hype" merchant section from top stores. */
async function buildMerchants(): Promise<MerchantSummary[]> {
  const stores = await StoreModel.find({ status: 'active' })
    .sort({ rating: -1, productCount: -1 })
    .limit(config.feed.merchantsSize)
    .lean<IStore[]>();
  if (stores.length === 0) {
    return [];
  }

  const storeIds = stores.map((s) => String((s as { _id: unknown })._id));
  const featured = await Listing.find({ ownerType: 'store', storeId: { $in: storeIds }, status: 'active' })
    .sort({ publishedAt: -1 })
    .lean<IListing[]>();

  const featuredByStore = new Map<string, IListing[]>();
  for (const l of featured) {
    const key = String(l.storeId);
    const bucket = featuredByStore.get(key);
    if (bucket) {
      bucket.push(l);
    } else {
      featuredByStore.set(key, [l]);
    }
  }

  return stores.map((store) =>
    toMerchantSummary(store, featuredByStore.get(String((store as { _id: unknown })._id)) ?? []),
  );
}

/** Assemble the feed from the DB (no caching). */
async function buildFeedFromDb(): Promise<Feed> {
  const allCategories = await CategoryModel.find({ isActive: true })
    .sort({ position: 1 })
    .lean<ICategory[]>();
  const topLevel = allCategories.filter((c) => c.parentId === null).slice(0, config.feed.categoriesSize);
  const children = allCategories.filter((c) => c.parentId !== null);

  const [newArrivalsListings, onSaleListings] = await Promise.all([
    Listing.find({ status: 'active' })
      .sort({ publishedAt: -1, _id: -1 })
      .limit(config.feed.newArrivalsSize)
      .lean<IListing[]>(),
    Listing.find({ status: 'active', 'priceRange.min.amount': { $gt: 0 } })
      .sort({ publishedAt: -1 })
      .lean<IListing[]>(),
  ]);

  // "On sale" = listings whose cheapest variant carries a compareAtPrice.
  const onSaleVariants = await ProductVariant.find({
    listingId: { $in: onSaleListings.map((l) => String((l as { _id: unknown })._id)) },
    compareAtPrice: { $exists: true },
  })
    .select('listingId')
    .lean<{ listingId: string }[]>();
  const onSaleListingIds = new Set(onSaleVariants.map((v) => String(v.listingId)));
  const filteredOnSale = onSaleListings
    .filter((l) => onSaleListingIds.has(String((l as { _id: unknown })._id)))
    .slice(0, config.feed.onSaleSize);

  const [newArrivals, onSale, merchants] = await Promise.all([
    toProductSummaries(newArrivalsListings),
    toProductSummaries(filteredOnSale),
    buildMerchants(),
  ]);

  const sections: FeedSection[] = [
    { kind: 'category-pills', id: 'category-pills', pills: buildCategoryPills(topLevel) },
    { kind: 'products', id: 'new-arrivals', title: 'New arrivals', products: newArrivals },
    { kind: 'categories', id: 'shop-by-category', categories: buildShopByCategory(topLevel, children) },
    { kind: 'merchants', id: 'worth-the-hype', title: 'Worth the hype', merchants },
    { kind: 'products', id: 'on-sale', title: 'On sale', products: onSale },
  ];

  return { sections };
}

/**
 * Get the home feed for a viewer, served from Redis when warm. Cache absence or
 * any Redis error falls back to building from the DB; cache writes are best
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
      await withRedisTimeout(redis.set(key, JSON.stringify(feed), 'EX', config.feed.cacheTtlSeconds));
    } catch (err) {
      log.general.warn({ err }, 'Feed cache write failed (continuing)');
    }
  }

  return feed;
}
