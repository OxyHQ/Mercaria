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
   * Saved shopping agents (#97).
   *
   * `detail` and `findings` sit UNDER the `all` prefix rather than beside it,
   * because every write in the domain changes both — pausing an agent changes
   * its row, and asking for one look appends to its timeline — so one
   * invalidation of the prefix is the whole story. Two sibling namespaces would
   * make a pause leave a stale timeline open on screen.
   */
  shoppingAgents: {
    all: ["shopping-agents"] as const,
    detail: (agentId: string) => ["shopping-agents", "detail", agentId] as const,
    findings: (agentId: string) => ["shopping-agents", "findings", agentId] as const,
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
  /**
   * The merchant page and its two browses (#73).
   *
   * The browse keys carry the whole parameter object, because a cursor is only
   * meaningful inside the scope and filters it was minted under — keying a
   * channel-scoped page under the merchant's plain key would let a stale cursor
   * from one scope be replayed into another.
   */
  merchants: {
    page: (idOrSlug: string) => ["merchants", "page", idOrSlug] as const,
    catalog: (idOrSlug: string, params: unknown) =>
      ["merchants", "catalog", idOrSlug, params] as const,
    offers: (idOrSlug: string, params: unknown) =>
      ["merchants", "offers", idOrSlug, params] as const,
  },
  /**
   * Grounded comparison and basket plans (#96).
   *
   * The whole REQUEST is in the key, because every field of it changes the
   * answer: a different currency is a different set of converted prices, a
   * different channel policy is a different candidate set, and a different
   * objective is a different plan. A key that named only the products would
   * serve one shopper's constraints to another's screen.
   *
   * A basket plan is deliberately NOT persisted anywhere — see the api client's
   * header. What survives a navigation is the query cache's short window, and
   * acting on a plan revalidates it first.
   */
  comparison: {
    compare: (params: Readonly<Record<string, string | number | undefined>>) =>
      ["comparison", "compare", params] as const,
    basket: (params: Readonly<Record<string, string | number | undefined>>) =>
      ["comparison", "basket", params] as const,
  },
  /**
   * The composed brand and family PAGES (#72).
   *
   * Keyed under `catalogPages` rather than under a brand or product key: a
   * page is a COMPOSITION over four domains, so invalidating "the brand" would
   * not be the same act as invalidating this read, and filing it under one of
   * its inputs would make an unrelated invalidation drop it silently.
   *
   * The browse keys carry a serialized filter set, because two filter sets are
   * two different lists and a shared key would serve one under the other's
   * cursor.
   */
  catalogPages: {
    brand: (handle: string, market: string) => ["catalogPages", "brand", handle, market] as const,
    brandProducts: (handle: string, filters: string) =>
      ["catalogPages", "brand", handle, "products", filters] as const,
    family: (handle: string, params: string) =>
      ["catalogPages", "family", handle, params] as const,
    familyProducts: (handle: string, filters: string) =>
      ["catalogPages", "family", handle, "products", filters] as const,
  },
  /**
   * The "Sell yours" flow (#91).
   *
   * The PREVIEW is keyed with its currency and market because those change what
   * the price guidance says — two sellers looking at one draft in two currencies
   * are asking two different questions and must not share a cache entry. The
   * `…Root` prefix is what a mutation invalidates, so a saved step drops every
   * currency's preview rather than only the one the screen happens to hold.
   */
  sellerDrafts: () => ["seller-drafts"] as const,
  sellerDraftPreviewRoot: (draftId: string) => ["seller-drafts", draftId] as const,
  sellerDraftPreview: (draftId: string, params?: { currency?: string; market?: string }) =>
    ["seller-drafts", draftId, params?.currency ?? "", params?.market ?? ""] as const,
  sellerMatchCandidates: (params: { identifier?: string; q?: string }) =>
    ["seller-drafts", "candidates", params.identifier ?? "", params.q ?? ""] as const,
  /**
   * Nearby availability and its manual fallback (#93).
   *
   * The AVAILABILITY key carries a COARSE CELL and never a coordinate — the
   * caller passes `cellKey(origin)`, not `origin`. That is a privacy property
   * rather than a cache-tuning one: a React Query key is held in memory, is
   * serialized by every devtools panel and is exactly the kind of place a
   * precise position ends up being read out of. Two shoppers at opposite ends
   * of one district therefore share an entry, which is the same coarsening the
   * server applies to what it returns.
   *
   * `null` is the no-origin state and is a real key, so a screen that has not
   * been granted location does not silently share a cache entry with one that
   * has.
   */
  nearby: {
    all: ["nearby"] as const,
    availability: (subject: string, cell: string | null) =>
      ["nearby", "availability", subject, cell ?? ""] as const,
    places: (subject: string, term: string) =>
      ["nearby", "places", subject, term] as const,
  },
  /**
   * An order's collection snapshot and its code (#93).
   *
   * Keyed on the ORDER and, for the guest path, on the checkout group whose
   * portal credential authorized the read — never on the credential itself. A
   * React Query key is held in memory and printed by every devtools panel, so a
   * key carrying a bearer token would put one on a screen somebody screenshots.
   *
   * Separate from `orders.detail` deliberately: the code is fetched by its own
   * call against its own authorized route, so it is never a field of a cached
   * order DTO that support tooling and logs forward on.
   */
  collection: {
    all: ["collection"] as const,
    byOrder: (orderId: string) => ["collection", "order", orderId] as const,
    byGuestOrder: (checkoutGroupId: string, orderId: string) =>
      ["collection", "guest", checkoutGroupId, orderId] as const,
  },
} as const;
