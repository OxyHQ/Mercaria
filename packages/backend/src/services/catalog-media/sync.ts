import { safeFetch } from '@oxy.so/core/server';
import { isOxyFileId } from '@mercaria/shared-types';
import { oxyServiceClient } from '../../capabilities/oxy-service-client.js';
import { findStoreById } from '../../db/stores/storeRepository.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
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
export async function synchronizeStoreImages(storeId: string, references: readonly string[]): Promise<string[]> {
  return synchronizeImages(references, async () => {
    const store = await findStoreById(storeId);
    if (!store) throw new CatalogMediaSyncError('The image owner store does not exist.');
    return store.oxyAccountId;
  });
}

/** The account must come from authenticated server context, never request data.
 * Canonical operators own the durable media they import into the catalogue. */
export async function synchronizeAccountImages(ownerOxyUserId: string | undefined, references: readonly string[]): Promise<string[]> {
  return synchronizeImages(references, async () => {
    if (!ownerOxyUserId) throw new CatalogMediaSyncError('Catalog image synchronization needs an authenticated owner.');
    return ownerOxyUserId;
  });
}

async function synchronizeImages(references: readonly string[], resolveOwner: () => Promise<string>): Promise<string[]> {
  if (references.length > 64) throw new CatalogMediaSyncError('Too many catalog images.');
  if (references.every((value): boolean => isOxyFileId(value))) return [...references];

  // Refuse invalid references before uploading any image from this gallery.
  for (const value of references) {
    if (isOxyFileId(value)) continue;
    let url: URL;
    try { url = new URL(value); }
    catch { throw new CatalogMediaSyncError('A catalog image must be an Oxy file ID or an HTTPS source.'); }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new CatalogMediaSyncError('A catalog image source must use HTTPS without embedded credentials.');
    }
  }
  const ownerOxyUserId = await resolveOwner();
  const client = oxyServiceClient();
  if (!client) throw new CatalogMediaSyncError('Catalog image synchronization needs Oxy application credentials.');

  const imported = new Map<string, string>();
  const ids: string[] = [];
  for (const reference of references) {
    if (isOxyFileId(reference)) { ids.push(reference); continue; }
    const existing = imported.get(reference);
    if (existing) { ids.push(existing); continue; }
    let downloaded: Awaited<ReturnType<typeof safeFetch>> | undefined;
    try {
      // safeFetch validates and pins DNS and revalidates every redirect; no
      // supplier credentials or Oxy token are sent to the source server.
      downloaded = await safeFetch(reference, {
        headersTimeoutMs: TIMEOUT_MS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const mime = String(downloaded.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (downloaded.status !== 200 || !mime.startsWith('image/')) {
        throw new CatalogMediaSyncError('The catalog image source did not return an image.');
      }
      const declared = Number(downloaded.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        throw new CatalogMediaSyncError('The catalog image exceeds the size limit.');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of downloaded.response) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_IMAGE_BYTES) throw new CatalogMediaSyncError('The catalog image exceeds the size limit.');
        chunks.push(bytes);
      }
      if (size === 0) throw new CatalogMediaSyncError('The catalog image is empty.');

      // This is durable user-owned media, NOT Oxy's evictable federation cache.
      // Oxy requires files:user-media:write for this cross-account upload.
      const response = await fetch(`${client.baseURL.replace(/\/+$/, '')}/assets/service/user-media`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await client.serviceToken()}`,
          'Content-Type': mime,
          'Content-Length': String(size),
          'x-owner-user-id': ownerOxyUserId,
          'x-original-name': 'catalog-image',
          Accept: 'application/json',
        },
        body: new Uint8Array(Buffer.concat(chunks)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CatalogMediaSyncError(response.status === 401 || response.status === 403
          ? 'Oxy has not authorized catalog image synchronization.'
          : 'Oxy could not store the catalog image.');
      }
      const payload = await response.json() as { data?: { file?: { id?: unknown; visibility?: unknown } } };
      const file = payload.data?.file;
      if (!isOxyFileId(file?.id) || file.visibility !== 'public') {
        throw new CatalogMediaSyncError('Oxy did not return a public catalog image file ID.');
      }
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
