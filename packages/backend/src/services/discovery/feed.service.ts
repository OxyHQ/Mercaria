/**
 * Discovery feed service.
 *
 * Turns ONE {@link DiscoveryScope} into an ordered {@link DiscoveryFeed} — the
 * explore (`root`), category and deals pages are one section machine reading
 * one card set, and the only thing that differs between them is which sections
 * this service put in the response (see `shared-types/src/discovery.ts`'s own
 * docblock).
 *
 * ## No composed sentences
 *
 * A section never carries a `title` here. Every section names its heading by
 * `signal` + `categoryHandle` (or, for a headless section like `hero`, by
 * neither), and the CLIENT resolves the actual copy from those keys. A string
 * assembled on the server ("Best selling in Electronics") is a string that
 * cannot be translated — the same rule `AGENTS.md` states for `@mercaria/ui`'s
 * module-scope copy, applied to a wire DTO instead of a source file.
 *
 * ## No empty section
 *
 * A heading over an empty row is worse than no heading, so every `buildX`
 * helper below returns `null` rather than a section with nothing in it, and
 * every caller drops a `null`. `best-selling`, `most-viewed` and the `stores`
 * sections legitimately return nothing until Task 4's sweep has run at least
 * once — an empty shelf in that case is correct, not a bug.
 *
 * ## Category scope's five signals split three ways
 *
 * `top-rated` and `new` render as two compact cards inside ONE `card-group`
 * (the reference capture's own measured shape — see `CARD_GROUP_SIGNALS`);
 * `on-sale`, `best-selling` and `most-viewed` render as full-width `products`
 * shelves. `best-selling` and `most-viewed` are the two signals
 * `DISCOVERY_SIGNALS_FROM_COUNTS` names — their `pageDepth` is `'capped'`,
 * reported rather than implied, because nothing below what the sweep stored
 * (`config.discovery.topNPerCategory`) was ever counted.
 *
 * ## `stores` sections
 *
 * `findStoresBySignal` ranks a category's stores by `units_sold` — the same
 * counted-signal mechanism as `best-selling`'s products, so these sections
 * carry `signal: 'best-selling'` too and are just as sweep-dependent. The
 * category scope renders ONE (`variant: 'large'`); the root scope renders one
 * PER top-level category (`variant: 'compact'`), mirroring how its product
 * shelves are also per-category.
 *
 * ## Root's product shelves need no sweep
 *
 * `top-rated`, `new` and `on-sale` (`DISCOVERY_SIGNALS_FROM_LISTINGS`) read
 * `listings` directly and have no Task-4 dependency, so root renders one
 * shelf per top-level category, rotating through those three signals rather
 * than repeating one — matching the reference capture's per-category, per-
 * signal shelf titles ("Top rated in home", "New in beauty", …).
 *
 * ## Cached exactly like the home feed
 *
 * Same discipline as `services/feed.service.ts`: a Redis error is logged and
 * the feed is built from the database, never thrown, and a cache write is best
 * effort. Keyed per scope AND viewer, on `config.feed.cacheTtlSeconds`.
 */

import type {
  CategoryTile,
  CurrencyCode,
  DiscountSummary,
  DiscoveryFeed,
  DiscoveryScope,
  DiscoverySection,
  DiscoverySectionPageDepth,
  DiscoverySignal,
  CardGroupSection,
  CategoryTilesSection,
  HeroCard,
  HeroSection,
  PillsSection,
  ProductsSection,
  StoresSection,
  StoreSummary,
} from '@mercaria/shared-types';
import {
  DISCOVERY_SIGNALS_FROM_COUNTS,
  DISCOVERY_SIGNALS_FROM_LISTINGS,
} from '@mercaria/shared-types';
import {
  findActiveCategories,
  findActiveCategoryBySlug,
  findCategorySubtreePaths,
  type CategoryRecord,
} from '../../db/catalog/categoryRepository.js';
import {
  findListingsBySignal,
  findStoresBySignal,
  findStoresWithLiveDiscounts,
} from '../../db/discovery/discoveryReadRepository.js';
import {
  findActiveListingsForStores,
  findListingChildren,
  type ListingImageRecord,
  type ListingRecord,
} from '../../db/catalog/listingRepository.js';
import { findStoresByIds, type StoreRow } from '../../db/stores/storeRepository.js';
import { type DiscountRow } from '../../db/merchandising/discountRepository.js';
import { toProductSummaries, toStoreSummary } from '../catalog-hydration.service.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { config } from '../../config/index.js';
import { getRedisClient, withRedisTimeout } from '../../lib/redis.js';
import { log } from '../../lib/logger.js';

