# Connector verification: the contract suite, and what it deliberately cannot prove (#69)

> Moved out of `AGENTS.md` unchanged. Connector behaviour, the merchant-facing
> defect catalog and the webhook trigger are in `docs/channels.md`; the manual
> half is `docs/runbooks/connector-real-store-verification.md`.


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
- **The catalogue is NAMESPACED per world, and SKUs are not part of it.**
  `contractCatalogue(namespace)` is the only way to build one, and it namespaces
  the PLATFORM-SIDE ids — product, variant, inventory item, order — because those
  are what a row is looked up by. SKUs were namespaced too until #296, purely
  because `product_variants_sku_key` was table-wide; with that index gone nothing
  reads a variant by SKU except a listing-scoped query, so the namespacing was
  removed rather than left as a rule with no reason. The evidence it tracked the
  INDEX and not a cross-case read is `barcode`, which was never namespaced at all
  under an equally table-wide unique and went unnoticed because WooCommerce
  publishes none.
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
  conflict it is — NAMED since #292, carrying the incumbent listing and the
  connection holding the handle. (3) `connectors/timestamps.ts` appends `Z` only to a value
  carrying NO zone, then omits what is still unreadable — omitting a
  legitimately-zoned value would ERASE the stored freshness, because
  `buildSource` writes `?? null` on every sync. (4) Shopify's `fx_rate_as_of` is
  VALIDATED and kept verbatim rather than rewritten.
