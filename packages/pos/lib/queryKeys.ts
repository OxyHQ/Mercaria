/**
 * Centralized TanStack Query key factory for the POS.
 *
 * Every store-scoped key is prefixed by `storeId` so switching the active store
 * cleanly isolates cache entries. Mutations invalidate the narrowest relevant
 * key.
 */
export const queryKeys = {
  stores: {
    all: ["stores"] as const,
    detail: (storeId: string) => ["stores", storeId] as const,
  },
  catalog: {
    list: (
      storeId: string,
      q: string,
      category: string,
      inStock: boolean,
    ) => ["stores", storeId, "catalog", { q, category, inStock }] as const,
  },
  categories: ["categories"] as const,
  locations: (storeId: string) => ["stores", storeId, "locations"] as const,
  customers: {
    list: (storeId: string, search: string) =>
      ["stores", storeId, "customers", { search }] as const,
  },
  draftOrders: {
    detail: (storeId: string, id: string) =>
      ["stores", storeId, "draft-orders", id] as const,
  },
  orders: {
    list: (storeId: string, page: number) =>
      ["stores", storeId, "orders", { page }] as const,
    detail: (storeId: string, id: string) =>
      ["stores", storeId, "orders", id] as const,
  },
} as const;
