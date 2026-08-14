# Runbook — verifying the connectors against real development stores (#69)

This runbook is for one operator with credentials, working through the scenarios
issue #69 lists that **cannot** be automated. Everything that could be automated
already is; §1 says exactly which, so nobody repeats machine work by hand.

**No secret, and no plaintext channel key, may be written into this file, into a
commit, into an issue comment, into a fixture, or into a log.** Every evidence
cell below asks for a REDACTED observation — a count, a status, a row id, a
timestamp, the last four characters of an identifier — and never a credential.
A channel key is shown once by design; if you paste one anywhere, revoke it.

---

## 1. What is already automated, and what a real store still adds

Four suites run in CI on every push. They drive the REAL providers (their URL
building, pagination, zod schemas, price parsing and — for Shopify — the
rate-limit wrapper), the REAL `connector-sync.service`, and a REAL Postgres
server with every CHECK and unique index production has. Only the SOCKET is
faked.

| Suite | What it covers |
|---|---|
| `packages/backend/src/connectors/shopify/__tests__/shopify-contract.test.ts` | 23 cases: the Shopify half of the contract suite |
| `packages/backend/src/connectors/woocommerce/__tests__/woocommerce-contract.test.ts` | 21 cases: the WooCommerce half |
| `packages/backend/src/services/__tests__/channel-push-contract.realdb.test.ts` | 15 cases: all eight plugin-push scenarios, over real HTTP |
| `packages/backend/src/services/__tests__/connector-queue-boundary.test.ts` | 8 cases: every sync entry point enqueues rather than working inline |

The shared cases live in
`packages/backend/src/connectors/__tests__/connector-contract-suite.ts`; a third
platform gets all of them by writing one harness.

**What a fake platform cannot testify about, and a real store can:**

- that Shopify emits the `Link` header, the leaky-bucket header and the
  fulfillment-order shape the provider parses;
- that WooCommerce publishes `date_modified_gmt` without a zone suffix, reports
  `manage_stock: 'parent'` on inherited variations, and paginates with
  `X-WP-TotalPages`;
- that the app's GRANTED scopes actually cover every endpoint the connector
  calls (§3 is the whole reason this matters);
- that a catalogue of real size completes inside the job's lifetime, and that
  real rate limits are survivable;
- that the WordPress plugin sends what the ingest routes accept;
- anything about images, HTML descriptions or currencies the fixtures do not
  contain.

Those are §§4–7 below.

---

## 2. Environment

Set these on a **non-production** deployment (a preview task or a local API with
a tunnel — Shopify and WooCommerce both need to reach the callback and webhook
URLs from the public internet).

| Variable | Value | Why |
|---|---|---|
| `CONNECTOR_ENCRYPTION_KEY` | `openssl rand -hex 32` | AES-256-GCM for stored credentials + channel keys. Rotating it makes every stored credential undecryptable. |
| `CONNECTOR_OAUTH_STATE_SECRET` | `openssl rand -hex 32` | Signs the OAuth `state` (CSRF). |
| `CONNECTOR_OAUTH_REDIRECT_BASE_URL` | the PUBLIC base of the API | Both the callback and the webhook address are built from this one value. |
| `CONNECTOR_OAUTH_SUCCESS_REDIRECT_URL` | the dashboard channels screen | Optional; without it the callback renders a plain success page. |
| `CONNECTOR_DEFAULT_CATEGORY_SLUG` | an EXISTING category slug | Every imported product is filed here. A slug that does not exist fails the backfill with a clear error. |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | from the Partner app (§3) | The secret also verifies every inbound webhook HMAC. |
| `SHOPIFY_SCOPES` | see §3 — **the default is not enough** | |
| `REDIS_URL` | an ElastiCache/Valkey or local Redis | Without it every sync runs INLINE in the request. Scenario S5 and W3 are meaningless without it. |

Secrets go through the documented path only: GitHub Actions repo secret → SSM
`/oxy/mercaria/*` → the ECS task definition. Never a literal in a workflow, a
task definition, or this file.

---

## 3. The Shopify app — scopes and webhook topics, READ OUT OF THE CODE

### 3.1 Every endpoint the connector calls

Derived from `packages/backend/src/connectors/shopify/index.ts` (Admin API
version pinned at the code constant `API_VERSION`, currently **`2024-10`**):

