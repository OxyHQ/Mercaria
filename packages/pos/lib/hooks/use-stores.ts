import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Store, StorePermission } from "@mercaria/shared-types";
import { fetchMyStores, fetchStore } from "../api/stores";
import { queryKeys } from "../queryKeys";
import { useActiveStore } from "../stores/active-store";

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

/**
 * The resolved active-store context for the current caller:
 *  - `activeStoreId` — the persisted selection (null until one is picked).
 *  - `store`         — the active store DTO (from the store list cache).
 *  - `permissions`   — the caller's effective permission set on that store.
 *  - `can(perm)`     — convenience predicate for nav/action gating.
 *
 * Permissions are the caller's own, resolved by the API through the Oxy
 * account that owns the store (`Store.access`); they only HIDE affordances —
 * the server still authorizes every write.
 */
export function useActiveStoreContext() {
  const { activeStoreId } = useActiveStore();
  const { data: stores } = useMyStores();

  const store = useMemo(
    () => stores?.find((s) => s.id === activeStoreId),
    [stores, activeStoreId],
  );

  const permissions = useMemo<Set<StorePermission>>(
    () => new Set<StorePermission>(store?.access.permissions ?? []),
    [store],
  );

  const can = useMemo(
    () => (perm: StorePermission) => permissions.has(perm),
    [permissions],
  );

  return { activeStoreId, store, permissions, can };
}
