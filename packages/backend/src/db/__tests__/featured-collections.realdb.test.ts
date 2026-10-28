import { deleteTestStores } from './store-teardown.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { connectPostgres, closePostgres, getDb } from '../postgres.js';
import { insertStore } from '../stores/storeRepository.js';
import { insertCollection } from '../merchandising/collectionRepository.js';
import {
  featuredCollections,
  replaceFeaturedCollections,
} from '../merchandising/featuredCollectionRepository.js';
import { collections, storeFeaturedCollections } from '../schema/merchandising.js';
import { stores } from '../schema/stores.js';

const run = uuidv7();
const created: string[] = [];
async function fixture() {
  const store = await insertStore({
    oxyAccountId: `owner-${run}`,
    handle: uuidv7(),
    name: 'Curated shop',
    description: '',
    brandColor: '#000000',
    defaultCurrency: 'EUR',
  });
  created.push(store.id);
  const a = await insertCollection(
    store.id,
    { title: 'First', handle: 'first', type: 'manual', isPublished: true },
    [],
  );
  const b = await insertCollection(
    store.id,
    { title: 'Second', handle: 'second', type: 'manual', isPublished: true },
    [],
  );
  return { store, a, b };
}
beforeAll(connectPostgres);
afterAll(async () => {
  for (const id of created) await deleteTestStores(getDb(), [id]);
  await closePostgres();
});

describe('seller featured collection selection', () => {
  it('persists seller order, replacement, and explicit clearing', async () => {
    const { store, a, b } = await fixture();
    await replaceFeaturedCollections(store.id, store.oxyAccountId, [b.id, a.id]);
    expect((await featuredCollections(store.id, true)).map((x) => x.id)).toEqual([b.id, a.id]);
    await replaceFeaturedCollections(store.id, store.oxyAccountId, [a.id]);
    expect((await featuredCollections(store.id, true)).map((x) => x.id)).toEqual([a.id]);
    await replaceFeaturedCollections(store.id, store.oxyAccountId, []);
    expect(await featuredCollections(store.id, true)).toEqual([]);
  });
  it('rejects invalid selection atomically, retaining previous selection', async () => {
    const { store, a, b } = await fixture();
    const other = await fixture();
    await replaceFeaturedCollections(store.id, store.oxyAccountId, [a.id]);
    for (const ids of [[a.id, a.id], [other.a.id], Array.from({ length: 7 }, () => uuidv7())]) {
      await expect(replaceFeaturedCollections(store.id, store.oxyAccountId, ids)).rejects.toThrow();
    }
    await getDb().update(collections).set({ isPublished: false }).where(eq(collections.id, b.id));
    await expect(
      replaceFeaturedCollections(store.id, store.oxyAccountId, [b.id]),
    ).rejects.toThrow();
    await getDb()
      .update(collections)
      .set({ isPublished: true, type: 'automated' })
      .where(eq(collections.id, b.id));
    await expect(
      replaceFeaturedCollections(store.id, store.oxyAccountId, [b.id]),
    ).rejects.toThrow();
    expect((await featuredCollections(store.id, true)).map((x) => x.id)).toEqual([a.id]);
  });
  it('enforces same-store ownership and bounded positions at SQL boundary', async () => {
    const { store, a } = await fixture();
    const other = await fixture();
    await expect(
      getDb()
        .insert(storeFeaturedCollections)
        .values({ storeId: store.id, collectionId: other.a.id, position: 0 }),
    ).rejects.toThrow();
    await expect(
      getDb()
        .insert(storeFeaturedCollections)
        .values({ storeId: store.id, collectionId: a.id, position: 6 }),
    ).rejects.toThrow();
  });
  it('hides unpublished or no-longer-manual selections and cascades deleted collections', async () => {
    const { store, a, b } = await fixture();
    await replaceFeaturedCollections(store.id, store.oxyAccountId, [a.id, b.id]);
    await getDb().update(collections).set({ isPublished: false }).where(eq(collections.id, a.id));
    await getDb().update(collections).set({ type: 'automated' }).where(eq(collections.id, b.id));
    expect(await featuredCollections(store.id, true)).toEqual([]);
    expect(await featuredCollections(store.id, false)).toHaveLength(2);
    await getDb().delete(collections).where(eq(collections.id, a.id));
    expect((await featuredCollections(store.id, false)).map((x) => x.id)).toEqual([b.id]);
  });
  it('refuses a setter authorized against a previous store owner', async () => {
    const { store, a } = await fixture();
    await getDb()
      .update(stores)
      .set({ oxyAccountId: `new-${run}` })
      .where(eq(stores.id, store.id));
    await expect(replaceFeaturedCollections(store.id, store.oxyAccountId, [a.id])).rejects.toThrow(
      'Store ownership changed',
    );
    expect(await featuredCollections(store.id, false)).toEqual([]);
  });
  it('store deletion cascades its selection without affecting another store', async () => {
    const { store, a } = await fixture();
    const other = await fixture();
    await replaceFeaturedCollections(store.id, store.oxyAccountId, [a.id]);
    await replaceFeaturedCollections(other.store.id, other.store.oxyAccountId, [other.a.id]);
    await deleteTestStores(getDb(), [store.id]);
    expect(await featuredCollections(store.id, false)).toEqual([]);
    expect((await featuredCollections(other.store.id, false)).map((row) => row.id)).toEqual([
      other.a.id,
    ]);
  });
  it('concurrent replacements leave one complete ordered selection', async () => {
    const { store, a, b } = await fixture();
    await Promise.all([
      replaceFeaturedCollections(store.id, store.oxyAccountId, [a.id, b.id]),
      replaceFeaturedCollections(store.id, store.oxyAccountId, [b.id, a.id]),
    ]);
    const selected = (await featuredCollections(store.id, true)).map((x) => x.id);
    expect([
      [a.id, b.id],
      [b.id, a.id],
    ]).toContainEqual(selected);
  });
});
