/**
 * The discovery feed service — one contract, three scopes — against a REAL
 * Postgres database.
 *
 * These pin the SHAPE of each scope, not its exact contents (the service's own
 * docblock states why): which section kinds lead, in which order, and two
 * properties a shape assertion alone cannot catch —
 *
 *  - **no empty section.** Every `buildX` helper in the service returns `null`
 *    rather than a section with nothing in it, and this suite proves it by
 *    checking every section of a real assembled feed rather than trusting the
 *    docblock.
 *  - **no composed sentence.** A section carrying a `signal` must carry no
 *    `title` — the client resolves the heading from `signal` +
 *    `categoryHandle`, and a sentence assembled here could never be
 *    translated.
 *
 * `best-selling`, `most-viewed` and every `stores` section read
 * `discovery_signals`, and Task 4's sweep that POPULATES that table has not
 * landed yet, so every fixture that needs one of those writes the row
 * directly — the sweep's own output shape, not a bug in the shelf being
 * empty otherwise.
 *
 * Fix round 1 (review) added: the `stores` section for both scopes, root's
 * per-category product shelves, the card-group/shelf split corrected to the
 * reference capture's measured shape (`top-rated` + `new` in the card group,
 * `on-sale` as a full shelf), and one `store-offer` section per store even
 * when it runs two simultaneously live discounts.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every category, listing and store this file creates carries a per-run
 * suffix, and teardown deletes exactly what it made — the same discipline
 * `discovery-read-repository.realdb.test.ts` documents. Category PARENT/CHILD
 * pairs are new here (that file only ever created flat categories): `deleteEach
 * cleans up children before parents, because `categories.parent_id` is
 * RESTRICT and a single bulk `DELETE` gives Postgres no ordering guarantee
 * across the rows of one statement.
 *
 * `findStoresWithLiveDiscounts` (the deals scope's read) carries no scope at
 * all — it is a cross-store read, documented as such on the repository side —
 * so the "nothing else" assertion below holds regardless of how many OTHER
 * stores' live discounts sit in the same run's database: every entry the
 * service can ever produce for the deals scope is `store-offer`, by
 * construction, independent of how many rows exist.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type {
  CardGroupSection,
  DiscoverySection,
  ProductsSection,
  StoreOfferSection,
  StoresSection,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { discoverySignals } from '../../db/schema/discovery.js';
import { discounts } from '../../db/schema/merchandising.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertVariants } from '../../db/catalog/variantRepository.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { getDiscoveryFeed } from '../discovery/feed.service.js';

let db: Database;

const createdCategoryIds: string[] = [];
const createdListingIds: string[] = [];
const createdUserIds: string[] = [];
const createdStoreIds: string[] = [];

/** A fresh Oxy account id, registered for cleanup (no cleanup actually needed — no FK). */
function makeUserId(role: string): string {
  const id = `realdb-discovery-feed-${role}-${uuidv7()}`;
  createdUserIds.push(id);
  return id;
}

/** A category unique to this test run. Push order matters: parent before child. */
async function makeCategory(
  overrides: { parentId?: string; ancestorIds?: string[]; imageUrl?: string; position?: number } = {},
): Promise<{ id: string; slug: string }> {
  const suffix = uuidv7().slice(-12);
  const [category] = await db
    .insert(categories)
    .values({
      key: `discovery-feed-${suffix}`,
      name: `Discovery feed ${suffix}`,
      slug: `discovery-feed-${suffix}`,
      parentId: overrides.parentId ?? null,
      ancestorIds: overrides.ancestorIds ?? [],
      imageUrl: overrides.imageUrl ?? null,
      position: overrides.position ?? 0,
    })
    .returning({ id: categories.id, slug: categories.slug });
  createdCategoryIds.push(category.id);
  return category;
}

/** A P2P listing in a category — no store required. */
async function makeListing(
  categoryId: string,
  overrides: { rating?: number; reviewCount?: number } = {},
): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: makeUserId('seller'),
      title: 'Realdb discovery feed listing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      categoryId,
      status: 'active',
      rating: overrides.rating ?? 0,
      reviewCount: overrides.reviewCount ?? 0,
      publishedAt: new Date(),
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);
  return listing.id;
}

