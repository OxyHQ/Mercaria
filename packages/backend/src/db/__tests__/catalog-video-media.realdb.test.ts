import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { listings, listingImages, productVariantImages } from '../schema/catalog.js';
import { listingConditionPhotos } from '../schema/condition.js';
import { findListingChildren, findListingGallery, replaceListingImages, replaceListingMedia } from '../catalog/listingRepository.js';
import { insertVariants } from '../catalog/variantRepository.js';

let db: Database;
const ids: string[] = [];
beforeAll(async () => { db = await connectPostgres(); });
afterAll(async () => { if (ids.length) await db.delete(listings).where(inArray(listings.id, ids)); await closePostgres(); });
async function fixture() {
  const [listing] = await db.insert(listings).values({ ownerType: 'user', oxyUserId: `video-owner-${uuidv7()}`, title: 'Gallery', description: '', condition: 'used_good', conditionAssertion: 'seller_declared', status: 'draft' }).returning();
  ids.push(listing.id); return listing.id;
}
async function gallery(id: string) { return (await findListingChildren([id], db)).media.get(id) ?? []; }

describe('mixed catalog media persistence', () => {
  it('keeps photo IDs and variant assignments while reordering mixed media; legacy writers preserve video slots', async () => {
    const id = await fixture();
    await db.transaction(tx => replaceListingMedia(id, [{ kind: 'image', fileId: 'photo-a', position: 0 }, { kind: 'video', fileId: 'video-a', position: 1 }, { kind: 'image', fileId: 'photo-b', position: 2 }], tx));
    const before = await gallery(id);
    const [variant] = await insertVariants(id, [{ title: 'Blue', position: 0, optionValues: [], priceAmount: 1000, priceCurrency: 'FAIR', inventoryTracked: true, inventoryAvailable: 5 }], db);
    await db.insert(productVariantImages).values({ listingId: id, variantId: variant.id, listingImageId: before[0].id, position: 0 });
    // The public legacy entry point also serializes when passed a root DB.
    await replaceListingImages(id, [{ fileId: 'photo-b', position: 0 }, { fileId: 'photo-a', position: 1 }, { fileId: 'photo-c', position: 2 }], db);
    expect((await gallery(id)).map(row => [row.fileId, row.position])).toEqual([['photo-b', 0], ['video-a', 1], ['photo-a', 2], ['photo-c', 3]]);
    expect((await findListingGallery(id, db)).map(row => row.fileId)).toEqual(['photo-b', 'photo-a', 'photo-c']);
    expect((await db.select().from(productVariantImages).where(eq(productVariantImages.variantId, variant.id)))[0].listingImageId).toBe(before[0].id);
    await db.transaction(tx => replaceListingImages(id, [], tx));
    expect((await gallery(id)).map(row => [row.id, row.kind])).toEqual([[before[1].id, 'video']]);
    await db.transaction(tx => replaceListingMedia(id, [], tx));
    expect(await gallery(id)).toEqual([]);
  });

  it('rejects video association even when a SQL writer bypasses application validation', async () => {
    const id = await fixture();
    await db.transaction(tx => replaceListingMedia(id, [{ kind: 'video', fileId: `video-${uuidv7()}`, position: 0 }], tx));
    const [video] = await gallery(id);
    await expect(db.insert(listingImages).values({ listingId: await fixture(), fileId: video.fileId, kind: 'image', position: 0 })).rejects.toThrow();
    const [variant] = await insertVariants(id, [{ title: 'Default', position: 0, optionValues: [], priceAmount: 1000, priceCurrency: 'FAIR', inventoryTracked: true, inventoryAvailable: 5 }], db);
    await expect(db.insert(productVariantImages).values({ listingId: id, variantId: variant.id, listingImageId: video.id, position: 0 })).rejects.toThrow();
    await expect(db.insert(productVariantImages).values({ listingId: id, variantId: variant.id, listingImageId: video.id, mediaKind: 'video', position: 0 })).rejects.toThrow();
  });

  it('rejects video condition evidence in both write orders', async () => {
    const id = await fixture(); const fileId = `video-${uuidv7()}`;
    await db.transaction(tx => replaceListingMedia(id, [{ kind: 'video', fileId, position: 0 }], tx));
    const photo = { listingId: id, fileId, provenance: 'seller_uploaded' as const, uploadedByOxyUserId: 'owner', uploadedAt: new Date() };
    await expect(db.insert(listingConditionPhotos).values(photo)).rejects.toThrow();
    const second = `photo-${uuidv7()}`;
    await db.insert(listingConditionPhotos).values({ ...photo, fileId: second });
    await expect(db.insert(listingImages).values({ listingId: id, fileId: second, kind: 'video', position: 1 })).rejects.toThrow();
    await db.insert(listingImages).values({ listingId: id, fileId: second, kind: 'image', position: 1 });
  });

  it('requires a transaction for mixed replacements and rolls back a refused kind change', async () => {
    const id = await fixture();
    await expect(replaceListingMedia(id, [], db)).rejects.toThrow(/transaction/);
    await db.transaction(tx => replaceListingMedia(id, [{ kind: 'image', fileId: 'retained-photo', position: 0 }], tx));
    const before = await gallery(id);
    await expect(db.transaction(tx => replaceListingMedia(id, [{ kind: 'video', fileId: 'retained-photo', position: 0 }], tx))).rejects.toThrow(/kind/);
    expect(await gallery(id)).toEqual(before);
  });
  it('serializes competing file-kind claims and condition evidence across listings', async () => {
    const first = await fixture(); const second = await fixture(); const fileId = `racing-${uuidv7()}`;
    const writes = await Promise.allSettled([
      db.insert(listingImages).values({ listingId: first, fileId, kind: 'image', position: 0 }),
      db.insert(listingImages).values({ listingId: second, fileId, kind: 'video', position: 0 }),
    ]);
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const evidenceId = `evidence-${uuidv7()}`;
    const evidence = await Promise.allSettled([
      db.insert(listingImages).values({ listingId: first, fileId: evidenceId, kind: 'video', position: 2 }),
      db.insert(listingConditionPhotos).values({ listingId: second, fileId: evidenceId, provenance: 'seller_uploaded', uploadedByOxyUserId: 'owner', uploadedAt: new Date() }),
    ]);
    expect(evidence.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });

});
