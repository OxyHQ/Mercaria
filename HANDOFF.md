# Mercaria — Connectors deploy runbook (handoff)

The connectors platform (Shopify + WooCommerce sync, ingestion API, WordPress plugin) is **code-complete and CI-green** and has **still never run against a real Shopify store, a real WooCommerce site or a real WordPress plugin install** — acceptance criterion 7 of #69 is not met and this sentence stays until it is.

What changed with #69 is the *shape* of the remaining unknown. It is no longer "everything is unit-tested with mocked HTTP": the providers, the sync service and the database are now exercised together, with only the socket faked, so the unknown is narrowed to what only a real platform can settle. §5 says precisely which scenarios are automated, which are manual, and which known defects a real run will meet. The ordered, copy-pasteable procedure lives in **`docs/runbooks/connector-real-store-verification.md`**.

## 0. What's deployed vs what's inert
The connector backend, dashboard "Sales channels" UI, ingestion API, and the WooCommerce plugin (repo `OxyHQ/mercaria-woocommerce`) are all on `main` and deploy with the normal Mercaria pipeline. They are **inert until** the env below is set + a Partner app exists.

## 1. Env / secrets (SSM `/oxy/mercaria/*`, via GitHub Actions repo secrets)
Generate + set these on the **Mercaria backend** (ECS):

