import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { listings, listingImages, productVariantImages } from '../../db/schema/catalog.js';
import { stores } from '../../db/schema/stores.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import {
  findListingGallery,
  findLegacyMediaListingIds,
} from '../../db/catalog/listingRepository.js';
import { insertVariants } from '../../db/catalog/variantRepository.js';
import { backfillListingMedia } from '../catalog-media/backfill.js';

// Only the two remote transports are simulated. These cases prove maintenance
// atomicity/identity in real PostgreSQL; they do not prove live Oxy imports.
const { upload, download } = vi.hoisted(() => ({ upload: vi.fn(), download: vi.fn() }));
vi.mock('@oxy.so/core/server', async (original) => ({
  ...(await original<typeof import('@oxy.so/core/server')>()),
  safeFetch: (...args: unknown[]) => download(...args),
}));
vi.mock('../../capabilities/oxy-service-client.js', () => ({
  oxyServiceClient: () => ({
    baseURL: 'https://api.oxy.so',
    serviceToken: async () => 'test-service-token',
  }),
}));

let db: Database;
const listingIds: string[] = [];
const storeIds: string[] = [];
const owner = `media-owner-${uuidv7()}`;
const source = 'https://supplier.example/one.jpg?signature=private';
beforeAll(async () => {
  db = await connectPostgres();
});
beforeEach(() => {
  vi.resetAllMocks();
  download.mockImplementation(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    response: Readable.from([Buffer.from('test bytes')]),
  }));
  upload.mockImplementation(async () =>
    Response.json({ data: { file: { id: 'imported-file', visibility: 'public' } } }),
  );
  vi.stubGlobal('fetch', upload);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  if (listingIds.length) await db.delete(listings).where(inArray(listings.id, listingIds));
  await deleteTestStores(db, storeIds);
  await closePostgres();
});

async function fixture(references = [source, 'already-internal', source], storeId?: string) {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: storeId ? 'store' : 'user',
      oxyUserId: storeId ? null : owner,
      storeId: storeId ?? null,
      title: 'Legacy media',
      description: '',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning();
  listingIds.push(listing.id);
  await db.insert(listingImages).values(
    references.map((fileId, index) => ({
      listingId: listing.id,
      fileId,
      position: index * 2,
      alt: `Photo ${index}`,
    })),
  );
  return listing.id;
}

