/**
 * #261 — `listings.published_at` holds the FIRST activation, against a REAL
 * Postgres database.
 *
 * The defect: every create stamped it, including one the caller immediately made
 * `draft`, so the column meant "when the row was written" — which `created_at`
 * already means — and a reader trusting the name was wrong. #221 asserted the old
 * behaviour rather than narrowing it, because narrowing moves the keyset position
 * of every listing created as a draft and published later.
 *
 * ## Why this suite needs a real server
 *
 * The stamp is a SQL `coalesce` over the column's CURRENT value, not a JavaScript
 * comparison, so "a second activation does not restamp" is a fact about the
 * statement Postgres executes. A mocked `update` accepts any `.set()` and would
 * report the same green whether the expression read the stored value, ignored it,
 * or was dropped altogether. The `::timestamptz` cast has the same property: bound
 * the wrong way it throws `ERR_INVALID_ARG_TYPE` in the driver, which only a real
 * driver against a real column can tell you.
 *
 * ## What each case covers, and the one thing NONE of them covers
 *
 * The three statements that can write `listings.status` are all here: the create
 * (`insertListing`, through both service funnels), the patch
 * (`updateListingColumns`, through `updateListing`) and the CAS
 * (`setListingStatusIfIn`, the shape `services/moderation/enforcement.service.ts`
 * calls for a `restore`). `listing-publication-chokepoint.test.ts` is what covers
 * a FOURTH statement appearing — no runtime case can, because a writer nobody has
 * written yet runs in no test.
 *
 * Rows written BEFORE #261 are deliberately not covered, because they are
 * deliberately not changed: a historic draft keeps its create-time stamp, since
 * nothing in the schema tells one that was never published from one that WAS
 * active and was returned to `draft`. There is no backfill to test.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { sellerProfiles } from '../../db/schema/buyers.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertCategory } from '../../db/taxonomy/taxonomyRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import {
  findListingById,
  setListingStatusIfIn,
  type ListingRecord,
} from '../../db/catalog/listingRepository.js';
import { createP2PListing, createStoreProduct, updateListing } from '../catalog-write.service.js';

let db: Database;
const createdStoreIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdSellerIds: string[] = [];

/** A store with a default location, plus the category slug its products use. */
interface Fixture {
  readonly storeId: string;
  readonly categorySlug: string;
  readonly locationId: string;
}

async function makeFixture(): Promise<Fixture> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `publication-${suffix}`,
      name: 'Publication store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);

  const location = await insertLocation(store.id, {
    name: 'Default location',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });

  const category = await insertCategory({
    key: `publication-goods-${suffix}`,
    name: 'Publication goods',
    slug: `publication-goods-${suffix}`,
  });
  createdCategoryIds.push(category.id);

  return { storeId: store.id, categorySlug: category.slug, locationId: location.id };
}

/** One store product, created with the status the case is about. */
async function makeStoreProduct(
  fixture: Fixture,
  status?: 'active' | 'draft',
): Promise<ListingRecord> {
  const listingId = await createStoreProduct(
    fixture.storeId,
    {
      title: 'Publication tee',
      description: '',
      category: fixture.categorySlug,
      handle: `publication-tee-${uuidv7()}`,
      imageFileIds: [],
      options: [],
      variants: [
        {
          optionValues: [],
          price: { amount: 1500, currency: 'GBP' },
          inventory: { tracked: true, available: 3 },
        },
      ],
    },
    { locationId: fixture.locationId, ...(status ? { status } : {}) },
  );
  return readListing(listingId);
}