| Endpoint | Called by | Scope it needs |
|---|---|---|
| `POST /admin/oauth/access_token` | `exchangeCode` | — (the OAuth exchange itself) |
| `GET /shop.json` | `verifyConnection` | — (any valid token) |
| `GET /products.json` | `fetchProducts` | `read_products` |
| `GET /collects.json` | the collection index | `read_products` |
| `GET /smart_collections.json` | the collection index | `read_products` |
| `GET /collections/{id}/products.json` | the collection index | `read_products` |
| `POST /products.json`, `PUT /products/{id}.json` | `pushProduct` | `write_products` |
| `GET /orders.json` | `fetchOrders` | `read_orders` |
| `GET /inventory_levels.json` | `fetchInventory` | `read_inventory` (Shopify also gates the location join on `read_locations` — confirm in the Partner scope picker) |
| `GET /orders/{id}/fulfillment_orders.json` | `pushFulfillment` | `read_merchant_managed_fulfillment_orders` |
| `POST /fulfillments.json` | `pushFulfillment` | `write_merchant_managed_fulfillment_orders` |
| `GET /webhooks.json` | `listWebhooks` / `registerWebhooks` (reconcile) | the READ scope of every topic below |
| `POST /webhooks.json`, `DELETE /webhooks/{id}.json` | `registerWebhooks` / `deleteWebhooks` | the READ scope of every topic below |

An order routed to a fulfillment service or a third-party location needs
`*_assigned_fulfillment_orders` / `*_third_party_fulfillment_orders` as well;
the connector reads whatever `fulfillment_orders.json` returns, so a store using
those needs the matching scopes.

### 3.2 The scope string

```
SHOPIFY_SCOPES=read_products,write_products,read_orders,read_inventory,read_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders
```

**That string IS the code default** (`shopify/config.ts` `DEFAULT_SCOPES`), so
`SHOPIFY_SCOPES` only needs setting to request something NARROWER. It used to be
`read_products` alone, which is the configuration that triggered #218 (§8.1):
the connector registers order and inventory topics unconditionally, Shopify
gates each `POST /webhooks.json` on that topic's READ scope, and the refusal
threw away the subscriptions already created.

`shopify/__tests__/shopify-scopes.test.ts` is the gate that keeps the two in
step — it fails the build if a registered topic's scope, or an endpoint behind a
declared capability, is missing from this default, and also if the default
requests a scope nothing calls. **A narrower `SHOPIFY_SCOPES` is still a
supported choice, and the consequence is now visible rather than silent:** the
topics Shopify refuses are recorded on the connection and reported as
`webhookFailures`, and `ChannelReadiness` reads the catalogue axis as
`degraded`.

### 3.3 The webhook topics the connector registers

From `PRODUCT_WEBHOOK_TOPICS`, `ORDER_WEBHOOK_TOPICS` and
`INVENTORY_WEBHOOK_TOPICS` in `shopify/index.ts` — registered automatically on
connect, in this order:

1. `products/create`
2. `products/update`
3. `products/delete`
4. `orders/create`
5. `orders/updated`
6. `inventory_levels/update`

Delivery address: `{CONNECTOR_OAUTH_REDIRECT_BASE_URL}/channels/webhooks/shopify`.
Verification is the app secret over the RAW body (`X-Shopify-Hmac-Sha256`).

Redirect URL to register in the Partner dashboard:
`{CONNECTOR_OAUTH_REDIRECT_BASE_URL}/channels/oauth/shopify/callback`.

**Before running any scenario, read the granted scopes back.** The connector
stores what Shopify actually granted:

```
GET /admin/stores/{storeId}/channels     → the connection's `scopes[]`
```

If that array is missing anything in §3.2, stop and fix the app — every scenario
below would otherwise fail for a reason that is not the connector's.

---

## 4. Provisioning

### 4.1 Shopify development store

1. Partner dashboard → **Stores** → *Add store* → *Development store*.
2. Create an app (custom is fine), set the redirect URL from §3.3, request the
   scopes from §3.2, copy the API key/secret into the environment.
3. Seed a catalogue that spans what the fixtures cannot:
   - at least **one product with 3+ variants across 2 option axes**;
   - one **single-variant** product;
   - one product with **several images** and one with **none**;
   - one product with a **compare-at price**;
   - one product in a **manual (custom) collection** and one in a **smart**
     collection — the connector builds its collection index from both;
   - **stock across two locations** on one variant (the connector sums them);
   - enough products to exceed one page: **> 250** for a real pagination run.
     A few thousand is better, and is the only way scenario S5 means anything.