/** A store-owned listing, for the deals scope's featured products. */
async function makeStoreListing(storeId: string): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: 'Realdb discovery feed store listing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      publishedAt: new Date(),
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);
  return listing.id;
}

/** Give a listing a variant with a `compareAtPrice` — the `on-sale` signal's shape. */
async function makeOnSaleVariant(listingId: string): Promise<void> {
  await insertVariants(listingId, [
    {
      title: 'Default Title',
      priceAmount: 4000,
      priceCurrency: 'FAIR',
      compareAtPriceAmount: 9000,
      compareAtPriceCurrency: 'FAIR',
      inventoryTracked: true,
      inventoryAvailable: 2,
      position: 0,
      optionValues: [],
    },
  ]);
}

/** One `discovery_signals` row, written straight to the table — the sweep's own output shape. */
async function seedSignal(values: {
  subjectId: string;
  categoryId: string;
  unitsSold?: number;
  viewCount?: number;
}): Promise<void> {
  await db.insert(discoverySignals).values({
    subjectType: 'listing',
    subjectId: values.subjectId,
    categoryId: values.categoryId,
    window: '30d',
    unitsSold: values.unitsSold ?? 0,
    orderCount: 0,
    viewCount: values.viewCount ?? 0,
    computedAt: new Date(),
  });
}

/** A `discovery_signals` row for a STORE — the `stores` section's shape. */
async function seedStoreSignal(values: {
  storeId: string;
  categoryId: string;
  unitsSold?: number;
}): Promise<void> {
  await db.insert(discoverySignals).values({
    subjectType: 'store',
    subjectId: values.storeId,
    categoryId: values.categoryId,
    window: '30d',
    unitsSold: values.unitsSold ?? 0,
    orderCount: 0,
    viewCount: 0,
    computedAt: new Date(),
  });
}

/** A store, for the deals-scope fixtures — `discounts.store_id` cascades on delete. */
async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `discovery-feed-${suffix}`,
      name: 'Discovery feed store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: makeUserId('owner'), role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A LIVE automatic discount (started, active, no end) — `findStoresWithLiveDiscounts`'s shape. */
async function makeLiveDiscount(
  storeId: string,
  overrides: { startsAt?: Date; value?: number } = {},
): Promise<string> {
  const [discount] = await db
    .insert(discounts)
    .values({
      storeId,
      title: 'Realdb discovery feed discount',
      method: 'automatic',
      valueType: 'percentage',
      value: overrides.value ?? 1500,
      appliesToScope: 'order',
      startsAt: overrides.startsAt ?? new Date(Date.now() - 60 * 1000),
      isActive: true,
    })
    .returning({ id: discounts.id });
  return discount.id;
}

/**
 * Seed a category carrying real data for all five signals — a `new` listing,
 * a `top-rated` one (above the review floor), an `on-sale` one, and
 * `discovery_signals` rows for `best-selling` and `most-viewed` (Task 4's
 * sweep has not landed, so these are written directly) — PLUS a store-type
 * `discovery_signals` row, so the category's `stores` section has data too.
 * Returns the handle `getDiscoveryFeed` is called with.
 */
async function seedFullCategoryScope(): Promise<{ handle: string; categoryId: string }> {
  const parent = await makeCategory();
  await makeCategory({ parentId: parent.id, ancestorIds: [parent.id] }); // a child, for pills

  await makeListing(parent.id); // `new`
  await makeListing(parent.id, { rating: 4.8, reviewCount: 999 }); // `top-rated`

  const onSaleId = await makeListing(parent.id);
  await makeOnSaleVariant(onSaleId); // `on-sale`

  const bestSellingId = await makeListing(parent.id);
  await seedSignal({ subjectId: bestSellingId, categoryId: parent.id, unitsSold: 10 });

  const mostViewedId = await makeListing(parent.id);
  await seedSignal({ subjectId: mostViewedId, categoryId: parent.id, viewCount: 10 });

  const storeId = await makeStore();
  await seedStoreSignal({ storeId, categoryId: parent.id, unitsSold: 10 }); // `stores`

  return { handle: parent.slug, categoryId: parent.id };
}

