import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Collection,
  CreateCollectionInput,
  UpdateCollectionInput,
  SetCollectionProductsInput,
} from '@mercaria/shared-types';
import {
  fetchCollections,
  fetchCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  setCollectionProducts,
} from '../api/collections';
import { queryKeys } from '../queryKeys';

/** The store's collections. */
export function useCollections(storeId: string) {
  return useQuery<Collection[]>({
    queryKey: queryKeys.collections.list(storeId),
    queryFn: () => fetchCollections(storeId),
    enabled: Boolean(storeId),
  });
}

/** A single collection. */
export function useCollection(storeId: string, id: string) {
  return useQuery<Collection>({
    queryKey: queryKeys.collections.detail(storeId, id),
    queryFn: () => fetchCollection(storeId, id),
    enabled: Boolean(storeId) && Boolean(id),
  });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.collections.list(storeId) });
}

/** Publish the server DTO before refetch; older reads cannot undo this save. */
async function publishCollection(
  queryClient: ReturnType<typeof useQueryClient>,
  storeId: string,
  collection: Collection,
) {
  const listKey = queryKeys.collections.list(storeId);
  const detailKey = queryKeys.collections.detail(storeId, collection.id);
  await queryClient.cancelQueries({ queryKey: listKey, exact: true });
  await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
  queryClient.setQueryData(detailKey, collection);
  queryClient.setQueryData<Collection[]>(listKey, (current) =>
    current?.map((item) => (item.id === collection.id ? collection : item)),
  );
  invalidate(queryClient, storeId);
}

/** Create a collection. */
export function useCreateCollection(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCollectionInput) => createCollection(storeId, input),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

/** Update a collection. */
export function useUpdateCollection(storeId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCollectionInput) => updateCollection(storeId, id, input),
    onSuccess: async (collection, input) => {
      await publishCollection(queryClient, storeId, collection);
      if (input.rules) queryClient.invalidateQueries({ queryKey: ['stores', storeId, 'products'] });
    },
  });
}

/** Delete a collection. */
export function useDeleteCollection(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCollection(storeId, id),
    onSuccess: async (_, id) => {
      const listKey = queryKeys.collections.list(storeId);
      const detailKey = queryKeys.collections.detail(storeId, id);
      // Cancel older list/detail reads before publishing the confirmed deletion.
      await queryClient.cancelQueries({ queryKey: listKey, exact: true });
      await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
      queryClient.setQueryData<Collection[]>(listKey, (current) =>
        current?.filter((collection) => collection.id !== id),
      );
      queryClient.removeQueries({ queryKey: detailKey, exact: true });
      invalidate(queryClient, storeId);
    },
  });
}

/** Replace the complete ordered membership of a manual collection. */
export function useSetCollectionProducts(storeId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetCollectionProductsInput) => setCollectionProducts(storeId, id, input),
    onSuccess: async (collection) => {
      await publishCollection(queryClient, storeId, collection);
      queryClient.invalidateQueries({ queryKey: ['stores', storeId, 'products'] });
    },
  });
}
