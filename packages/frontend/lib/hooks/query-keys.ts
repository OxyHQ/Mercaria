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
  /**
   * The PUBLIC P2P seller profile (#92). Keyed on the Oxy account id, which is
   * the seller's whole identity here — there is no Mercaria-local seller key to
   * file this under, and inventing one is exactly what #26 refuses.
   *
   * `followTarget` sits beside its `stores` twin rather than under a shared
   * "follow" key, because the two resolve DIFFERENT kinds against different URI
   * spaces and a shared key would invite one call site to reuse the other's
   * cached id.
   */
  sellers: {
    profile: (oxyUserId: string) => ["sellers", oxyUserId] as const,
    listings: (oxyUserId: string) => ["sellers", oxyUserId, "listings"] as const,
    followTarget: (oxyUserId: string) => ["sellers", "follow-target", oxyUserId] as const,
  },
  listings: {
    list: (query: ListingQuery & { page?: number; limit?: number }) =>
      ["listings", query] as const,
    detail: (id: string) => ["listings", id] as const,
    reviews: (id: string, page: number) =>
      ["listings", id, "reviews", page] as const,
  },
  /**
   * The SCOPED review reads (#76). Deliberately keyed under `reviews` rather
   * than under `listings`/`stores`: a product review is not a fact about any
   * one listing, and a merchant review is not a fact about any one store —
   * filing them under an entity key would make an invalidation of that entity
   * silently drop a rating that belongs to a different target.
   *
   * Each scope has an `…All` prefix key so a write can invalidate every PAGE of
   * a target in one call; the per-page keys are separate cache entries, as they
   * are for the legacy reads.
   */
  reviews: {
    productAll: (canonicalProductId: string) =>
      ["reviews", "product", canonicalProductId] as const,
    product: (canonicalProductId: string, page: number) =>
      ["reviews", "product", canonicalProductId, page] as const,
    merchantAll: (merchantId: string) => ["reviews", "merchant", merchantId] as const,
    merchant: (merchantId: string, page: number) =>
      ["reviews", "merchant", merchantId, page] as const,
    eligibilities: ["reviews", "eligibilities"] as const,
  },
} as const;
