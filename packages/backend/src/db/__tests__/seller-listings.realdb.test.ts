/**
 * A P2P seller's PUBLIC inventory, against a REAL Postgres database (#92).
 *
 * Three properties, and none of them can be tested against a mocked drizzle
 * client — a mock accepts any statement, including one whose predicate selects
 * the wrong rows:
 *
 *  1. **Ownership.** A store's listings never appear as a person's own
 *     inventory, even when that person owns the store (#92 acceptance 4,
 *     listing rule 8). The fixture makes the same Oxy account a store OWNER and
 *     a P2P seller, which is the only shape in which the bug can occur.
 *  2. **Status.** Sold, archived, restricted and draft listings are not public
 *     (listing rule 5). `restricted` is the one that matters most: it is what a
 *     CrowdSource takedown writes, so a wrong predicate here keeps a delisted
 *     item on the page most likely to be linked from a report.
 *  3. **Keyset stability.** Paging is stable across an insert that lands
 *     between two page reads (listing rule 6) — the failure an offset has and a
 *     keyset does not, which is only observable against a real ORDER BY and a
 *     real comparison, including the `nulls last` half of it.
 *
 * Every fixture pair spans the distinction its assertion exists to make: a
 * suite that seeded only the rows that must APPEAR could not tell a correct
 * predicate from `SELECT *`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { listings } from '../schema/catalog.js';
import { deleteTestStores } from './store-teardown.js';
import { insertStore } from '../stores/storeRepository.js';
import { insertListing } from '../catalog/listingRepository.js';
import {
  countActiveSellerListings,
  findActiveSellerListingsKeyset,
  findSellerFirstPublishedAt,
} from '../catalog/listingRepository.js';

let db: Database;

/** Store ids created by a test, dropped afterwards so the shared database stays clean. */
const createdStoreIds: string[] = [];
/** Listing ids created directly (not via a store), dropped afterwards. */
const createdListingIds: string[] = [];

