import { isOxyFileId, type ReviewMediaItem } from '@mercaria/shared-types';

/** Public gallery pages can overlap during pagination. Preserve the server's
 * order and the selected attachment's identity, never its old array offset. */
export function reviewMediaEntries(items: ReviewMediaItem[]): ReviewMediaItem[] {
  const seen = new Set<string>();
  return items.filter(({ media, review }) => {
    if (
      !isOxyFileId(media.fileId) ||
      review.status !== 'published' ||
      !['canonical_product', 'listing'].includes(review.targetType) ||
      !review.media?.some(
        (attachment) => attachment.id === media.id && attachment.fileId === media.fileId,
      ) ||
      seen.has(media.id)
    )
      return false;
    seen.add(media.id);
    return true;
  });
}

export function reviewMediaIndex(items: ReviewMediaItem[], selectedId: string): number {
  return items.findIndex((item) => item.media.id === selectedId);
}
