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
  },
  stores: {
    detail: (handle: string) => ["stores", handle] as const,
    collections: (handle: string) => ["stores", handle, "collections"] as const,
    collection: (handle: string, collectionHandle: string) =>
      ["stores", handle, "collections", collectionHandle] as const,
    reviews: (handle: string, page: number) =>
      ["stores", handle, "reviews", page] as const,
  },
  listings: {
    list: (query: ListingQuery & { page?: number; limit?: number }) =>
      ["listings", query] as const,
    detail: (id: string) => ["listings", id] as const,
    reviews: (id: string, page: number) =>
      ["listings", id, "reviews", page] as const,
  },
} as const;
