import type { Collection, UpdateCollectionInput } from '@mercaria/shared-types';

export type CollectionDraft = Partial<Pick<Collection, 'title' | 'handle' | 'description' | 'isPublished' | 'sortOrder'>>;

/** Only explicit changes are patched; a refetch may update untouched fields. */
export function collectionChanges(collection: Collection, draft: CollectionDraft): UpdateCollectionInput {
  const changes: UpdateCollectionInput = {};
  if (draft.title !== undefined && draft.title.trim() !== collection.title) changes.title = draft.title.trim();
  if (draft.handle !== undefined && draft.handle.trim() !== collection.handle) changes.handle = draft.handle.trim();
  if (draft.description !== undefined && draft.description !== (collection.description ?? '')) changes.description = draft.description;
  if (draft.isPublished !== undefined && draft.isPublished !== collection.isPublished) changes.isPublished = draft.isPublished;
  if (draft.sortOrder !== undefined && draft.sortOrder !== collection.sortOrder) changes.sortOrder = draft.sortOrder;
  return changes;
}