4. Place **2 test orders**, one paid and unfulfilled, one with a discount and
   tax, in the shop's own currency. If the store has Markets enabled, place a
   third in a DIFFERENT presentment currency.

### 4.2 WooCommerce site

1. Any disposable WordPress with WooCommerce (a local `wp-env`, a throwaway
   droplet, a sandbox host). It must be reachable over **HTTPS** from the API —
   the provider's transport refuses plain http.
2. WP admin → WooCommerce → Advanced → REST API → **Add key**, permissions
   **Read/Write**. Read-only is not enough: webhook registration is a `POST`,
   and with a read-only key it fails silently (best-effort) and you get no
   real-time sync.
3. Seed the equivalent catalogue: at least one `variable` product with several
   variations, one `simple` product, stock managed at both the parent and the
   variation level (`manage_stock: 'parent'` on a variation is a branch the
   provider has), and **> 100 products** to exceed one page.
4. Place 2 orders.

### 4.3 The WordPress plugin

Repo: `OxyHQ/mercaria-woocommerce` (private).

1. Build/zip the plugin and install it on the same disposable WordPress.
2. In the Mercaria dashboard, on a WooCommerce **`push_in`** connection, generate
   a Channel API Key. **It is displayed once.** Paste it, the API base URL and
   the connection id into the plugin's Settings → Mercaria page.
3. The plugin pushes to
   `{base}/channels/ingest/{connectionId}/products` and `/inventory` with
   `Authorization: Bearer mck_…`.

---

## 5. Recording evidence

For every scenario below, record in a private document (not this repo):

- date/time (UTC), the store, and the Mercaria environment;
- the observable named in the table — a count, a status, a row id, a
  `sync_runs` id and its four tallies;
- for a failure: the `sync_runs.error` string and the correlating log line, with
  any identifier truncated to its last four characters.

Do NOT record: access tokens, consumer keys/secrets, channel keys, webhook
secrets, buyer emails, buyer addresses, or a full API response body.

The cheapest evidence source is the connector's own record:

```
GET /admin/stores/{storeId}/channels                     -- connections + scopes
GET /admin/stores/{storeId}/channels/{connectionId}/runs -- sync runs + tallies
```

---

## 6. Shopify scenarios

| # | Scenario | Do this | Expected observable |
|---|---|---|---|
| S1 | OAuth connect and reconnect | Connect from the dashboard; then run the whole connect again for the same shop | ONE connection row (not two), `status: connected`, `scopes[]` matching §3.2, `syncSettings` from before the reconnect preserved |
| S2 | Initial product + inventory backfill | Set products/inventory to `pull`, press *Sync now* | A `backfill` run reaching `completed`; `countsCreated` equal to the shop's product count; spot-check one listing's images, variants and stock |
| S3 | Product create / update / delete webhook | Create, then edit, then delete a product in Shopify | Three `webhook` runs; the listing appears, changes, then reaches `status: archived` — **never deleted** |
| S4 | Variant, price, image and inventory update | Edit a variant price, add an image, change stock | The listing's variant price and gallery follow; stock follows via `inventory_levels/update` |
| S5 | Large catalogue pagination + rate limiting | Backfill the > 250-product store with `REDIS_URL` set | One `completed` run covering every product; no 429 failure in the logs; note wall-clock duration |
| S6 | Locally overridden field survives resync | Edit a listing's title in Mercaria (so `overriddenFields` carries `title`), then change the title in Shopify and resync | The Mercaria title stands; an UNPINNED field still follows Shopify |
| S7 | Order import + idempotent update | Sync orders, then change an order in Shopify and sync again | One Mercaria order per Shopify order; amounts in the SHOP's currency, not FAIR; a second sync updates in place |
| S8 | Fulfillment pushed back | Set orders to `bidirectional`, mark a Mercaria order `shipped` | A `fulfillment_push` run `completed`; the Shopify order shows fulfilled with tracking; a re-push adds NO second fulfillment |
| S9 | Credential revocation and recovery | Uninstall the app in Shopify, run a sync, reinstall, run a sync | The first run `failed` and **archived nothing**; the connection reads `error`; after reconnect a run completes and the catalogue is intact |
| S10 | Native currency preservation | Inspect any imported variant and order | `price.currency` is the SHOP's currency; the order's `DualMoney` carries the platform's own amounts on both sides |