/** Item count of one section — mirrors every renderer's own emptiness check. */
function sectionItemCount(section: DiscoverySection): number {
  switch (section.kind) {
    case 'hero':
      return section.cards.length;
    case 'category-tiles':
    case 'category-images':
    case 'pills':
      return section.tiles.length;
    case 'products':
      return section.products.length;
    case 'stores':
      return section.stores.length;
    case 'store-offer':
      return section.products.length;
    case 'card-group':
      return section.cards.length;
  }
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  const listingIds = createdListingIds.splice(0);
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  const categoryIds = createdCategoryIds.splice(0);
  if (categoryIds.length > 0) {
    // No FK ties a `discovery_signals` row to a category — it is a polymorphic
    // scope key — so nothing but this scoped delete would ever clean it up.
    await db.delete(discoverySignals).where(inArray(discoverySignals.categoryId, categoryIds));
    // Children before parents, one at a time: `categories.parent_id` is
    // RESTRICT, and `createdCategoryIds` is pushed parent-then-child, so the
    // reverse is always leaf-first.
    for (const id of [...categoryIds].reverse()) {
      await db.delete(categories).where(eq(categories.id, id));
    }
  }
  for (const storeId of createdStoreIds.splice(0)) {
    // `discounts.store_id` is CASCADE, so its rows go with the store.
    await deleteTestStores(db, [storeId]);
  }
  createdUserIds.length = 0;
});

afterAll(async () => {
  await closePostgres();
});

