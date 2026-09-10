/**
 * `findActiveListingsForStores` — the merchant shelf's read, against a REAL
 * Postgres database.
 *
 * The property under test is one no mock can hold: the bound is applied PER
 * STORE by a window function, not as one `LIMIT` over the batch. Both failure
 * modes are live shapes rather than hypotheticals —
 *
 *  - **no bound at all** is what this function shipped with, and the discovery
 *    root feed calls it once per top-level category, so an uncached explore
 *    request pulled every active listing of up to `shelfSize × shelfSize`
 *    stores into memory to render three thumbnails per card;
 *  - **one global bound** is the obvious repair and is worse than it looks: the
 *    order is global too, so the busiest store spends the whole budget and every
 *    other card on the shelf silently loses its images.
 *
 * The fixture is adverse to both. Store A carries four listings, all NEWER than
 * store B's two, against a `perStoreLimit` of 2: an unbounded read returns four
 * of A's, and a global `LIMIT 4` returns four of A's and none of B's.
 *
 * `categoryIds` is under test for the SAME property one restriction over: the
 * store's newest listings are filed in another category, so a cap spent before
 * the category is considered leaves the card empty. Its control is the case
 * that omits `categoryIds` entirely — the deals scope and the home feed's
 * merchant shelf both call this read that way and must keep seeing every
 * category.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every assertion is scoped to the two store ids this file creates, and the
 * read itself takes those ids, so no other file's stores can enter the result.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { categories, listings } from '../schema/catalog.js';
import { insertStore } from '../stores/storeRepository.js';
import { findActiveListingsForStores } from '../catalog/listingRepository.js';
import { deleteTestStores } from './store-teardown.js';

let db: Database;

const createdListingIds: string[] = [];
const createdStoreIds: string[] = [];
const createdCategoryIds: string[] = [];

/** A store, unique to this run. */
async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `store-shelf-${suffix}`,
      name: 'Store shelf fixture',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [
      {
        oxyUserId: `realdb-store-shelf-owner-${uuidv7()}`,
        role: 'owner',
        permissions: ['store:manage'],
      },
    ],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A flat category, unique to this run — `categoryIds`' population. */
async function makeCategory(): Promise<string> {
  const suffix = uuidv7().slice(-12);
  const [category] = await db
    .insert(categories)
    .values({
      key: `store-shelf-${suffix}`,
      name: `Store shelf ${suffix}`,
      slug: `store-shelf-${suffix}`,
      ancestorIds: [],
      position: 0,
      isActive: true,
    })
    .returning({ id: categories.id });
  createdCategoryIds.push(category.id);
  return category.id;
}

/** A store-owned listing published at an explicit moment — the shelf's ordering key. */
async function makeStoreListing(input: {
  storeId: string;
  publishedAt: Date;
  status?: 'active' | 'draft';
  categoryId?: string;
}): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId: input.storeId,
      title: 'Realdb store shelf listing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: input.status ?? 'active',
      publishedAt: input.publishedAt,
      categoryId: input.categoryId ?? null,
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);
  return listing.id;
}

