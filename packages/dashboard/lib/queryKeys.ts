/**
 * Centralized TanStack Query key factory for the dashboard.
 *
 * Every key is scoped by `storeId` so switching the active store cleanly
 * isolates cache entries. Mutations invalidate the narrowest relevant key.
 */
export const queryKeys = {
  stores: {
    all: ["stores"] as const,
    detail: (storeId: string) => ["stores", storeId] as const,
  },
  members: (storeId: string) => ["stores", storeId, "members"] as const,
  products: {
    list: (storeId: string, page: number, search: string) =>
      ["stores", storeId, "products", { page, search }] as const,
    detail: (storeId: string, productId: string) =>
      ["stores", storeId, "products", productId] as const,
    levels: (storeId: string, productId: string, variantId: string) =>
      ["stores", storeId, "products", productId, "variants", variantId, "levels"] as const,
  },
  orders: {
    list: (storeId: string, page: number, status: string) =>
      ["stores", storeId, "orders", { page, status }] as const,
    detail: (storeId: string, orderId: string) =>
      ["stores", storeId, "orders", orderId] as const,
    refunds: (storeId: string, orderId: string) =>
      ["stores", storeId, "orders", orderId, "refunds"] as const,
    stats: (storeId: string) => ["stores", storeId, "orders", "stats"] as const,
  },
  reports: {
    summary: (storeId: string) => ["stores", storeId, "reports", "summary"] as const,
    sales: (storeId: string, interval: string) =>
      ["stores", storeId, "reports", "sales", interval] as const,
    topProducts: (storeId: string) =>
      ["stores", storeId, "reports", "top-products"] as const,
  },
  collections: {
    list: (storeId: string) => ["stores", storeId, "collections"] as const,
    detail: (storeId: string, id: string) =>
      ["stores", storeId, "collections", id] as const,
  },
  discounts: {
    list: (storeId: string) => ["stores", storeId, "discounts"] as const,
    detail: (storeId: string, id: string) =>
      ["stores", storeId, "discounts", id] as const,
  },
  taxRates: (storeId: string) => ["stores", storeId, "tax-rates"] as const,
  locations: (storeId: string) => ["stores", storeId, "locations"] as const,
  channels: (storeId: string) => ["stores", storeId, "channels"] as const,
  customers: {
    list: (storeId: string, page: number, search: string) =>
      ["stores", storeId, "customers", { page, search }] as const,
    detail: (storeId: string, id: string) =>
      ["stores", storeId, "customers", id] as const,
    orders: (storeId: string, id: string) =>
      ["stores", storeId, "customers", id, "orders"] as const,
  },
} as const;