/** Bump when the assembled feed shape changes so stale cache entries are ignored. */
const DISCOVERY_FEED_CACHE_VERSION = 'v1';

/**
 * The two signals a category page renders as compact two-per-row cards —
 * `top-rated` and `new`, the reference capture's own measured shape (NOT
 * `best-selling`, which the capture renders as a full-width shelf instead).
 */
const CARD_GROUP_SIGNALS: readonly DiscoverySignal[] = ['top-rated', 'new'];

/** The three signals a category page renders as full-width shelves. */
const SHELF_SIGNALS: readonly DiscoverySignal[] = ['on-sale', 'best-selling', 'most-viewed'];

/** The single signal driving the root scope's hero — new arrivals, category by category. */
const HERO_SIGNAL: DiscoverySignal = 'new';

/** Basis points per whole percentage point — `discounts.value`'s own unit for `valueType: 'percentage'`. */
const BASIS_POINTS_PER_PERCENT = 100;

function discoveryFeedCacheKey(scope: DiscoveryScope, viewerId: string | undefined): string {
  const scopeKey = scope.kind === 'category' ? `category:${scope.handle}` : scope.kind;
  return `discovery:${DISCOVERY_FEED_CACHE_VERSION}:${scopeKey}:${viewerId ?? 'anon'}`;
}

/** `'capped'` for the two signals paged only as deep as the sweep counted, `'complete'` otherwise. */
function pageDepthFor(signal: DiscoverySignal): DiscoverySectionPageDepth {
  return DISCOVERY_SIGNALS_FROM_COUNTS.includes(signal) ? 'capped' : 'complete';
}

/** A category record projected to the wire `CategoryTile` shape. */
function toCategoryTile(category: CategoryRecord): CategoryTile {
  const tile: CategoryTile = { id: category.id, name: category.name, slug: category.slug };
  if (category.imageUrl) {
    tile.imageUrl = category.imageUrl;
  }
  return tile;
}

/**
 * One `products` shelf for a signal, scoped to a category subtree — `null`
 * when the signal has nothing to show, so the caller never has to.
 */
async function buildProductsSection(input: {
  id: string;
  signal: DiscoverySignal;
  categoryIds: string[];
  categoryHandle: string;
  layout: 'carousel' | 'grid';
}): Promise<ProductsSection | null> {
  const rows = await findListingsBySignal({
    signal: input.signal,
    categoryIds: input.categoryIds,
    limit: config.discovery.shelfSize,
    offset: 0,
  });
  if (rows.length === 0) {
    return null;
  }
  const products = await toProductSummaries(rows);
  return {
    kind: 'products',
    id: input.id,
    categoryHandle: input.categoryHandle,
    signal: input.signal,
    layout: input.layout,
    products,
    pageDepth: pageDepthFor(input.signal),
  };
}

/**
 * One `stores` section for a category: the top stores by `units_sold` within
 * it (`findStoresBySignal`, the same counted-signal mechanism as
 * `best-selling`'s products) — `null` when the sweep has nothing counted yet.
 */