/** Minutes before now, as a `published_at`. */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  const listingIds = createdListingIds.splice(0);
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  // AFTER the listings: `listings.category_id` is RESTRICT, so a category with
  // a listing still pointing at it cannot be deleted.
  const categoryIds = createdCategoryIds.splice(0);
  if (categoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, categoryIds));
  }
  const storeIds = createdStoreIds.splice(0);
  if (storeIds.length > 0) {
    await deleteTestStores(db, storeIds);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('findActiveListingsForStores', () => {
  it('caps each store at perStoreLimit and starves none of them', async () => {
    const busy = await makeStore();
    const quiet = await makeStore();

    // Store A's four are ALL newer than store B's two, so a single global
    // LIMIT 4 would return A's four and none of B's.
    const busyNewest = await makeStoreListing({ storeId: busy, publishedAt: minutesAgo(1) });
    const busySecond = await makeStoreListing({ storeId: busy, publishedAt: minutesAgo(2) });
    const busyThird = await makeStoreListing({ storeId: busy, publishedAt: minutesAgo(3) });
    const busyOldest = await makeStoreListing({ storeId: busy, publishedAt: minutesAgo(4) });
    const quietNewest = await makeStoreListing({ storeId: quiet, publishedAt: minutesAgo(10) });
    const quietOldest = await makeStoreListing({ storeId: quiet, publishedAt: minutesAgo(11) });

    const rows = await findActiveListingsForStores({
      storeIds: [busy, quiet],
      perStoreLimit: 2,
    });

    const idsOf = (storeId: string): string[] =>
      rows.filter((row) => row.storeId === storeId).map((row) => row.id);
    // Exact and ORDERED: the two newest of each, newest first.
    expect(idsOf(busy)).toEqual([busyNewest, busySecond]);
    expect(idsOf(quiet)).toEqual([quietNewest, quietOldest]);
    expect(rows.map((row) => row.id)).not.toContain(busyThird);
    expect(rows.map((row) => row.id)).not.toContain(busyOldest);
  });

  it('never spends a cap on a listing that is not active', async () => {
    // The cap is applied to the ACTIVE population, not to the store's rows: a
    // draft newer than everything else would otherwise occupy a slot and be
    // filtered out afterwards, leaving the card one thumbnail short.
    const storeId = await makeStore();
    const draft = await makeStoreListing({
      storeId,
      publishedAt: minutesAgo(1),
      status: 'draft',
    });
    const active = await makeStoreListing({ storeId, publishedAt: minutesAgo(2) });

    const rows = await findActiveListingsForStores({ storeIds: [storeId], perStoreLimit: 1 });

    expect(rows.map((row) => row.id)).toEqual([active]);
    expect(rows.map((row) => row.id)).not.toContain(draft);
  });

  it('reads nothing for an empty store list', async () => {
    expect(await findActiveListingsForStores({ storeIds: [], perStoreLimit: 3 })).toEqual([]);
  });

  it('spends the cap on the CATEGORY, not on the store', async () => {
    // The adverse shape, and the whole reason `categoryIds` is a predicate of
    // this read rather than a filter its caller applies afterwards. The store's
    // three NEWEST listings are all filed elsewhere, so a cap spent before the
    // category is considered returns the wanted category's products — none of
    // them — and the card renders empty for a store that plainly sells here.
    const storeId = await makeStore();
    const wanted = await makeCategory();
    const other = await makeCategory();

    const newestElsewhere = await makeStoreListing({
      storeId,
      publishedAt: minutesAgo(1),
      categoryId: other,
    });
    await makeStoreListing({ storeId, publishedAt: minutesAgo(2), categoryId: other });
    await makeStoreListing({ storeId, publishedAt: minutesAgo(3), categoryId: other });
    const wantedNewest = await makeStoreListing({
      storeId,
      publishedAt: minutesAgo(4),
      categoryId: wanted,
    });
    const wantedOldest = await makeStoreListing({
      storeId,
      publishedAt: minutesAgo(5),
      categoryId: wanted,
    });

    const rows = await findActiveListingsForStores({
      storeIds: [storeId],
      perStoreLimit: 2,
      categoryIds: [wanted],
    });

    expect(rows.map((row) => row.id)).toEqual([wantedNewest, wantedOldest]);
    expect(rows.map((row) => row.id)).not.toContain(newestElsewhere);
  });

  it('leaves the whole catalogue alone when no category is named', async () => {
    // The control for the case above, and the property the deals scope and the
    // home feed's merchant shelf depend on: both call this read with no
    // `categoryIds` at all, and must keep seeing every category. Without this,
    // the case above passes just as well against a read that scoped ALWAYS.
    const storeId = await makeStore();
    const wanted = await makeCategory();
    const other = await makeCategory();

    const newestElsewhere = await makeStoreListing({
      storeId,
      publishedAt: minutesAgo(1),
      categoryId: other,
    });
    const inWanted = await makeStoreListing({
      storeId,
      publishedAt: minutesAgo(2),
      categoryId: wanted,
    });

    const rows = await findActiveListingsForStores({ storeIds: [storeId], perStoreLimit: 3 });

    expect(rows.map((row) => row.id)).toEqual([newestElsewhere, inWanted]);
  });

  it('reads nothing for an explicitly empty category list', async () => {
    // "Nothing qualifies", never "no restriction" — the same convention
    // `listingIds`, `collectionIds` and `findOnSaleListings` already follow. A
    // caller that resolved a scope to zero categories must not be answered with
    // the store's whole catalogue.
    const storeId = await makeStore();
    const category = await makeCategory();
    await makeStoreListing({ storeId, publishedAt: minutesAgo(1), categoryId: category });

    expect(
      await findActiveListingsForStores({ storeIds: [storeId], perStoreLimit: 3, categoryIds: [] }),
    ).toEqual([]);
  });
});
