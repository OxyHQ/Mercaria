import type { Asset } from '@oxy.so/core';
import { isOxyFileId, reviewMediaKind, type ReviewMediaKind } from '@mercaria/shared-types';

export interface ReviewAttachment {
  fileId: string;
  name: string;
  kind: ReviewMediaKind;
}

/** Read metadata back from Oxy before treating an upload as an attachment.
 * The review backend independently repeats these checks with the author's bearer. */
export function reviewAttachmentFromAsset(
  asset: Partial<
    Pick<Asset, 'id' | 'ownerUserId' | 'status' | 'visibility' | 'mime' | 'size' | 'originalName'>
  >,
  accountId: string,
  requestedId: string,
  filename: string,
): ReviewAttachment | undefined {
  const kind = reviewMediaKind(asset.mime ?? '', asset.size ?? 0);
  if (
    !accountId ||
    asset.ownerUserId !== accountId ||
    asset.status !== 'active' ||
    asset.visibility !== 'public' ||
    asset.id !== requestedId ||
    !isOxyFileId(asset.id) ||
    !kind
  )
    return undefined;
  return { fileId: asset.id, name: filename, kind };
}
