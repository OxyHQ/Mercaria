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

Also verify, because it is the defect in §8.3: **create a NEW variable product in
WooCommerce and let the `product.created` webhook import it** (do not backfill
first). Expect it to arrive with ONE variant at the parent's lowest price, out of
stock, and to STAY that way through later syncs. Record what you see.

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
  reconnect with the topic set unchanged. Record it if you see it.

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

### 8.3 A WooCommerce webhook collapses a variable product to one variant (#220)

A `product.created` / `product.updated` delivery carries the product WITHOUT its
variations (WooCommerce sends `variations: [ids]`). The provider's
`normalizeProduct` therefore takes the single-variant branch and produces one
variant at the parent's lowest price, with no option values and `available: 0`,
while still declaring the option axis. Measured directly against the provider.
Because `importProduct` never ADDS variants to an existing listing, a product
first seen through a webhook stays wrong permanently.

### 8.4 An import is not atomic between creating a listing and stamping provenance (#221)

`createStoreProduct` and the `updateListingColumns` that writes the four
`source_*` columns are separate statements. A failure in between leaves a listing
with no provenance: no later sync can match it by external id, and the next
attempt to import the same product fails on `listings_store_id_handle_key`.
Observed while building the harness, triggered by an invalid `externalUpdatedAt`
— the WooCommerce provider builds it as `new Date(\`${value}Z\`)`, which yields
an Invalid Date for any timestamp that already carries a zone, and the invalid
Date throws inside drizzle.

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
   re-importing. **Check the platform's own webhook list afterwards** — since
   #218 Mercaria holds an id for every subscription it created, but a connection
   that last registered before that fix may still carry orphans, and the way to
   clear those is to RECONNECT (which reconciles) before disconnecting.
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