Automated equivalents: S1, S2, S4, S6, S7, S9, S10 and the delete half of S3 are
covered at contract level; what a real store adds is the wire shape and the
scale. S5 and S8 have contract-level cases but their real content — a real
catalogue, a real leaky bucket, a real fulfillment order — is only here.

---

## 7. WooCommerce scenarios

| # | Scenario | Do this | Expected observable |
|---|---|---|---|
| W1 | REST credential connection | Dashboard → add a WooCommerce channel with the site URL + key/secret | Connection `connected`, `shopCurrency` matching the site, ONE row |
| W2 | Product, variant and inventory backfill | Enable product pull, sync | `completed`; variable products import with EVERY variation; `manage_stock: 'parent'` variations get the parent's stock |
| W3 | Pagination and retry | Backfill the > 100-product site | Every product imported. A 429 is now RETRIED (§8.2) — note whether the host produced one at all, whether it carried `Retry-After`, and its value. A run that still `failed` on `HTTP 429` means the retries were exhausted: record the wall-clock duration |
| W4 | Product update and removal | Edit a product, then trash one, then resync | The edit follows; the trashed product's listing reaches `archived` |
| W5 | Order import where configured | Enable order pull, sync | One Mercaria order per Woo order, single-currency `DualMoney` |
| W6 | Native currency preservation | Inspect an imported variant | The site's currency, never FAIR |
| W7 | Invalid / insufficient permission | Re-connect with a READ-ONLY key, then sync and check webhooks | The sync still works; webhook registration is REFUSED per topic. `webhookIds` is empty AND `webhookFailures` names every topic with its status and reason (§8.1) — record them verbatim. `GET .../channels/readiness` reports `catalog.state: degraded` |
| W8 | A product with MORE THAN 100 variations | Create (or find) a variable product with > 100 variations, then backfill | Every variation imports — the variations endpoint is paged, so a second page is fetched. Record the number of `/variations` requests and whether each page carried `X-WP-TotalPages`. A product refused as `declared_not_fetched` means the site's `variations` id list and the variations endpoint disagree: record BOTH, since only a real site settles whether WooCommerce publishes the full id list at that size (§8.3) |
| W9 | A site that strips `X-WP-TotalPages` | Put the site behind a caching/security plugin that removes response headers (or confirm one already does), then backfill | Every product still imports and NOTHING is archived. Mercaria pages on until an EMPTY page instead of trusting a missing header, so expect exactly one extra `/products` request at the end; record the request count and confirm `counts` shows no archives. A run that archived listings here is the #259 catalogue failure and must be reported (§8.3) |

Also verify, because §8.3 fixed it and only a real store settles the wire shape:
**create a NEW variable product in WooCommerce and let the `product.created`
webhook import it** (do not backfill first). Expect EVERY variation, each at its
own price with its own option values and stock. Then **add a variation on the
site and re-sync**: expect the new variant to appear. Then **delete one and
re-sync**: expect it to survive at zero stock rather than disappear. Record what
you see, including the webhook run's tallies.

---

## 8. Known defects to expect (filed separately, referencing #69)

These were found while building the automated suites. They are not blockers for
running the scenarios; they change what you should expect to see.

### 8.1 Webhook registration — FIXED (#218), and what a real run still settles

`registerWebhooks` no longer throws on the first refused topic. It reads the
platform's OWN subscription list first (`GET /webhooks.json`, `GET /webhooks`),
reconciles what already points at Mercaria's delivery URL — ADOPTING on Shopify,
where one app secret verifies everything, and DELETING-then-recreating on
WooCommerce, where the secret is fixed at creation and never disclosed again —
then creates the rest per topic. The ids, the webhook secret and the topics the
platform REFUSED are persisted in ONE transaction, so:

- a partial registration is disconnectable (Mercaria holds every id) and
  retryable (a retry adopts or replaces rather than adding a second set);
- a shop already carrying orphaned subscriptions from the old behaviour
  CONVERGES on the next connect, because the reconcile reads the platform rather
  than `webhookIds`;
- the refused topics are readable — `Connection.webhookFailures` names each
  topic, its HTTP status and a classified reason, and `ChannelReadiness` reports
  the catalogue axis as `degraded` while any exist.

**The four residual holes the first fix left, all closed now, because they change
what you should see on a real store:**