describe('legacy listing media import', () => {
  it('previews hashes and row identities without media I/O or writes', async () => {
    const id = await fixture();
    const before = await findListingGallery(id, db);
    const report = await backfillListingMedia({ mode: 'preview', limit: 1, listingId: id }, db);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      listingId: id,
      outcome: 'pending',
      images: [
        { id: before[0].id, position: 0 },
        { id: before[2].id, position: 4 },
      ],
    });
    expect(JSON.stringify(report)).not.toMatch(/supplier|signature|private/);
    expect(report.entries[0].images[0].sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await findListingGallery(id, db)).toEqual(before);
    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('retains row IDs, ordering, alt text and variant selections, then reruns without I/O', async () => {
    const id = await fixture();
    const before = await findListingGallery(id, db);
    const [variant] = await insertVariants(
      id,
      [
        {
          title: 'Blue',
          position: 0,
          optionValues: [],
          priceAmount: 1000,
          priceCurrency: 'FAIR',
          inventoryTracked: true,
          inventoryAvailable: 5,
        },
      ],
      db,
    );
    await db
      .insert(productVariantImages)
      .values({ listingId: id, variantId: variant.id, listingImageId: before[2].id, position: 7 });
    const report = await backfillListingMedia({ mode: 'apply', limit: 1, listingId: id }, db);
    expect(report.entries[0].outcome).toBe('applied');
    const after = await findListingGallery(id, db);
    expect(after.map(({ id, position, alt }) => ({ id, position, alt }))).toEqual(
      before.map(({ id, position, alt }) => ({ id, position, alt })),
    );
    expect(after.map((row) => row.fileId)).toEqual([
      'imported-file',
      'already-internal',
      'imported-file',
    ]);
    const selected = await db
      .select()
      .from(productVariantImages)
      .where(eq(productVariantImages.variantId, variant.id));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ listingImageId: before[2].id, position: 7 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][1].headers['x-owner-user-id']).toBe(owner);
    expect(
      (await backfillListingMedia({ mode: 'apply', limit: 1, listingId: id }, db)).entries,
    ).toEqual([]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('preserves the complete gallery if a later upload fails and reports its retry ID', async () => {
    const id = await fixture([source, 'https://supplier.example/two.png']);
    const before = await findListingGallery(id, db);
    upload
      .mockResolvedValueOnce(
        Response.json({ data: { file: { id: 'first-file', visibility: 'public' } } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const report = await backfillListingMedia({ mode: 'apply', limit: 1, listingId: id }, db);
    expect(report.entries[0]).toMatchObject({
      outcome: 'failed',
      reason: 'Oxy has not authorized catalog image synchronization.',
    });
    expect(report.retryListingIds).toEqual([id]);
    expect(await findListingGallery(id, db)).toEqual(before);
  });

  it('keeps a gallery larger than one download batch atomic', async () => {
    const references = Array.from(
      { length: 65 },
      (_, index) => `https://supplier.example/${index}.png`,
    );
    const id = await fixture(references);
    const before = await findListingGallery(id, db);
    let uploaded = 0;
    upload.mockImplementation(async () =>
      ++uploaded === 65
        ? new Response(null, { status: 500 })
        : Response.json({ data: { file: { id: `file-${uploaded}`, visibility: 'public' } } }),
    );
    const report = await backfillListingMedia({ mode: 'apply', limit: 1, listingId: id }, db);
    expect(upload).toHaveBeenCalledTimes(65);
    expect(report.entries[0].outcome).toBe('failed');
    expect(await findListingGallery(id, db)).toEqual(before);
  });

  it.each(['alt', 'order', 'new-image', 'owner', 'deleted'] as const)(
    'refuses a concurrent %s change made while downloading',
    async (kind) => {
      const id = await fixture([source]);
      const [image] = await findListingGallery(id, db);
      upload.mockImplementationOnce(async () => {
        if (kind === 'alt')
          await db
            .update(listingImages)
            .set({ alt: 'Edited caption' })
            .where(eq(listingImages.id, image.id));
        if (kind === 'order')
          await db
            .update(listingImages)
            .set({ position: 99 })
            .where(eq(listingImages.id, image.id));
        if (kind === 'new-image')
          await db
            .insert(listingImages)
            .values({ listingId: id, fileId: 'new-photo', position: 2 });
        if (kind === 'owner')
          await db
            .update(listings)
            .set({ oxyUserId: `${owner}-new` })
            .where(eq(listings.id, id));
        if (kind === 'deleted') await db.delete(listings).where(eq(listings.id, id));
        return Response.json({ data: { file: { id: 'imported-file', visibility: 'public' } } });
      });
      const report = await backfillListingMedia({ mode: 'apply', limit: 1, listingId: id }, db);
      expect(report.entries[0].outcome).toBe('changed');
      expect(report.retryListingIds).toEqual([id]);
      const after = await findListingGallery(id, db);
      if (kind === 'deleted') expect(after).toHaveLength(0);
      else expect(after.find((row) => row.id === image.id)?.fileId).toBe(source);
    },
  );

  it('imports under the persisted store account and refuses an ownership transfer during upload', async () => {
    const [store] = await db
      .insert(stores)
      .values({
        handle: `media-${uuidv7()}`,
        name: 'Media store',
        description: '',
        oxyAccountId: owner,
        brandColor: '#000000',
      })
      .returning();
    storeIds.push(store.id);
    const id = await fixture([source], store.id);
    upload.mockImplementationOnce(async () => {
      await db
        .update(stores)
        .set({ oxyAccountId: `${owner}-new` })
        .where(eq(stores.id, store.id));
      return Response.json({ data: { file: { id: 'imported-file', visibility: 'public' } } });
    });
    const report = await backfillListingMedia({ mode: 'apply', limit: 1, listingId: id }, db);
    expect(upload.mock.calls[0][1].headers['x-owner-user-id']).toBe(owner);
    expect(report.entries[0].outcome).toBe('changed');
    expect((await findListingGallery(id, db))[0].fileId).toBe(source);
  });

  it('includes malformed references in the backlog and refuses them before remote I/O', async () => {
    const id = await fixture(['not a file ID']);
    expect(await findLegacyMediaListingIds({ listingId: id, limit: 1 }, db)).toEqual([id]);
    expect(await findLegacyMediaListingIds({ listingId: id, after: id, limit: 1 }, db)).toEqual([]);
    const report = await backfillListingMedia({ mode: 'apply', limit: 1, listingId: id }, db);
    expect(report.entries[0].outcome).toBe('failed');
    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
