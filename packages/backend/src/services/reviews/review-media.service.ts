import { OxyApiError, OxyServices } from '@oxy.so/core';
import {
  isOxyFileId,
  REVIEW_MEDIA_LIMIT,
  reviewMediaKind,
  type ReviewMediaKind,
  type ReviewScope,
} from '@mercaria/shared-types';
import type { StoreCaller } from '../store-access.service.js';
import { forbidden, serviceUnavailable, validationError } from '../../lib/errors/error-codes.js';

/** Uses the author's bearer on a fresh client, never the shared singleton.
 * The caller may attach their own public upload but may not promote private
 * media, borrow another account's upload or supply its MIME/visibility. */
export async function prepareReviewMedia(
  author: StoreCaller,
  scope: ReviewScope,
  ids: readonly string[] = [],
): Promise<{ fileId: string; kind: ReviewMediaKind }[]> {
  if (!ids.length) return [];
  if (scope === 'native_transaction')
    throw validationError('Private transaction reviews do not accept public media');
  if (
    ids.length > REVIEW_MEDIA_LIMIT ||
    ids.some((id) => !isOxyFileId(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw validationError(
      'Review media must contain distinct Oxy file IDs within the attachment limit',
    );
  }
  const client = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  client.session.setAccessToken(author.accessToken);
  const media: { fileId: string; kind: ReviewMediaKind }[] = [];
  // Validate the whole selection before linking any file. A rejected later
  // attachment must not publish or alter an earlier one.
  for (const fileId of ids) {
    let result: Awaited<ReturnType<typeof client.assets.get>>;
    try {
      result = await client.assets.get(fileId);
    } catch (error) {
      if (error instanceof OxyApiError && [401, 403, 404].includes(error.status))
        throw forbidden('This review attachment is not available to its author');
      throw serviceUnavailable('Review attachments could not be verified. Try again shortly.');
    }
    const file = result.file;
    if (
      file.id !== fileId ||
      file.ownerUserId !== author.accountId ||
      file.status !== 'active' ||
      file.visibility !== 'public'
    ) {
      throw forbidden('Review attachments must be active public files owned by their author');
    }
    const kind = reviewMediaKind(file.mime, file.size);
    if (!kind) {
      throw validationError(
        'Review attachments must be supported images or videos within the size limit',
      );
    }
    media.push({ fileId, kind });
  }
  // No reference is made here. The review write's `review_media` rows fire the
  // reference trigger (migration 0170), and the outbox registers the use with
  // Mercaria's service token after the review commits (Oxy ADR 0041 D4) — a
  // review that fails to save registers nothing. The author's file is theirs
  // and Oxy never collects an account's file (D5), so nothing has to hold it
  // alive across the write. Nothing here changes visibility either.
  return media;
}
