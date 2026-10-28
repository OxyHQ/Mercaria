import { MAX_FEATURED_COLLECTIONS, type Collection } from '@mercaria/shared-types';

/** Editing aids only; Mercaria revalidates ownership and eligibility on save. */
export function addFeaturedCollection(
  ids: readonly string[],
  collection: Collection,
  storeId: string,
): string[] {
  if (
    ids.length >= MAX_FEATURED_COLLECTIONS ||
    ids.includes(collection.id) ||
    collection.storeId !== storeId ||
    collection.type !== 'manual' ||
    !collection.isPublished
  )
    return [...ids];
  return [...ids, collection.id];
}

export function moveFeaturedCollection(
  ids: readonly string[],
  id: string,
  delta: -1 | 1,
): string[] {
  const index = ids.indexOf(id);
  const destination = index + delta;
  if (index < 0 || destination < 0 || destination >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}
