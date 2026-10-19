import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOxy } from '@oxy.so/services/ui/client';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ProductSummary } from '@mercaria/shared-types';
import {
  migrateShoppingHistory,
  SHOPPING_HISTORY_VERSION,
  type ViewedProduct,
} from './shopping-history-migration';

interface ShoppingHistory {
  hydrated: boolean;
  products: ViewedProduct[];
  viewProduct: (owner: string, product: ProductSummary) => void;
}

/**
 * Device-local "recently viewed", isolated by Oxy identity.
 *
 * Shopping conversations are not kept here: they are the person's Alia
 * conversations started in Mercaria (`components/alia/MercariaAskProvider.tsx`);
 * `migrateShoppingHistory` drops the ones version 0 stored on the device.
 */
export const useShoppingHistory = create<ShoppingHistory>()(
  persist(
    (set) => ({
      hydrated: false,
      products: [],
      viewProduct: (owner, product) =>
        set((state) => ({
          // Saved status belongs to the authenticated query cache, never history.
          products: [
            { owner, product: { ...product, saved: undefined } },
            ...state.products.filter(
              (item) => item.owner !== owner || item.product.id !== product.id,
            ),
          ].slice(0, 50),
        })),
    }),
    {
      name: 'mercaria.shopping-history',
      version: SHOPPING_HISTORY_VERSION,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ products }) => ({ products }),
      migrate: migrateShoppingHistory,
      onRehydrateStorage: () => () => {
        useShoppingHistory.setState({ hydrated: true });
      },
    },
  ),
);

export function useShoppingHistoryOwner() {
  const { user, isAuthenticated } = useOxy();
  return isAuthenticated && user?.id ? user.id : 'guest';
}
