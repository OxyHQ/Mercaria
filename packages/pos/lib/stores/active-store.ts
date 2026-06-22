import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persisted selection of the active store AND register location the POS operates
 * on.
 *
 * The store-setup picker sets `activeStoreId` then `activeLocationId`; every
 * register screen reads BOTH to scope its draft orders (a POS sale always commits
 * stock at a concrete location). Persisting both means a returning operator lands
 * back on the store + register they last used. Switching the store CLEARS the
 * location so the operator re-picks a register for the new store. `hydrated`
 * flips true once the persisted values have rehydrated, so the shell can avoid a
 * flash of the picker before the saved selection loads on native.
 */
interface ActiveStoreState {
  activeStoreId: string | null;
  activeLocationId: string | null;
  hydrated: boolean;
  /** Set the active store; selecting a NEW store clears the active location. */
  setActiveStoreId: (storeId: string | null) => void;
  /** Set the active register location for the current store. */
  setActiveLocationId: (locationId: string | null) => void;
}

export const useActiveStore = create<ActiveStoreState>()(
  persist(
    (set, get) => ({
      activeStoreId: null,
      activeLocationId: null,
      hydrated: false,
      setActiveStoreId: (storeId) => {
        // Changing store invalidates the previously-picked register location.
        const changed = storeId !== get().activeStoreId;
        set({
          activeStoreId: storeId,
          ...(changed ? { activeLocationId: null } : {}),
        });
      },
      setActiveLocationId: (locationId) => set({ activeLocationId: locationId }),
    }),
    {
      name: "mercaria.pos.active-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        activeStoreId: state.activeStoreId,
        activeLocationId: state.activeLocationId,
      }),
      onRehydrateStorage: () => () => {
        useActiveStore.setState({ hydrated: true });
      },
    },
  ),
);
