import { isOxyFileId, type CatalogMediaSource, type ListingMedia } from '@mercaria/shared-types';
import { findStoreById } from '../../db/stores/storeRepository.js';

import { config } from '../../config/index.js';
import { importOxyFileFromUrl, OxyFilesError, type OxyFileOwner } from './oxy-files.js';
import { catalogMediaKind } from './policy.js';

/**
 * No source URL, signed query or credential reaches a sync-run error. `cause`
 * is the adapter's `OxyFilesError` when Oxy refused (its message is as safe),
 * so a caller can tell Oxy's rate limit (`isOxyRateLimited`) from a refusal.
 */
export class CatalogMediaSyncError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CatalogMediaSyncError';
  }
}

/**
 * Import sources BEFORE catalog writes, never while holding a DB transaction.
 *
 * Oxy fetches the bytes (ADR 0043 D7) and remembers each source per owner, so an
 * unchanged source imported again returns the SAME file id without a download —
 * a connector that re-sends a whole gallery on every product update therefore
 * re-writes nothing. The owner is decided by the caller's function name, never
 * by request data:
 *
 * - `Store*` — the persisted store's Oxy account (`stores.oxy_account_id`).
 * - `Account*` — an account established by authenticated server context or a
 *   persisted owner during maintenance: a P2P seller, a store owner in a backfill.
 * - `Application*` — the Mercaria application itself, for content no account
 *   owns: canonical catalogue media, category art, brand logos. Never an
 *   operator's personal account (it was, until ADR 0043 gave products an owner).
 *
 * No reference is registered here: the reference outbox does that after the row
 * holding the file commits.
 */
export async function synchronizeStoreImages(
  storeId: string,
  references: readonly string[],
): Promise<string[]> {
  return synchronizeImages(references, () => storeOwner(storeId));
}

/** The account must come from authenticated server context or a persisted
 * owner during maintenance, never request data. */
export async function synchronizeAccountImages(
  ownerOxyUserId: string | undefined,
  references: readonly string[],
): Promise<string[]> {
  return synchronizeImages(references, async () => accountOwner(ownerOxyUserId));
}

/** Content no account owns belongs to the Mercaria application (ADR 0043 D1/D2). */
export async function synchronizeApplicationImages(
  references: readonly string[],
): Promise<string[]> {
  return synchronizeImages(references, async () => APPLICATION_OWNER);
}

export async function synchronizeStoreMedia(
  storeId: string,
  sources: readonly CatalogMediaSource[],
): Promise<ListingMedia[]> {
  return synchronizeMedia(sources, () => storeOwner(storeId));
}

export async function synchronizeAccountMedia(
  ownerOxyUserId: string | undefined,
  sources: readonly CatalogMediaSource[],
): Promise<ListingMedia[]> {
  return synchronizeMedia(sources, async () => accountOwner(ownerOxyUserId));
}

export async function synchronizeApplicationMedia(
  sources: readonly CatalogMediaSource[],
): Promise<ListingMedia[]> {
  return synchronizeMedia(sources, async () => APPLICATION_OWNER);
}

const APPLICATION_OWNER: OxyFileOwner = { kind: 'application' };

async function storeOwner(storeId: string): Promise<OxyFileOwner> {
  const store = await findStoreById(storeId);
  if (!store) throw new CatalogMediaSyncError('The media owner store does not exist.');
  return { kind: 'account', oxyUserId: store.oxyAccountId };
}

function accountOwner(ownerOxyUserId: string | undefined): OxyFileOwner {
  if (!ownerOxyUserId)
    throw new CatalogMediaSyncError('Catalog media synchronization needs an authenticated owner.');
  return { kind: 'account', oxyUserId: ownerOxyUserId };
}

async function synchronizeMedia(
  sources: readonly CatalogMediaSource[],
  resolveOwner: () => Promise<OxyFileOwner>,
): Promise<ListingMedia[]> {
  const references = sources.map((source) => source.reference);
  const kinds = new Map(sources.map((source) => [source.reference, source.kind]));
  if (sources.some((source) => kinds.get(source.reference) !== source.kind))
    throw new CatalogMediaSyncError('Conflicting catalog media types.');
  if (sources.some((source) => source.kind === 'video')) {
    if (!config.catalog.videoWritesEnabled)
      throw new CatalogMediaSyncError('Catalog video writes are not enabled.');
    // A declared kind is not proof of the stored MIME. Already-uploaded videos
    // enter through the authenticated metadata-verifying merchant writer.
    if (sources.some((source) => source.kind === 'video' && isOxyFileId(source.reference)))
      throw new CatalogMediaSyncError(
        'Video imports require an HTTPS source for byte verification.',
      );
  }
  const ids = await synchronizeImages(references, resolveOwner, kinds);
  return ids.map((fileId, position) => ({ fileId, position, kind: sources[position].kind }));
}

async function synchronizeImages(
  references: readonly string[],
  resolveOwner: () => Promise<OxyFileOwner>,
  kinds?: ReadonlyMap<string, 'image' | 'video'>,
): Promise<string[]> {
  if (references.length > 64) throw new CatalogMediaSyncError('Too many catalog images.');
  if (references.every((value): boolean => isOxyFileId(value))) return [...references];

  // Refuse invalid references before importing any image from this gallery.
  for (const value of references) {
    if (isOxyFileId(value)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new CatalogMediaSyncError('A catalog image must be an Oxy file ID or an HTTPS source.');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new CatalogMediaSyncError(
        'A catalog image source must use HTTPS without embedded credentials.',
      );
    }
  }
  const owner = await resolveOwner();

  const imported = new Map<string, string>();
  const ids: string[] = [];
  for (const reference of references) {
    if (isOxyFileId(reference)) {
      ids.push(reference);
      continue;
    }
    const existing = imported.get(reference);
    if (existing) {
      ids.push(existing);
      continue;
    }
    const kind = kinds?.get(reference) ?? 'image';
    let stored: Awaited<ReturnType<typeof importOxyFileFromUrl>>;
    try {
      stored = await importOxyFileFromUrl(owner, reference);
    } catch (error) {
      if (error instanceof OxyFilesError)
        throw new CatalogMediaSyncError(error.message, { cause: error });
      throw new CatalogMediaSyncError('Catalog image synchronization failed.');
    }
    if (stored.visibility !== 'public')
      throw new CatalogMediaSyncError('Oxy did not return a public catalog image file ID.');
    // The response's discriminator is derived from what Oxy measured, never from
    // the source's extension or the declared kind: a video that is not an MP4 we
    // accept, or an "image" that is a video, is refused before any write.
    const measured = catalogMediaKind(stored.mime, stored.size);
    if (measured !== kind)
      throw new CatalogMediaSyncError(
        kind === 'video'
          ? 'The catalog video is not an MP4 file within the size limit.'
          : 'The catalog image source did not return a supported image.',
      );
    imported.set(reference, stored.fileId);
    ids.push(stored.fileId);
  }
  return ids;
}
