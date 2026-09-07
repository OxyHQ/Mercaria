/**
 * `discoveryReadRepository` — the discovery feed's READ side, against a REAL
 * Postgres database.
 *
 * A mocked repository accepts any statement, so nothing here can be told apart
 * from a broken query under a mock: the review-count FLOOR, the scope on a
 * `discovery_signals` join, and the discount window's three independent
 * predicates are all properties of the SQL, not of the code that calls it.
 *
 *  - `top-rated` must apply `topRatedMinReviews` — a single glowing review
 *    with no floor would outrank a listing with hundreds.
 *  - `new` must order by `listings.published_at`, which means the FIRST
 *    activation and is NOT the row's `created_at` (#261).
 *  - `best-selling` must both READ the counted rows (an empty
 *    `discovery_signals` scope is an empty shelf, never every listing in the
 *    category via a bad join) and HONOUR the scope (a sibling category's row
 *    must never leak in).
 *  - `best-selling` / `most-viewed` must also exclude a listing that is no
 *    longer `active` — `discovery_signals` carries no status of its own, so a
 *    listing counted while it sold and later archived, sold out or put under
 *    a moderation hold must not stay on a public shelf until the row ages out
 *    of the window.
 *  - `findStoresBySignal` / `findStoresWithLiveDiscounts` must exclude a store
 *    that is no longer `active`, the same reasoning one level up.
 *  - `findStoresWithLiveDiscounts` must apply all four of its predicates
 *    independently: `method`, `is_active`, BOTH halves of the scheduled
 *    window (a discount that has not started yet, and one whose window has
 *    closed) each get their own fixture that differs from the live one in
 *    exactly that one dimension, so no single assertion can pass for the
 *    wrong reason.
 *
 * ## Scoping, because this database is SHARED
 *
 * `findListingsBySignal` and `findStoresBySignal` are scoped to a category, so
 * every fixture mints its OWN category (and, where the failure mode is a
 * missing scope filter, a sibling one) and teardown deletes exactly what it
 * created. `findStoresWithLiveDiscounts` carries no scope at all — it is a
 * cross-store read — so its assertions look up ONE store's own row by id
 * rather than asserting on the returned list's shape, which stays correct
 * however many other stores' discounts sit in the same run's database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { DiscountMethod, ListingStatus } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { categories, listings } from '../schema/catalog.js';
import { discoverySignals } from '../schema/discovery.js';
import { discounts } from '../schema/merchandising.js';
import { insertStore, updateStoreColumns } from '../stores/storeRepository.js';
import { insertVariants } from '../catalog/variantRepository.js';
import { deleteTestStores } from './store-teardown.js';
import {
  findListingsBySignal,
  findStoresBySignal,
  findStoresWithLiveDiscounts,
} from '../discovery/discoveryReadRepository.js';

let db: Database;

const createdCategoryIds: string[] = [];
const createdListingIds: string[] = [];
const createdUserIds: string[] = [];
const createdStoreIds: string[] = [];

/** A fresh Oxy account id, registered for cleanup. */
function makeUserId(role: string): string {
  const id = `realdb-discovery-read-${role}-${uuidv7()}`;
  createdUserIds.push(id);
  return id;
}

/** A category, unique to this test run. */
async function makeCategory(): Promise<string> {
  const suffix = uuidv7().slice(-12);
  const [category] = await db
    .insert(categories)
    .values({
      key: `discovery-read-${suffix}`,
      name: `Discovery read ${suffix}`,
      slug: `discovery-read-${suffix}`,
    })
    .returning({ id: categories.id });
  createdCategoryIds.push(category.id);
  return category.id;
}

/** A P2P listing in a category — no store required — with the shelf-ordering fields left to the caller. */
async function makeListing(
  categoryId: string,
  overrides: {
    rating?: number;
    reviewCount?: number;
    publishedAt?: Date | null;
    status?: ListingStatus;
  } = {},
): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: makeUserId('seller'),
      title: 'Realdb discovery listing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      categoryId,
      status: overrides.status ?? 'active',
      rating: overrides.rating ?? 0,
      reviewCount: overrides.reviewCount ?? 0,
      publishedAt: overrides.publishedAt === undefined ? new Date() : overrides.publishedAt,
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);
  return listing.id;
}

