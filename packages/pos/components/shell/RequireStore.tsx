import React from "react";
import { useRouter } from "expo-router";
import type { StorePermission } from "@mercaria/shared-types";
import { ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { useActiveStoreContext, useMyStores } from "@/lib/hooks/use-stores";
import { useActiveStore } from "@/lib/stores/active-store";

interface RequireStoreProps {
  /** Permission the active screen requires. When the caller lacks it, a clean
   *  "no access" message is shown instead of the screen body. */
  permission?: StorePermission;
  /** Render-prop receiving the resolved, guaranteed-present `storeId`. */
  children: (storeId: string) => React.ReactNode;
}

/**
 * Guard for STORE-scoped screens that do NOT need a register location (e.g. the
 * sales history). It:
 *  - waits for the persisted active-store selection to rehydrate,
 *  - redirects to the store-setup picker (`/store-setup`) when no store is active
 *    or the selected store is no longer one the caller belongs to,
 *  - blocks the screen body with a "no access" message when the caller lacks the
 *    required permission on the active store.
 *
 * Children receive the resolved `storeId`, so screens never juggle a nullable id.
 */
export function RequireStore({ permission, children }: RequireStoreProps) {
  const router = useRouter();
  const { hydrated } = useActiveStore();
  const { isPending } = useMyStores();
  const { activeStoreId, store, can } = useActiveStoreContext();

  if (!hydrated || isPending) {
    return <ScreenLoading />;
  }

  // No active store, or the persisted store is no longer accessible → picker.
  if (!activeStoreId || !store) {
    router.replace("/store-setup");
    return <ScreenLoading />;
  }

  if (permission && !can(permission)) {
    return (
      <ScreenMessage
        title="No access"
        body="You don't have permission to view this area for the active store."
      />
    );
  }

  return <>{children(activeStoreId)}</>;
}
