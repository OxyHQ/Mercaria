import type { ListingQuery } from '@mercaria/shared-types';

export const queryKeys = {
  notifications: {
    all: ["notifications"] as const,
  },
  feed: {
    all: ["feed"] as const,
  },
  cart: {
    all: ["cart"] as const,
    /**
     * The guest→Oxy merge (#104). A separate key so React Query's own
     * once-per-`enabled`-transition semantics can stand in for the sign-in
     * effect that would otherwise watch the auth state.
     */
    merge: ["cart", "merge"] as const,
  },
  addresses: {
    all: ["addresses"] as const,
  },
  orders: {
    list: (page: number) => ["orders", "list", page] as const,
    detail: (id: string) => ["orders", "detail", id] as const,
  },
  stores: {
    detail: (handle: string) => ["stores", handle] as const,
    collections: (handle: string) => ["stores", handle, "collections"] as const,
    collection: (handle: string, collectionHandle: string) =>
      ["stores", handle, "collections", collectionHandle] as const,
    reviews: (handle: string, page: number) =>
      ["stores", handle, "reviews", page] as const,
    // Keyed on the store ID, not the handle like its siblings: the follow
    // target is identified by the immutable id (see `lib/follow-graph.ts`).
    followTarget: (storeId: string) => ["stores", "follow-target", storeId] as const,
  },
  listings: {
    list: (query: ListingQuery & { page?: number; limit?: number }) =>
      ["listings", query] as const,
    detail: (id: string) => ["listings", id] as const,
    reviews: (id: string, page: number) =>
      ["listings", id, "reviews", page] as const,
  },
} as const;
