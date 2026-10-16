import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { collections } from '../../db/schema/merchandising.js';
import { stores } from '../../db/schema/stores.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { findLegacyArtworkStoreIds } from '../../db/stores/storeArtworkMediaRepository.js';
import { backfillStoreArtwork } from '../catalog-media/store-artwork-backfill.js';

// Only Oxy is simulated, at the SDK boundary: `importUserMedia` is Oxy's import
// by URL (ADR 0043 D7). These cases prove maintenance atomicity/identity in real
// PostgreSQL; they do not prove live Oxy imports.
const { importMedia } = vi.hoisted(() => ({ importMedia: vi.fn() }));
vi.mock('../../capabilities/oxy-service-client.js', () => ({
  oxyServiceClient: () => ({
    assets: { importUserMedia: (...args: unknown[]) => importMedia(...args) },
  }),
}));
function imported(id: string) {
  return {
    file: { id, mime: 'image/png', size: 10, visibility: 'public', status: 'active' },
    outcome: 'downloaded',
    deduplicated: false,
  };
}

let db: Database;
const storeIds: string[] = [];
const owner = `artwork-owner-${uuidv7()}`;
const logo = 'https://supplier.example/logo.png?signature=private';
const banner = 'https://supplier.example/collection.png';
beforeAll(async () => {
  db = await connectPostgres();
});
beforeEach(() => {
  vi.resetAllMocks();
  let uploaded = 0;
  importMedia.mockImplementation(async () => imported(`imported-${++uploaded}`));
});
afterAll(async () => {
  await deleteTestStores(db, storeIds);
  await closePostgres();
});

async function fixture(
  artwork: { logo?: string; cover?: string; collection?: string } = { logo, collection: banner },
) {
  const [store] = await db
    .insert(stores)
    .values({
      handle: `artwork-${uuidv7()}`,
      name: 'Artwork store',
      description: '',
      oxyAccountId: owner,
      brandColor: '#000000',
      logoFileId: artwork.logo ?? null,
      coverFileId: artwork.cover ?? null,
    })
    .returning();
  storeIds.push(store.id);
  const [collection] = await db
    .insert(collections)
    .values({
      storeId: store.id,
      title: 'Featured',
      handle: `featured-${uuidv7()}`,
      type: 'manual',
      imageFileId: artwork.collection ?? null,
    })
    .returning();
  return { storeId: store.id, collectionId: collection.id };
}

async function artwork(storeId: string, collectionId: string) {
  const [store] = await db
    .select({ logo: stores.logoFileId, cover: stores.coverFileId })
    .from(stores)
    .where(eq(stores.id, storeId));
  const [collection] = await db
    .select({ image: collections.imageFileId })
    .from(collections)
    .where(eq(collections.id, collectionId));
  return { ...store, collection: collection.image };
}

describe('legacy store artwork import', () => {
  it('previews hashes without media I/O or writes', async () => {
    const { storeId, collectionId } = await fixture();
    const before = await artwork(storeId, collectionId);
    const report = await backfillStoreArtwork({ mode: 'preview', limit: 1, storeId }, db);
    expect(report.entries[0]).toMatchObject({
      storeId,
      outcome: 'pending',
      artwork: [
        { target: 'logo', id: storeId },
        { target: 'collection', id: collectionId },
      ],
    });
    expect(JSON.stringify(report)).not.toMatch(/supplier|signature|private/);
    expect(await artwork(storeId, collectionId)).toEqual(before);
    expect(importMedia).not.toHaveBeenCalled();
  });

  it('imports under the persisted store owner, keeps Oxy IDs and reruns without I/O', async () => {
    const { storeId, collectionId } = await fixture({
      logo,
      cover: 'already-internal',
      collection: banner,
    });
    const report = await backfillStoreArtwork({ mode: 'apply', limit: 1, storeId }, db);
    expect(report.entries[0].outcome).toBe('applied');
    expect(await artwork(storeId, collectionId)).toEqual({
      logo: 'imported-1',
      cover: 'already-internal',
      collection: 'imported-2',
    });
    expect(importMedia.mock.calls[0][0]).toBe(owner);
    expect(await findLegacyArtworkStoreIds({ storeId, limit: 1 }, db)).toEqual([]);
    expect((await backfillStoreArtwork({ mode: 'apply', limit: 1, storeId }, db)).entries).toEqual(
      [],
    );
    expect(importMedia).toHaveBeenCalledTimes(2);
  });

  it('commits nothing when a later upload fails and reports the retry', async () => {
    const { storeId, collectionId } = await fixture();
    const before = await artwork(storeId, collectionId);
    importMedia
      .mockResolvedValueOnce(imported('first-file'))
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 403'), { status: 403 }));
    const report = await backfillStoreArtwork({ mode: 'apply', limit: 1, storeId }, db);
    expect(report.entries[0].outcome).toBe('failed');
    expect(report.retryStoreIds).toEqual([storeId]);
    expect(await artwork(storeId, collectionId)).toEqual(before);
  });

  it.each(['owner', 'logo', 'collection'] as const)(
    'refuses a concurrent %s change made while uploading',
    async (kind) => {
      const { storeId, collectionId } = await fixture();
      importMedia.mockImplementationOnce(async () => {
        if (kind === 'owner')
          await db
            .update(stores)
            .set({ oxyAccountId: `${owner}-new` })
            .where(eq(stores.id, storeId));
        if (kind === 'logo')
          await db
            .update(stores)
            .set({ logoFileId: 'merchant-new-logo' })
            .where(eq(stores.id, storeId));
        if (kind === 'collection')
          await db
            .update(collections)
            .set({ imageFileId: null })
            .where(eq(collections.id, collectionId));
        return imported('imported-file');
      });
      const before = await artwork(storeId, collectionId);
      const report = await backfillStoreArtwork({ mode: 'apply', limit: 1, storeId }, db);
      expect(report.entries[0].outcome).toBe('changed');
      expect(report.retryStoreIds).toEqual([storeId]);
      const after = await artwork(storeId, collectionId);
      // Nothing this run imported was written; only the concurrent edit stands.
      expect(after.logo).toBe(kind === 'logo' ? 'merchant-new-logo' : before.logo);
      expect(after.collection).toBe(kind === 'collection' ? null : before.collection);
    },
  );

  it('includes malformed references and refuses them before remote I/O', async () => {
    const { storeId } = await fixture({ logo: 'not a file ID' });
    expect(await findLegacyArtworkStoreIds({ storeId, limit: 1 }, db)).toEqual([storeId]);
    const report = await backfillStoreArtwork({ mode: 'apply', limit: 1, storeId }, db);
    expect(report.entries[0].outcome).toBe('failed');
    expect(importMedia).not.toHaveBeenCalled();
  });
});