/** The row, insisted upon — a `null` here would make every assertion below vacuous. */
async function readListing(listingId: string): Promise<ListingRecord> {
  const row = await findListingById(listingId);
  expect(row, `listing ${listingId} must exist`).not.toBeNull();
  return row as ListingRecord;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  // `listings.store_id` is ON DELETE RESTRICT, so listings go first; the store
  // itself goes through the shared helper, which clears the `native_store_links`
  // row a whole-catalogue backfill pass may have minted against it.
  const storeIds = createdStoreIds.splice(0);
  for (const storeId of storeIds) {
    await db.delete(listings).where(eq(listings.storeId, storeId));
  }
  await deleteTestStores(db, storeIds);

  const sellerIds = createdSellerIds.splice(0);
  if (sellerIds.length > 0) {
    await db.delete(listings).where(inArray(listings.oxyUserId, sellerIds));
    await db.delete(sellerProfiles).where(inArray(sellerProfiles.oxyUserId, sellerIds));
  }
  for (const categoryId of createdCategoryIds.splice(0)) {
    await db.delete(categories).where(eq(categories.id, categoryId));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('a create derives `published_at` from the status it lands in', () => {
  it('leaves it NULL for a listing created as `draft`, and still records `created_at`', async () => {
    const fixture = await makeFixture();

    const row = await makeStoreProduct(fixture, 'draft');

    // The two facts are read in ONE row on purpose (#221's device): asserting the
    // NULL alone cannot tell "the column now means the first activation" from "the
    // row was never written properly", and `created_at` is the fact that used to
    // be duplicated into `published_at`.
    expect(row.status).toBe('draft');
    expect(row.publishedAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('stamps it for a store product created `active`', async () => {
    const fixture = await makeFixture();

    const row = await makeStoreProduct(fixture);

    expect(row.status).toBe('active');
    expect(row.publishedAt).toBeInstanceOf(Date);
  });

  it('stamps it for a P2P listing, which is born `active`', async () => {
    // The SECOND create funnel `insertListing` serves. Its status is a constant, so
    // this case cannot go red for the draft reason — what it guards is that making
    // the derivation the repository's did not stop the P2P path stamping at all.
    const fixture = await makeFixture();
    const oxyUserId = `seller-${uuidv7()}`;
    createdSellerIds.push(oxyUserId);

    const listingId = await createP2PListing(oxyUserId, {
      title: 'Second-hand bike',
      description: 'Ridden twice',
      category: fixture.categorySlug,
      price: { amount: 12000, currency: 'GBP' },
      // Two, because #90 refuses a used condition with fewer — the gallery IS the
      // condition evidence, so an empty one fails before any listing is written.
      imageFileIds: [`file-${uuidv7()}`, `file-${uuidv7()}`],
      // A real used listing: #90 wants the photographs, the acknowledgement AND a
      // disclosed detail before it will publish one, and none of that is optional.
      itemCondition: {
        key: 'used_good',
        defectsAcknowledged: true,
        details: [{ kind: 'cosmetic_wear', severity: 'light' }],
      },
    });
    const row = await readListing(listingId);

    expect(row.status).toBe('active');
    expect(row.publishedAt).toBeInstanceOf(Date);
  });
});

describe('the FIRST activation stamps it and no later one moves it', () => {
  it('stamps a draft the seller publishes — the branch the old create made dead', async () => {
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture, 'draft');
    expect(created.publishedAt, 'the premise of this case').toBeNull();

    await updateListing(created.id, { status: 'active' }, { kind: 'source' });

    const published = await readListing(created.id);
    expect(published.status).toBe('active');
    expect(published.publishedAt).toBeInstanceOf(Date);
    // The instant is the PUBLICATION, not the create: that is the whole ordering
    // change #261 accepted, and a stamp equal to `created_at` would mean the
    // derivation had silently kept the old meaning.
    expect(published.publishedAt.getTime()).toBeGreaterThanOrEqual(
      published.createdAt.getTime(),
    );
  });

  it('does NOT restamp when a listing is published a second time', async () => {
    // Pinned rather than left to the implementation, because both answers are
    // defensible and they differ on a listing moderation returned to `draft` and
    // the seller then republished. First publication is what the column claims to
    // hold, so a later one must not move it — otherwise a jury's
    // `request_changes` silently rewrites a shopper-visible "listed since" and
    // moves the listing to the head of every newest-first feed.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture, 'draft');

    await updateListing(created.id, { status: 'active' }, { kind: 'source' });
    const firstPublication = (await readListing(created.id)).publishedAt;
    expect(firstPublication).toBeInstanceOf(Date);

    await updateListing(created.id, { status: 'draft' }, { kind: 'source' });
    const unpublished = await readListing(created.id);
    // Returning to draft does not CLEAR it either — the listing has been on sale,
    // and forgetting that is what would let the next activation look like a first.
    expect(unpublished.status).toBe('draft');
    expect(unpublished.publishedAt).toEqual(firstPublication);

    await updateListing(created.id, { status: 'active' }, { kind: 'source' });
    const republished = await readListing(created.id);
    expect(republished.status).toBe('active');
    expect(republished.publishedAt).toEqual(firstPublication);
  });

  it('leaves it untouched when the status moves to `archived`', async () => {
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture);
    const publishedAt = created.publishedAt;
    expect(publishedAt).toBeInstanceOf(Date);

    await updateListing(created.id, { status: 'archived' }, { kind: 'source' });

    const archived = await readListing(created.id);
    expect(archived.status).toBe('archived');
    expect(archived.publishedAt).toEqual(publishedAt);
  });
});

describe('the moderation CAS is a first activation too', () => {
  it('stamps a never-published listing that a `restore` moves to `active`', async () => {
    // `enforcement.service.ts`'s restore is
    // `setListingStatusIfIn(subject.id, restoredStatus, ['restricted', 'draft'])`,
    // and `restoredStatus` falls back to `'active'` when the enforcement recorded
    // no previous status — so a listing that was never on sale can be activated by
    // this path and nothing else would stamp it. The call here is that call, with
    // the same arguments, rather than a convenient narrower one.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture, 'draft');
    expect(created.publishedAt, 'the premise of this case').toBeNull();

    const moved = await setListingStatusIfIn(created.id, 'active', ['restricted', 'draft']);
    expect(moved).toBe(true);

    const restored = await readListing(created.id);
    expect(restored.status).toBe('active');
    expect(restored.publishedAt).toBeInstanceOf(Date);
  });

  it('stamps nothing when the same CAS restores to `draft`', async () => {
    // The negative control in the SAME currency: this is the restore of a listing
    // whose enforcement DID record a previous status, and it must not publish
    // something its seller never listed. A stamp appearing here would mean the
    // derivation was reading the call rather than the status.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture, 'draft');
    await setListingStatusIfIn(created.id, 'restricted', ['draft']);

    const moved = await setListingStatusIfIn(created.id, 'draft', ['restricted', 'draft']);
    expect(moved).toBe(true);

    const restored = await readListing(created.id);
    expect(restored.status).toBe('draft');
    expect(restored.publishedAt).toBeNull();
  });

  it('does not move an existing stamp when a restriction is applied and lifted', async () => {
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture);
    const publishedAt = created.publishedAt;
    expect(publishedAt).toBeInstanceOf(Date);

    await setListingStatusIfIn(created.id, 'restricted', ['active']);
    expect((await readListing(created.id)).publishedAt).toEqual(publishedAt);

    await setListingStatusIfIn(created.id, 'active', ['restricted', 'draft']);
    const relisted = await readListing(created.id);
    expect(relisted.status).toBe('active');
    expect(relisted.publishedAt).toEqual(publishedAt);
  });
});
