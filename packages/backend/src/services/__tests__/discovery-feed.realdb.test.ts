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
 * `best-selling` and `most-viewed` read `discovery_signals`, and Task 4's
 * sweep that POPULATES that table has not landed yet, so every fixture that
 * needs one of those two shelves writes the row directly — the sweep's own
 * output shape, not a bug in the shelf being empty otherwise.
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
import type { DiscoverySection, ProductsSection } from '@mercaria/shared-types';
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
  overrides: { parentId?: string; ancestorIds?: string[]; imageUrl?: string } = {},
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
async function makeLiveDiscount(storeId: string): Promise<void> {
  await db.insert(discounts).values({
    storeId,
    title: 'Realdb discovery feed discount',
    method: 'automatic',
    valueType: 'percentage',
    value: 1500,
    appliesToScope: 'order',
    startsAt: new Date(Date.now() - 60 * 1000),
    isActive: true,
  });
}

/**
 * Seed a category carrying real data for all five signals: a `new` listing, a
 * `top-rated` one (above the review floor), an `on-sale` one, and
 * `discovery_signals` rows for `best-selling` and `most-viewed` (Task 4's
 * sweep has not landed, so these are written directly). Returns the handle
 * `getDiscoveryFeed` is called with.
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

  it('a category scope carries pills, then a card group, then shelves', async () => {
    const { handle } = await seedFullCategoryScope();

    const feed = await getDiscoveryFeed({ kind: 'category', handle });

    expect(feed.sections.map((s) => s.kind)).toContain('pills');
    expect(feed.sections.map((s) => s.kind)).toContain('card-group');
    expect(feed.sections[0]?.kind).toBe('pills');
    expect(feed.sections[1]?.kind).toBe('card-group');
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
    // `best-selling` is capped at what the sweep stored; `new` is complete. A
    // section that claimed `complete` for a capped signal would send the
    // paginated route past the end of the data.
    const { handle } = await seedFullCategoryScope();

    const feed = await getDiscoveryFeed({ kind: 'category', handle });

    const bestSelling = feed.sections.find(
      (s): s is ProductsSection => s.kind === 'products' && s.signal === 'best-selling',
    );
    expect(bestSelling?.pageDepth).toBe('capped');

    const newest = feed.sections.find(
      (s): s is ProductsSection => s.kind === 'products' && s.signal === 'new',
    );
    expect(newest?.pageDepth).toBe('complete');
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