describe('getDiscoveryFeed', () => {
  it('root leads with a hero row and browse-category tiles', async () => {
    await makeCategory(); // guarantee at least one active top-level category

    const feed = await getDiscoveryFeed({ kind: 'root' });

    expect(feed.sections[0]?.kind).toBe('hero');
    expect(feed.sections[1]?.kind).toBe('category-tiles');
  });

  it('a category scope carries pills, then a card group, then a stores section, then shelves', async () => {
    const { handle } = await seedFullCategoryScope();

    const feed = await getDiscoveryFeed({ kind: 'category', handle });

    expect(feed.sections.map((s) => s.kind)).toContain('pills');
    expect(feed.sections.map((s) => s.kind)).toContain('card-group');
    expect(feed.sections.map((s) => s.kind)).toContain('stores');
    expect(feed.sections[0]?.kind).toBe('pills');
    expect(feed.sections[1]?.kind).toBe('card-group');
    expect(feed.sections[2]?.kind).toBe('stores');

    const stores = feed.sections.find((s): s is StoresSection => s.kind === 'stores');
    expect(stores?.variant).toBe('large');
    expect(stores?.stores.length).toBeGreaterThan(0);
  });

  it('the card group holds top-rated and new; on-sale renders as a full shelf', async () => {
    // The reference capture's own measured shape: `card-group` = ['Top
    // rated', "What's new"], and "Bestsellers" (best-selling) is a
    // full-width shelf, not a card-group member. `on-sale` follows the same
    // rule as best-selling: a full shelf.
    const { handle } = await seedFullCategoryScope();

    const feed = await getDiscoveryFeed({ kind: 'category', handle });

    const cardGroup = feed.sections.find((s): s is CardGroupSection => s.kind === 'card-group');
    expect(cardGroup?.cards.map((c) => c.signal).sort()).toEqual(['new', 'top-rated']);

    const onSaleShelf = feed.sections.find(
      (s): s is ProductsSection => s.kind === 'products' && s.signal === 'on-sale',
    );
    expect(onSaleShelf).toBeDefined();
  });

  it('root renders a product shelf and a compact stores section per top-level category', async () => {
    // `buildRootFeed` reads EVERY active root category, ordered by
    // `(parentId, position, slug)`, and slices to `shelfSize` (12) — so on
    // the shared database, whether THIS category survives that slice would
    // otherwise depend on how many other root categories other test files
    // happen to have live at the same moment, and where their slugs happen
    // to fall in sort order. A very negative `position` sorts ahead of every
    // other root category (they all default to 0), so this category's
    // presence in the slice is decided by a row this file owns, not by
    // concurrent state it doesn't.
    const category = await makeCategory({ position: -2_000_000_000 });
    // Data for all three sweep-free signals, so the test does not depend on
    // WHICH one root's per-category rotation happens to assign this category.
    await makeListing(category.id); // `new`
    await makeListing(category.id, { rating: 4.8, reviewCount: 999 }); // `top-rated`
    const onSaleId = await makeListing(category.id);
    await makeOnSaleVariant(onSaleId); // `on-sale`

    const storeId = await makeStore();
    await seedStoreSignal({ storeId, categoryId: category.id, unitsSold: 5 });

    const feed = await getDiscoveryFeed({ kind: 'root' });

    const shelf = feed.sections.find(
      (s): s is ProductsSection => s.kind === 'products' && s.categoryHandle === category.slug,
    );
    expect(shelf).toBeDefined();

    const stores = feed.sections.find(
      (s): s is StoresSection => s.kind === 'stores' && s.id === `stores-${category.slug}`,
    );
    expect(stores?.variant).toBe('compact');
    expect(stores?.stores.length).toBeGreaterThan(0);
  });

  it('a store running two live discounts still produces exactly one store-offer section', async () => {
    // `discounts.combinesWith*` lets a store run more than one simultaneously
    // LIVE automatic discount — `findStoresWithLiveDiscounts` returns one row
    // per discount, so the service must collapse them to one section itself.
    const storeId = await makeStore();
    await makeStoreListing(storeId);
    await makeLiveDiscount(storeId, {
      startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      value: 500,
    });
    const newerId = await makeLiveDiscount(storeId, {
      startsAt: new Date(Date.now() - 1000),
      value: 2000,
    });

    const feed = await getDiscoveryFeed({ kind: 'deals' });

    const offersForStore = feed.sections.filter(
      (s): s is StoreOfferSection => s.kind === 'store-offer' && s.store.id === storeId,
    );
    expect(offersForStore).toHaveLength(1);
    expect(offersForStore[0]?.discount.id).toBe(newerId);
    expect(offersForStore[0]?.discount.percentOff).toBe(20);
  });

  it('an unknown category handle is refused', async () => {
    await expect(
      getDiscoveryFeed({ kind: 'category', handle: `no-such-category-${uuidv7()}` }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deals carries one store-offer section per discounted store and nothing else', async () => {
    const storeId = await makeStore();
    await makeStoreListing(storeId);
    await makeLiveDiscount(storeId);

    const feed = await getDiscoveryFeed({ kind: 'deals' });

    expect(new Set(feed.sections.map((s) => s.kind))).toEqual(new Set(['store-offer']));
  });

  it('reports the page depth honestly per section', async () => {
    // `best-selling` is capped at what the sweep stored; `on-sale` (a
    // top-level shelf, unlike `new` which lives in the card group) is
    // complete. A section that claimed `complete` for a capped signal would
    // send the paginated route past the end of the data.
    const { handle } = await seedFullCategoryScope();

    const feed = await getDiscoveryFeed({ kind: 'category', handle });

    const bestSelling = feed.sections.find(
      (s): s is ProductsSection => s.kind === 'products' && s.signal === 'best-selling',
    );
    expect(bestSelling?.pageDepth).toBe('capped');

    const onSale = feed.sections.find(
      (s): s is ProductsSection => s.kind === 'products' && s.signal === 'on-sale',
    );
    expect(onSale?.pageDepth).toBe('complete');
  });

  it('emits no empty section', async () => {
    await makeCategory();

    const feed = await getDiscoveryFeed({ kind: 'root' });

    expect(feed.sections.length).toBeGreaterThan(0);
    for (const section of feed.sections) {
      expect(sectionItemCount(section)).toBeGreaterThan(0);
    }
  });

  it('sends a signal and a scope, never a composed sentence', async () => {
    const { handle } = await seedFullCategoryScope();

    const feed = await getDiscoveryFeed({ kind: 'category', handle });

    expect(feed.sections.length).toBeGreaterThan(0);
    for (const section of feed.sections) {
      if (section.signal !== undefined) {
        expect(section.title).toBeUndefined();
      }
    }
  });
});
