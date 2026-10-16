/**
 * Maintenance reads/writes for store-owned artwork that still holds a URL where
 * an Oxy file ID belongs: the store logo and cover, and collection images. The
 * import runs outside any transaction; the apply refuses a stale owner or value
 * instead of overwriting an edit made while the network was in flight.
 */
import { and, asc, eq, gt, inArray, or, sql, TransactionRollbackError, type SQL } from 'drizzle-orm';
import { isOxyFileId } from '@mercaria/shared-types';
import { getDb, type Database, type DatabaseOrTransaction } from '../postgres.js';
import { collections } from '../schema/merchandising.js';
import { stores } from '../schema/stores.js';

const NOT_FILE_ID = '^[A-Za-z0-9_-]+$';

function legacy(column: typeof stores.logoFileId | typeof stores.coverFileId | typeof collections.imageFileId): SQL {
  return sql`(${column} is not null and ${column} !~ ${NOT_FILE_ID})`;
}

export type StoreArtworkTarget = 'logo' | 'cover' | 'collection';

export interface StoreArtworkEntry {
  target: StoreArtworkTarget;
  /** The store ID for `logo`/`cover`, the collection ID for `collection`. */
  id: string;
  source: string;
}

export interface StoreArtworkSnapshot {
  storeId: string;
  ownerOxyUserId: string;
  entries: StoreArtworkEntry[];
}

/** Malformed references are included: they must be reported, never skipped. */
export async function findLegacyArtworkStoreIds(
  options: { after?: string; storeId?: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const withLegacyCollection = sql`exists (
    select 1 from ${collections}
    where ${collections.storeId} = ${stores.id} and ${legacy(collections.imageFileId)}
  )`;
  const rows = await db.select({ id: stores.id }).from(stores)
    .where(and(
      or(legacy(stores.logoFileId), legacy(stores.coverFileId), withLegacyCollection),
      options.after ? gt(stores.id, options.after) : undefined,
      options.storeId ? eq(stores.id, options.storeId) : undefined,
    ))
    .orderBy(asc(stores.id)).limit(options.limit);
  return rows.map(row => row.id);
}

export async function findStoreArtworkSnapshot(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreArtworkSnapshot | null> {
  const [store] = await db.select({ owner: stores.oxyAccountId, logo: stores.logoFileId, cover: stores.coverFileId })
    .from(stores).where(eq(stores.id, storeId));
  if (!store) return null;
  const entries: StoreArtworkEntry[] = [];
  if (store.logo !== null && !isOxyFileId(store.logo)) entries.push({ target: 'logo', id: storeId, source: store.logo });
  if (store.cover !== null && !isOxyFileId(store.cover)) entries.push({ target: 'cover', id: storeId, source: store.cover });
  const rows = await db.select({ id: collections.id, source: collections.imageFileId }).from(collections)
    .where(and(eq(collections.storeId, storeId), legacy(collections.imageFileId)))
    .orderBy(asc(collections.id));
  for (const row of rows) if (row.source !== null) entries.push({ target: 'collection', id: row.id, source: row.source });
  return { storeId, ownerOxyUserId: store.owner, entries };
}

/** All of a store's artwork commits as one unit, or none of it does. */
export async function applyStoreArtworkImport(
  snapshot: StoreArtworkSnapshot,
  fileIds: readonly string[],
  db: Database = getDb(),
): Promise<'applied' | 'changed'> {
  if (fileIds.length !== snapshot.entries.length || !fileIds.every(isOxyFileId)) {
    throw new Error('Imported artwork must contain one Oxy file ID per entry.');
  }
  return db.transaction(async tx => {
    const [store] = await tx.select({ owner: stores.oxyAccountId }).from(stores)
      .where(eq(stores.id, snapshot.storeId)).for('update');
    if (store?.owner !== snapshot.ownerOxyUserId) return 'changed';
    const collectionIds = snapshot.entries.filter(entry => entry.target === 'collection').map(entry => entry.id);
    if (collectionIds.length) {
      await tx.select({ id: collections.id }).from(collections).where(inArray(collections.id, collectionIds)).for('update');
    }
    for (const [index, entry] of snapshot.entries.entries()) {
      const fileId = fileIds[index];
      const updated = entry.target === 'collection'
        ? await tx.update(collections).set({ imageFileId: fileId })
          .where(and(eq(collections.id, entry.id), eq(collections.storeId, snapshot.storeId), eq(collections.imageFileId, entry.source)))
          .returning({ id: collections.id })
        : await tx.update(stores).set(entry.target === 'logo' ? { logoFileId: fileId } : { coverFileId: fileId })
          .where(and(eq(stores.id, entry.id), eq(entry.target === 'logo' ? stores.logoFileId : stores.coverFileId, entry.source)))
          .returning({ id: stores.id });
      if (updated.length !== 1) tx.rollback();
    }
    return 'applied' as const;
  }).catch((error: unknown) => {
    if (error instanceof TransactionRollbackError) return 'changed' as const;
    throw error;
  });
}