| Var | How | Notes |
|---|---|---|
| `CONNECTOR_ENCRYPTION_KEY` | `openssl rand -hex 32` | AES-256-GCM key for connection credentials + channel keys. **If rotated, all stored credentials become undecryptable** — treat as durable. |
| `CONNECTOR_OAUTH_STATE_SECRET` | `openssl rand -hex 32` | Signs the OAuth `state` (CSRF). |
| `CONNECTOR_OAUTH_REDIRECT_BASE_URL` | e.g. `https://api.mercaria.co` | Public base of the backend; the Shopify callback is `{base}/channels/oauth/shopify/callback`. |
| `CONNECTOR_OAUTH_SUCCESS_REDIRECT_URL` | e.g. `https://dashboard.mercaria.co/channels` | Where the merchant lands after authorizing. |
| `CONNECTOR_DEFAULT_CATEGORY_SLUG` | e.g. `home` | An existing category slug imported products default to. |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | from the Partner app (§2) | |
| `SHOPIFY_SCOPES` | optional — the code default is now the full string in `docs/runbooks/connector-real-store-verification.md` §3.2 | It WAS `read_products` alone, which is what #218 landed a default deployment in. Set it only to request a NARROWER grant, and read the granted `scopes[]` back after connecting either way: a scope Shopify did not grant at install cannot be added without re-authorizing, and a topic it refuses is now recorded on the connection rather than thrown away (§5.3). |
| `REDIS_URL` | ElastiCache Valkey (already in `oxy-infra`) | **Important:** without it, syncs run INLINE in the request → large backfills time out, and neither scheduled sweep runs — not the 6h catalogue reconcile, nor the 15-minute webhook re-registration sweep (#262), whose merchant-triggered equivalent does still run inline. Required for production. |

Guest commerce (#103, ADR 0003 — DO NOT enable before the M8 security + privacy review): `GUEST_COMMERCE_ENABLED=true` requires BOTH `GUEST_PII_ENCRYPTION_KEY` and `GUEST_EMAIL_HASH_KEY` (each `openssl rand -hex 32`, two DIFFERENT keys — D12) or it stays OFF and logs once at boot. `GUEST_SESSION_ISSUANCE_ENABLED=false` is the incident kill switch (stops new sessions only). Tunables `GUEST_SESSION_IDLE_DAYS=30`, `GUEST_SESSION_ABSOLUTE_DAYS=90`.

FX (optional but recommended): the 15 non-USD/EUR/GBP currencies use env-overridable **static** fallback rates (`FX_STATIC_RATE_JPY`, `…_MXN`, etc.). The live provider only yields FAIR→USD. For correct display and for the presentment side of a cross-currency order, wire a real multi-currency FX source or keep the static rates current. A missing rate is never fabricated: the pair is simply omitted, and a conversion that needs it fails rather than quoting a wrong amount — so a same-currency sale is unaffected by an FX outage, and a cross-currency one is refused.

## 2. Shopify Partner app
1. In the Shopify Partner dashboard, create an app (public or custom).
2. Set the OAuth redirect URL: `{CONNECTOR_OAUTH_REDIRECT_BASE_URL}/channels/oauth/shopify/callback`.
3. Request the scopes in `SHOPIFY_SCOPES` (above).
4. Copy the API key/secret → `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`.
5. Webhooks are registered automatically by the backend on connect (products/create|update|delete, inventory_levels/update, orders/create|updated) — no manual webhook setup needed, but the app must have the matching read scopes. A registration the platform refused, or one that could not be concluded, is **re-registered by a 15-minute sweep, or on demand from the channel screen** (#262) — so widening a scope afterwards does not need the merchant to re-authorize. A `permission_denied` or `topic_not_supported` refusal stops on the first attempt and waits for the merchant, since no retry can fix either.

## 3. Connect a store (operator/merchant flow)
- **Shopify:** Dashboard → Sales channels → Add channel → Shopify → enter `{shop}.myshopify.com` → OAuth → authorize. Then set the connection's `syncSettings` (products/inventory/orders direction, autoPublish, price markup/rounding, target location) and hit "Sync now" (or wait for the 6h reconcile / webhooks).
- **WooCommerce (pull):** Dashboard → Sales channels → Add channel → WooCommerce → enter site URL + a WC REST **consumer key/secret** (generated in WP admin → WooCommerce → Advanced → REST API, read scope) → connect.

## 4. WordPress plugin (WooCommerce → Mercaria push)
Repo: `OxyHQ/mercaria-woocommerce` (private). To ship:
1. Make it public (and/or submit to wordpress.org — SVN).
2. Merchant flow: in the Mercaria dashboard, on a WooCommerce `push_in` connection, **generate a Channel API Key** (`mck_…`, shown once) → paste it (+ the API base URL + connection id) into the plugin's Settings → Mercaria page → the plugin pushes the Woo catalog/stock to `{base}/channels/ingest/{connectionId}/{products,inventory}` with `Authorization: Bearer mck_…`. The key is long-lived (no OAuth needed).

## 5. Real-store E2E verification (the remaining unknown)

Full procedure, scope table, evidence template, enablement checklist and
rollback: **`docs/runbooks/connector-real-store-verification.md`**.

### 5.0 Status as of 2026-08-15 — WooCommerce RUN, Shopify NOT

**WooCommerce has now run against a real store.** A disposable WordPress 7.0.4 /
WooCommerce 11.0.1 / PHP 8.3.33 site (124 products, one with 110 variations,
EUR, `manage_stock: 'parent'` variations, 2 orders) was provisioned behind a
public HTTPS hostname and driven by the real service layer against real
Postgres and real Redis. Provisioning is reproducible from
`packages/backend/scripts/e2e/woocommerce/`.

| Scenario | Verdict |
|---|---|
| W1 connect, W2 backfill, W3 pagination, W5 orders, W6 native currency, W9 header-stripped host | **PASSED** |
| W8 (>100 variations) | **FAILED** — #294. Still fails: the ceiling is deliberate and unchanged, and the row needs `MAX_VARIANTS_PER_PRODUCT` raised above the product's variation count (runbook §7.2). What #294 fixed is that the omission is no longer silent |
| W4, W7, X1–X3 | NOT RUN — need a person in the WooCommerce admin (§5.4) |
| plugin 3 (push), 4 (replay), 5 (rotate/revoke), 6 (cross-store), 8 (plugin half) | **PASSED** — 3 as 7 of 8, the 8th refused by #296 |
| plugin 7 | HALF PASSED — merchant half, with a positive control; server half needs the admin route |
| plugin 1, 2 | NOT RUN — both are properties of the admin HTTP mint response, so both need an Oxy bearer |
| plugin 8, server half | **N/A**, not unmeasured — the ingest route is synchronous (a 1-product push returns `results[0].action` in the same response). The queueing on this rail lives in the **plugin** (WP-Cron, chunks of 100), not the server, which ingests a bounded batch inline. #69 scenario 8's "queue-backed ingestion" is satisfied by the plugin half; the pull rail's BullMQ queues are a different mechanism and were proven separately |

Every WooCommerce row was driven through the service layer, so **Mercaria's own
admin HTTP auth was not exercised** — that needs a real Oxy bearer token and is
labelled per row in the evidence, not once in a preamble.

**Shopify: nothing has run.** No Partner account, no development store, no app.
Acceptance criterion 7 of #69 is **not met**, and the sentence at the top of
this file stays until a Shopify backfill and webhook cycle has completed against
a real store.

### 5.0b Defects found by the real run

Eleven, all measured rather than reasoned except one half labelled as inference.
The two to read together are **#290** and **plugin#4**: the first rejected 100%
of pushed products on a timestamp format, the second is why nobody found out.

| # | What |
|---|---|
| #286 | The Shopify Admin API pin is out of support and Shopify falls forward silently. Read-back landed; pin moved `2024-10` → `2025-10` → **`2026-07`**, matching the Partner app's Webhooks API version so REST and webhook payloads cannot reach one normalizer in two shapes. Every endpoint and every schema-required field is documented at `2026-07`, the nested shapes were walked, `product-variant` was DIFFED `2025-10`-vs-`2026-07` (identical, ceiling intact) and no schema was widened. Bounds, stated: only that one resource was diffed, rate-limit/pagination are unversioned pages so "unchanged" is an INFERENCE, the per-version release notes 404 after `2025-01` (control-checked), and **no real store has answered** — so the pin is *consistent with* what Shopify publishes rather than verified against `2026-07` BEHAVIOUR. The served-version read-back in `http.ts`/`preflight.ts` settles it and needs the first real connect (#69 acceptance 7) |
| #287 | `read_orders` alone truncates the order import to 60 days, undocumented |
| #288 | The scope test asserts `read_locations` from its own table — circularity FIXED (each row cites an endpoint checked against the provider source, and the unconfirmed set is pinned exactly); whether `read_locations` is needed is still open, and runbook §3.1 carries the one-connect experiment that settles it |
| #289 | vitest discovered only `src/**`, so the evidence redactors were unprotected — FIXED |
| #290 | The ingest schema rejects every RFC-3339 **offset** timestamp; 0 of 124 products accepted — FIXED |
| #291 | A pushed price change never reaches an already-imported listing — FIXED for the variants a push NAMES and matches; creating and removing still need the completeness signal the wire DTO does not carry |
| #292 | Pull-then-push on one store collides on `listings_store_id_handle_key` |
| #293 | An absent `inventory` key is read as `tracked: true, available: 0` — FIXED |
| #294 | A >100-variant product is refused whole and the run still reports `completed` — REPORTING FIXED (the run names the product and the reason, and the channel reads `degraded`); the ceiling is unchanged and correct, so the product is still not imported |
| #295 | A change of delivery base URL orphans WooCommerce webhooks; the reconcile cannot adopt them back |
| #296 | `sku` and `barcode` are unique across the WHOLE table, so two merchants cannot list one GTIN |
| #297 | `webhook_registration_state` has no success value |
| plugin #1 | Parent-managed variations each push the parent's pool (125 sellable where 75 exist) |
| plugin #2 | Disconnect left the Channel API Key in `wp_options` — FIXED |
| plugin #3 | A third-party response body is echoed into a redirect URL |
| plugin #4 | The backfill reports success when every product failed |

### 5.1 Now AUTOMATED (CI, every push)

Four suites drive the REAL providers (URL building, pagination, zod schemas,
price parsing, and Shopify's 429/leaky-bucket wrapper), the REAL
`connector-sync.service` and a REAL Postgres server. Only the socket is faked.

| Suite | Cases |
|---|---|
| `connectors/shopify/__tests__/shopify-contract.test.ts` | 23 |
| `connectors/woocommerce/__tests__/woocommerce-contract.test.ts` | 21 |
| `services/__tests__/channel-push-contract.realdb.test.ts` | 15 — all eight plugin-push scenarios, over real HTTP |
| `services/__tests__/connector-queue-boundary.test.ts` | 8 — every sync entry point enqueues instead of working inline |

The shared cases live in `connectors/__tests__/connector-contract-suite.ts`; a
new platform gets all of them by writing one harness.

Covered at contract level: connect/reconnect/disconnect, credential revocation
and recovery, insufficient permission, backfill, price/title/image/stock updates,
override preservation, archive-on-removal, cursor pagination, rate-limit
behaviour, order import idempotency, native currency preservation, product and
order webhooks, inventory convergence, fulfillment push idempotency, channel-key
minting/rotation/revocation, cross-store and cross-connection rejection, and
"the plaintext key never appears in any response after creation".

### 5.2 Still MANUAL — needs a provisioned store

- [ ] Shopify OAuth connect against a real Partner app, with the GRANTED scopes read back.
- [ ] A backfill of a > 250-product catalogue, paginated and rate-limited for real.
- [ ] Real `products/*`, `orders/*` and `inventory_levels/update` deliveries.
- [ ] A real fulfillment pushed back and visible in Shopify.
- [ ] A WooCommerce pull from a real WordPress site (> 100 products, `manage_stock: 'parent'` variations).
- [ ] A real WordPress plugin install pushing its catalogue and stock in.
- [ ] Evidence recorded for each, redacted, per the runbook.

### 5.4 What a HUMAN must do, exactly

Everything automatable is automated. What remains needs either a credential
nobody can mint or a person clicking in somebody else's admin UI.

**A. An Oxy bearer token + its account id.** Any account — the store and the
owner membership are seeded locally, since Oxy ids carry no foreign key. It buys
the admin HTTP surface and nothing else on the WooCommerce list; without it
every row carries `admin surface not exercised`. Measured: `api.oxy.so` is
reachable, but `POST /session/device/register` answers **401** — device
registration needs an already-authenticated user, so a device pair cannot be
minted from nothing. There is no shared-secret way round it: the
`SERVICE_SECRET` path that once existed reached no route (`/admin` runs
`authenticateToken`) and was deleted whole in #164, so a real Oxy bearer token
is the only thing that opens this surface.

**B. A Shopify Partner account and development store.** All free; no phone, no
legal entity, no review delay. Full numbered procedure, including what to seed:
`packages/backend/scripts/e2e/shopify/README.md`. Two steps are irreversible or
refusable and are called out there: **app distribution cannot be changed after
selection** (and public distribution additionally requires GraphQL, which this
connector is not), and requesting **`read_all_orders`** makes Shopify refuse the
**entire** grant rather than narrowing it.

**C. Seven clicks in the WooCommerce admin**, for W4, W7 and X1–X3. Tell the
operator **before and after each step** — a sync runs between them and an
un-flagged edit makes the run unattributable.

1. Products → open any published product → change its **title** → Update.
2. Products → a DIFFERENT product → **Move to Trash**.
3. WooCommerce → Settings → Advanced → REST API → **Add key**, permissions
   **Read** (do not revoke the existing key), and hand the key/secret over
   through the token file, never a message.
4. Set that same key to **Read/Write** and say so, to verify #262's recovery.
5. Products → Add new → **Variable product**, an attribute with 3+ values used
   for variations, generate them, give each its own price and stock → Publish.
   Do **not** ask for a sync — the `product.created` webhook must do it.
6. Same product → Variations → add one more attribute value and save the new
   variation with its own price → Update.
7. Same product → Variations → **remove one** → Update. It must survive at zero
   stock, never disappear.

**Do not touch the 110-variation product** — it is #294's subject and its
failure is the control. Flag any edit made outside these steps.

### 5.3 Defects found while building the suites (filed, referencing #69)

- **#218 — FIXED.** `registerWebhooks` is per-topic fault tolerant: it reconciles against the platform's OWN subscription list (adopting on Shopify, recreating on WooCommerce, where the secret is fixed at creation), then persists the ids, the secret and the topics the platform REFUSED in one transaction. A partial registration is now disconnectable, retryable without duplicating anything, and names the events that will not arrive — on the connection DTO (`webhookFailures`) and by degrading the catalogue axis of `ChannelReadiness`. **Who retries it is #262:** a 15-minute sweep over the connections whose registration did not finish, and a "Register webhooks again" control on the channel screen — not a human re-authorizing the channel, which is what "retryable" meant when this bullet was written. The `SHOPIFY_SCOPES` default is the full set, so the configuration that triggered it no longer exists. **Still unverified against a real store:** whether Shopify and WooCommerce report their subscription lists in the shape the providers parse.
- **#219 — FIXED.** `createWooCommerceTransport` retries a 429, honouring `Retry-After` (capped at 30s per wait) else an equal-jitter backoff, bounded by a 60s total budget and five retries, on every method including the registration POST. After the retries the 429 still surfaces, so a genuinely rate-limited run fails as before and archives nothing. The proactive self-throttle Shopify has was deliberately NOT ported — WordPress publishes no leaky-bucket header and a fixed interval would be Mercaria guessing somebody's hosting plan. **Still unverified against a real store:** whether a real host's 429 carries `Retry-After`, and whether its value fits the cap.
- **#220 — FIXED.** The webhook path COMPLETES a delivery before normalizing (`expandWebhookProduct`: a no-op on Shopify, a `GET /products/{id}/variations` on WooCommerce), the pure normalizer REFUSES a payload declaring variations it does not carry rather than collapsing it, and a variant the platform ADDED is created on the next sync — so an earlier collapse is self-healing. A refused delivery fails the run and writes nothing; the safety net is the scheduled reconcile sweep, not a platform re-delivery. A variant the platform REMOVED is unsold (stock zero, tracking on) and never deleted, because a variant id cascades into carts, saves and offers. **Still unverified against a real store:** the wire shape of a real `product.updated` delivery, and whether the variations call completes inside the webhook job's lifetime for a product with many variations.
- **#221 — FIXED.** An import's provenance no longer lands in a second statement. The four `source_*` columns, the `draft`/`active` status and the variants' own `source_*` columns are all arguments to `createStoreProduct`, written by `insertStoreProductWithin` — so the window that stranded a listing with no `source_external_id`, invisible to every later match while still holding the handle, does not exist. The variant insert rides the same transaction on purpose: `convergeVariants` returns early on a listing with zero variants, so fixing only the provenance window would have traded a loudly-failing listing for a permanently empty one. `listings_store_id_source_key_idx` became UNIQUE (migration `0070`, a `post` phase that also collapses any duplicate the old race produced), because two concurrent deliveries could both read null and both create; the loser now converges by re-reading, matched by constraint NAME so a handle collision still surfaces as the merchant conflict it is. Provider timestamps go through one parse that appends `Z` only to a value carrying no zone — omitting a legitimately-zoned value would ERASE the stored freshness the next sync compares against, since `buildSource` writes `?? null` on every sync — and Shopify's `fx_rate_as_of` is validated and kept in the platform's own spelling rather than rewritten. **Still unverified against a real store:** the timestamp shapes are measured against what the platforms document, not against what they emit — whether a real WordPress site's `*_gmt` fields and a real Shopify order's `updated_at` arrive in those shapes, and whether anything upstream of them rewrites the response.

## 6. Known limitations (code, not blockers)
- FX static rates for the 15 new currencies are dev defaults — need a real feed for accuracy.
- `collectionMapping` populates from Shopify collects on backfill; a webhook-driven single-product update carries no collection context (reconciled at the next backfill).
- Fulfillment holds/cancellations beyond line-level partial fulfillment are not mapped.
- A no-change resync tallies as `updated`, not `skipped` — the listing patch is built from every unpinned connector-managed field whether or not it changed.
