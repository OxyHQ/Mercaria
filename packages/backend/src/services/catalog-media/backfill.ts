import { createHash } from 'node:crypto';
import { isOxyFileId } from '@mercaria/shared-types';
import {
  applyListingMediaImport,
  findLegacyMediaListingIds,
  findListingMediaSnapshot,
} from '../../db/catalog/listingRepository.js';
import { getDb, type Database } from '../../db/postgres.js';
import { CatalogMediaSyncError, synchronizeAccountImages } from './sync.js';

export interface MediaBackfillOptions {
  mode: 'preview' | 'apply';
  limit: number;
  after?: string;
  listingId?: string;
}

/** A preview never downloads or uploads; an upload cannot be rolled back by a
 * database transaction. Reports contain hashes, not possibly signed source URLs. */
export async function backfillListingMedia(options: MediaBackfillOptions, db: Database = getDb()) {
  if (
    !['preview', 'apply'].includes(options.mode) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 500
  ) {
    throw new Error('Use preview or apply with a listing limit between 1 and 500.');
  }
  const ids = await findLegacyMediaListingIds({ ...options, limit: options.limit + 1 }, db);
  const entries: Array<{
    listingId: string;
    images: Array<{ id: string; position: number; sourceSha256: string }>;
    outcome: 'pending' | 'applied' | 'changed' | 'failed';
    reason?: string;
  }> = [];
  for (const listingId of ids.slice(0, options.limit)) {
    const snapshot = await findListingMediaSnapshot(listingId, db);
    const entry: (typeof entries)[number] = { listingId, images: [], outcome: 'changed' };
    entries.push(entry);
    if (!snapshot) continue;
    entry.images = snapshot.images
      .filter((image) => !isOxyFileId(image.fileId))
      .map((image) => ({
        id: image.id,
        position: image.position,
        sourceSha256: createHash('sha256').update(image.fileId).digest('hex'),
      }));
    if (entry.images.length === 0) continue;
    if (options.mode === 'preview') {
      entry.outcome = 'pending';
      continue;
    }
    try {
      const fileIds: string[] = [];
      // The synchronizer bounds a batch to 64. Large galleries still commit as
      // one unit only after every batch succeeds.
      for (let start = 0; start < snapshot.images.length; start += 64) {
        fileIds.push(
          ...(await synchronizeAccountImages(
            snapshot.ownerOxyUserId,
            snapshot.images.slice(start, start + 64).map((image) => image.fileId),
          )),
        );
      }
      entry.outcome = await applyListingMediaImport(snapshot, fileIds, db);
    } catch (error) {
      entry.outcome = 'failed';
      entry.reason =
        error instanceof CatalogMediaSyncError
          ? error.message
          : 'The gallery import could not be committed.';
    }
  }
  return {
    mode: options.mode,
    entries,
    resumeAfterListingId: ids.length > options.limit ? ids[options.limit - 1] : null,
    // Cursor progress is not success: changed/failed IDs need an explicit retry.
    retryListingIds: entries
      .filter((entry) => entry.outcome === 'changed' || entry.outcome === 'failed')
      .map((entry) => entry.listingId),
  };
}
