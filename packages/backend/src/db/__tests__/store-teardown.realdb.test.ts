/**
 * `deleteTestStores` against a REAL server — the one property the census in
 * `store-teardown-census.test.ts` cannot see.
 *
 * That census proves no fixture deletes `stores` any other way. It says nothing
 * about whether the one function they all go through actually clears the link
 * first: strip that statement out and every scan stays green, because the
 * offender list is unchanged. This is the case that goes red instead.
 *
 * The precondition is written directly rather than by driving
 * `services/backfill/stages/store-merchants.ts`, which is the real writer.
 * Standing that stage up needs a run row, a cohort, a graph writer and the
 * publication flag — `backfill.realdb.test.ts` owns all of it — and reproducing
 * it here would make this file fail for the backfill's reasons. What the
 * teardown needs is exactly two facts: a `native_store_links` row points at
 * this file's store, and its merchant is one this file's teardown does not
 * know. Both are written through the same services the stage's writer calls, so
 * the row is production-shaped rather than hand-assembled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { constraintNameOf, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { merchants, nativeStoreLinks } from '../schema/merchants.js';
import { stores } from '../schema/stores.js';
import { insertStore } from '../stores/storeRepository.js';
import { createMerchant } from '../../services/commerce-graph/merchant.service.js';
import { linkNativeStore } from '../../services/commerce-graph/native-store-link.service.js';
import { deleteTestStores } from './store-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

/**
 * Merchants minted here, cleaned up LAST — a merchant cannot go while a link
 * points at it, and clearing the link is what the case under test does.
 */
const createdMerchantIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (createdMerchantIds.length > 0) {
    // `inArray` over the whole array rather than `[0]`. There is exactly one
    // push today, so the two spellings agree — which is the problem: the second
    // push would leave a merchant behind silently, and this file exists to
    // demonstrate a teardown that does not do that.
    await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  }
  await closePostgres();
});

/** A store with an `owner` member — the shape every fixture in this suite creates. */
async function seedStore(label: string): Promise<string> {
  const suffix = `${RUN}-${label}`;
  const store = await insertStore(
    {
      handle: `store-teardown-${suffix}`,
      name: `Store teardown ${suffix}`,
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  return store.id;
}

describe('deleting a store a foreign canonical link points at', () => {
  it('is REFUSED without the link clear, and succeeds with it', async () => {
    const storeId = await seedStore('linked');
    const merchant = await createMerchant({ name: `Store teardown ${RUN}` });
    createdMerchantIds.push(merchant.id);
    await linkNativeStore({
      merchantId: merchant.id,
      storeId,
      method: 'operator',
      reason: 'stands in for the store_merchants backfill stage, which links every active store',
      actorOxyUserId: `owner-${RUN}-linked`,
    });

    // The mechanism itself, asserted rather than assumed: this is the statement
    // every teardown in the suite used to issue, and it is what raised `23503`
    // on `store-linkage.realdb.test.ts` in a full local run. Naming the
    // CONSTRAINT rather than settling for "it threw" is what stops this passing
    // on some other rule the store happens to violate.
    const refused = await db
      .delete(stores)
      .where(eq(stores.id, storeId))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(refused, 'an unlinked store would make this whole case vacuous').not.toBeNull();
    expect(constraintNameOf(refused)).toBe('native_store_links_store_id_stores_id_fk');

    await deleteTestStores(db, [storeId]);

    expect(await db.select().from(stores).where(eq(stores.id, storeId))).toEqual([]);
    expect(
      await db.select().from(nativeStoreLinks).where(eq(nativeStoreLinks.storeId, storeId)),
    ).toEqual([]);
  });

  it('leaves a store nobody else named alone, and is a no-op on an empty list', async () => {
    // The other direction, so the helper cannot pass by deleting broadly. An
    // empty list must issue nothing at all: `inArray(col, [])` renders as the
    // literal `false`, which is harmless, but a caller whose fixture list is
    // empty should not be reaching the database to find that out.
    const kept = await seedStore('kept');

    await deleteTestStores(db, []);

    expect(await db.select().from(stores).where(eq(stores.id, kept))).toHaveLength(1);

    await deleteTestStores(db, [kept]);
    expect(await db.select().from(stores).where(eq(stores.id, kept))).toEqual([]);
  });
});
