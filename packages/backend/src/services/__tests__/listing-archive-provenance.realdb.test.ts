/**
 * #390 — what moved a listing into `archived`, recorded, against a REAL Postgres
 * database.
 *
 * The defect this closes is not a missing feature. It is that two situations
 * became INDISTINGUISHABLE the moment they had happened: a merchant deleting a
 * listing in Mercaria and a connector mirroring a product that vanished
 * upstream both produced the identical row. So a connector asked to relist on a
 * republish could only either undo the merchant's own decision or do nothing,
 * and #417 recorded that as the finding rather than choosing one.
 *
 * ## Where each half is covered
 *
 * The CONNECTOR half — the three causes it writes, and the republish that
 * consumes them — is in `connectors/__tests__/connector-contract-suite.ts`,
 * because it needs a platform to republish a product on and it must hold for
 * both providers. The MODERATION half is in `moderation-decision.realdb.test.ts`
 * beside the appeal that produces it.
 *
 * This file covers the rest — the writers that need no connector — and the
 * repository derivation all of them share:
 *
 *  - the two MERCHANT archivers, which are the pair a FILE-grained census
 *    cannot separate: `archiveListing` (the seller/admin `DELETE`) and
 *    `updateListing` writing `status: 'archived'`, both in
 *    `catalog-write.service.ts`;
 *  - the disconnect policy;
 *  - the derivation's three properties — that the previous status comes from
 *    the row rather than from a caller, that leaving `archived` CLEARS the
 *    record, and that a write which is not a transition records no previous
 *    status;
 *  - the refusal, which is what stops the unknowable set growing.
 *
 * ## Why a real server
 *
 * `archived_from_status` is `nullif(listings.status, 'archived')` evaluated
 * INSIDE the update, so "the previous status is the one the row actually held"
 * is a fact about the statement Postgres executes. A mocked `update` accepts any
 * `.set()` and reports the same green whether that expression reads the stored
 * value, reads the value being written, or was dropped. The three CHECKs have
 * the same property: nothing but a server refuses a row.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { ALL_LISTING_STATUSES } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertCategory } from '../../db/taxonomy/taxonomyRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import {
  findListingById,
  setListingStatusIfIn,
  type ListingRecord,
} from '../../db/catalog/listingRepository.js';
import { archiveListing, createStoreProduct, updateListing } from '../catalog-write.service.js';
import type { ConditionActor } from '../condition/condition-write.service.js';

/**
 * The merchant editing their own listing — `updateListing`'s actor.
 *
 * Deliberately a SELLER rather than `{kind:'source'}`: a connector patch would
 * take the same code path and none of these cases would be about a merchant any
 * more, which is the whole distinction under test.
 */
const MERCHANT: ConditionActor = { kind: 'seller', oxyUserId: `merchant-${uuidv7()}` };

let db: Database;
const createdStoreIds: string[] = [];
const createdCategoryIds: string[] = [];

interface Fixture {
  readonly storeId: string;
  readonly categorySlug: string;
  readonly locationId: string;
}

async function makeFixture(): Promise<Fixture> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `archive-provenance-${suffix}`,
      name: 'Archive provenance store',
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
    key: `archive-provenance-goods-${suffix}`,
    name: 'Archive provenance goods',
    slug: `archive-provenance-goods-${suffix}`,
  });
  createdCategoryIds.push(category.id);

  return { storeId: store.id, categorySlug: category.slug, locationId: location.id };
}

