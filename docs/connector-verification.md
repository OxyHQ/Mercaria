# Connector verification: the contract suite, and what it deliberately cannot prove (#69)

`connectors/__tests__/connector-contract-suite.ts` + `contract-world.ts`, run by
`shopify/__tests__/shopify-contract.test.ts` and
`woocommerce/__tests__/woocommerce-contract.test.ts`, plus
`services/__tests__/channel-push-contract.realdb.test.ts` and
`connector-queue-boundary.test.ts`. Full procedure for the part that stays
manual: **`docs/runbooks/connector-real-store-verification.md`**.

The failure mode that shapes it: **the nine pre-existing connector suites mock
the PROVIDER**, so between `connector-sync.service` and the wire there was
nothing under test at all — a URL never built, a `Link` header never followed, a
429 never retried, a zod schema that rejects the platform's real shape and a
CHECK the database would have refused all looked identical to a green suite.

- **Only the SOCKET is faked, and the boundary is stated rather than implied.**
  The provider is built by its own real factory (`createShopifyProvider`,
  `createWooCommerceProvider`) over a transport serving a `ContractWorld`; for
  Shopify the SHIPPED rate-limit wrapper sits in between with its clock and sleep
  stubbed, so the retry under test is the production one. Everything else —
  service, catalog-write funnels, inventory, Postgres with every CHECK and unique
  index — is real. **A `ContractWorld` is not a store and cannot testify about
  one**; the runbook carries what only a real platform can settle.
- **Capabilities are DECLARED and a missing one is MEASURED, never skipped.**
  WooCommerce has no product push, no fulfillment push and no 429 handling; each
  gated case asserts the REFUSAL on that branch, so a provider that silently lost
  a feature cannot report the same green as one that never had it.
- **`getConnectorProvider` is the ONE thing mocked, and the registry deliberately
  stays a module-level constant.** Connectors are static, unlike ingestion
  adapters (which a flag registers at boot), so adding a mutable
  `registerConnectorProvider` would put a production seam in place purely for a
  test's convenience.
- **The catalogue is NAMESPACED per world.** `product_variants_sku_key` is unique
  over the whole table rather than per store, so a shared fixture SKU collides
  across cases and fails inside `createStoreProduct` where it reads as a connector
  bug. `contractCatalogue(namespace)` is the only way to build one.
- **The fault schedule is mutation-tested by the suite itself.** Every "archives
  nothing" case rests on a fault actually reaching the provider; a fault matching
  no URL would make each of them pass by measuring a healthy run. The Shopify
  runner asserts a fault fires exactly N times, is consumed, and stops.
- **Cleanup order is load-bearing**: `listings.store_id`, `orders.store_id` and
  both `source_connection_id` columns are `ON DELETE RESTRICT` — deliberately, so
  a live connection cannot be dropped out from under the provenance pointing at
  it — so a fixture deletes orders, then listings, then the connection, then the
  store.
- **The plugin-push suite scans response BYTES for the minted key**, not the DTO
  shape: a shape assertion covers the fields somebody remembered, and the
  positive control (the public prefix IS present) is what stops the scan passing
  against an endpoint returning nothing.
- **Acceptance 4 is split honestly.** `connector-queue-boundary.test.ts` pins the
  half Mercaria owns — every `request*` entry point validates synchronously and
  then ENQUEUES, while `runBackfill`/`syncOrders`/`syncInventory` are the worker
  bodies beside them. The producers are mocked because their INLINE FALLBACK is
  the thing under test: with the real producer and no Redis, "enqueued" and "ran
  inline" are indistinguishable.
- **Acceptance criterion 7 is NOT met and `HANDOFF.md` still says so.** No
  Shopify store, no WooCommerce site and no WordPress plugin install has been
  exercised; nothing here may be read as evidence that one has.