/** Create a store owned by `oxyUserId` and register it for cleanup. */
async function makeStoreOwnedBy(oxyUserId: string): Promise<string> {
  const store = await insertStore(
    {
      handle: `seller-listings-${uuidv7()}`,
      name: 'Seller-listings realdb store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

type ListingInput = Parameters<typeof insertListing>[0];

/** The common half of every listing fixture — only the owner and status vary. */
function baseListing(): Omit<ListingInput, 'ownerType' | 'oxyUserId' | 'storeId' | 'status'> {
  return {
    title: 'Seller realdb listing',
    productTypeDefinitionId: null,
    description: '',
    condition: 'used_good',
    conditionAssertion: 'seller_declared',
    conditionSourceLabel: null,
    conditionAcknowledgedAt: null,
    categoryId: null,
    categorySlugs: [],
    tags: [],
    priceRangeMinAmount: null,
    priceRangeMinCurrency: null,
    priceRangeMaxAmount: null,
    priceRangeMaxCurrency: null,
    hasInventory: false,
    variantCount: 0,
    longitude: null,
    latitude: null,
    vendor: null,
    productType: null,
    handle: null,
    seoTitle: null,
    seoDescription: null,
    sourceConnectionId: null,
    sourceProvider: null,
    sourceExternalId: null,
    sourceExternalUpdatedAt: null,
    overriddenFields: [],
    rating: 0,
    reviewCount: 0,
    favoriteCount: 0,
    publishedAt: new Date(),
  };
}

/** A P2P (person-owned) listing. */
async function makeSellerListing(
  oxyUserId: string,
  overrides: Partial<ListingInput> = {},
): Promise<string> {
  const row = await insertListing(
    {
      ...baseListing(),
      ownerType: 'user',
      oxyUserId,
      storeId: null,
      status: 'active',
      ...overrides,
    },
    [],
    [],
  );
  createdListingIds.push(row.id);
  return row.id;
}

/** A store-owned listing. */
async function makeStoreListing(storeId: string): Promise<string> {
  const row = await insertListing(
    {
      ...baseListing(),
      ownerType: 'store',
      oxyUserId: null,
      storeId,
      status: 'active',
      title: 'Store-owned stock, not personal inventory',
    },
    [],
    [],
  );
  createdListingIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  const listingIds = createdListingIds.splice(0);
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  for (const storeId of createdStoreIds.splice(0)) {
    // `listings.store_id` is RESTRICT, so any survivor has to go first.
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await deleteTestStores(db, [storeId]);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe("a seller's public inventory never mixes with a store's", () => {
  it('excludes store-owned listings even when the seller OWNS the store', async () => {
    const oxyUserId = `seller-owner-${uuidv7()}`;
    const storeId = await makeStoreOwnedBy(oxyUserId);

    const personal = await makeSellerListing(oxyUserId);
    const shopStock = await makeStoreListing(storeId);

    const page = await findActiveSellerListingsKeyset(oxyUserId, 50, undefined);
    const ids = page.map((row) => row.id);

    // Both directions, because a predicate that returned NOTHING would satisfy
    // the exclusion on its own and tell us nothing about the query working.
    expect(ids).toContain(personal);
    expect(ids).not.toContain(shopStock);
    expect(await countActiveSellerListings(oxyUserId)).toBe(1);
  });
});

describe('only ACTIVE listings are public', () => {
  it.each(['draft', 'sold', 'archived', 'restricted'] as const)(
    'excludes a %s listing',
    async (status) => {
      const oxyUserId = `seller-status-${uuidv7()}`;
      const visible = await makeSellerListing(oxyUserId);
      const hidden = await makeSellerListing(oxyUserId, { status });

      const ids = (await findActiveSellerListingsKeyset(oxyUserId, 50, undefined)).map((r) => r.id);

      expect(ids).toEqual([expect.any(String)]);
      expect(ids).toContain(visible);
      expect(ids).not.toContain(hidden);
      expect(await countActiveSellerListings(oxyUserId)).toBe(1);
    },
  );
});

describe('keyset pagination is stable', () => {
  it('never repeats or skips a row when one is inserted between page reads', async () => {
    const oxyUserId = `seller-keyset-${uuidv7()}`;
    // Distinct, DESCENDING publish instants so the intended order is
    // unambiguous and not decided by a tiebreak.
    const base = Date.now() - 10 * 60_000;
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      seeded.push(
        await makeSellerListing(oxyUserId, { publishedAt: new Date(base + i * 60_000) }),
      );
    }
    const newestFirst = [...seeded].reverse();

    const first = await findActiveSellerListingsKeyset(oxyUserId, 2, undefined);
    expect(first.map((r) => r.id)).toEqual(newestFirst.slice(0, 2));

    // The insert that breaks an offset: a NEWER listing arrives, shifting every
    // row's position by one. A keyset cursor names a ROW, so page two is
    // unaffected; an offset would re-serve the row already shown.
    const interloper = await makeSellerListing(oxyUserId, { publishedAt: new Date(base + 6 * 60_000) });

    const last = first[first.length - 1];
    const second = await findActiveSellerListingsKeyset(oxyUserId, 2, {
      publishedAt: last.publishedAt,
      id: last.id,
    });

    expect(second.map((r) => r.id)).toEqual(newestFirst.slice(2, 4));
    expect(second.map((r) => r.id)).not.toContain(interloper);
    // And no row from page one reappears — the property an offset loses.
    for (const id of first.map((r) => r.id)) {
      expect(second.map((r) => r.id)).not.toContain(id);
    }
  });

  it('walks a NULL-published row last, and reaches it', async () => {
    const oxyUserId = `seller-nulls-${uuidv7()}`;
    const dated = await makeSellerListing(oxyUserId, { publishedAt: new Date() });
    // `published_at` is NULL on a listing that was activated without one. The
    // index orders `desc nulls last`, so this row must come AFTER the dated one
    // and must still be reachable through the cursor — the branch a plain
    // `(published_at, id) < (?, ?)` row comparison silently drops, because SQL
    // row comparison with a NULL member yields NULL rather than true.
    const undated = await makeSellerListing(oxyUserId, { publishedAt: null });

    const first = await findActiveSellerListingsKeyset(oxyUserId, 1, undefined);
    expect(first.map((r) => r.id)).toEqual([dated]);

    const second = await findActiveSellerListingsKeyset(oxyUserId, 5, {
      publishedAt: first[0].publishedAt,
      id: first[0].id,
    });
    expect(second.map((r) => r.id)).toEqual([undated]);

    // And a cursor sitting ON the NULL row terminates rather than looping.
    const third = await findActiveSellerListingsKeyset(oxyUserId, 5, {
      publishedAt: null,
      id: undated,
    });
    expect(third).toEqual([]);
  });
});

describe('"seller since"', () => {
  it('is the EARLIEST publish across every status, and null when nothing was published', async () => {
    const never = `seller-never-${uuidv7()}`;
    await makeSellerListing(never, { publishedAt: null, status: 'draft' });
    expect(await findSellerFirstPublishedAt(never)).toBeNull();

    const oxyUserId = `seller-since-${uuidv7()}`;
    const oldest = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    // The oldest listing is SOLD. A seller whose first three items all sold has
    // not become newer, so an active-only read would report the wrong date.
    await makeSellerListing(oxyUserId, { publishedAt: oldest, status: 'sold' });
    await makeSellerListing(oxyUserId, { publishedAt: new Date() });

    const firstPublishedAt = await findSellerFirstPublishedAt(oxyUserId);
    expect(firstPublishedAt).not.toBeNull();
    expect(new Date(firstPublishedAt ?? 0).getTime()).toBe(oldest.getTime());
  });
});
