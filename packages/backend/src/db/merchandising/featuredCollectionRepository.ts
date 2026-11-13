import { and, asc, eq, inArray } from 'drizzle-orm';
import { MAX_FEATURED_COLLECTIONS } from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { collections, storeFeaturedCollections } from '../schema/merchandising.js';
import { stores } from '../schema/stores.js';
import { conflict, validationError } from '../../lib/errors/error-codes.js';

export async function featuredCollections(storeId: string, publicOnly: boolean) {
  return getDb()
    .select({ collection: collections })
    .from(storeFeaturedCollections)
    .innerJoin(
      collections,
      and(
        eq(collections.id, storeFeaturedCollections.collectionId),
        eq(collections.storeId, storeFeaturedCollections.storeId),
      ),
    )
    .where(
      and(
        eq(storeFeaturedCollections.storeId, storeId),
        publicOnly
          ? and(eq(collections.isPublished, true), eq(collections.type, 'manual'))
          : undefined,
      ),
    )
    .orderBy(asc(storeFeaturedCollections.position))
    .limit(MAX_FEATURED_COLLECTIONS)
    .then((rows) => rows.map((row) => row.collection));
}

/** Serialize replacements on the owning store; a transfer invalidates the loaded authority. */
export async function replaceFeaturedCollections(
  storeId: string,
  ownerAccountId: string,
  ids: string[],
) {
  if (ids.length > MAX_FEATURED_COLLECTIONS || new Set(ids).size !== ids.length)
    throw validationError('Invalid featured collection selection');
  await getDb().transaction(async (tx) => {
    const [store] = await tx.select().from(stores).where(eq(stores.id, storeId)).for('update');
    if (!store || store.oxyAccountId !== ownerAccountId) throw conflict('Store ownership changed');
    const selected = ids.length
      ? await tx
          .select()
          .from(collections)
          .where(and(eq(collections.storeId, storeId), inArray(collections.id, ids)))
          .for('update')
      : [];
    if (
      selected.length !== ids.length ||
      selected.some((row) => !row.isPublished || row.type !== 'manual')
    )
      throw validationError('Select published manual collections belonging to this store');
    await tx.delete(storeFeaturedCollections).where(eq(storeFeaturedCollections.storeId, storeId));
    if (ids.length)
      await tx
        .insert(storeFeaturedCollections)
        .values(ids.map((collectionId, position) => ({ storeId, collectionId, position })));
  });
}