- Four defects found while building it were filed (#218, #219, #220, #221)
  rather than fixed there, and fixing #218 turned up a FIFTH (#262). All five
  are now fixed. **#218 is FIXED:** `registerWebhooks` returns a
  structured result (every subscription that exists, every topic REFUSED with its
  status and a classified reason), reconciles against the platform's OWN
  subscription list before creating anything — ADOPTING on Shopify, RECREATING on
  WooCommerce, where the secret is fixed at creation and never disclosed again —
  and `registerConnectionWebhooks` persists the ids, the secret and the refusals
  in ONE transaction. So a partial registration is disconnectable, retryable
  without duplicating anything, converges a shop already carrying orphans, and
  NAMES the events that will not arrive (`Connection.webhookFailures`, plus a
  `degraded` catalogue axis on `ChannelReadiness`). `SHOPIFY_SCOPES` now defaults
  to the full runbook §3.2 string, gated by `shopify-scopes.test.ts` against both
  the registered topics and the endpoints each declared capability calls — the
  old `['read_products']` default WAS the configuration that triggered it.
  **#262 supplied the trigger the "retryable" above assumes.**
  `registerConnectionWebhooks` had two call sites, both on connect, so
  "retryable" meant a person re-authorizing. There is now a 15-minute sweep over
  a DERIVED population — refused topics whose reason a retry could fix, or an
  empty `webhook_ids`, which is the only trace a registration that THREW leaves —
  plus `POST /admin/stores/:storeId/channels/:connectionId/webhooks/reregister`
  behind `channels:write`, which stays available while the sweep is off.
  `CONNECTOR_WEBHOOK_REREGISTRATION_ENABLED` defaults ON: it gates the LOOP, and
  the catalogue reconcile beside it calls the same platforms every six hours with
  no lever at all. A re-registration REUSES the stored secret — Mercaria has no
  previous-secret grace for a connection, so minting would 401 every delivery
  already queued. `permission_denied` and `topic_not_supported` dead-letter on
  the FIRST attempt; everything else backs off, capped, over twelve. **The sweep
  does NOT make #218's shared-address disconnect guard redundant** — a sibling
  whose live subscriptions were deleted has complete stored ids and no refusal,
  so the derived population is blind to it by construction. The merchant surface
  is `WebhookHealth` on the channel screen, and it renders even when nothing is
  refused, deliberately: that same invisible state shows no symptom, so a control
  appearing only on a recorded failure could never be pressed for it.
  **`webhookRegistration` is the authority on whether Mercaria is still trying
  and `webhookFailures` is a separate fact about which topics were refused — a
  surface keying on the refusal list FIRST renders a dead-lettered channel as
  healthy**, because a registration that throws is caught before
  `recordConnectionWebhookRegistration` and writes no per-topic row at all. That
  is pinned by a test, so teaching the throw path to record fails the build.
  **#219 is FIXED:** `createWooCommerceTransport` retries a 429 (`Retry-After`
  capped at 30s per wait, else an equal-jitter backoff, bounded by a 60s total
  budget and five retries) on every method including the registration POST, and
  the 429 still surfaces afterwards so a rate-limited run fails as before and
  archives nothing. Shopify's proactive self-throttle was deliberately NOT
  ported — WordPress publishes no leaky-bucket header, and `no_rate_limit_retry`
  became a CAPABILITY-derived channel limitation rather than a hardcoded defect.
  **#220 is FIXED:** the webhook path COMPLETES a delivery before normalizing
  (`expandWebhookProduct` — a no-op on Shopify, a `GET /products/{id}/variations`
  on WooCommerce, so `normalizeProduct` stays pure and synchronous), the pure
  normalizer REFUSES a payload declaring variations it does not carry rather than
  collapsing it, and `convergeVariants` CREATES a variant the platform added — so
  an earlier collapse self-heals on the next sync instead of being permanent. A
  variant the platform REMOVED is unsold (stock zero, tracking on) and never
  deleted, because a variant id cascades into carts, saves, offers and the
  canonical links. **#221 is FIXED**, and the fix is four things rather than
  one. (1) An imported listing's four `source_*` columns, its `draft`/`active`
  status and its VARIANTS' four `source_*` columns are all arguments to
  `createStoreProduct`, written by `insertStoreProductWithin` — the store-product
  mirror of `insertP2PListingWithin`, carrying the same two rulings: the variant
  insert belongs INSIDE (a listing with no variant is not a state anything should
  observe, and `convergeVariants` returns early on one, so nothing repairs it)
  and `syncListingFacets` stays OUTSIDE (its outbox work must survive
  independently). `stampVariantSources` is GONE; `stampVariantSource` stays for
  #220's convergence. (2) `listings_store_id_source_key_idx` is UNIQUE
  (migration `0070`, `post`), because the read-then-create the service performs
  was a real race two deliveries could both win; the loser converges by
  RE-READING and taking the update branch, matched by CONSTRAINT NAME so a
  `listings_store_id_handle_key` collision still surfaces as the merchant
  conflict it is. (3) `connectors/timestamps.ts` appends `Z` only to a value
  carrying NO zone, then omits what is still unreadable — omitting a
  legitimately-zoned value would ERASE the stored freshness, because
  `buildSource` writes `?? null` on every sync. (4) Shopify's `fx_rate_as_of` is
  VALIDATED and kept verbatim rather than rewritten.
- **A fixed defect leaves `WOOCOMMERCE_OPEN_DEFECTS` and, unless something still
  produces it, leaves `CHANNEL_LIMITATION_CODES` too** — `channel-catalog.test.ts`
  asserts the EXACT open-issue set rather than containment, because a list that
  only ever grows is a wizard warning about problems somebody solved.
  `no_rate_limit_retry` is the one that stayed: #219 made it capability-DERIVED
  rather than unproduceable.
