import { safeFetch } from '@oxy.so/core/server';
import { isOxyFileId, type CatalogMediaSource, type ListingMedia } from '@mercaria/shared-types';
import { oxyServiceClient } from '../../capabilities/oxy-service-client.js';
import { findStoreById } from '../../db/stores/storeRepository.js';

import { config } from '../../config/index.js';
import { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_VIDEO_MAX_BYTES, matchesProductVideo } from './policy.js';
const MAX_IMAGE_BYTES = PRODUCT_IMAGE_MAX_BYTES;
const TIMEOUT_MS = 20_000;

/** No source URL, signed query or credential reaches a sync-run error. */
export class CatalogMediaSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogMediaSyncError';
  }
}

/** Import bytes BEFORE catalog writes, never while holding a DB transaction.
 * Store ownership comes from Mercaria's persisted Oxy account reference.
 * Oxy authorizes the upload and owns the durable public file. */
export async function synchronizeStoreImages(
  storeId: string,
  references: readonly string[],
): Promise<string[]> {
  return synchronizeImages(references, async () => {
    const store = await findStoreById(storeId);
    if (!store) throw new CatalogMediaSyncError('The image owner store does not exist.');
    return store.oxyAccountId;
  });
}

/** The account must come from authenticated server context or a persisted
 * listing owner during maintenance, never request data.
 * Canonical operators own the durable media they import into the catalogue. */
export async function synchronizeAccountImages(
  ownerOxyUserId: string | undefined,
  references: readonly string[],
): Promise<string[]> {
  return synchronizeImages(references, async () => {
    if (!ownerOxyUserId)
      throw new CatalogMediaSyncError(
        'Catalog image synchronization needs an authenticated owner.',
      );
    return ownerOxyUserId;
  });
}

export async function synchronizeStoreMedia(
  storeId: string,
  sources: readonly CatalogMediaSource[],
): Promise<ListingMedia[]> {
  return synchronizeMedia(sources, async () => {
    const store = await findStoreById(storeId);
    if (!store) throw new CatalogMediaSyncError('The media owner store does not exist.');
    return store.oxyAccountId;
  });
}

export async function synchronizeAccountMedia(
  ownerOxyUserId: string | undefined,
  sources: readonly CatalogMediaSource[],
): Promise<ListingMedia[]> {
  return synchronizeMedia(sources, async () => {
    if (!ownerOxyUserId)
      throw new CatalogMediaSyncError(
        'Catalog media synchronization needs an authenticated owner.',
      );
    return ownerOxyUserId;
  });
}

async function synchronizeMedia(
  sources: readonly CatalogMediaSource[],
  resolveOwner: () => Promise<string>,
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
  resolveOwner: () => Promise<string>,
  kinds?: ReadonlyMap<string, 'image' | 'video'>,
): Promise<string[]> {
  if (references.length > 64) throw new CatalogMediaSyncError('Too many catalog images.');
  if (references.every((value): boolean => isOxyFileId(value))) return [...references];

  // Refuse invalid references before uploading any image from this gallery.
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
  const ownerOxyUserId = await resolveOwner();
  const client = oxyServiceClient();
  if (!client)
    throw new CatalogMediaSyncError(
      'Catalog image synchronization needs Oxy application credentials.',
    );

  const imported = new Map<string, string>();
  const ids: string[] = [];
  for (const reference of references) {
    const kind = kinds?.get(reference) ?? 'image';
    const maxBytes = kind === 'video' ? PRODUCT_VIDEO_MAX_BYTES : MAX_IMAGE_BYTES;
    if (isOxyFileId(reference)) {
      ids.push(reference);
      continue;
    }
    const existing = imported.get(reference);
    if (existing) {
      ids.push(existing);
      continue;
    }
    let downloaded: Awaited<ReturnType<typeof safeFetch>> | undefined;
    try {
      // safeFetch validates and pins DNS and revalidates every redirect; no
      // supplier credentials or Oxy token are sent to the source server.
      downloaded = await safeFetch(reference, {
        headersTimeoutMs: TIMEOUT_MS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const mime = String(downloaded.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (
        downloaded.status !== 200 ||
        (kind === 'video' ? mime !== 'video/mp4' : !mime.startsWith('image/'))
      ) {
        throw new CatalogMediaSyncError('The catalog image source did not return an image.');
      }
      const declared = Number(downloaded.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new CatalogMediaSyncError('The catalog image exceeds the size limit.');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of downloaded.response) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes)
          throw new CatalogMediaSyncError('The catalog image exceeds the size limit.');
        chunks.push(bytes);
      }
      if (size === 0) throw new CatalogMediaSyncError('The catalog image is empty.');

      if (kind === 'video' && !matchesProductVideo(Buffer.concat(chunks), mime))
        throw new CatalogMediaSyncError('The catalog video is not an MP4 file.');

      // This is durable user-owned media, NOT Oxy's evictable federation cache.
      // Oxy requires files:user-media:write for this cross-account upload.
      const response = await fetch(
        `${client.baseURL.replace(/\/+$/, '')}/assets/service/user-media`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await client.serviceToken()}`,
            'Content-Type': mime,
            'Content-Length': String(size),
            'x-owner-user-id': ownerOxyUserId,
            'x-original-name': `catalog-${kind}`,
            Accept: 'application/json',
          },
          body: new Uint8Array(Buffer.concat(chunks)),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error',
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new CatalogMediaSyncError(
          response.status === 401 || response.status === 403
            ? 'Oxy has not authorized catalog image synchronization.'
            : `Oxy could not store the catalog image (HTTP ${response.status}).`,
        );
      }
      const payload = (await response.json()) as {
        data?: { file?: { id?: unknown; visibility?: unknown; mime?: unknown; size?: unknown } };
      };
      const file = payload.data?.file;
      if (!isOxyFileId(file?.id) || file.visibility !== 'public') {
        throw new CatalogMediaSyncError('Oxy did not return a public catalog image file ID.');
      }
      if (kind === 'video' && (file.mime !== mime || file.size !== size))
        throw new CatalogMediaSyncError('Oxy video metadata did not match the imported bytes.');
      imported.set(reference, file.id);
      ids.push(file.id);
    } catch (error) {
      if (error instanceof CatalogMediaSyncError) throw error;
      throw new CatalogMediaSyncError('Catalog image synchronization failed.');
    } finally {
      downloaded?.response.destroy();
    }
  }
  return ids;
}
