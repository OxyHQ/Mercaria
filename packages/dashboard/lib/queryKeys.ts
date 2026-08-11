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
  // Payment onboarding. A sibling of `channels`, never a child of it: a sales
  // channel is where a catalogue is listed and this is where money is settled.
  payments: (storeId: string) => ["stores", storeId, "payments"] as const,
  // The store's own PLAN, a sibling of `payments` and never a child: one is what
  // Mercaria pays the store for orders, the other what the store pays Mercaria
  // for tooling. Two different directions of money with two different
  // lifecycles.
  plan: (storeId: string) => ["stores", storeId, "plan"] as const,
  planCatalog: (storeId: string) => ["stores", storeId, "plan", "catalog"] as const,
  locations: (storeId: string) => ["stores", storeId, "locations"] as const,
  channels: (storeId: string) => ["stores", storeId, "channels"] as const,
  channelKeys: (storeId: string) => ["stores", storeId, "channel-keys"] as const,
  /** The unified sales-channel surface (#87). */
  channelCatalog: (storeId: string) => ["stores", storeId, "channel-catalog"] as const,
  channelSummary: (storeId: string) => ["stores", storeId, "channel-summary"] as const,
  channelReadiness: (storeId: string) => ["stores", storeId, "channel-readiness"] as const,
  channelAudit: (storeId: string) => ["stores", storeId, "channel-audit"] as const,
  channelRuns: (storeId: string, connectionId: string) =>
    ["stores", storeId, "channels", connectionId, "runs"] as const,
  channelReconciliation: (storeId: string, connectionId: string) =>
    ["stores", storeId, "channels", connectionId, "reconciliation"] as const,
  channelOnboarding: (storeId: string) => ["stores", storeId, "channel-onboarding"] as const,
  channelOnboardingSession: (storeId: string, sessionId: string) =>
    ["stores", storeId, "channel-onboarding", sessionId] as const,
  /** The store's product feeds (#63), which #87 gives screens. */
  feeds: (storeId: string) => ["stores", storeId, "feeds"] as const,
  feed: (storeId: string, configurationId: string) =>
    ["stores", storeId, "feeds", configurationId] as const,
  feedStatus: (storeId: string, configurationId: string) =>
    ["stores", storeId, "feeds", configurationId, "status"] as const,
  feedReports: (storeId: string, configurationId: string) =>
    ["stores", storeId, "feeds", configurationId, "reports"] as const,
  customers: {
    list: (storeId: string, page: number, search: string) =>
      ["stores", storeId, "customers", { page, search }] as const,
    detail: (storeId: string, id: string) =>
      ["stores", storeId, "customers", id] as const,
    orders: (storeId: string, id: string) =>
      ["stores", storeId, "customers", id, "orders"] as const,
  },
} as const;
