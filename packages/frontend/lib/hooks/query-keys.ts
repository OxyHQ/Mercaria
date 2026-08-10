import type { ListingQuery } from '@mercaria/shared-types';

export const queryKeys = {
  notifications: {
    all: ["notifications"] as const,
  },
  feed: {
    all: ["feed"] as const,
  },
  /**
   * Natural-language search (#95). The RESULTS key carries the filters, so
   * removing a chip is a new key and therefore a new fetch — which is what
   * makes editing an interpretation re-run the search without re-parsing it.
   */
  searchIntent: {
    all: ["search-intent"] as const,
    results: (term: string, filters: unknown) =>
      ["search-intent", "results", term, filters] as const,
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
  /**
   * Price alerts (#79).
   *
   * `suggestion` is keyed on the product AND the currency, because the same
   * product priced in two currencies is two different answers and a shared key
   * would show a buyer a target in a currency they did not ask for.
   */
  priceAlerts: {
    all: ["price-alerts"] as const,
    forProduct: (canonicalProductId: string) =>
      ["price-alerts", "product", canonicalProductId] as const,
    suggestion: (canonicalProductId: string, currency: string) =>
      ["price-alerts", "suggestion", canonicalProductId, currency] as const,
  },
  /**
   * The guest order PORTAL (#108). Its own namespace rather than a branch of
   * `orders`, because the two are reached with different credentials and a
   * shared key would let a sign-out clear one buyer's cache and not the other's.
   */
  guestPortal: {
    all: ["guest-portal"] as const,
    session: ["guest-portal", "session"] as const,
    view: (checkoutGroupId: string) =>
      ["guest-portal", "view", checkoutGroupId] as const,
    status: (checkoutGroupId: string) =>
      ["guest-portal", "status", checkoutGroupId] as const,
  },
  /**
   * Claiming a guest checkout group into an Oxy account (#109).
   *
   * Its own namespace beside `guestPortal` rather than a key inside it, for the
   * reason the two credential stores are separate: a claim REMOVES the portal
   * session, so a successful claim clears both — and one shared namespace would
   * make "forget the portal" and "forget the claim preview" the same call, when
   * only the first is true on a sign-out.
   */
  guestClaim: {
    all: ["guest-claim"] as const,
    preview: (checkoutGroupId: string) =>
      ["guest-claim", "preview", checkoutGroupId] as const,
  },
  orders: {
    all: ["orders"] as const,
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
   * Saves (#80). Filed under their own key rather than under `listings`,
   * because a canonical PRODUCT save is not a fact about any one listing —
   * exactly the reasoning `reviews` records one block down — and because the
   * merged saved list spans both kinds, so an invalidation of either has to
   * reach it.
   *
   * `savedItems` is a prefix key with no page in it: the list is keyset-
   * paginated through `useInfiniteQuery`, which holds its pages under this one
   * entry, so a save or an un-save invalidates the whole list in one call.
   */
  saves: {
    savedItems: ["saved-items"] as const,
    /** The two-button context of one listing page. */
    listingContext: (listingId: string) => ["saves", "listing", listingId] as const,
  },
  /**
   * Private watchlists (#81), and the BASKET is a key of its own beside the
   * list it belongs to.
   *
   * Two keys rather than one query returning both, because they fail
   * independently: opening a list reads two tables, while pricing it runs an
   * offer comparison per item. A single key would put a failing comparison into
   * the same error state as the list and take the editing with it, which is
   * exactly what #81 acceptance 7 forbids.
   */
  watchlists: {
    all: ["watchlists"] as const,
    detail: (watchlistId: string) => ["watchlists", "detail", watchlistId] as const,
    basket: (watchlistId: string) => ["watchlists", "basket", watchlistId] as const,
    snapshots: (watchlistId: string) => ["watchlists", "snapshots", watchlistId] as const,
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
  /**
   * The canonical product page (#71). Its own namespace rather than a branch of
   * `listings`, because the two are different things: a listing is one seller's
   * item and a canonical product is the model every seller's item resolves to,
   * and an invalidation of one must not drop the other.
   *
   * The PARAMS are in the key — the variant especially. A variant-scoped page is
   * a different server read whose comparison cannot contain another
   * configuration's offer, so filtering one cached product-wide answer down
   * would show the wrong price for as long as a refetch took.
   */
  productPage: {
    detail: (handle: string, params: Readonly<Record<string, string | number | undefined>>) =>
      ["product-page", handle, params] as const,
    priceHistory: (canonicalProductId: string, segment: string, currency: string) =>
      ["product-page", canonicalProductId, "price-history", segment, currency] as const,
  },
} as const;