- **A refused LIST no longer erases the stored ids.** `registerWebhooks` returns
  a discriminated result; the branch meaning "the platform's list could not be
  read" carries NO subscription list at all, and the persisted ids are left
  exactly as they were. Nothing was created and nothing deleted, so they are
  still the best handle anyone has on that shop.
- **A refused DELETE no longer drops the id of a subscription that is still
  live.** An undeleted duplicate, the survivors of a blocked recreate and a
  retired topic the platform would not remove are all persisted.
- **`disconnect` reads the platform** and deletes the union of the stored ids and
  every subscription live at this connection's EXACT delivery URL, best-effort
  and never blocking the disconnect. A registration that threw between the
  platform call and the database write is the case: it leaves subscriptions
  Mercaria holds no id for, and trusting `webhookIds` walks past them.
- **Shopify's `GET /webhooks.json` is paged** (`Link: rel="next"`) like every
  other Shopify collection. Past the page limit a truncated list reads as "these
  are all the subscriptions that exist", which produces duplicates and orphans on
  exactly the shops with accumulated ones.

**What a real store still settles, and what to record:**

- that Shopify's `GET /webhooks.json` and WooCommerce's `GET /webhooks` return
  the `address` / `delivery_url` and `topic` fields the providers parse, for a
  shop with subscriptions from ANOTHER app installed;
- that a read-only WooCommerce REST key produces the refusal this expects — run
  W7 and record `webhookFailures` verbatim (topics + status + reason);
- that WooCommerce's per-connection delivery URL survives its own normalization,
  so the exact-URL comparison the reconcile makes actually matches on the second
  pass. **If a real Woo site rewrites the delivery URL it was given, the reconcile
  will not recognise its own subscriptions and will recreate them every
  registration** — the observable is `deletedWebhookIds` growing on every
  reconnect with the topic set unchanged. Record it if you see it. The SAME
  rewrite would make `disconnect` leave every subscription behind, since it
  matches on that URL too;
- **two Mercaria stores connected to the SAME Shopify shop.** Shopify has one
  app-wide delivery address, so both connections adopt the same subscriptions and
  store the same ids — disconnecting either deletes them for both, until the
  other's next reconnect recreates them. That is a property of Shopify's
  app-secret verification rather than of the disconnect, and it was already true
  of the stored ids; record whether a real pair of stores behaves as described.

### 8.1b Re-registering webhooks without a reconnect — ADDED (#262)

Everything §8.1 describes ran on CONNECT and nowhere else, so a shop left with a
refused topic — or one whose registration Mercaria could not conclude anything
about — stayed that way until a person re-authorized the channel. `#262` adds the
two triggers and no second implementation: both drive the same
`registerWebhooks` reconcile §8.1 describes.

- **On demand:** the "Register webhooks again" control on the dashboard's channel
  screen, or `POST /admin/stores/:storeId/channels/:connectionId/webhooks/reregister`
  directly, behind `channels:write`. It validates synchronously (404 for a missing or
  cross-store connection, 400 for a disconnected, push-in or credential-less one)
  and answers `202 {status: 'enqueued'}`; the outcome arrives on the connection
  itself. It stays available while the scheduled sweep is off.
- **On a schedule:** every 15 minutes, a bounded pass over the connections whose
  registration did not finish — refused topics a retry could take, or an empty
  `webhookIds`, which is what a registration that THREW leaves behind. Gated by
  `CONNECTOR_WEBHOOK_REREGISTRATION_ENABLED` (default ON; it gates the LOOP and
  no stored fact).

**What to expect on a real store, and what to record:**

- **The secret is REUSED, not rotated.** On WooCommerce a re-registration
  recreates each topic with the secret already stored, so no delivery 401s during
  the swap. A CONNECT still mints a fresh one, which is the sub-second window
  §8.1 already had — if a real Woo site shows failed deliveries around a
  reconnect, record it: that is the gap a previous-secret grace would close, and
  Mercaria has none for a connection.
- **A scope refusal STOPS rather than retrying.** After W7 (a read-only key), the
  connection reaches `webhookRegistration.state: 'dead_letter'` on the first
  automatic attempt and is not swept again — a credential that answered 403
  answers 403 again. Widen the key to **Read/Write** and press re-register: that
  is the supported recovery, and it is what to verify rather than waiting.
- **A retryable refusal backs off**, capped at six hours over twelve attempts
  (roughly a day), and `webhookRegistration.nextAttemptAt` says when. Record the
  reason a real host actually produces for a 429 or a 5xx.
