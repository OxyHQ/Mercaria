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

## 5.5 Connect Accounts v2 — what is done and what is left

`POST /v1/accounts` is REFUSED on this platform account for every input
(measured 2026-09-06, test mode). Before the port, `ensureConnectedAccount` threw
for every seller, so no seller could reach `ready` and
`assertSellerGroupsPaymentReady` refused every native checkout group: **native
checkout was not un-onboarded, it was DOWN.** Nothing said so anywhere, because
there has never been a connected account, so no test or deploy could notice.

Done (ADR 0008): creation ported to `POST /v2/core/accounts`, the capability set
amended with `card_payments`, and the account read back through `GET /v1/accounts`
because `v2.core.account` carries none of D9's readiness fields.

Left, in order:

- [ ] **One browser onboarding run.** No settling transfer has ever executed. The
      account cannot be driven to `active` by API — under
      `requirements_collector: stripe` the platform is refused ToS acceptance
      (`tos_acceptance_on_behalf_not_allowed`), which is exactly the property D2
      wants. Only a real hosted-onboarding run closes it.
- [ ] **A third webhook endpoint for v2 events** (ADR 0008 D2-E). NOT blocking —
      `account.updated` still fires — but mandatory before onboarding a seller in
      a country where a recipient-only account is expressible (the US), because
      such a seller emits no `account.updated` at all.
- [ ] **Ask Stripe support whether a recipient-only account is enablable for ES.**
      The `card_payments` coupling is country-specific and undocumented; if it can
      be lifted, ADR 0008 D2-C's 33-requirement onboarding form gets shorter —
      but D2-D must be re-read first, because `card_payments` is also what makes
      the readiness event fire.
- [ ] `transfer.canceled` is subscribed on the test platform webhook endpoint and
      is in neither code tuple. Drift introduced during rehearsal; remove it or
      adopt it deliberately.

## 6. Known limitations (code, not blockers)
- FX static rates for the 15 new currencies are dev defaults — need a real feed for accuracy.
- `collectionMapping` populates from Shopify collects on backfill; a webhook-driven single-product update carries no collection context (reconciled at the next backfill).
- Fulfillment holds/cancellations beyond line-level partial fulfillment are not mapped.
- A no-change resync tallies as `updated`, not `skipped` — the listing patch is built from every unpinned connector-managed field whether or not it changed.
- **Radar's verdict is not wired to the high-value hold.** Mercaria subscribes to no `review.*` event and stores no `charge.outcome.risk_level`, so a held transfer's risk assessment is readable only in Stripe's dashboard, and closing a Radar review neither releases the hold nor refunds. The hold is purely time-based (`STRIPE_HIGH_VALUE_HOLD_WINDOW_MS`) and an operator's `retry_withheld_transfer` is the only early exit. Wiring it means two new platform event types — and `STRIPE_PLATFORM_EVENT_TYPES` is transcribed by hand in a test against ADR 0001 deliberately, so they belong in their own tuple beside `STRIPE_BILLING_EVENT_TYPES` rather than appended to that list.

---

# Mercaria Digital (#1015) — what is built, what is inert, and what Phases B–E still need

**Status: Phase A is code-complete, CI-green and INERT.** Four of the five feature
levers default OFF and nothing has run against real object storage, a real asset
file or a real buyer. Binding decisions: [ADR 0010](docs/adr/0010-digital-commerce.md).
Design: [docs/digital-commerce.md](docs/digital-commerce.md).

## 0. What is deployed vs what is inert

Migration `0156` creates fifteen tables and seven triggers and runs with the normal
pipeline, so the schema is live on every deployment. **Nothing uses it** until the
levers below are set, and a deployment that sets none behaves exactly as it did
before #1015 — including the address constraint, which is stricter for physical
orders and otherwise invisible.

## 1. Env / levers (SSM `/oxy/mercaria/*`, via GitHub Actions repo secrets)

| Var | Default | Notes |
|---|---|---|
| `DIGITAL_UPLOADS_ENABLED` | `false` | gates the creator upload surface. Off does not touch a published asset. |
| `DIGITAL_PUBLICATION_ENABLED` | `false` | gates a version becoming sellable. Separate from uploads so work can be staged while publication is paused. |
| `DIGITAL_PAID_CHECKOUT_ENABLED` | `false` | **the launch gate — see §3.** A free claim still works with it off. |
| `DIGITAL_DOWNLOADS_ENABLED` | **`true`** | the INCIDENT lever. Off refuses new grants with `downloads_disabled` and leaves every right `active`, so flipping it back restores access with nothing to repair. **Never use it as a rollout lever.** |
| `DIGITAL_ENABLED_VERTICALS` | empty | comma-separated `DigitalVertical` keys; an ALLOW-list. `three_d` is the only one with a format registry today. |

