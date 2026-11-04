import {
  isOxyFileId,
  REVIEW_MEDIA_LIMIT,
  reviewMediaKind,
  type ReviewMediaKind,
  type ReviewScope,
} from '@mercaria/shared-types';
import type { StoreCaller } from '../store-access.service.js';
import { forbidden, serviceUnavailable, validationError } from '../../lib/errors/error-codes.js';
import { oxyAccessOutcome } from '../../lib/errors/oxy-access.js';
import { oxyClient } from '../../middleware/auth.js';

/** Reads each file AS the author (`oxyClient.withUser`), never as the shared client.
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
  return oxyClient.withUser(author.accessToken, async (user) => {
    const media: { fileId: string; kind: ReviewMediaKind }[] = [];
    // Validate the whole selection before linking any file. A rejected later
    // attachment must not publish or alter an earlier one.
    for (const fileId of ids) {
      let result: Awaited<ReturnType<typeof user.assets.get>>;
      try {
        result = await user.assets.get(fileId);
      } catch (error) {
        if (oxyAccessOutcome(error) === 'unavailable')
          throw serviceUnavailable('Review attachments could not be verified. Try again shortly.');
        throw forbidden('This review attachment is not available to its author');
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
    // reference trigger (migration 0172), and the outbox registers the use with
    // Mercaria's service token after the review commits (Oxy ADR 0043 D4) — a
    // review that fails to save registers nothing. The author's file is theirs
    // and Oxy never collects an account's file (D5), so nothing has to hold it
    // alive across the write. Nothing here changes visibility either.
    return media;
  });
}
