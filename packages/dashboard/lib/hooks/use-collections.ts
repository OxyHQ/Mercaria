import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Collection,
  CreateCollectionInput,
  UpdateCollectionInput,
} from "@mercaria/shared-types";
import {
  fetchCollections,
  fetchCollection,
  createCollection,
  updateCollection,
  deleteCollection,
} from "../api/collections";
import { queryKeys } from "../queryKeys";

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
    onSuccess: () => {
      invalidate(queryClient, storeId);
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.detail(storeId, id) });
    },
  });
}

/** Delete a collection. */
export function useDeleteCollection(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCollection(storeId, id),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}
