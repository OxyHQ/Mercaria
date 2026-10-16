import { OxyApiError, OxyServices } from '@oxy.so/core';
import { isOxyFileId, type ListingMedia } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { forbidden, serviceUnavailable, validationError } from '../../lib/errors/error-codes.js';
import { catalogMediaKind } from './policy.js';

/** Store authority was established by loadStore; bytes belong to its persisted
 * Oxy account, including when an editor operates in their personal session. */
export async function prepareCatalogMedia(
  ownerAccountId: string,
  accessToken: string,
  ids: readonly string[],
  imagesOnly = false,
  retainedFileIds: ReadonlySet<string> = new Set(),
): Promise<ListingMedia[]> {
  if (
    ids.length > config.catalog.maxImagesPerListing ||
    ids.some((id) => !isOxyFileId(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw validationError('Catalog media must be distinct Oxy file IDs within the gallery limit');
  }
  if (!ids.length) return [];
  if (!ownerAccountId || !accessToken)
    throw forbidden('Catalog media access requires the store caller');
  const client = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  client.session.setAccessToken(accessToken);
  const result: ListingMedia[] = [];
  for (const [position, fileId] of ids.entries()) {
    let file: Awaited<ReturnType<typeof client.assets.get>>['file'];
    try {
      file = (await client.assets.get(fileId)).file;
    } catch (error) {
      if (error instanceof OxyApiError && [401, 403, 404].includes(error.status))
        throw forbidden('Catalog media is unavailable to the store caller');
      throw serviceUnavailable('Catalog media could not be verified. Please retry.');
    }
    if (
      file.id !== fileId ||
      (file.ownerUserId !== ownerAccountId && !retainedFileIds.has(fileId)) ||
      file.status !== 'active' ||
      file.visibility !== 'public'
    ) {
      throw forbidden('New catalog media must be active public files owned by the store');
    }
    const kind = catalogMediaKind(file.mime, file.size);
    if (!kind || (imagesOnly && kind !== 'image'))
      throw validationError('Unsupported catalog media type or size');
    result.push({ fileId, kind, position });
  }
  return result;
}
