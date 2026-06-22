import React from "react";
import { useRouter } from "expo-router";
import type { StorePermission } from "@mercaria/shared-types";
import { ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { useActiveStoreContext, useMyStores } from "@/lib/hooks/use-stores";
import { useActiveStore } from "@/lib/stores/active-store";

interface RequirePosProps {
  /** Permission the register screen requires. When the caller lacks it, a clean
   *  "no access" message is shown instead of the screen body. */
  permission?: StorePermission;
  /** Render-prop receiving the resolved, guaranteed-present `storeId` + `locationId`. */
  children: (storeId: string, locationId: string) => React.ReactNode;
}

/**
 * Guard for REGISTER screens that need BOTH an active store AND an active
 * register location. It:
 *  - waits for the persisted active-store selection to rehydrate,
 *  - redirects to the store-setup picker (`/store-setup`) when no store/location
 *    is active or the selected store is no longer one the caller belongs to,
 *  - blocks the screen body with a "no access" message when the caller lacks the
 *    required permission on the active store.
 *
 * Children receive the resolved `storeId` + `locationId`, so register screens
 * never juggle nullable ids.
 */
export function RequirePos({ permission, children }: RequirePosProps) {
  const router = useRouter();
  const { hydrated, activeLocationId } = useActiveStore();
  const { isPending } = useMyStores();
  const { activeStoreId, store, can } = useActiveStoreContext();

  if (!hydrated || isPending) {
    return <ScreenLoading />;
  }

  // No active store/location, or the persisted store is no longer accessible.
  if (!activeStoreId || !store || !activeLocationId) {
    router.replace("/store-setup");
    return <ScreenLoading />;
  }

  if (permission && !can(permission)) {
    return (
      <ScreenMessage
        title="No access"
        body="You don't have permission to use the register for the active store."
      />
    );
  }

  return <>{children(activeStoreId, activeLocationId)}</>;
}
