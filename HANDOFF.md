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
| `REDIS_URL` | ElastiCache Valkey (already in `oxy-infra`) | **Important:** without it, syncs run INLINE in the request → large backfills time out, and the scheduled 6h reconcile never runs. Required for production. |

Guest commerce (#103, ADR 0003 — DO NOT enable before the M8 security + privacy review): `GUEST_COMMERCE_ENABLED=true` requires BOTH `GUEST_PII_ENCRYPTION_KEY` and `GUEST_EMAIL_HASH_KEY` (each `openssl rand -hex 32`, two DIFFERENT keys — D12) or it stays OFF and logs once at boot. `GUEST_SESSION_ISSUANCE_ENABLED=false` is the incident kill switch (stops new sessions only). Tunables `GUEST_SESSION_IDLE_DAYS=30`, `GUEST_SESSION_ABSOLUTE_DAYS=90`.

FX (optional but recommended): the 15 non-USD/EUR/GBP currencies use env-overridable **static** fallback rates (`FX_STATIC_RATE_JPY`, `…_MXN`, etc.). The live provider only yields FAIR→USD. For correct display and for the presentment side of a cross-currency order, wire a real multi-currency FX source or keep the static rates current. A missing rate is never fabricated: the pair is simply omitted, and a conversion that needs it fails rather than quoting a wrong amount — so a same-currency sale is unaffected by an FX outage, and a cross-currency one is refused.

## 2. Shopify Partner app
1. In the Shopify Partner dashboard, create an app (public or custom).
2. Set the OAuth redirect URL: `{CONNECTOR_OAUTH_REDIRECT_BASE_URL}/channels/oauth/shopify/callback`.
3. Request the scopes in `SHOPIFY_SCOPES` (above).
4. Copy the API key/secret → `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`.
5. Webhooks are registered automatically by the backend on connect (products/create|update|delete, inventory_levels/update, orders/create|updated) — no manual webhook setup needed, but the app must have the matching read scopes.

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

### 5.3 Defects found while building the suites (filed, referencing #69)

- **#218 — FIXED.** `registerWebhooks` is per-topic fault tolerant: it reconciles against the platform's OWN subscription list (adopting on Shopify, recreating on WooCommerce, where the secret is fixed at creation), then persists the ids, the secret and the topics the platform REFUSED in one transaction. A partial registration is now disconnectable, retryable without duplicating anything, and names the events that will not arrive — on the connection DTO (`webhookFailures`) and by degrading the catalogue axis of `ChannelReadiness`. The `SHOPIFY_SCOPES` default is the full set, so the configuration that triggered it no longer exists. **Still unverified against a real store:** whether Shopify and WooCommerce report their subscription lists in the shape the providers parse.
- **#219 — FIXED.** `createWooCommerceTransport` retries a 429, honouring `Retry-After` (capped at 30s per wait) else an equal-jitter backoff, bounded by a 60s total budget and five retries, on every method including the registration POST. After the retries the 429 still surfaces, so a genuinely rate-limited run fails as before and archives nothing. The proactive self-throttle Shopify has was deliberately NOT ported — WordPress publishes no leaky-bucket header and a fixed interval would be Mercaria guessing somebody's hosting plan. **Still unverified against a real store:** whether a real host's 429 carries `Retry-After`, and whether its value fits the cap.
- **#220** — a WooCommerce `product.*` webhook collapses a variable product to ONE variant at the parent's lowest price, permanently.
- **#221** — an import is not atomic between creating the listing and stamping provenance; a failure between them strands a listing no later sync can match.

## 6. Known limitations (code, not blockers)
- FX static rates for the 15 new currencies are dev defaults — need a real feed for accuracy.
- `collectionMapping` populates from Shopify collects on backfill; a webhook-driven single-product update carries no collection context (reconciled at the next backfill).
- Fulfillment holds/cancellations beyond line-level partial fulfillment are not mapped.
- A no-change resync tallies as `updated`, not `skipped` — the listing patch is built from every unpinned connector-managed field whether or not it changed.
