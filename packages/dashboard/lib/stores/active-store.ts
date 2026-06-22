import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persisted selection of the active store the dashboard operates on.
 *
 * The store picker sets `activeStoreId`; every admin screen reads it to scope
 * its queries (`/admin/stores/:storeId/...`). Persisting it means a returning
 * admin lands back on the store they were last managing. `hydrated` flips true
 * once the persisted value has been rehydrated, so the shell can avoid a flash
 * of the picker before the saved selection loads on native.
 */
interface ActiveStoreState {
  activeStoreId: string | null;
  hydrated: boolean;
  setActiveStoreId: (storeId: string | null) => void;
}

export const useActiveStore = create<ActiveStoreState>()(
  persist(
    (set) => ({
      activeStoreId: null,
      hydrated: false,
      setActiveStoreId: (storeId) => set({ activeStoreId: storeId }),
    }),
    {
      name: "mercaria.dashboard.active-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ activeStoreId: state.activeStoreId }),
      onRehydrateStorage: () => (state) => {
        state?.setActiveStoreId(state.activeStoreId);
        useActiveStore.setState({ hydrated: true });
      },
    },
  ),
);
