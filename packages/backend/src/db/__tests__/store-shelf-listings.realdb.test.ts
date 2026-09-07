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
 * ## Scoping, because this database is SHARED
 *
 * Every assertion is scoped to the two store ids this file creates, and the
 * read itself takes those ids, so no other file's stores can enter the result.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { listings } from '../schema/catalog.js';
import { insertStore } from '../stores/storeRepository.js';
import { findActiveListingsForStores } from '../catalog/listingRepository.js';
import { deleteTestStores } from './store-teardown.js';

let db: Database;

const createdListingIds: string[] = [];
const createdStoreIds: string[] = [];

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

/** A store-owned listing published at an explicit moment — the shelf's ordering key. */
async function makeStoreListing(input: {
  storeId: string;
  publishedAt: Date;
  status?: 'active' | 'draft';
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
});