async function buildStoresSection(input: {
  id: string;
  categoryId: string;
  categoryHandle: string;
  variant: 'large' | 'compact';
}): Promise<StoresSection | null> {
  const storeIds = await findStoresBySignal({
    categoryId: input.categoryId,
    limit: config.discovery.shelfSize,
  });
  if (storeIds.length === 0) {
    return null;
  }

  const storeRows = await findStoresByIds(storeIds);
  const storeById = new Map(storeRows.map((s) => [s.id, s]));
  // `findStoresByIds` carries no order of its own — reapply the ranking
  // `findStoresBySignal` already computed.
  const ranked = storeIds.flatMap((id) => {
    const store = storeById.get(id);
    return store ? [store] : [];
  });
  if (ranked.length === 0) {
    return null;
  }

  const featured = await findActiveListingsForStores(ranked.map((s) => s.id));
  const featuredByStore = new Map<string, ListingRecord[]>();
  for (const listing of featured) {
    if (!listing.storeId) continue;
    const bucket = featuredByStore.get(listing.storeId);
    if (bucket) {
      bucket.push(listing);
    } else {
      featuredByStore.set(listing.storeId, [listing]);
    }
  }
  const images: Map<string, ListingImageRecord[]> =
    featured.length > 0 ? (await findListingChildren(featured.map((l) => l.id))).images : new Map();

  const stores: StoreSummary[] = ranked.map((store) =>
    toStoreSummary(store, featuredByStore.get(store.id) ?? [], images),
  );

  return {
    kind: 'stores',
    id: input.id,
    categoryHandle: input.categoryHandle,
    signal: 'best-selling',
    layout: 'carousel',
    stores,
    variant: input.variant,
  };
}

/** The root scope's hero row: one card per top-level category. */
function buildHeroSection(topLevel: CategoryRecord[]): HeroSection | null {
  const cards: HeroCard[] = topLevel.map((category) => {
    const card: HeroCard = {
      id: category.id,
      title: category.name,
      categoryHandle: category.slug,
      signal: HERO_SIGNAL,
    };
    if (category.imageUrl) {
      card.imageUrl = category.imageUrl;
    }
    return card;
  });
  if (cards.length === 0) {
    return null;
  }
  return { kind: 'hero', id: 'hero', layout: 'carousel', cards };
}

/** The root scope's "browse by category" row. */
function buildCategoryTilesSection(topLevel: CategoryRecord[]): CategoryTilesSection | null {
  const tiles = topLevel.map(toCategoryTile);
  if (tiles.length === 0) {
    return null;
  }
  return { kind: 'category-tiles', id: 'category-tiles', layout: 'grid', tiles };
}

/**
 * The root scope: a hero row, browse-category tiles, one product shelf per
 * top-level category (rotating through the three sweep-free signals) and one
 * `stores` section per top-level category.
 */
async function buildRootFeed(): Promise<DiscoveryFeed> {
  const allCategories = await findActiveCategories();
  const topLevel = allCategories
    .filter((c) => c.parentId === null)
    .slice(0, config.discovery.shelfSize);

  const sections: DiscoverySection[] = [];
  const hero = buildHeroSection(topLevel);
  if (hero) {
    sections.push(hero);
  }
  const tiles = buildCategoryTilesSection(topLevel);
  if (tiles) {
    sections.push(tiles);
  }

  for (const [index, category] of topLevel.entries()) {
    const signal = DISCOVERY_SIGNALS_FROM_LISTINGS[index % DISCOVERY_SIGNALS_FROM_LISTINGS.length];
    const subtree = await findCategorySubtreePaths(category.id);
    const shelf = await buildProductsSection({
      id: `products-${category.slug}-${signal}`,
      signal,
      categoryIds: subtree.map((row) => row.id),
      categoryHandle: category.slug,
      layout: 'carousel',
    });
    if (shelf) {
      sections.push(shelf);
    }
  }

  for (const category of topLevel) {
    const stores = await buildStoresSection({
      id: `stores-${category.slug}`,
      categoryId: category.id,
      categoryHandle: category.slug,
      variant: 'compact',
    });
    if (stores) {
      sections.push(stores);
    }
  }

  return { sections };
}

/** A category page's filter pills, from its immediate children. */
function buildPillsSection(children: CategoryRecord[]): PillsSection | null {
  const tiles = children.map(toCategoryTile);
  if (tiles.length === 0) {
    return null;
  }
  return { kind: 'pills', id: 'pills', layout: 'carousel', tiles };
}

