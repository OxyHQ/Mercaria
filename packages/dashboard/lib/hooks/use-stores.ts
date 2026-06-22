import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import type {
  Store,
  StorePermission,
  CreateStoreInput,
  UpdateStoreInput,
  UpdateStoreSettingsInput,
} from "@mercaria/shared-types";
import {
  fetchMyStores,
  fetchStore,
  createStore,
  updateStore,
  updateStoreSettings,
} from "../api/stores";
import { queryKeys } from "../queryKeys";
import { useActiveStore } from "../stores/active-store";
import { findMembership, effectivePermissions } from "../permissions";

/** All stores the caller belongs to. */
export function useMyStores() {
  return useQuery<Store[]>({
    queryKey: queryKeys.stores.all,
    queryFn: fetchMyStores,
  });
}

/** A single store by id (enabled only when an id is provided). */
export function useStore(storeId: string | null) {
  return useQuery<Store>({
    queryKey: queryKeys.stores.detail(storeId ?? ""),
    queryFn: () => fetchStore(storeId ?? ""),
    enabled: Boolean(storeId),
  });
}

/** Create a store; invalidates the store list. */
export function useCreateStore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStoreInput) => createStore(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stores.all });
    },
  });
}

/** Update a store's core profile; invalidates that store + the list. */
export function useUpdateStore(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateStoreInput) => updateStore(storeId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stores.detail(storeId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stores.all });
    },
  });
}

/** Update a store's settings (policies/notifications/tax). */
export function useUpdateStoreSettings(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateStoreSettingsInput) => updateStoreSettings(storeId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stores.detail(storeId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stores.all });
    },
  });
}

/**
 * The resolved active-store context for the current caller:
 *  - `activeStoreId` — the persisted selection (null until one is picked).
 *  - `store`         — the active store DTO (from the store list cache).
 *  - `permissions`   — the caller's effective permission set on that store.
 *  - `can(perm)`     — convenience predicate for nav/action gating.
 *
 * Permissions are derived from the store's `members` and the caller's Oxy id;
 * they only HIDE affordances — the server still authorizes every write.
 */
export function useActiveStoreContext() {
  const { activeStoreId } = useActiveStore();
  const { user } = useOxy();
  const { data: stores } = useMyStores();

  const store = useMemo(
    () => stores?.find((s) => s.id === activeStoreId),
    [stores, activeStoreId],
  );

  const permissions = useMemo<Set<StorePermission>>(() => {
    const membership = findMembership(store, user?.id);
    return membership ? effectivePermissions(membership) : new Set<StorePermission>();
  }, [store, user?.id]);

  const can = useMemo(
    () => (perm: StorePermission) => permissions.has(perm),
    [permissions],
  );

  return { activeStoreId, store, permissions, can };
}