- **A per-record sync failure has a DURABLE reason (#303), and the summary is
  not the reason.** A run is `failed` only when NOTHING succeeded, so the
  commonest shape — mostly successful, a handful refused — records `completed`.
  #294 gave that run a summary in `sync_runs.error`, elided at three reasons with
  three ids each; `sync_run_record_failures` is the per-record residual behind it
  (`catalog_source_rejections`' argument one domain over), carrying the subject
  KIND, the external id, a classified reason code and a bounded detail. Both are
  composed from ONE input by ONE classifier (`classifyMerchantFacingFailure`,
  which `merchantFacingFailureMessage` now delegates to) inside ONE transaction
  with the close, so the at-a-glance line and the full list cannot disagree, and
  a raw driver statement can no more reach a row than it can reach that column
  (#292). **`sync_runs.error` is NOT widened further** — one column for a whole
  run. **`subject_type` is stored, not derived from `sync_runs.kind`**: that
  column says `inventory_sync` for both the pull (an inventory ITEM) and the push
  (a PRODUCT), so a derivation is silently wrong on one of them. **`ordinal` is
  stored because both halves of `(created_at, id)` are degenerate here** — one
  multi-row insert shares an instant and uuid v7 is not monotonic within a
  millisecond, so the read came back SHUFFLED and paging was unstable; the
  `(run_id, ordinal)` unique then forces the writer to REPLACE a run's rows,
  which is what makes closing a run twice converge instead of throwing 23505.
  Retention is 30 days — the only `connectors.ts` table bounded by TRAFFIC — and
  expiry costs the DETAIL, never the tally or the summary. `syncOrders` and
  `syncInventory` were still recording nothing per record until #303.
- **A change of DELIVERY BASE URL is what #262's derived population cannot see,
  and #295 closes it with a READ rather than a wider query.** `webhook_ids` is
  full and nothing was refused, so no derivation over Mercaria's own rows can
  find a shop whose subscriptions the platform disabled — WooCommerce disables
  one itself past five failed deliveries (`class-wc-webhook.php`
  `failed_delivery()`), and they stay disabled once the address is fixed. It is
  quiet in BOTH directions: the REGISTRATION succeeded, so `webhookFailures` is
  empty, and what failed was DELIVERY, days later, on the platform's side.
  - **ADOPTION: `reconcileWebhookSubscriptions` takes `ownedSubscriptionIds` —
    the already-stored `webhook_ids` — as a second, disjoint ownership channel
    used for REMOVAL only.** The delivery URL answers "is this live at the
    address we serve" and cannot answer "did we create it", and after the base
    moves those stop being the same question. A displaced subscription is
    deleted BEFORE any topic is created (so "no second set" is true at every
    instant) and NEVER adopted on either reconcile mode — adopting one satisfies
    a topic with something that delivers nowhere and reports a healthy channel
    forever. Its removal is BEST-EFFORT, unlike the delete before a recreate: it
    cannot double-deliver, so a platform that will not remove it must not also
    stop the topic being registered, and its id is RETAINED. **An in-place `PUT`
    that re-pointed the row is the tempting repair and is the SAME bet
    `adoptExisting: false` already refuses** — the stored envelope is not
    PROVABLY the secret that subscription carries.
  - **DETECTION is `auditConnectionWebhooks`, and NO new schedule.** One bounded
    job per connection enqueued by the EXISTING six-hourly
    `connection.reconcile` sweep, beside the per-connection backfill it already
    enqueues (`queue/scheduler.ts` is untouched). Its population is
    `findConnectionsToAuditWebhooks` — deliberately NOT
    `findPullConnectionsToReconcile` (that one requires product pull, and an
    orders-only connection has webhooks) and deliberately carrying NONE of
    `findConnectionsNeedingWebhookRegistration`'s state predicates, since a
    registration Mercaria believes finished is exactly the case.
  - **Only a stored id the platform CONTRADICTS triggers a repair**, which is
    what makes running it on every connection every six hours affordable rather
    than a re-registration schedule wearing a detector's name. An EMPTY
    `webhook_ids` is not a finding (that is #262's own population — one state,
    one owner); an UNREADABLE list is not a finding (a re-registration fails at
    the same call and spends an attempt saying so); and a `dead_letter`
    connection is REPORTED and never restarted, because a detector must not undo
    a deliberate stop from outside.
  - **`status` is the trigger and `failure_count` is EVIDENCE.** Both are
    optional on `PlatformWebhookSubscription` and ABSENT means "this platform
    does not say", never "disabled" — Shopify's REST webhook object publishes
    neither, and reading silence as unhealthy would put every Shopify connection
    through a delete-and-recreate every six hours. `failure_count` decides
    nothing on purpose: re-registering does not fix whatever is refusing the
    deliveries, and a recreate over a transient blip churns a merchant's
    subscriptions and their secret. WooCommerce serves it as a STRING, so the
    schema coerces.
  - **CLEANUP is bounded by the ID, and the bound is the point.** Orphans
    Mercaria holds an id for are deleted by the repair; one it never recorded is
    LEFT ALONE, deliberately and visibly — a URL under a base nobody here serves
    says only that some Mercaria is at that hostname (a staging deployment, a
    sibling environment), and deleting on that evidence is the cross-deployment
    form of the prefix bug the exact-URL comparison exists to prevent.
- **A fixed defect leaves `WOOCOMMERCE_OPEN_DEFECTS` and, unless something still
  produces it, leaves `CHANNEL_LIMITATION_CODES` too** — `channel-catalog.test.ts`
  asserts the EXACT open-issue set rather than containment, because a list that
  only ever grows is a wizard warning about problems somebody solved.
  `no_rate_limit_retry` is the one that stayed: #219 made it capability-DERIVED
  rather than unproduceable.
- **A connect may not rewrite a connection's MODE, and the refusal is a
  CONDITIONAL WRITE rather than a guard (#302).** `UNIQUE(store_id, provider)`
  means a "second connection" in the other mode is a mode change on the existing
  row, and `mode` sat in `upsertConnection`'s `onConflictDoUpdate` `set` — so an
  OAuth pull connect silently flipped a merchant's `push_in` row, invisibly: the
  id does not move, `listings.source_connection_id` still resolves, and the only
  symptom is the plugin's next push 400ing on `requirePushInConnection` with no
  run recorded. Two of the three connect paths read the row first; **all three
  read outside a transaction, so two concurrent connects both see "no row" and
  the loser's upsert flips it anyway** — which is why the rule is `setWhere:
  eq(connections.mode, values.mode)` on the conflict branch, whose empty
  `RETURNING` set IS the refusal and which a FOURTH connect path inherits without
  knowing it exists. The pre-reads are kept as EARLY refusals only (before
  `exchangeCode` burns a one-time code, before `verifyConnection` calls the
  merchant's site) and can never admit what the write refuses. **There is
  deliberately NO supported mode SWITCH**: `disconnectConnection` keeps the row
  and never touches `mode`, nothing in `src/` deletes a connection, and a
  merchant moving from the plugin to the pull connector has no self-service path
  — stated so, because the channel keys, webhook secret and `source_*`
  provenance bound to a `push_in` row each need a decision that is its own issue.