/**
 * The category page's compact highlight row: `top-rated` and `new`, each its
 * own bordered card, two per row (see `CardGroupSection`'s own docblock and
 * `CARD_GROUP_SIGNALS`). `null` when NEITHER signal has anything to show.
 */
async function buildCardGroupSection(
  categoryIds: string[],
  categoryHandle: string,
): Promise<CardGroupSection | null> {
  const cards: ProductsSection[] = [];
  for (const signal of CARD_GROUP_SIGNALS) {
    const card = await buildProductsSection({
      id: `card-group-${signal}`,
      signal,
      categoryIds,
      categoryHandle,
      layout: 'grid',
    });
    if (card) {
      cards.push(card);
    }
  }
  if (cards.length === 0) {
    return null;
  }
  return { kind: 'card-group', id: 'card-group', layout: 'grid', cards };
}

/** A category scope: pills, a card group, a `stores` section, then the remaining shelves. */
async function buildCategoryFeed(handle: string): Promise<DiscoveryFeed> {
  const category = await findActiveCategoryBySlug(handle);
  if (!category) {
    throw notFound('Category not found');
  }

  // The subtree, not just the subject: a listing filed under a subcategory is
  // still part of what this page browses.
  const subtree = await findCategorySubtreePaths(category.id);
  const categoryIds = subtree.map((row) => row.id);

  const allCategories = await findActiveCategories();
  const children = allCategories.filter((c) => c.parentId === category.id);

  const sections: DiscoverySection[] = [];

  const pills = buildPillsSection(children);
  if (pills) {
    sections.push(pills);
  }

  const cardGroup = await buildCardGroupSection(categoryIds, category.slug);
  if (cardGroup) {
    sections.push(cardGroup);
  }

  const stores = await buildStoresSection({
    id: 'stores',
    categoryId: category.id,
    categoryHandle: category.slug,
    variant: 'large',
  });
  if (stores) {
    sections.push(stores);
  }

  for (const signal of SHELF_SIGNALS) {
    const shelf = await buildProductsSection({
      id: `products-${signal}`,
      signal,
      categoryIds,
      categoryHandle: category.slug,
      layout: 'carousel',
    });
    if (shelf) {
      sections.push(shelf);
    }
  }

  return { sections };
}

/** A discount row projected to the wire `DiscountSummary`, in the store's own native currency. */
function toDiscountSummary(discount: DiscountRow, currency: CurrencyCode): DiscountSummary {
  const summary: DiscountSummary = {
    id: discount.id,
    exclusive:
      discount.customerEligibilityType !== null && discount.customerEligibilityType !== 'all',
  };
  if (discount.valueType === 'percentage') {
    summary.percentOff = discount.value / BASIS_POINTS_PER_PERCENT;
  } else if (discount.valueType === 'fixed_amount') {
    summary.amountOff = { amount: discount.value, currency };
  }
  if (discount.minimumRequirementType === 'subtotal' && discount.minimumRequirementValue !== null) {
    summary.minimumSubtotal = { amount: discount.minimumRequirementValue, currency };
  }
  return summary;
}

/**
 * Collapse `findStoresWithLiveDiscounts`' rows to ONE per store.
 *
 * The read returns one row per matching DISCOUNT, not per store — a store can
 * carry more than one simultaneously live `automatic` discount at once
 * (`discounts.combinesWith*` exists specifically to let them stack), and a
 * `store-offer` section is keyed by store id, so two rows for one store would
 * collide on that id. The most recently STARTED wins, tie-broken by id
 * ascending for a deterministic pick. "Biggest saving" was rejected on
 * purpose: a percentage and a fixed amount are only comparable against a
 * basket total this feed does not have, so "biggest" would be a false
 * comparison dressed as a choice.
 */