- **Two Mercaria stores on ONE Shopify shop** (the §8.1 pair): re-registering
  either must leave the other's subscriptions live, because the app-secret
  reconcile ADOPTS what is already at the shared address. Record whether a real
  pair behaves as described — this is the one place the automated suite's fake
  cannot testify about Shopify's own duplicate-topic rules.
- **It does NOT detect a shop whose subscriptions were deleted on the platform.**
  Its population is derived from Mercaria's own rows, and that shop has complete
  stored ids and no refusal. The remedy is the on-demand button; if you delete a
  subscription in the Shopify or WooCommerce admin during a run, expect nothing
  to notice until you press it.

### 8.2 WooCommerce rate-limit handling — FIXED (#219), with a stated limit

`woocommerce/http.ts` now wraps its raw layer in `createWooCommerceTransport`: a
429 is retried, honouring `Retry-After` when the host sends one (capped at 30s
per wait) else an equal-jitter exponential backoff, bounded by a 60s total wait
budget and five retries. It applies to GET, DELETE and the registration POST — a
429 means the request was not processed. After the retries the 429 still
surfaces, so a genuinely rate-limited run fails exactly as it always did and
still archives nothing.

**What was deliberately NOT built, so nobody adds it later thinking it was
forgotten:** the proactive self-throttle Shopify's transport has. Shopify
publishes `X-Shopify-Shop-Api-Call-Limit` describing one documented, uniform
leaky bucket; WordPress publishes nothing of the kind and has no uniform limit to
describe. Reading an `X-WP-*`-shaped header would be inventing a contract, and a
fixed per-host minimum interval would be Mercaria guessing somebody's hosting
plan — slowing every healthy site to protect the ones it cannot measure.

**What a real store still settles:** whether a real host's 429 carries a
`Retry-After` at all, and whether its value is inside the 30s cap. Record both
during W3.

### 8.3 Variable products over webhooks — FIXED (#220)

A `product.created` / `product.updated` delivery carries the product WITHOUT its
variations (WooCommerce sends `variations: [ids]`), so `normalizeProduct` used to
take the single-variant branch and produce one variant at the parent's lowest
price, with no option values and `available: 0`, beside an option axis declaring
several. `importProduct` never ADDED variants to an existing listing, so it
stayed wrong permanently.

Three changes, and each closes a different half:

- **The webhook path COMPLETES the payload before normalizing.**
  `expandWebhookProduct` is an explicit provider seam — Shopify's returns the
  payload unchanged, WooCommerce's fetches `GET /products/{id}/variations` — so
  `normalizeProduct` stays pure and synchronous and both paths normalize the same
  shape.
- **The pure normalizer REFUSES a payload that declares variations it does not
  carry**, so the collapse cannot be reintroduced by a later simplification. A
  refused delivery fails the webhook RUN and writes nothing: the listing keeps
  its variants, nothing is archived, and the next backfill converges. Note it
  does NOT cause a platform re-delivery — the ingress route enqueues and the
  worker records the failure — so the safety net is the scheduled reconcile
  sweep, not WooCommerce.
- **A variant the platform ADDED is created on the next sync.** That is what
  makes any earlier collapse self-healing rather than permanent.

**A variant the platform REMOVED is unsold, never deleted:** its stock is set to
zero with tracking on, once. Deleting it would cascade it out of live carts,
saved items and offers; leaving it buyable would read the platform's silence as
availability.

**What a real store still settles:** whether a real `product.updated` delivery
carries `variations` in the id shape the provider reads (a plugin that alters
the REST response could change it), and whether the extra variations call
completes inside the webhook job's lifetime for a product with many variations.

#### 8.3.1 Incomplete responses and stable variant identity — FIXED (#259)

#220 stopped a payload that declared variations and carried NONE. #259 covers
the responses that carry SOME, and the identity question underneath them.

- **A variant set now says what the provider could PROVE about it.**
  `NormalizedProduct.variants` is a union whose `incomplete` branch carries a
  gap — `declared_not_fetched`, `fetched_not_declared`, `duplicate_fetched`,
  `pagination_unprovable`, `declares_variants_and_carries_none` — and no variant
  list, so nothing downstream can read an unproven enumeration as one. A product
  in that state is refused by `importProduct` before ANY write: no listing field,
  no variant, no unsell, on every retry.
