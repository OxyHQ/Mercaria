import { createHash } from 'node:crypto';
import {
  findAssetFileIdPage,
  findAssetFileStorageKey,
  replaceAssetFileStorageKey,
} from '../../db/digital/assetRepository.js';
import { getDb, type Database } from '../../db/postgres.js';
import { assetStorage, isDigitalStorageError } from './storage.js';

export interface AssetStorageBackfillOptions {
  mode: 'preview' | 'apply';
  limit: number;
  after?: string;
  fileId?: string;
}

/**
 * Move every digital deliverable onto an APPLICATION-owned PRIVATE Oxy file
 * (Oxy ADR 0043 D3/D5) holding the same bytes, so serving it never depends on
 * a creator's link (ADR 0021).
 *
 * The storage key is read through `findAssetFileStorageKey` — the one sanctioned
 * reader of that protected column — and never leaves this function: reports
 * carry a SHA-256 of it, never the key. A preview calls nothing. An apply adopts
 * through the storage port (`adoptAssetObject`: Oxy gives Mercaria its own file
 * of the stored bytes — ADR 0043 stage 4b, every type and size — and Mercaria
 * measures the copy's hash and size against the source's) and moves the row
 * with `replaceAssetFileStorageKey`, a compare-and-swap that the published-file
 * trigger admits only as a declared, same-bytes move (migration `0172`).
 *
 * `blocked`: Oxy refused the bytes as taken down (451, ADR 0043 D10). Not
 * retried — the claim decides, not a rerun.
 */
export async function backfillDigitalAssetStorage(
  options: AssetStorageBackfillOptions,
  db: Database = getDb(),
) {
  if (
    !['preview', 'apply'].includes(options.mode) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 500
  ) {
    throw new Error('Use preview or apply with a file limit between 1 and 500.');
  }
  const ids = await findAssetFileIdPage({ ...options, limit: options.limit + 1 }, db);
  const entries: Array<{
    fileId: string;
    storageKeySha256?: string;
    outcome: 'pending' | 'applied' | 'unchanged' | 'changed' | 'unreadable' | 'blocked' | 'failed';
    reason?: string;
  }> = [];
  for (const fileId of ids.slice(0, options.limit)) {
    const file = await findAssetFileStorageKey(fileId, db);
    if (!file) {
      entries.push({ fileId, outcome: 'changed' });
      continue;
    }
    const entry: (typeof entries)[number] = {
      fileId,
      storageKeySha256: createHash('sha256').update(file.storageKey).digest('hex'),
      outcome: 'pending',
    };
    entries.push(entry);
    if (options.mode === 'preview') continue;
    try {
      const adopted = await assetStorage.adoptAssetObject(file.storageKey);
      if (!adopted) {
        entry.outcome = 'unreadable';
        continue;
      }
      if (adopted.storageKey === file.storageKey) {
        entry.outcome = 'unchanged';
        continue;
      }
      entry.outcome = (await replaceAssetFileStorageKey(
        {
          fileId,
          previousKey: file.storageKey,
          next: {
            storageKey: adopted.storageKey,
            contentHash: adopted.contentHash,
            byteSize: adopted.byteSize,
            mediaType: file.mediaType,
          },
        },
        db,
      ))
        ? 'applied'
        : 'changed';
    } catch (error) {
      const status = (
        (isDigitalStorageError(error) ? error.cause : undefined) as { status?: unknown } | undefined
      )?.status;
      entry.outcome = status === 451 ? 'blocked' : 'failed';
      entry.reason = isDigitalStorageError(error)
        ? error.message
        : 'The storage move could not be committed.';
    }
  }
  return {
    mode: options.mode,
    entries,
    resumeAfterFileId: ids.length > options.limit ? ids[options.limit - 1] : null,
    retryFileIds: entries
      .filter((entry) => entry.outcome === 'changed' || entry.outcome === 'failed')
      .map((entry) => entry.fileId),
  };
}