## 2. Object storage IS wired now — and the part that is NOT is upload

`asset_files.storage_key` holds an **Oxy `file_id`**, and `services/digital/storage.ts`
is the one module that resolves one. ADR 0010 D17 records the mechanism and, more
usefully, the mechanism it is not: the obvious `oxyClient.getFileDownloadUrlAsync`
resolves a URL for the CURRENT USER against Oxy's ACL, and a Mercaria buyer is not a
user Oxy knows anything about. The resolution is Oxy's service-token mint
(`POST /assets/service/linked-url`, **Oxy ADR 0021**), authorized by the file's own
owner having attached it to the `mercaria` application.

**This needs the Oxy side deployed.** It is implemented and pushed on Oxy's
`claude/pensive-fermat-wi3gcq`, and it requires, in order:

1. That branch merged and released.
2. The `mercaria` Oxy application granted the **`files:linked:read`** scope. It is
   NOT implied by `files:read` — deliberately, because `files:read` is metadata-only
   and spelling byte access as a widening of it would have handed byte access to
   every application already holding the smaller one.
3. `OXY_APPLICATION_KEY` / `OXY_APPLICATION_SECRET` set (they already are, for the
   capability catalogue).
4. **A swap in `storage.ts`:** it calls the route through `makeServiceRequest`
   because Mercaria consumes `@oxy.so/core` from npm and the release carrying
   `getServiceLinkedDownloadUrls` lands after this one. Switch to the SDK method at
   the next bump — the wrapper is where the batch cap of 25 lives, so a future caller
   wanting a whole version's files must go through it.

Until step 2, every download answers `absent`, which surfaces as *"your purchase is
unaffected — please contact support"* rather than a revocation. `downloadsEnabled`
defaults **on** (it is the incident lever), so the gate that actually holds is
`publicationEnabled`.

### What is still missing: UPLOAD

There is **no creator upload endpoint**. `putAssetObject` exists and works for an
object this service uploads, but the real flow is the creator uploading STRAIGHT TO
OXY (an 8 GiB `MAX_ASSET_FILE_BYTES` and a 10 MB `express.json()` limit are not
reconcilable), and that flow carries a client-side obligation:

- **The creator must call Oxy's `POST /assets/:id/links` with their OWN session**,
  `app: 'mercaria'`, before registering the file here. Oxy admits a file only when
  `file_links.created_by = files.owner_user_id`, so a link created by this backend on
  the creator's behalf would NOT satisfy it. A file that was not attached is refused
  at **registration**, with the same wording as "no such file" — which is deliberate
  (distinguishing them is a probe for which Oxy file ids exist) and is why the
  dashboard has to get the link right rather than discover it later.
