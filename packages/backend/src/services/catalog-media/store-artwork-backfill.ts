import { createHash } from 'node:crypto';
import {
  applyStoreArtworkImport,
  findLegacyArtworkStoreIds,
  findStoreArtworkSnapshot,
  type StoreArtworkTarget,
} from '../../db/stores/storeArtworkMediaRepository.js';
import { getDb, type Database } from '../../db/postgres.js';
import { CatalogMediaSyncError, synchronizeAccountImages } from './sync.js';

export interface StoreArtworkBackfillOptions {
  mode: 'preview' | 'apply';
  limit: number;
  after?: string;
  storeId?: string;
}

/** The store-artwork sibling of `backfillListingMedia`: logo, cover and
 * collection images import under the persisted store owner. A preview never
 * downloads or uploads; reports carry source hashes, never source URLs. */
export async function backfillStoreArtwork(options: StoreArtworkBackfillOptions, db: Database = getDb()) {
  if (!['preview', 'apply'].includes(options.mode) || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new Error('Use preview or apply with a store limit between 1 and 500.');
  }
  const ids = await findLegacyArtworkStoreIds({ ...options, limit: options.limit + 1 }, db);
  const entries: Array<{
    storeId: string;
    artwork: Array<{ target: StoreArtworkTarget; id: string; sourceSha256: string }>;
    outcome: 'pending' | 'applied' | 'changed' | 'failed';
    reason?: string;
  }> = [];
  for (const storeId of ids.slice(0, options.limit)) {
    const snapshot = await findStoreArtworkSnapshot(storeId, db);
    const entry: (typeof entries)[number] = { storeId, artwork: [], outcome: 'changed' };
    entries.push(entry);
    if (!snapshot) continue;
    entry.artwork = snapshot.entries.map(item => ({
      target: item.target, id: item.id, sourceSha256: createHash('sha256').update(item.source).digest('hex'),
    }));
    if (entry.artwork.length === 0) continue;
    if (options.mode === 'preview') { entry.outcome = 'pending'; continue; }
    try {
      const fileIds: string[] = [];
      // The synchronizer bounds a batch to 64; the store still commits as one unit.
      for (let start = 0; start < snapshot.entries.length; start += 64) {
        fileIds.push(...await synchronizeAccountImages(snapshot.ownerOxyUserId, snapshot.entries.slice(start, start + 64).map(item => item.source)));
      }
      entry.outcome = await applyStoreArtworkImport(snapshot, fileIds, db);
    } catch (error) {
      entry.outcome = 'failed';
      entry.reason = error instanceof CatalogMediaSyncError ? error.message : 'The store artwork import could not be committed.';
    }
  }
  return {
    mode: options.mode, entries,
    resumeAfterStoreId: ids.length > options.limit ? ids[options.limit - 1] : null,
    retryStoreIds: entries.filter(entry => entry.outcome === 'changed' || entry.outcome === 'failed').map(entry => entry.storeId),
  };
}
