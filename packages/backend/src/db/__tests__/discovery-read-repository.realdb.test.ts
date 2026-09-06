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
 *  - `findStoresWithLiveDiscounts` must apply all three of its predicates
 *    independently: `method`, `is_active` and the scheduled window each get
 *    their own fixture that differs from the live one in exactly that one
 *    dimension, so no single assertion can pass for the wrong reason.
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
import type { DiscountMethod } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { categories, listings } from '../schema/catalog.js';
import { discoverySignals } from '../schema/discovery.js';
import { discounts } from '../schema/merchandising.js';
import { insertStore } from '../stores/storeRepository.js';
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
    status?: 'active' | 'draft';
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
});

describe('findStoresBySignal', () => {
  it('ranks store ids by units_sold and honours the scope', async () => {
    const categoryId = await makeCategory();
    const siblingCategoryId = await makeCategory();
    const topStoreId = `realdb-discovery-read-store-${uuidv7()}`;
    const laggardStoreId = `realdb-discovery-read-store-${uuidv7()}`;
    // Highest count of the three, but in a SIBLING category — a query that
    // ignores the scope puts it first.
    const siblingStoreId = `realdb-discovery-read-store-${uuidv7()}`;
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
});