- **The declared/fetched id comparison is the WooCommerce rule.** A variable
  parent publishes its variation ids, so the fetched set matching the declared
  set is decisive and costs no extra request. A `variable` product carrying no
  usable variation is refused rather than collapsed into one parent-priced
  variant — the synthetic simple variant is gone.
- **Pagination is proven, not assumed.** A missing or malformed
  `X-WP-TotalPages` used to read as "one page", so a full first page proved a
  complete enumeration — and for the PRODUCTS list that proof is what
  `runBackfill` hands to `archiveUnseenSourcedListings`, which soft-archives
  every listing past page 1. Enumerations now finish on a usable header or an
  EMPTY page. A merely SHORT page is deliberately not a proof: `per_page` is a
  request, a site is free to serve fewer, and then every page is short.
- **Identity is the platform's own variation id first.** SKU and option tuple
  are a migration fallback for rows the connector never stamped, and an
  ambiguous fallback match refuses the product instead of picking one — a
  `product_variants_source_external_variant_key` unique index makes the
  ambiguity unreachable for stamped rows in the first place. A merchant editing
  a SKU or renaming an option keeps the same local variant id, so its carts,
  saved items, offers and order history survive the edit.
- **An unsell lands at the connection's TARGET location.** It used to be written
  at the store DEFAULT while the connector's stock sat at the target, and the
  variant scalar is the SUM of its levels — so the zero landed beside the
  surviving stock and the "unsold" variant stayed fully buyable wherever a
  merchant had configured a target location.

**What a real store still settles:** whether WooCommerce publishes the complete
`variations` id list on the `products` LIST response for a product with many
variations (W8), whether a real header-stripping plugin leaves the body intact
so the empty-page rule terminates (W9), and whether a real site ever serves a
`per_page` smaller than the 100 requested.

### 8.4 An import is atomic between creating a listing and stamping provenance (#221 — FIXED)

Was: `createStoreProduct` and the `updateListingColumns` that wrote the four
`source_*` columns were separate statements, so a failure in between left a
listing with no provenance — no later sync could match it by external id, and
the next attempt to import the same product failed on
`listings_store_id_handle_key`, permanently. Observed while building the harness,
triggered by an invalid `externalUpdatedAt`: the WooCommerce provider built it as
`new Date(\`${value}Z\`)`, which yields an Invalid Date for any timestamp already
carrying a zone, and the invalid Date throws inside drizzle.

All of it is fixed, in four parts.

1. The provenance, the initial `draft`/`active` status, the VARIANTS and their
   stock are written by ONE transaction — `insertStoreProductWithin`, the
   store-product mirror of `insertP2PListingWithin` — on BOTH import paths (the
   pull `importProduct` and the push-in `upsertProduct`). A failure leaves no
   listing rather than a stranded one, and no listing with nothing to sell:
   the variants used to be inserted after the transaction committed, and
   `convergeVariants` returns early on a listing with zero variants, so nothing
   would ever have grown one.
2. `listings_store_id_source_key_idx` is UNIQUE (migration `0070`, `post`), so
   two concurrent deliveries for one external id can no longer both create. The
   loser re-reads and converges; a `listings_store_id_handle_key` collision still
   fails the product, deliberately.
3. An unreadable provider timestamp OMITS the field, and a legitimately ZONED one
   is read at its own offset rather than discarded — discarding it would erase
   the stored freshness on every later sync (`connectors/timestamps.ts`).
4. Shopify's `fx_rate_as_of` is validated and kept verbatim.

`services/__tests__/connector-import-atomicity.realdb.test.ts` drives it end to
end against a real server: a first run whose product carries an invalid
timestamp leaves ZERO listings, the next run imports the same product
successfully, and the same fixture WITHOUT the fault imports exactly one — the
positive control that stops "zero listings" reading as a harness that ran
nothing.

**What a real store still settles:** nothing specific to this defect — the
failure and the recovery are both properties of Mercaria's own write path. What
a real store adds is the ordinary confirmation that a first backfill of a live
catalogue reports no per-product failures at all, and — new with the unique
index — that a webhook delivered DURING a backfill converges rather than failing
that product. A `duplicate key … listings_store_id_source_key_idx` in the run
log means the convergence is not working.

