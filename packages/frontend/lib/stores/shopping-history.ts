import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOxy } from '@oxy.so/services';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ProductSummary, SearchResult, ShoppingThreadMessage } from '@mercaria/shared-types';

export type ThreadMessage = ShoppingThreadMessage & {
  results?: readonly SearchResult[];
  examples?: ProductSummary[];
};
export interface RecentThread {
  id: string;
  owner: string;
  title: string;
  updatedAt: string;
  preview: boolean;
  messages: ThreadMessage[];
}
interface ViewedProduct {
  owner: string;
  product: ProductSummary;
}
interface ShoppingHistory {
  hydrated: boolean;
  threads: RecentThread[];
  products: ViewedProduct[];
  saveThread: (thread: RecentThread) => void;
  viewProduct: (owner: string, product: ProductSummary) => void;
}

/** Device-local history, isolated by Oxy identity. No inference or purchase is simulated. */
export const useShoppingHistory = create<ShoppingHistory>()(
  persist(
    (set) => ({
      hydrated: false,
      threads: [],
      products: [],
      saveThread: (thread) =>
        set((state) => {
          const threads = [thread, ...state.threads.filter((item) => item.id !== thread.id)].slice(
            0,
            12,
          );
          // Bound persisted conversation text as well as the number of rows.
          while (threads.length > 1 && JSON.stringify(threads).length > 1_500_000) threads.pop();
          return { threads };
        }),
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
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ threads, products }) => ({ threads, products }),
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