/** One `discovery_signals` row, written straight to the table — the sweep's own output shape. */
async function seedSignal(values: {
  subjectType: 'listing' | 'store';
  subjectId: string;
  categoryId: string;
  unitsSold?: number;
  viewCount?: number;
}): Promise<void> {
  await db.insert(discoverySignals).values({
    subjectType: values.subjectType,
    subjectId: values.subjectId,
    categoryId: values.categoryId,
    window: '30d',
    unitsSold: values.unitsSold ?? 0,
    orderCount: 0,
    viewCount: values.viewCount ?? 0,
    computedAt: new Date(),
  });
}

/** A store, for the discount fixtures — `discounts.store_id` cascades on delete. */
async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `discovery-read-${suffix}`,
      name: 'Discovery read store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: makeUserId('owner'), role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/**
 * A discount, LIVE by default (`automatic`, active, an open window that
 * already started) — each exclusion test overrides exactly one field.
 */
async function makeDiscount(
  storeId: string,
  overrides: {
    method?: DiscountMethod;
    isActive?: boolean;
    startsAt?: Date;
    endsAt?: Date | null;
  } = {},
): Promise<string> {
  const now = Date.now();
  const [discount] = await db
    .insert(discounts)
    .values({
      storeId,
      title: 'Realdb discount',
      method: overrides.method ?? 'automatic',
      valueType: 'percentage',
      value: 1000,
      appliesToScope: 'order',
      startsAt: overrides.startsAt ?? new Date(now - 60 * 60 * 1000),
      endsAt: overrides.endsAt === undefined ? null : overrides.endsAt,
      isActive: overrides.isActive ?? true,
    })
    .returning({ id: discounts.id });
  return discount.id;
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
    // `listings.category_id` is RESTRICT, so the listings above must go first.
    await db.delete(categories).where(inArray(categories.id, categoryIds));
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

describe('findListingsBySignal', () => {
  it('top-rated excludes a listing below the review floor', async () => {
    // Two listings in one category: rating 5.0 with 1 review, rating 4.2 with
    // 400. Without the floor the one-review listing wins, which is the whole
    // reason the floor exists.
    const categoryId = await makeCategory();
    const manyReviewsId = await makeListing(categoryId, { rating: 4.2, reviewCount: 400 });
    await makeListing(categoryId, { rating: 5.0, reviewCount: 1 });

    const found = await findListingsBySignal({
      signal: 'top-rated',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found.map((l) => l.id)).toEqual([manyReviewsId]);
  });

  it('new orders by published_at and not by row creation', async () => {
    // Created in the REVERSE order they were published — the row published
    // LATER is written to the table FIRST — so a query ordering by
    // `created_at` shows `publishedEarlierId` first and fails this assertion.
    const categoryId = await makeCategory();
    const publishedLaterId = await makeListing(categoryId, {
      publishedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const publishedEarlierId = await makeListing(categoryId, {
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const found = await findListingsBySignal({
      signal: 'new',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found.map((l) => l.id)).toEqual([publishedLaterId, publishedEarlierId]);
  });

  it('on-sale honours the category scope (#7 ruling 7)', async () => {
    // A discounted listing in a SIBLING category must not leak onto this
    // category's shelf — `findOnSaleListings` used to accept no category
    // filter at all, so a category page's `on-sale` shelf was really a
    // store-wide one.
    const categoryId = await makeCategory();
    const siblingCategoryId = await makeCategory();
    const onSaleInScopeId = await makeListing(categoryId);
    await insertVariants(onSaleInScopeId, [
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
    const onSaleOutOfScopeId = await makeListing(siblingCategoryId);
    await insertVariants(onSaleOutOfScopeId, [
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

    const found = await findListingsBySignal({
      signal: 'on-sale',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found.map((l) => l.id)).toEqual([onSaleInScopeId]);
  });

  it('best-selling reads the counted rows and honours the scope', async () => {
    const categoryId = await makeCategory();
    const siblingCategoryId = await makeCategory();
    const bestSellerId = await makeListing(categoryId);
    const laggardId = await makeListing(categoryId);
    // The sibling's count is the HIGHEST of the three: a query that ignores
    // the category scope puts it first, which this exact-order assertion
    // catches immediately.
    const siblingListingId = await makeListing(siblingCategoryId);
    await seedSignal({
      subjectType: 'listing',
      subjectId: bestSellerId,
      categoryId,
      unitsSold: 50,
    });
    await seedSignal({ subjectType: 'listing', subjectId: laggardId, categoryId, unitsSold: 5 });
    await seedSignal({
      subjectType: 'listing',
      subjectId: siblingListingId,
      categoryId: siblingCategoryId,
      unitsSold: 999,
    });

    const found = await findListingsBySignal({
      signal: 'best-selling',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found.map((l) => l.id)).toEqual([bestSellerId, laggardId]);
  });

  it('best-selling excludes a listing whose units_sold is zero', async () => {
    // Unlike the vacuity case above, `unsoldId` DOES have a `discovery_signals`
    // row — every counted subject earns one in every scope it belongs to,
    // whether or not it ever sold anything. A shelf named for units sold must
    // not show a row where that column is zero.
    const categoryId = await makeCategory();
    const soldId = await makeListing(categoryId);
    const unsoldId = await makeListing(categoryId);
    await seedSignal({ subjectType: 'listing', subjectId: soldId, categoryId, unitsSold: 5 });
    await seedSignal({ subjectType: 'listing', subjectId: unsoldId, categoryId, unitsSold: 0 });

    const found = await findListingsBySignal({
      signal: 'best-selling',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found.map((l) => l.id)).toEqual([soldId]);
  });

  it('best-selling returns nothing when nothing was counted', async () => {
    // The vacuity floor's counterpart: an active listing exists in the
    // category, but the sweep never wrote a `discovery_signals` row for it. A
    // query that joins the wrong way round returns every listing in the
    // category instead of an empty shelf.
    const categoryId = await makeCategory();
    await makeListing(categoryId);

    const found = await findListingsBySignal({
      signal: 'best-selling',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found).toEqual([]);
  });

  it('best-selling excludes a listing whose status is no longer active', async () => {
    // The restricted listing's count is far HIGHER than the active one's — a
    // missing status filter would put it FIRST, not merely leave it in
    // second place, so this fails loudly rather than by omission.
    const categoryId = await makeCategory();
    const activeId = await makeListing(categoryId);
    const restrictedId = await makeListing(categoryId, { status: 'restricted' });
    await seedSignal({ subjectType: 'listing', subjectId: activeId, categoryId, unitsSold: 5 });
    await seedSignal({
      subjectType: 'listing',
      subjectId: restrictedId,
      categoryId,
      unitsSold: 500,
    });

    const found = await findListingsBySignal({
      signal: 'best-selling',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found.map((l) => l.id)).toEqual([activeId]);
  });

  it('most-viewed excludes a listing whose view_count is zero', async () => {
    // Same defect as the best-selling case above, the other column.
    const categoryId = await makeCategory();
    const viewedId = await makeListing(categoryId);
    const unviewedId = await makeListing(categoryId);
    await seedSignal({ subjectType: 'listing', subjectId: viewedId, categoryId, viewCount: 5 });
    await seedSignal({ subjectType: 'listing', subjectId: unviewedId, categoryId, viewCount: 0 });

    const found = await findListingsBySignal({
      signal: 'most-viewed',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found.map((l) => l.id)).toEqual([viewedId]);
  });

  it('most-viewed excludes a listing whose status is no longer active', async () => {
    const categoryId = await makeCategory();
    const activeId = await makeListing(categoryId);
    const restrictedId = await makeListing(categoryId, { status: 'restricted' });
    await seedSignal({ subjectType: 'listing', subjectId: activeId, categoryId, viewCount: 5 });
    await seedSignal({
      subjectType: 'listing',
      subjectId: restrictedId,
      categoryId,
      viewCount: 500,
    });

    const found = await findListingsBySignal({
      signal: 'most-viewed',
      categoryIds: [categoryId],
      limit: 10,
      offset: 0,
    });

    expect(found.map((l) => l.id)).toEqual([activeId]);
  });
});

describe('findStoresBySignal', () => {
  it('ranks store ids by units_sold and honours the scope', async () => {
    const categoryId = await makeCategory();
    const siblingCategoryId = await makeCategory();
    const topStoreId = await makeStore();
    const laggardStoreId = await makeStore();
    // Highest count of the three, but in a SIBLING category — a query that
    // ignores the scope puts it first.
    const siblingStoreId = await makeStore();
    await seedSignal({
      subjectType: 'store',
      subjectId: laggardStoreId,
      categoryId,
      unitsSold: 5,
    });
    await seedSignal({
      subjectType: 'store',
      subjectId: topStoreId,
      categoryId,
      unitsSold: 50,
    });
    await seedSignal({
      subjectType: 'store',
      subjectId: siblingStoreId,
      categoryId: siblingCategoryId,
      unitsSold: 999,
    });

    const found = await findStoresBySignal({ categoryId, limit: 10 });

    expect(found).toEqual([topStoreId, laggardStoreId]);
  });

  it('excludes a store that is no longer active', async () => {
    // Highest count of the two, but suspended — a missing status filter would
    // put it first rather than exclude it.
    const categoryId = await makeCategory();
    const activeStoreId = await makeStore();
    const suspendedStoreId = await makeStore();
    await updateStoreColumns(suspendedStoreId, { status: 'suspended' });
    await seedSignal({
      subjectType: 'store',
      subjectId: activeStoreId,
      categoryId,
      unitsSold: 5,
    });
    await seedSignal({
      subjectType: 'store',
      subjectId: suspendedStoreId,
      categoryId,
      unitsSold: 500,
    });

    const found = await findStoresBySignal({ categoryId, limit: 10 });

    expect(found).toEqual([activeStoreId]);
  });
});

describe('findStoresWithLiveDiscounts', () => {
  it('lists a store with a live automatic discount', async () => {
    const storeId = await makeStore();
    const discountId = await makeDiscount(storeId);

    const found = await findStoresWithLiveDiscounts(500);
    const entry = found.find((row) => row.storeId === storeId);

    expect(entry?.discount.id).toBe(discountId);
  });

  it('excludes a code discount', async () => {
    // A shelf advertising a saving that needs a code the shopper does not
    // have is a false price.
    const storeId = await makeStore();
    await makeDiscount(storeId, { method: 'code' });

    const found = await findStoresWithLiveDiscounts(500);

    expect(found.some((row) => row.storeId === storeId)).toBe(false);
  });

  it('excludes a discount that has not started yet', async () => {
    // `starts_at` in the future, `ends_at` left open. The converse fixture
    // below closes the window from the other side; deleting or inverting
    // either half of the predicate is caught by exactly one of the two.
    const storeId = await makeStore();
    await makeDiscount(storeId, { startsAt: new Date(Date.now() + 60 * 60 * 1000) });

    const found = await findStoresWithLiveDiscounts(500);

    expect(found.some((row) => row.storeId === storeId)).toBe(false);
  });

  it('excludes a discount whose window has closed', async () => {
    // `ends_at` in the past. A query filtering only on `is_active` passes
    // every fixture whose window is open, so this fixture keeps `is_active`
    // true and varies only the window.
    const storeId = await makeStore();
    const now = Date.now();
    await makeDiscount(storeId, {
      startsAt: new Date(now - 2 * 60 * 60 * 1000),
      endsAt: new Date(now - 60 * 60 * 1000),
    });

    const found = await findStoresWithLiveDiscounts(500);

    expect(found.some((row) => row.storeId === storeId)).toBe(false);
  });

  it('excludes an inactive discount whose window is open', async () => {
    // The converse of the previous case. Neither assertion's fixture can
    // pass for the other's reason.
    const storeId = await makeStore();
    await makeDiscount(storeId, { isActive: false });

    const found = await findStoresWithLiveDiscounts(500);

    expect(found.some((row) => row.storeId === storeId)).toBe(false);
  });

  it('excludes a discount whose store is no longer active', async () => {
    // The discount itself is perfectly live — the only thing wrong is the
    // store underneath it.
    const storeId = await makeStore();
    await makeDiscount(storeId);
    await updateStoreColumns(storeId, { status: 'suspended' });

    const found = await findStoresWithLiveDiscounts(500);

    expect(found.some((row) => row.storeId === storeId)).toBe(false);
  });
});
