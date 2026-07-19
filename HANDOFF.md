# Mercaria — Connectors deploy runbook (handoff)

The connectors platform (Shopify + WooCommerce sync, ingestion API, WordPress plugin) is **code-complete and CI-green** but has **never run against a real store** — everything is unit-tested with mocked HTTP. This runbook lists the exact steps to make it live in production. Everything here needs your accounts/infra; the code is ready for it.

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
| `SHOPIFY_SCOPES` | `read_products,write_products,read_inventory,read_orders,write_merchant_managed_fulfillment_orders` | Missing a scope degrades that feature gracefully (webhook registration is best-effort). |
| `REDIS_URL` | ElastiCache Valkey (already in `oxy-infra`) | **Important:** without it, syncs run INLINE in the request → large backfills time out, and the scheduled 6h reconcile never runs. Required for production. |

FX (optional but recommended): the 15 non-USD/EUR/GBP currencies use env-overridable **static** fallback rates (`FX_STATIC_RATE_JPY`, `…_MXN`, etc.). The live provider only yields FAIR→USD. For correct display/settlement, wire a real multi-currency FX source or keep the static rates current.

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
Everything is unit-green with mocked HTTP; verify against a real dev store:
- [ ] Shopify OAuth connect succeeds; a backfill imports products with native currency + images.
- [ ] A price/inventory change in Shopify propagates (webhook + the 6h reconcile).
- [ ] Deleting a product in Shopify archives it in Mercaria.
- [ ] `overriddenFields` (a locally-edited price/collection) survives re-sync.
- [ ] A Shopify order appears in Mercaria (source-stamped, DualMoney); marking it shipped pushes a fulfillment back.
- [ ] WooCommerce connect-key + plugin push a Woo catalog in.
- [ ] A large catalog backfill completes without 429 failures (needs `REDIS_URL`).

## 6. Known limitations (code, not blockers)
- FX static rates for the 15 new currencies are dev defaults — need a real feed for accuracy.
- `collectionMapping` populates from Shopify collects on backfill; a webhook-driven single-product update carries no collection context (reconciled at the next backfill).
- Fulfillment holds/cancellations beyond line-level partial fulfillment are not mapped.