- Oxy computes the SHA-256 server-side and this service reads it from the mint
  (#1015 W1 rule 7), so no client-reported digest is ever written.
- A `completed` download event with `bytes_transferred` is still written by nothing:
  the redirect hands the transfer to S3, which does not report back. Closing it needs
  either a proxying route or an S3 access-log consumer.

## 3. The paid-launch gate (ADR 0010 D15) — three sign-offs, per market

`DIGITAL_PAID_CHECKOUT_ENABLED` must stay off in a market until all three are
recorded here with a date and a name:

| Gate | What it has to establish | Status |
|---|---|---|
| Payment provider | Peable (and the provider settling behind it) permits a third-party digital-goods marketplace on this account | **NOT DONE** |
| Tax | electronically-supplied-service rates exist for the market, scoped to a COUNTRY — a digital line matches nothing narrower, and a market with no country-scoped rate is taxed at ZERO | **NOT DONE** |
| Consumer law | the withdrawal-waiver copy reviewed for the market, and the waiver presented before payment rather than after | **NOT DONE** |

The code cannot hold these. What it holds is that the lever defaults off and that a
missing rate is a visible zero rather than a plausible one.

## 4. Phase B — the Mercaria 3D MVP, and what each piece still needs

| Piece | State | What it needs |
|---|---|---|
| **Asset inspection workers** (W4) | **BUILT** — `services/digital/inspection/` parses STL (binary + ASCII), OBJ, glTF/GLB and 3MF; a fourth BullMQ queue (`marketplace-digital`, concurrency 2) because an inspection is CPU-bound while `marketplace-sync` waits on suppliers; bytes arrive through `byte-source.ts` and the storage port | the limits are in-process, not a SANDBOX. Every ceiling W12 asks for is enforced (256 MiB read, 32 MiB JSON, 512 MiB declared expansion, 200:1 ratio, nesting depth 1 by having no recursion, a 20 s cooperative budget) but it runs in the API's own worker. A `blend`/`fbx` parser must NOT be added without a real sandbox and a threat model — both answer `unsupported` today, and that is the safe answer. |
| **Malware scanning** (W1 rule 12) | `scan_verdict` defaults `pending`; `everyFileScannedClean` gates publication; `inspection/scanner.ts` is the seam and answers **`error`, never `clean`** | an actual scanner. **Until one exists, nothing can be published**, which is the safe failure and is why publication is a separate lever. |
| **Inspection publication gate** | **BUILT** — `everyFileInspectionAcceptable` closes the escape the scan gate left: a `corrupt` file is not malicious, so a scanner calls it clean and nothing else stood between it and a buyer. `unsupported` and `missing_resources` deliberately PASS (`PUBLISHABLE_ASSET_INSPECTION_VERDICTS` says why each membership is a decision) | nothing |
| **`web_derivative` generation** | `ASSET_FILE_VISIBILITIES.preview_only` and the role exist; the authorizer already refuses to hand one over as a file | a glTF/GLB derivative generator, and a viewer route that streams it without exposing the source |
| **The 3D viewer** (W4) | **BUILT, rendererless.** `AssetPreviewViewer` has the full chrome and the accessible static path; `AssetPreviewSource` is branded with a module-private `unique symbol` so handing it a paid file is a COMPILE error, not a runtime check | a WebGL renderer through the `renderer?: AssetModelRenderer` prop. **No three.js/expo-gl dependency was added** — that is a human decision with `expo.install.exclude` and native-version consequences across three apps. |
| **3D product profiles** (W3) | **BUILT** — seven profiles, 9 categories, 17 claim attributes, 96 fields, seeded through #367's authoring path (`bun run seed:digital-3d`, `docs/verticals/3d.md`). Keys are `three_d_*`: a LEADING DIGIT is illegal under `PRODUCT_TYPE_KEY_PATTERN`, so `3d_print_model` would never have inserted | nothing |
| **Creator authoring UI** | nothing; the repositories and services are callable | a dashboard surface for upload → package → licence → publish |
| **Storefront surfaces** (W5) | **BUILT** — `/3d`, `/3d/printable`, `/3d/game-assets`, `/3d/[slug]`, `/creators/[slug]`, `/library`, with facets coming FROM the read and a rail that renders only when the read reports `selectionApplied` | the reads behind them. `lib/digital/source.ts` is the single seam and all four producers answer `unavailable`, so every screen renders an honest notice today. See §6. |
| **Buyer library + download UI** (W9) | `listBuyerLibrary` returns the full projection including the file inventory and an `updateAvailable` flag | the screens, and update notifications per communication preferences |
| **Reference licences** | **BUILT** — `applyReferenceLicences` writes each as an `authorship: 'mercaria_reference'` row plus a published version 1, converging on a re-run including the awkward state (version 1 left in `draft` by an interrupted run, which `findPublishedLicenceVersion` answers NULL for) | nothing |

## 5. Phases C–E, and the seams that exist for them

- **Bundles and memberships** (W7): `asset_packages` already separates "the thing
  sold" from "the files", so a bundle is a package naming more than one asset's
  files. Nothing is built.
- **Re-upload detection** (W8): **BUILT** (`services/digital/provenance/`) — content
  hash, a quantised geometry fingerprint (`gfp1:q1024:…`, readers for STL and OBJ
  only; every other format answers `unsupported` rather than a weak fingerprint), and
  a preview perceptual hash over a Mercaria-generated raster. The sweep escalates to
  the EXISTING abuse-report path with `reportedType: 'listing'` and
  `category: 'stolen_goods'`, requires an `operatorOxyUserId` with no default and no
  sentinel (so a machine can never file), and **stores nothing** — a persisted
  candidate list is a verdict-shaped row.
  - **The one real limitation, measured:** an equality-indexed digest cannot be
    noise-tolerant. A float32 round-trip survives the fingerprint with p≈0.002 and a
    3-decimal rewrite with p≈1e-270, and no grid choice fixes that — failure is
    linear in vertex count. Closing it needs a DISTANCE-capable retrieval (an LSH
    banding column, a `bit(64)` Hamming index, a vector index), i.e. a schema change.
  - **Upstream ask:** the CrowdSource `commerce` family has no rights-infringement
    code. `stolen_goods → commerce.prohibited_item` is the closest honest fit and
    `counterfeit` is wrong — a re-upload is a genuine copy sold by the wrong person.
    Worth raising as `commerce.rights_infringement`.
- **Creator analytics** (W13): **BUILT and deliberately UNWIRED.**
  `services/digital/analytics/` is six pure projections with a ten-sale cohort floor
  on geographic revenue that SUPPRESSES rather than rounds, and no path by which
  ranking can read it (`DIGITAL_METRIC_SCOPES` has exactly two members, neither of
  them a listing or an offer). `DigitalAnalyticsFactReader` is the seam and **has no
  SQL behind it**, which is not an oversight — two of its six fact types cannot be
  projected yet:
  - `DigitalViewFact` has **no source table**. Nothing records an asset view.
  - `DigitalSaleFact.creatorEarningsAmount` is a **Phase D decision**. #1015 forbids
    building creator royalties on referral commission or marketplace fees, and ADR
    0010 does not decide the royalty architecture. Projecting it from the ledger
    today would be inventing that decision in a repository.
    The other four (`downloads`, `rights`, `processing`, `publications`) are
    straightforward reads of existing tables and could ship independently.
  - `findMatchingProvenanceSignals` returns no `created_at`, so the sweep re-reads
    each candidate version to answer "which came first" — N round trips a repository
    change would remove.
- **The physical print bridge** (W10): not started. ADR 0010 does not decide the
  royalty architecture, and #1015 is explicit that royalties must NOT be built on
  referral commission or marketplace fees — that needs its own ADR.
- **A second digital vertical** (W14 Phase E): the four steps are in
  `docs/digital-commerce.md` §"Adding a second digital vertical". The only genuinely
  new piece per vertical is a processor.

## 6. Known gaps a reviewer should not mistake for oversights

- **The creator and buyer HTTP routes DO ship** (`routes/digital.routes.ts`,
  `controllers/digital-{creator,buyer}.controller.ts`) now that §2's storage is
  wired. What does NOT ship is the **client-reachable read the new storefront screens
  want**: `lib/digital/source.ts`'s four producers all answer `unavailable`, so every
  screen renders "switched off here; anything you already own is unaffected". The
  reads still needed are a browse read scoped by `DigitalVertical` (returning
  `CatalogProductBrowsePage[]` plus its `FacetScope`), an asset-page read carrying a
  SERVER-FILTERED public preview descriptor, a creator read, and `listBuyerLibrary`
  behind an authenticated route with a grant-mint endpoint beside it.
- **No SEO registry entries for the new routes.** `PublicRouteId` / `/seo/resolve` is
  #75's, so the new pages emit a title and description and claim no canonical.
- **`listBuyerLibrary` does N queries for N rights.** Correct and not fast; it is
  fine for a pilot-sized library and wants batching before a creator with a thousand
  buyers looks at it.
- **`asset_download_grants` has no sweeper wired.** `deleteExpiredGrants` exists and
  nothing calls it on a schedule. An expired grant opens nothing, so this is growth
  rather than a hole.
- **Guest rights are keyed on a SESSION**, which expires. The claim path carries them
  to an Oxy account (ADR 0010 D9.5) — a guest who never claims and whose session
  lapses keeps the right row and loses the way to reach it. That is #101's
  recovery surface, and it is not extended here.

---

# Authorized digital retail (#1016) — what Phase A built, and what is deliberately inert

ADR 0011 is binding for the whole epic; the code that landed with it is items 1–8
of the epic's own recommended order plus the library projection. Read
`docs/digital-retail.md` first — this section is only what is NOT done and what
each remaining piece needs.

## What is live-but-inert, and the levers that hold it

Everything defaults OFF except the incident lever:

| Variable | Default | Stops |
|---|---|---|
| `DIGITAL_RETAIL_CATALOG_SYNC_ENABLED` | off | pulling supplier catalogues |
| `DIGITAL_RETAIL_PUBLICATION_ENABLED` | off | an offer becoming publishable |
| `DIGITAL_RETAIL_CHECKOUT_ENABLED` | off | buying |
| `DIGITAL_RETAIL_PROCUREMENT_ENABLED` | off | submitting anything to a supplier |
| `DIGITAL_RETAIL_REVEAL_ENABLED` | **on** | revealing something a buyer already owns |

`DIGITAL_RETAIL_SEAL_KEY_REFERENCE` must name a path under
`/oxy/mercaria/digital-retail/seal/`, and the key itself is 32 base64 bytes in
`DIGITAL_RETAIL_SEAL_KEY_<LAST_SEGMENT>`. **Treat it as durable: rotating it makes
every artifact sealed under it unopenable.** A deployment with no key can seal
nothing, which is the reason procurement defaults off rather than failing after
money has been spent.

## What is NOT built, and what each needs

- **The public offer surface and the checkout wiring (#57).** Mercaria's unified
  offer domain does not exist, so this domain exposes `DigitalRetailSourcingSeam`
  the way #118 did for physical retail. Until #57 lands there is no path from a
  cart to `procureDigitalLine`, and building a parallel one would be the second
  commerce stack #1015 acceptance criterion 20 refuses. What it needs: #57's offer
  kind, a variant→offer binding equivalent to `asset_variant_bindings`, and a
  checkout refusal message for a line whose supply went dark between browse and
  pay.
- **A named provider adapter.** The epic forbids coding against guessed
  capabilities. The verification list is in `docs/digital-retail.md` ("Adding an
  authorized digital supplier") and step 1 is commercial, not technical. The
  sandbox adapter is a conformance fixture and is registered on every deployment
  — it can sell nothing, because no `supplier_accounts` row points at it.
- **The catalogue sync worker.** `upsertProcurementOffer` and
  `retireUnconfirmedOffers` exist and nothing schedules them. It wants a queue job
  per account, a run cursor, and an operator queue for `mapping_status =
  'ambiguous'` — which is where every unmapped supplier SKU currently accumulates,
  visible only by SQL.
- **The ambiguity recovery sweeper.** `findAmbiguousPurchaseOrders` and
  `recoverAmbiguousPurchaseOrder` exist and nothing runs them on a schedule. This
  is the highest-priority gap of the list: an ambiguous attempt BLOCKS its order
  line by construction, so without the sweep a supplier timeout strands a paid
  customer until somebody notices. `DIGITAL_RETAIL_RECOVERY_DELAY_SECONDS` is the
  interval it should respect.
- **Ledger postings.** ADR 0011 states the accounting treatment — buyer revenue,
  supplier procurement cost, processing cost, tax and realized retail margin — and
  none of it posts. The procurement cost and the customer receipt are separate
  financial events settling on different days, which is #128's reconciliation
  domain and is not wired to this one.
- **Refund execution.** `deriveDigitalRemedy` answers WHAT should happen and
  nothing performs it. A `refund_customer` outcome does not call the rail, a
  `replace_artifact` outcome does not re-procure, and a `supplier_credit_pending`
  outcome records nothing to chase.
- **Direct account activation.** The capability is in the vocabulary and an
  artifact of that kind stores no secret, correctly. The reviewed OAuth
  account-linking flow it would need is its own issue, and until it exists such an
  offer is eligible only if a rider names the capability — which no rider should.
- **Gift cards and stored value.** ADR 0011 D16: unrepresentable, not disabled.
  Admitting one is a new ADR answering the epic's Workstream 13 list, plus the
  tuple, plus a migration in the same PR.
- **Per-supplier reliability.** The selector reads a `reliabilityByAccount` map the
  caller supplies, and nothing computes one; every supplier therefore ranks at
  `RELIABILITY_WITHOUT_HISTORY`. The inputs are all on
  `digital_purchase_orders` already.
- **Operator surfaces.** No route, no controller and no DTO exists for any table in
  this domain — deliberately for now (the private tables are private WHOLE), but
  the support view ADR 0011 D12 describes has to be built before a real pilot: an
  operator resolving an invalid-key case today has psql and nothing else.

## The one number worth knowing before a pilot

`DEFAULT_MAX_PROCUREMENT_ATTEMPTS` is 3. Three suppliers may be tried for one
order line, each inheriting the same `max_accepted_cost`. It is a constant rather
than a policy row because nothing yet has an opinion about it; the moment a second
real supplier exists it should become one.