function onePerStore(
  rows: readonly { storeId: string; discount: DiscountRow }[],
): { storeId: string; discount: DiscountRow }[] {
  const byStore = new Map<string, { storeId: string; discount: DiscountRow }[]>();
  for (const row of rows) {
    const bucket = byStore.get(row.storeId);
    if (bucket) {
      bucket.push(row);
    } else {
      byStore.set(row.storeId, [row]);
    }
  }
  return [...byStore.values()].map((bucket) =>
    bucket.reduce((mostRecent, row) => {
      if (row.discount.startsAt.getTime() !== mostRecent.discount.startsAt.getTime()) {
        return row.discount.startsAt.getTime() > mostRecent.discount.startsAt.getTime()
          ? row
          : mostRecent;
      }
      return row.discount.id < mostRecent.discount.id ? row : mostRecent;
    }),
  );
}

/** The deals scope: one `store-offer` card per store with a live automatic discount, nothing else. */
async function buildDealsFeed(): Promise<DiscoveryFeed> {
  const discounted = await findStoresWithLiveDiscounts(config.discovery.shelfSize);
  if (discounted.length === 0) {
    return { sections: [] };
  }

  const storeDiscounts = onePerStore(discounted);

  const storeIds = storeDiscounts.map((d) => d.storeId);
  const [stores, featured] = await Promise.all([
    findStoresByIds(storeIds),
    findActiveListingsForStores(storeIds),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const featuredByStore = new Map<string, ListingRecord[]>();
  for (const listing of featured) {
    if (!listing.storeId) continue;
    const bucket = featuredByStore.get(listing.storeId);
    if (bucket) {
      bucket.push(listing);
    } else {
      featuredByStore.set(listing.storeId, [listing]);
    }
  }

  // The card thumbnails come from the featured listings' galleries, batched
  // once for every store on the shelf rather than per store.
  const images: Map<string, ListingImageRecord[]> =
    featured.length > 0
      ? (await findListingChildren(featured.map((l) => l.id))).images
      : new Map();

  const sections: DiscoverySection[] = [];
  for (const { storeId, discount } of storeDiscounts) {
    const store: StoreRow | undefined = storeById.get(storeId);
    if (!store) {
      continue;
    }
    const storeListings = (featuredByStore.get(storeId) ?? []).slice(0, config.discovery.shelfSize);
    if (storeListings.length === 0) {
      // No products means no offer to show — the same "no empty section" rule
      // every other section builder follows.
      continue;
    }
    const products = await toProductSummaries(storeListings);
    sections.push({
      kind: 'store-offer',
      id: `store-offer-${storeId}`,
      layout: 'grid',
      store: toStoreSummary(store, storeListings, images),
      discount: toDiscountSummary(discount, store.defaultCurrency as CurrencyCode),
      products,
    });
  }

  return { sections };
}

async function buildDiscoveryFeedFromDb(scope: DiscoveryScope): Promise<DiscoveryFeed> {
  switch (scope.kind) {
    case 'root':
      return buildRootFeed();
    case 'category':
      return buildCategoryFeed(scope.handle);
    case 'deals':
      return buildDealsFeed();
  }
}

/**
 * Get the discovery feed for a scope + viewer, served from Redis when warm.
 * Cache absence or any Redis error falls back to building from the database;
 * cache writes are best effort and never block the response. A `category`
 * scope naming an unknown or inactive handle throws `notFound` — never cached,
 * since only a built feed is ever written to the cache.
 */
export async function getDiscoveryFeed(
  scope: DiscoveryScope,
  viewerId?: string,
): Promise<DiscoveryFeed> {
  const redis = getRedisClient();
  const key = discoveryFeedCacheKey(scope, viewerId);

  if (redis) {
    try {
      const cached = await withRedisTimeout(redis.get(key));
      if (cached) {
        return JSON.parse(cached) as DiscoveryFeed;
      }
    } catch (err) {
      log.general.warn({ err }, 'Discovery feed cache read failed — building from DB');
    }
  }

  const feed = await buildDiscoveryFeedFromDb(scope);

  if (redis) {
    try {
      await withRedisTimeout(
        redis.set(key, JSON.stringify(feed), 'EX', config.feed.cacheTtlSeconds),
      );
    } catch (err) {
      log.general.warn({ err }, 'Discovery feed cache write failed (continuing)');
    }
  }

  return feed;
}