**Before deploying the `post` migration, confirm no duplicate already exists**
(the query is in the migration's own header). It fails closed if one does, and
collapsing a duplicate is not mechanical — the two rows may carry different
local edits.

**One thing a real run should still watch for, and it is NOT #221:**
`applyCollectionMapping` runs after the create, so an interrupted import can
leave a listing with no connector collections — recoverable, because the listing
now carries its provenance and the next sync re-applies the mapping.

### 8.5 Not a defect, worth knowing

A no-change resync tallies as `updated`, not `skipped`: the listing patch is
built from every unpinned connector-managed field whether or not it changed. The
dashboard will say "N updated" after a reconcile that changed nothing.

---

## 9. Production enablement checklist

Do NOT enable connectors in production until every line is true.

- [ ] `CONNECTOR_ENCRYPTION_KEY` generated, stored in SSM `/oxy/mercaria/*`, and
      backed up — a lost key makes every stored credential undecryptable.
- [ ] `CONNECTOR_OAUTH_STATE_SECRET`, `CONNECTOR_OAUTH_REDIRECT_BASE_URL`,
      `CONNECTOR_OAUTH_SUCCESS_REDIRECT_URL` set; the redirect base is the real
      public API origin.
- [ ] `CONNECTOR_DEFAULT_CATEGORY_SLUG` names a category that EXISTS in
      production.
- [ ] `SHOPIFY_SCOPES` is the full §3.2 string, and the Partner app requests
      exactly those scopes.
- [ ] `REDIS_URL` set and reachable. Without it every sync runs inline in the
      request and a real backfill times out.
- [ ] A connect on the production app returns `scopes[]` matching §3.2 — read it
      back, do not assume it.
- [ ] Every scenario in §§6–7 has been run against a development store and its
      evidence recorded.
- [ ] The defects in §8 are either fixed or explicitly accepted, in writing, by
      whoever owns merchant onboarding.
- [ ] The WordPress plugin repo is published, and a channel key minted in
      production has been confirmed to work from a real plugin install.
- [ ] Alerting exists on `sync_runs.status = 'failed'` — a connector failure is
      otherwise visible only to a merchant who looks.

---

## 10. Rollback

Ordered least to most drastic. Every step is reversible except the last.

1. **Stop new connections.** Remove `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`
   from the task definition and redeploy. `getShopifyCredentials()` then throws a
   clear configuration error, so the connect flow refuses while everything
   already connected keeps syncing. Inbound Shopify webhooks stop verifying
   (the HMAC needs the secret) and are answered 401, which Shopify retries and
   eventually disables — acceptable for a rollback, and it does not touch data.
2. **Stop scheduled work.** Remove `REDIS_URL`. The 6-hour reconcile sweep is
   Redis-only and simply stops being scheduled; a merchant-triggered sync then
   runs inline. Reversible by restoring the variable.
3. **Disconnect one merchant.** `DELETE /admin/stores/{storeId}/channels/{connectionId}`
   deletes the platform webhooks, marks the connection `disconnected` and clears
   all six credential columns in one statement. The row and every imported
   listing's provenance SURVIVE, so reconnecting resumes rather than
   re-importing. The disconnect deletes the union of the ids Mercaria stores and
   every subscription the platform currently delivers to this connection's exact
   delivery URL, so an orphan from a pre-#218 registration is cleared by the
   disconnect itself and no longer needs a RECONNECT first. **Check the
   platform's own webhook list afterwards anyway** — that read is best-effort and
   is skipped when the platform will not answer it (an expired token, a 5xx), in
   which case only the stored ids were deleted and the log line says so.
4. **Stop the push-in surface for one merchant.** Revoke every channel key:
   `DELETE /admin/stores/{storeId}/channel-keys/{keyId}`. The plugin's next push
   gets 401; nothing already imported changes. Rotation is mint-then-revoke, in
   that order, so the merchant can reconfigure before the old key dies.
5. **Un-publish what a connector imported.** Set the affected listings to
   `draft`/`archived`. There is deliberately no bulk "delete everything this
   connection imported" — orders reference those listings, and
   `listings.source_connection_id` is `ON DELETE RESTRICT` precisely so a
   connection cannot be dropped out from under them.
6. **Roll back the API image.** The standard ECS rollback. Connector state is
   ordinary rows; nothing here needs a data migration to undo.

**What rollback CANNOT undo:** orders already imported (they are commercial
records, and an `external` payment row is linked to each), and a channel key that
was pasted somewhere it should not have been — revoke it and mint a new one.
