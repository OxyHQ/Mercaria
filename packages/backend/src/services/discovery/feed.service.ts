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
 * `signal` + `categoryHandle` + `categoryName` (or, for a headless section
 * like `hero`, by none of the three), and the CLIENT resolves the actual copy
 * from those keys. A string assembled on the server ("Best selling in
 * Electronics") is a string that cannot be translated — the same rule
 * `AGENTS.md` states for `@mercaria/ui`'s module-scope copy, applied to a wire
 * DTO instead of a source file.
 *
 * `categoryName` travels beside `signal` on every section that carries one
 * (`products`, `stores`): a slug is not a name, and a category scope's own
 * shelves are about a category that is never among that scope's own
 * `pills`/`category-images` tiles (those are its SUBcategories) — so without
 * this, the client would have nothing in the feed itself to resolve that
 * page's own heading's name from.
 *
 * ## The browse-category tile's sample images, which NO CLIENT READS TODAY
 *
 * A `category-tiles` tile carries two sample images drawn from the category's
 * own CHILDREN — never its own `imageUrl` (that would be the category's own
 * picture, not a preview of what it contains). `buildCategoryTilesSection`
 * reads them off `allCategories`, the same array already loaded for the tiles
 * themselves, so this costs no extra query.
 *
 * The tile that previewed them is gone: the storefront renders every
 * tile-bearing section through `CategoryPills`, the component the home feed
 * already used, and a pill shows one image, not a preview strip. So
 * `sampleImageUrls` is currently emitted and read by nobody. It is left in
 * place rather than removed because the richer treatment the storefront DOES
 * have — `CategoryCarousel`/`CategoryCard`, a category above a 2x2 grid of its
 * named subcategories — needs strictly MORE than this field carries (names and
 * slugs, not bare URLs), and that is the shape this section wants to grow
 * into rather than shrink away from.
 *
 * ## `category-images`: the same subcategories as `pills`, once
 *
 * The reference renders this kind twice on a category page (§4 and §7) with
 * two different-looking groups of tiles. This service has exactly one
 * grouping of a category's subcategories available — the same `children`
 * `buildPillsSection` already resolves — and no second query is added to
 * invent a distinct one, so it is emitted ONCE, ahead of that scope's product
 * shelves rather than threaded between them.
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
 * ## Cached exactly like the home feed, but keyed by SCOPE ALONE
 *
 * Same discipline as `services/feed.service.ts`: a Redis error is logged and
 * the feed is built from the database, never thrown, and a cache write is best
 * effort, on `config.feed.cacheTtlSeconds`.
 *
 * The key carries no viewer, and that is a statement about this feed rather
 * than an omission: discovery is the same bytes for everybody. Nothing here
 * reads a viewer — `toProductSummaries` takes none, so no item is marked
 * `saved` — and keying on one would give every signed-in shopper a private
 * entry for an identical feed, so each would pay a full cold build of a page
 * that reads the whole active taxonomy. The home feed keys on `viewerId`
 * because it is BECOMING personal by design; this one is explicitly not.
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
  CategoryImagesSection,
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
  findActiveCategoryByIdOrSlug,
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
 *
 * Exported, with {@link SHELF_SIGNALS}, so `__tests__/discovery-vocabularies.test.ts`
 * can bind the pair to `DISCOVERY_SIGNALS`: this is the RENDER split, and it is
 * as much a partition of the five signals as the storage split beside it there.
 */
export const CARD_GROUP_SIGNALS: readonly DiscoverySignal[] = ['top-rated', 'new'];

/** The three signals a category page renders as full-width shelves. */
export const SHELF_SIGNALS: readonly DiscoverySignal[] = ['on-sale', 'best-selling', 'most-viewed'];

/** The single signal driving the root scope's hero — new arrivals, category by category. */
const HERO_SIGNAL: DiscoverySignal = 'new';

/** Basis points per whole percentage point — `discounts.value`'s own unit for `valueType: 'percentage'`. */
const BASIS_POINTS_PER_PERCENT = 100;

/** The browse tile's slot count — exactly two sample images, never more. */
const CATEGORY_SAMPLE_SLOTS = 2;

function discoveryFeedCacheKey(scope: DiscoveryScope): string {
  const scopeKey = scope.kind === 'category' ? `category:${scope.handle}` : scope.kind;
  return `discovery:${DISCOVERY_FEED_CACHE_VERSION}:${scopeKey}`;
}

/**
 * `'capped'` for the two signals paged only as deep as the sweep counted,
 * `'complete'` otherwise. Exported: `services/discovery/signal.service.ts`'s
 * paginated single-signal read reports the same fact on the same rule — one
 * definition, not two that could drift apart on a third signal.
 */
export function pageDepthFor(signal: DiscoverySignal): DiscoverySectionPageDepth {
  return DISCOVERY_SIGNALS_FROM_COUNTS.includes(signal) ? 'capped' : 'complete';
}

/**
 * Every ACTIVE category of a subtree — the subject plus each active
 * descendant — as the id list a shelf scopes itself to.
 *
 * Deliberately NOT `findCategorySubtreePaths`, whose predicate carries no
 * `is_active` at all: its docblock states why for the path it was written for
 * (a write re-deriving browse paths must reach a deprecated or suppressed
 * node's listings, or exactly the rows a lifecycle change touched keep a stale
 * path). On a PUBLIC read that same absence is an escape one level ABOVE the
 * listing status filter every shelf query already carries: `categories.is_active`
 * is `lifecycle === 'published'` (`db/seo/seoRepository.ts` maps everything
 * else to `'suppressed'`), and `db/schema/catalog.ts` says suppression "decides
 * whether shoppers SEE a node" — a connector's imported categories sit
 * suppressed until somebody reviews them. Reaching into them here would put
 * their products on a shelf under a category the shopper cannot navigate to.
 *
 * Filtered from `findActiveCategories`' result rather than queried: both scopes
 * already load the whole active taxonomy for their tiles and pills, and
 * `ancestor_ids` (root-first, excluding the row itself) is the same authority
 * the subtree query reads — so this is one fewer round trip per category, not a
 * second implementation of the tree walk.
 *
 * `subjectId` is the caller's own already-active category, so it is always in
 * the list; a category is never its own ancestor.
 *
 * Exported for `services/discovery/signal.service.ts`'s `category:<handle>`
 * scope — the same suppressed-subtree escape this docblock states applies
 * there just as much as it does to a shelf built for the feed.
 */
export function activeSubtreeIds(activeCategories: CategoryRecord[], subjectId: string): string[] {
  return [
    subjectId,
    ...activeCategories.filter((c) => c.ancestorIds.includes(subjectId)).map((c) => c.id),
  ];
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
 * Up to {@link CATEGORY_SAMPLE_SLOTS} image URLs drawn from `categoryId`'s own
 * CHILDREN, in their existing order — a preview of what is inside the
 * category. See this file's own docblock for why nothing renders it today.
 *
 * A child with no image is skipped rather than represented by `''`: the
 * result is a SHORTER array, never a hole standing in for a missing sample —
 * `CategoryTile.sampleImageUrls`'s own docstring states the same rule every
 * other image field in that file follows.
 */
function sampleImageUrlsFor(categoryId: string, allCategories: CategoryRecord[]): string[] {
  const urls: string[] = [];
  for (const candidate of allCategories) {
    if (candidate.parentId !== categoryId || !candidate.imageUrl) {
      continue;
    }
    urls.push(candidate.imageUrl);
    if (urls.length === CATEGORY_SAMPLE_SLOTS) {
      break;
    }
  }
  return urls;
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
  categoryName: string;
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
    categoryName: input.categoryName,
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
 *
 * **Two category inputs, and they are not the same set.** `categoryId` is the
 * subject alone, because `discovery_signals` already holds one row per ANCESTOR
 * so an exact match there covers the whole subtree. `categoryIds` is that
 * subtree, because the card's THUMBNAILS come from `listings.category_id`,
 * where a product filed under a child is still part of what this page browses —
 * the same set every sibling section on the page is built from.
 */
async function buildStoresSection(input: {
  id: string;
  categoryId: string;
  categoryIds: string[];
  categoryHandle: string;
  categoryName: string;
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

  // Exactly the thumbnails the card renders and no more: `toStoreSummary`
  // slices each store's gallery to `storeCardThumbnails`, and this section is
  // built once per top-level category on the root feed.
  //
  // Scoped to the subtree, so the card shows what this store sells HERE. The
  // card's claim is "top performer in this category"; unscoped, it drew from
  // the store's whole catalogue and put products from elsewhere under that
  // claim. A store with nothing active in the subtree keeps its place on the
  // shelf — it earned it by selling here — and renders without thumbnails,
  // which is the honest answer rather than a borrowed one.
  const featured = await findActiveListingsForStores({
    storeIds: ranked.map((s) => s.id),
    perStoreLimit: config.feed.storeCardThumbnails,
    categoryIds: input.categoryIds,
  });
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
    categoryName: input.categoryName,
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

/**
 * The root scope's "browse by category" row — each tile carrying up to
 * {@link CATEGORY_SAMPLE_SLOTS} preview images drawn from ITS OWN children
 * (see {@link sampleImageUrlsFor}), so a top-level category with none gets no
 * `sampleImageUrls` at all, same "absent field, not an empty one" rule as
 * every other tile image.
 */
function buildCategoryTilesSection(
  topLevel: CategoryRecord[],
  allCategories: CategoryRecord[],
): CategoryTilesSection | null {
  const tiles = topLevel.map((category) => {
    const tile = toCategoryTile(category);
    const samples = sampleImageUrlsFor(category.id, allCategories);
    if (samples.length > 0) {
      tile.sampleImageUrls = samples;
    }
    return tile;
  });
  if (tiles.length === 0) {
    return null;
  }
  return { kind: 'category-tiles', id: 'category-tiles', layout: 'grid', tiles };
}

/**
 * A category page's secondary "browse deeper" row: the SAME immediate
 * children `buildPillsSection` already resolves, rendered as image tiles
 * instead of round pills (`category-images`, the reference's §4/§7 — see this
 * file's own docblock for why it is emitted once rather than twice). `null`
 * when the category has no children, the same "no empty section" rule as
 * every other builder here.
 */
function buildCategoryImagesSection(children: CategoryRecord[]): CategoryImagesSection | null {
  const tiles = children.map(toCategoryTile);
  if (tiles.length === 0) {
    return null;
  }
  return { kind: 'category-images', id: 'category-images', layout: 'grid', tiles };
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
  const tiles = buildCategoryTilesSection(topLevel, allCategories);
  if (tiles) {
    sections.push(tiles);
  }

  for (const [index, category] of topLevel.entries()) {
    const signal = DISCOVERY_SIGNALS_FROM_LISTINGS[index % DISCOVERY_SIGNALS_FROM_LISTINGS.length];
    const shelf = await buildProductsSection({
      id: `products-${category.slug}-${signal}`,
      signal,
      categoryIds: activeSubtreeIds(allCategories, category.id),
      categoryHandle: category.slug,
      categoryName: category.name,
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
      categoryIds: activeSubtreeIds(allCategories, category.id),
      categoryHandle: category.slug,
      categoryName: category.name,
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
  categoryName: string,
): Promise<CardGroupSection | null> {
  const cards: ProductsSection[] = [];
  for (const signal of CARD_GROUP_SIGNALS) {
    const card = await buildProductsSection({
      id: `card-group-${signal}`,
      signal,
      categoryIds,
      categoryHandle,
      categoryName,
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

/**
 * A category scope: pills, a card group, a `stores` section, a
 * `category-images` row, then the remaining shelves.
 *
 * `handle` resolves by id OR slug (ADR 0007 D1, `findActiveCategoryByIdOrSlug`'s
 * own docblock) — the same mechanism a category page's link survives a rename
 * with, whether the caller is holding the current slug or a stable id.
 */
async function buildCategoryFeed(handle: string): Promise<DiscoveryFeed> {
  const category = await findActiveCategoryByIdOrSlug(handle);
  if (!category) {
    throw notFound('Category not found');
  }

  const allCategories = await findActiveCategories();
  // The subtree, not just the subject: a listing filed under a subcategory is
  // still part of what this page browses — the ACTIVE subtree, because a
  // suppressed subcategory is not (see `activeSubtreeIds`).
  const categoryIds = activeSubtreeIds(allCategories, category.id);
  const children = allCategories.filter((c) => c.parentId === category.id);

  const sections: DiscoverySection[] = [];

  const pills = buildPillsSection(children);
  if (pills) {
    sections.push(pills);
  }

  const cardGroup = await buildCardGroupSection(categoryIds, category.slug, category.name);
  if (cardGroup) {
    sections.push(cardGroup);
  }

  const stores = await buildStoresSection({
    id: 'stores',
    categoryId: category.id,
    categoryIds,
    categoryHandle: category.slug,
    categoryName: category.name,
    variant: 'large',
  });
  if (stores) {
    sections.push(stores);
  }

  const categoryImages = buildCategoryImagesSection(children);
  if (categoryImages) {
    sections.push(categoryImages);
  }

  for (const signal of SHELF_SIGNALS) {
    const shelf = await buildProductsSection({
      id: `products-${signal}`,
      signal,
      categoryIds,
      categoryHandle: category.slug,
      categoryName: category.name,
      layout: 'carousel',
    });
    if (shelf) {
      sections.push(shelf);
    }
  }

  return { sections };
}

/**
 * A discount row projected to the wire `DiscountSummary`, in the store's own
 * native currency.
 *
 * Only two of the four `DiscountValueType`s reach here: `findStoresWithLiveDiscounts`
 * projects nothing a card cannot state a saving for, and that filter — not this
 * function's shape — is where a fifth value type becomes a compile error
 * (`STATES_ITS_OWN_SAVING`). Without it a live BOGO produced a summary with
 * neither `percentOff` nor `amountOff`, which the compiler cannot see because
 * both are optional on the DTO.
 */
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

/**
 * The listings of one store's candidate set that its discount actually
 * REDUCES.
 *
 * The read below already restricts each store's query to the right population;
 * this is the second net, and it is not redundant — the three reads are
 * batched across stores, so a store whose listing sits in ANOTHER store's
 * targeted collection (or is named by another store's `applies_to_product_ids`)
 * would otherwise arrive in this store's bucket and be advertised under a
 * discount that cannot touch it.
 *
 * Exhaustive over `DISCOUNT_SCOPES` through the `never` default, and that
 * default is load-bearing rather than decorative: this package compiles with
 * `strict: false`, so a switch missing an arm falls out of the bottom and
 * returns `undefined` with no diagnostic at all — measured, not assumed. With
 * it, a fourth scope is a compile error here rather than a silent
 * fall-through to "everything the store sells".
 */
function coveredByDiscount(
  candidates: readonly ListingRecord[],
  discount: DiscountRow,
  collectionIdsByListing: ReadonlyMap<string, string[]>,
): ListingRecord[] {
  switch (discount.appliesToScope) {
    case 'order':
      return [...candidates];
    case 'products': {
      const targeted = new Set(discount.appliesToProductIds ?? []);
      return candidates.filter((listing) => targeted.has(listing.id));
    }
    case 'collections': {
      const targeted = new Set(discount.appliesToCollectionIds ?? []);
      return candidates.filter((listing) =>
        (collectionIdsByListing.get(listing.id) ?? []).some((id) => targeted.has(id)),
      );
    }
    default: {
      const unreachable: never = discount.appliesToScope;
      throw new Error(`unhandled discount scope: ${String(unreachable)}`);
    }
  }
}

/**
 * The deals scope: one `store-offer` card per store with a live automatic
 * discount, showing the products that discount COVERS.
 *
 * `discounts.applies_to_scope` is `notNull` and has three members, and two of
 * them target a subset (`applies_to_product_ids`, `applies_to_collection_ids`)
 * — the columns the design maps to "which products the shelf shows". Filling
 * every card with the store's newest listings regardless would put products the
 * discount cannot reduce under a header that says "20% off", which is the same
 * false price the `method = 'code'` exclusion already refuses one layer down in
 * `findStoresWithLiveDiscounts`.
 *
 * One bounded read per scope rather than one per store: the stores are
 * partitioned by what their discount targets, and each partition's restriction
 * is the union of its stores' targets, resolved back to the right store by
 * `coveredByDiscount`.
 */
async function buildDealsFeed(): Promise<DiscoveryFeed> {
  const discounted = await findStoresWithLiveDiscounts(config.discovery.shelfSize);
  if (discounted.length === 0) {
    return { sections: [] };
  }

  const storeDiscounts = onePerStore(discounted);
  const perStoreLimit = config.discovery.shelfSize;

  const orderScoped = storeDiscounts.filter((d) => d.discount.appliesToScope === 'order');
  const productScoped = storeDiscounts.filter((d) => d.discount.appliesToScope === 'products');
  const collectionScoped = storeDiscounts.filter((d) => d.discount.appliesToScope === 'collections');

  const [stores, wholeCatalogue, targetedProducts, targetedCollections] = await Promise.all([
    findStoresByIds(storeDiscounts.map((d) => d.storeId)),
    // The card's own product row is `shelfSize` wide; anything past it would be
    // read and then sliced away.
    findActiveListingsForStores({
      storeIds: orderScoped.map((d) => d.storeId),
      perStoreLimit,
    }),
    findActiveListingsForStores({
      storeIds: productScoped.map((d) => d.storeId),
      perStoreLimit,
      listingIds: productScoped.flatMap((d) => d.discount.appliesToProductIds ?? []),
    }),
    findActiveListingsForStores({
      storeIds: collectionScoped.map((d) => d.storeId),
      perStoreLimit,
      collectionIds: collectionScoped.flatMap((d) => d.discount.appliesToCollectionIds ?? []),
    }),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const featured = [...wholeCatalogue, ...targetedProducts, ...targetedCollections];
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

  // The card thumbnails come from the featured listings' galleries — and the
  // memberships that decide a `collections`-scoped card's products come from
  // the SAME batched read, so honouring the scope costs no extra query.
  const children =
    featured.length > 0
      ? await findListingChildren(featured.map((l) => l.id))
      : { images: new Map<string, ListingImageRecord[]>(), collectionIds: new Map<string, string[]>() };

  const sections: DiscoverySection[] = [];
  for (const { storeId, discount } of storeDiscounts) {
    const store: StoreRow | undefined = storeById.get(storeId);
    if (!store) {
      continue;
    }
    const storeListings = coveredByDiscount(
      featuredByStore.get(storeId) ?? [],
      discount,
      children.collectionIds,
    );
    if (storeListings.length === 0) {
      // No products the discount covers means no offer to show — the same "no
      // empty section" rule every other section builder follows.
      continue;
    }
    const products = await toProductSummaries(storeListings);
    sections.push({
      kind: 'store-offer',
      id: `store-offer-${storeId}`,
      layout: 'grid',
      store: toStoreSummary(store, storeListings, children.images),
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
 * Get the discovery feed for a scope, served from Redis when warm.
 *
 * Cache absence or any Redis error falls back to building from the database;
 * cache writes are best effort and never block the response. A `category`
 * scope naming an unknown or inactive handle throws `notFound` — never cached,
 * since only a built feed is ever written to the cache.
 *
 * There is no viewer parameter. This feed is identical for every shopper (see
 * the file docblock), and a parameter that only fragmented the cache key
 * documented a personalisation that does not exist.
 */
export async function getDiscoveryFeed(scope: DiscoveryScope): Promise<DiscoveryFeed> {
  const redis = getRedisClient();
  const key = discoveryFeedCacheKey(scope);

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