/** One store product, in the status the case is about. */
async function makeStoreProduct(
  fixture: Fixture,
  status: 'active' | 'draft' = 'active',
): Promise<ListingRecord> {
  const listingId = await createStoreProduct(
    fixture.storeId,
    {
      title: 'Provenance tee',
      description: '',
      category: fixture.categorySlug,
      handle: `provenance-tee-${uuidv7()}`,
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
    { locationId: fixture.locationId, status },
  );
  return readListing(listingId);
}

/** The row, insisted upon — a `null` here would make every assertion vacuous. */
async function readListing(listingId: string): Promise<ListingRecord> {
  const row = await findListingById(listingId);
  expect(row, `listing ${listingId} must exist`).not.toBeNull();
  return row as ListingRecord;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  // `listings.store_id` is ON DELETE RESTRICT, so listings go before the store.
  const storeIds = createdStoreIds.splice(0);
  for (const storeId of storeIds) {
    await db.delete(listings).where(eq(listings.storeId, storeId));
  }
  await deleteTestStores(db, storeIds);
  for (const categoryId of createdCategoryIds.splice(0)) {
    await db.delete(categories).where(eq(categories.id, categoryId));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('a create records no archive provenance', () => {
  it('leaves both columns NULL, because a create replaced no status', async () => {
    const fixture = await makeFixture();

    const row = await makeStoreProduct(fixture, 'draft');

    expect(row.status).toBe('draft');
    expect(row.archivedBy).toBeNull();
    expect(row.archivedFromStatus).toBeNull();
  });
});

describe('the two MERCHANT archivers are told apart from each other and from a connector', () => {
  it('records `merchant_delete` for the DELETE funnel, with the status it replaced', async () => {
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture);

    await archiveListing(created.id);

    const row = await readListing(created.id);
    expect(row.status).toBe('archived');
    expect(row.archivedBy).toBe('merchant_delete');
    expect(row.archivedFromStatus).toBe('active');
  });

  it('records `merchant_status_change` for a PATCH, the archiver a file census cannot see', async () => {
    // `SELLER_SETTABLE_LISTING_STATUSES` contains `archived`, so this is an
    // ordinary merchant edit — and it lives in the same file as `archiveListing`,
    // which is why `listing-archive-census.test.ts` needed a per-CAUSE half.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture, 'draft');

    await updateListing(created.id, { status: 'archived' }, MERCHANT);

    const row = await readListing(created.id);
    expect(row.status).toBe('archived');
    expect(row.archivedBy).toBe('merchant_status_change');
    // `draft`, not `active`: the value a restore would put back is what the
    // listing HELD, and this listing has never been on sale.
    expect(row.archivedFromStatus).toBe('draft');
  });
});

describe('the derivation is the repository’s, not a caller’s', () => {
  it('reads the previous status off the ROW, in the statement that writes the new one', async () => {
    // No caller passes it and no caller could: `ListingColumnPatch` and
    // `NewListing` both subtract the two columns, so the only value that can
    // reach them is the one the update computes from `listings.status`.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture);
    await updateListing(created.id, { status: 'sold' }, MERCHANT);

    await archiveListing(created.id);

    expect((await readListing(created.id)).archivedFromStatus).toBe('sold');
  });

  it('CLEARS the record when the listing leaves `archived`', async () => {
    // A record left on a live listing is the stale read the NEXT archiver would
    // be measured against: it would say a connector archived a listing that a
    // merchant has since deleted.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture);
    await archiveListing(created.id);
    expect((await readListing(created.id)).archivedBy).toBe('merchant_delete');

    await updateListing(created.id, { status: 'active' }, MERCHANT);

    const row = await readListing(created.id);
    expect(row.status).toBe('active');
    expect(row.archivedBy).toBeNull();
    expect(row.archivedFromStatus).toBeNull();
  });

  it('records NO previous status when the write was not a transition', async () => {
    // An idempotent merchant PATCH of `archived` onto an already-archived
    // listing replaced nothing, so there is nothing true to name. A restore
    // refuses that rather than putting the listing back into `archived`, which
    // is what storing the literal `archived` here would ask it to do.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture);
    await archiveListing(created.id);

    await updateListing(created.id, { status: 'archived' }, MERCHANT);

    const row = await readListing(created.id);
    expect(row.status).toBe('archived');
    expect(row.archivedBy).toBe('merchant_status_change');
    expect(row.archivedFromStatus).toBeNull();
  });

  it('REFUSES to archive with no cause, and writes nothing when it does', async () => {
    // The refusal is what freezes the unknowable set at the migration. NULL is
    // how a pre-#390 row says "nobody knows"; a new writer quietly minting more
    // of those would make the set grow instead, and every one of them is a
    // listing a republish can never bring back.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture);

    await expect(
      setListingStatusIfIn(created.id, 'archived', ALL_LISTING_STATUSES),
    ).rejects.toThrow(/ListingArchiveCause/);

    // The floor on that refusal: it has to happen BEFORE the statement, or the
    // listing is archived with no record and the throw is decoration.
    const row = await readListing(created.id);
    expect(row.status).toBe('active');
    expect(row.archivedBy).toBeNull();
  });

  it('does not disturb the record on a write that touches no status', async () => {
    // Every connector re-sync ends with a provenance-only patch
    // (`sourceExternalUpdatedAt`), which runs on an archived listing on every
    // pass. Clearing there would erase the fact one page before the pass that
    // reads it.
    const fixture = await makeFixture();
    const created = await makeStoreProduct(fixture);
    await archiveListing(created.id);

    await updateListing(created.id, { title: 'Renamed while archived' }, MERCHANT);

    const row = await readListing(created.id);
    expect(row.title).toBe('Renamed while archived');
    expect(row.archivedBy).toBe('merchant_delete');
    expect(row.archivedFromStatus).toBe('active');
  });
});
