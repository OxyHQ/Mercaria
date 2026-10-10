# Mercaria — Connectors deploy runbook (handoff)

The connectors platform (Shopify + WooCommerce sync, ingestion API, WordPress plugin) is **code-complete and CI-green** and has **still never run against a real Shopify store, a real WooCommerce site or a real WordPress plugin install** — acceptance criterion 7 of #69 is not met and this sentence stays until it is.

What changed with #69 is the *shape* of the remaining unknown. It is no longer "everything is unit-tested with mocked HTTP": the providers, the sync service and the database are now exercised together, with only the socket faked, so the unknown is narrowed to what only a real platform can settle. §5 says precisely which scenarios are automated, which are manual, and which known defects a real run will meet. The ordered, copy-pasteable procedure lives in **`docs/runbooks/connector-real-store-verification.md`**.

## 0. What's deployed vs what's inert
The connector backend, dashboard "Sales channels" UI, ingestion API, and the WooCommerce plugin (repo `OxyHQ/mercaria-woocommerce`) are all on `main` and deploy with the normal Mercaria pipeline. They are **inert until** the env below is set + a Partner app exists.

## 1. Env / secrets (SSM `/oxy/mercaria/*`, the only source; `aws ssm put-parameter`)
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

## 1. Env / levers (SSM `/oxy/mercaria/*`, the only source; `aws ssm put-parameter`)

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

# Store ownership is an Oxy account (ADR 0012) — deploy and deferred work

**Before the deploy that carries `0158`/`0161`:** run the three queries in
[`docs/stores.md`](docs/stores.md) ("Deploying `0158`/`0161`") against
production and keep the export. `0161` drops `store_members`; every member but
each store's earliest owner loses access until that owner converts the store to
an organization, and after `0161` nothing in Mercaria remembers who they were.
A store with no `owner` member makes `0161` refuse to apply — fix those first.

**Deferred, each waiting on something outside this repository:**

- **A service-token membership read in Oxy.** Until one exists, a surface with
  no caller session (attribution jobs, MCP capabilities, notifications) can only
  see the owning account and override holders. Self-referral leaves the rest NOT
  ESTABLISHED; MCP store tools are owner-account only.
- **The operator on a capability ticket.** An editor operating an organization
  through an agent gets the organization's full store authority on MCP, because
  the ticket names only the effective account.
- **Organization inboxes.** Store notifications now go to the owning account;
  whether Oxy fans an organization's notifications out to its members is Oxy's.
- **`store_member_invited`** stays in `notifications_type_check` for the rows
  that carry it; nothing writes it any more. Narrowing it is a separate
  migration.

# Place facts live in GoWay (ADR 0013) — deploy and deferred work

**Before CI can go green:** `@goway.to/sdk` 0.3.0 has to be on npm (it is
built on GoWay's `feat/p4-integration-api`); `bun.lock` carries the integrity
of a local `npm pack` of it, so refresh the lock if the published tarball
differs. GoWay's API must serve that branch too — `GET /places?ids=`,
`GET /claims?placeId=`, exceptions on lists and merge-patch clears — before
this deploys, or every batch place read answers `goway_unavailable`.

**One release** with the ownership pair: `Migrate (pre)` applies `0158`–`0160`,
`Migrate (post)` applies `0161`–`0162` (`docs/pickup.md`, "One release").
Before it, run the queries in [`docs/stores.md`](docs/stores.md) and the count
and export in [`docs/pickup.md`](docs/pickup.md) ("Moving to GoWay") against
production and keep the exports. `0162` withdraws EVERY location published
today — none can name a GoWay place before this release — and drops the facts
that would have been needed to make one.

**`GOWAY_API_URL`** is pinned into each release revision by `deploy-aws.yml`
(repo variable `GOWAY_API_URL`, default `https://api.goway.to`), like
`OXY_API_URL`. Add it to the task definition's `environment` in oxy-infra
(`terraform-uswest2/app-services.tf`) as well, so a revision terraform
registers between deploys keeps it. `NEARBY_DISCOVERY_ENABLED` and
`STORE_PICKUP_ENABLED` stay off without it.

**Deferred:**

- **Following a merge on the public reads.** A location whose place GoWay
  merged is undiscoverable until its merchant's next verify (the dashboard
  runs one on opening the location). A sweep could do it; nothing does yet.


## Catalog media synchronization — open (2026-10-10)

The storefront requirement is **internal Oxy file IDs only**: download/import
remote artwork in the backend before publishing it; never hotlink a supplier
image as a fallback. This is not yet established across the whole catalog.
The audit and current implementation:

- `channel-ingest.service.ts` and `connector-sync.service.ts` now call
  `catalog-media/sync.ts` before catalog writes. It downloads through Oxy
  `safeFetch`, bounds images to 20 MiB, stores durable public media under the
  persisted store owner, and accepts only the returned file ID. Failed imports
  preserve the old product/gallery; pinned images skip remote I/O. This needs
  the Oxy application permission below before a live upload can succeed.
- `canonical-product.service.ts` now imports remote observation images before
  opening its transaction, under the authenticated operator's Oxy account.
  Source storage/display rights are checked before upload and again before
  writing. PostgreSQL coverage proves upload refusal preserves prior facts,
  provenance and gallery. `sourceUrl` remains provenance. The canonical page,
  bundle contents, merchant cards, swatches and SEO no longer use that URL as
  an image fallback. All three Bloom resolver providers reject non-ID input;
  `isOxyFileId` is shared with the backend importer.
- `catalog-hydration.service.ts` and `variant-images.controller.ts` now preserve
  stored `fileId` values. Listing galleries, related/store/seller cards, recent
  history and POS resolve them through Bloom/Oxy. Public `/public/v1` image
  `url` fields still resolve at their projection boundary, preserving the SDK
  contract. Legacy rows whose stored value is already a URL still need import.
- Backend `resolveMedia` now refuses URL-valued IDs. Feed, cart, checkout,
  draft-order, store, review and SEO projections omit unavailable images; public
  API galleries keep only resolved images and select their first valid primary.
  Category art prefers `imageFileId`; its legacy `imageUrl` and immutable order
  snapshot URLs are displayed only when they name the configured Oxy namespace.
  The order records themselves are not rewritten. Feed cache v2 invalidates
  responses assembled before this rule. Full backend validation: 804 files,
  12,654 tests passed, five skipped (2026-10-10).
- Device-local history can still contain earlier URL-valued DTOs. ProductCard
  and ThreadShelf now display those URLs only if they match the current
  Bloom/Oxy resolver output for the file/rendition. Titles, conversation text
  and navigation are retained. Two real browser cases at 390/1440px load old
  history and open its thread/product without any supplier image request; no
  image or API interception is used in those cases. This validates withholding
  stale hotlinks, not a completed media import.
- Order history and cart lines now apply the same resolver check to projected
  or cached image URLs. Saved items resolve only valid file IDs, using their
  supplied resolver or the shared Bloom provider; there is no raw-ID/URL
  fallback. Historical order snapshots themselves remain unchanged. Review avatars and
  store-menu collection/review thumbnails now use this same boundary; three
  browser viewer cases reject an injected old external avatar URL. Rich product
  descriptions apply the same check on web and native, preserving image alt text
  when the URL is external. Importing those embedded HTML images is still pending;
  hiding an external source is not a successful synchronization.
  The remaining successful SVG image interceptors in storefront orders and
  dashboard list/gallery tests were removed. Their replacement coverage uses
  missing-file responses and checks usable rows, placeholders and zero requests
  to supplier origins; successful real-media rendering remains unverified.
- The home hero now resolves `ProductSummary.imageFileId`; feed/store
  hydration exposes image/logo/cover IDs and cache v3 invalidates URL-only
  payloads. Shared product and merchant cards use the same resolver boundary,
  and new listing history stores IDs rather than projected URLs. Merchant
  artwork permits bundled files or verified Oxy URLs, without the former
  arbitrary `{ uri }` fallback. A browser regression injects malformed feed
  metadata and checks zero supplier requests plus preserved product navigation;
  it does not intercept image responses or demonstrate a successful upload.
- Hero and product shelves now share `CatalogImage`, including Oxy request
  failures and source-keyed image state. Failed images retain a usable product
  link and a missing-image label; a rotating hero resets only that image, not
  the animated card. Hover, keyboard focus and press pause independently, so
  mouse-out no longer changes a keyboard-selected product. Browser coverage
  exercises deliberately missing Oxy files, rotation and keyboard activation;
  this is failure/identity coverage, not live-import acceptance. The current
  local feed still has zero usable file IDs across its 16 product entries.
  Product/store hero cards now use actual Expo Router links; the previous
  `Pressable` with `role="link"` but no `href` did not activate with Enter on web.
- Home category mosaics no longer discard published destinations when artwork
  is absent; labels and real links remain visible through the shared missing-image
  state. Their image URLs must match the current Oxy resolver. The original
  `shopping.spec.ts` illustrated-category acceptance case still fails its image
  count precondition against the unsynchronized local seed; it was not weakened
  or replaced by successful image interceptors. Keyboard/link coverage is separate
  from that outstanding successful-media acceptance.
- Local preview seeds also put external URLs into image fields. Some category
  and merchant artwork is already bundled locally; this does not prove all
  catalog media is synchronized.
- `src/scripts/backfill-listing-media.ts` now provides a read-only `--preview`
  (the default) and explicit `--apply` for existing listing galleries. It uses
  persisted user/store ownership and the real importer. Images update in place
  only after the whole gallery uploads; row IDs, positions, alt text and variant
  selections survive. A concurrent gallery or ownership edit produces a retry
  instead of overwriting it. `--limit=1..500`, `--after=<listingId>` and
  `--listing=<listingId>` bound/resume the pass. Reports contain source hashes,
  never signed URLs. A local preview found **27 references across 12 listings**;
  no apply/upload was run. Canonical images and store/category/collection artwork
  are outside this listing-only command and still need their own migration.
  Ten of those local listings use `seed.ts`'s development owner sentinel;
  live media also needs a genuine local Oxy owner account. Do not solve this by
  fabricating file IDs or silently importing under an unrelated account.

SSM's existing Mercaria application credential successfully minted an Oxy token
on 2026-10-10; its scopes contain no `files:*` permissions. No credential values
were recorded, scopes changed, or production assets uploaded. The existing Oxy
`/assets/service/user-media` route writes durable public assets under a local
owner account and requires staff-granted `files:user-media:write` (or the broader
legacy pair). The federation cache route is an evictable namespace, not a
substitute for catalog ownership. Resolve the proper authorized upload path
before migrating stored references.

Remaining work: authorize and verify the live upload path, retain
source URLs as provenance only, migrate existing media without dropping gallery
identity/order, audit remaining independent image consumers, and verify all browser
requests never fetch supplier image origins. Existing unsynchronized listing
gallery rows now show the normal placeholder instead of fetching the supplier.
The temporary browser image interceptor was removed after user review: browser
integration now requires actual imported file IDs in the seed data. Do not count
earlier synthetic-media browser passes as proof of live synchronization. Oxy
transport mocks remain in isolated backend tests for error/atomicity coverage.
New dashboard list rows and bundle recommendation cards already reject URL
values in `fileId`; this is not a claim that other surfaces are corrected.
The canonical browser gallery test also supplies deliberately external source
URLs and asserts zero requests to that origin while rendering Oxy images; its
real-media seed precondition must pass before that case can establish this.

## Storefront product parity — review media upload/acceptance remaining (2026-10-10)

The public Shop [rhode product](https://shop.app/products/8117398765806/peptide-lip-tint-ribbon)
contains a ten-photo buyer-review strip (`pdp-reviews-media-strip-media-*`). Its
public `ReviewsSheetContent` module also renders an all-reviews strip and opens
`ReviewMediaViewer`, with the associated review rather than a product-gallery
image substituted for it. Mercaria now has `Review.media`, ordered `review_media`
children (additive migration 0165), and `mediaFileIds` on creation. The backend
checks each file against the author's Oxy metadata before durable linking;
public hydration excludes hidden parents and private transaction targets.
Eligibility consumption, review, dimensions and attachments commit atomically.
Focused tests include a real PostgreSQL rollback through `createReview`, the
public media DTO and separately mocked Oxy validation failures; these do not
prove live uploads. The complete integrated backend run passes 809 files (12,716 tests; five
skipped), including the new-table governance checks. Backend, shared UI and all
three app typechecks passed; backend lint has no errors.

Product-wide media reads now page attachments through
`/reviews/product/:canonicalProductId/media` and `/listings/:id/reviews/media`,
independently of text review pages; each entry includes its associated review.
PostgreSQL tests cover older photos beneath newer text-only reviews, ordering,
pagination totals, hidden reviews and other-target exclusion; HTTP tests cover
anonymous access and invalid IDs. The frontend client/cache hook is ready.

The strip and Bloom viewer now render on listing, canonical and digital PDPs
and the full review sheet. The viewer includes the associated ReviewCard and
its helpful/report actions, follows attachment IDs through pagination, and
handles image/video failures with retry. Expo-video 56.1.4 is a frontend-only
player dependency; shared UI receives a render slot. Source geometry was
checked against Shop's public ReviewMediaViewer module (current build
0f5768e5d9bc8a19d837645055c9402f1961d641) and the previously captured PDP HTML.
The current live PDP returned Shop's error shell, so this is not a claim of
fresh live interaction parity. Browser cases use deliberate missing files and
503/404 failures, never replacement image bytes or successful-upload fixtures.

The creation form now uploads new product/listing attachments through Oxy's
authenticated `useUploadFile` and a controlled Bloom FileUpload (native selection
uses Expo DocumentPicker). It discloses public visibility before selection,
checks returned metadata and accepts only verified author-owned file IDs.
The general Oxy FileManagement picker is deliberately unsuitable here: in
Services 11.1.10 selecting or deselecting an existing file changes its visibility
before confirmation. This flow never selects or promotes existing private files.
Eligibility queries and form identity are scoped to the active account; upload
and publish failures preserve the review draft. Private transaction prompts
have no public-media uploader.

The review-media pass pinned published Bloom 7.24.1 and Services 11.1.11. Bloom fixes
first-click star activation and hidden uploader status accessibility at source
(PR 301); the Services maintenance release verifies the compatible peer range.
All apps, shared UI and Services resolve one physical Bloom copy. Two real
browser refusal cases (390/1440px) pass against those official packages, including
actual star selection, pending upload, transport failure, private-file rejection,
retry and preservation of the draft. Three hero and two order cases also pass.
These intentionally do not provide synthetic successful image/upload responses.

Still missing: successful acceptance with real author-owned Oxy files and
cross-device/native playback validation. Unit tests with metadata and browser
transport-refusal cases do not prove live uploads. Keep purchase verification and
moderation intact; supplier URLs or synthetic file IDs are not review media.
Full Shop parity remains unproven.

# Open-data providers — what is built and what is next

Keyless catalogue and price providers (`services/open-data/`, doc
`docs/catalog-sources/open-data-providers.md`) are built, tested against
recorded responses and #62's contract suite, and exercised live. They **run by
default** (ADR 0015): the sources are declared in `services/open-data/sources.ts`
(the four Open Facts catalogues and the Spanish Open Prices chains) and the
catalogue autopilot converges them and cycles the backfill stages.

- **Reference seeding runs unattended (ADR 0014, 0015).** The autopilot's cycle
  includes `reference_products` → `source_readvance` → `reference_promotion`.
  Since ADR 0016 a source seeds by its own product key too: Scryfall, TCGdex,
  GOG, YGOPRODeck, Steam (`steam_store`, top 10,000 games for Spain) and fifteen
  Spanish Shopify stores (`shopify_storefront`) are declared; the last two are
  Mercaria's own robots-respecting extraction providers. MITECO fuel and
  CheapShark (USD) are registered but not declared. Products are not joined
  across sources; that is #59's merge. Seeded products carry
  no category, no brand and no images yet. The brand hint and the Open Facts
  photos are in the observation's payload, and mapping them is the next step.
  Facts are stored, not yet mapped onto the attribute registry (#94).
- **Cross-source identity for non-GTIN products** (the same game on GOG and
  Steam) is not built; each source seeds its own product (ADR 0016). Wikidata
  QIDs are the candidate join key; until then #59 merges by hand.
- **Storefront attribution is BUILT.** A product-page row from an open-data
  provider carries `source` (name, licence label, the day the source saw the
  price), and `OfferRow` renders "Price seen on {date}" in place of a dead
  button plus a "Data: {name} · {licence}" line. Still to do: a public
  `/data-sources` page linking each provider, and the ODbL subset export.
  Both need legal review before production.

## Local integration database — 2026-10-10

The published `origin/main` migration `0165_youthful_rictor` is authoritative.
The unpublished review-media migration was regenerated after it as
`0166_faulty_inertia` (pre, derived), with shared types rebuilt first. Do not
apply this sequence over a developer database that already applied the old
`0165_brave_johnny_blaze` / `0166_typical_kid_colt` sequence or rewrite its ledger.

This session's backend now uses local `mercaria_dev_canonical_20261010` on
Postgres port 5435. It was created through the canonical migration runner and
received a data-only restore of all 482 application tables after stopping the
local API. All 6,379 rows and sorted JSON row checksums matched before restart;
the original `mercaria_dev` remains untouched as a backup. The restored database
retains its own canonical migration ledger. Local dump, restore log and per-table
verification are under `/tmp/mercaria-local-db-preserved-20261010/`; they are not
repository fixtures. Only the ignored backend `.env` database path changed.
No production migration or data write was performed.

## Category media boundary — 2026-10-10

CategoryNode, CategoryPill and CategoryTile now carry `imageFileId`; Explore
child previews carry `sampleImageFileIds`. Both feeds and the tree use the
product hydration media verifier. This closes Explore's raw `imageUrl`
passthrough and the chips/grid's arbitrary-URI fallback. Verified old Oxy URLs
retain compatibility; supplier URLs are withheld until imported. Real database
projection and negative media-reference tests do not prove file upload or image
byte availability. The local catalog still needs authorized Oxy media imports;
the existing illustrated-category acceptance test remains unchanged.

## Catalog media recovery — 2026-10-10

The explicitly approved Oxy application + existing service credential scope grant
`files:user-media:write` was applied atomically, preserving the six existing scopes
and keys. The ECS operator receipt is task
`9fb8c20091f34199ae2e16293cbc955d` in `/oxy/ecs`; both temporary maintenance tasks
were stopped after completion. A fresh service token confirmed the new scope.
No production Mercaria catalog rows were changed.

The local `mercaria_dev_canonical_20261010` catalog now has real imported Oxy files:
66 source references covering 27 listing images, 6 canonical images, 39 category
images and store logos/covers (sources shared between rows). Local demo images
were imported under the verified Oxy seed operator account, without rewriting
fake fixture store/seller ownership. Listing row IDs, variant-image links,
canonical source observations and ordering were retained. The public source→file
mapping is `packages/backend/src/scripts/seed-media-manifest.json`; it contains
actual returned IDs, not image test doubles. Future dev seeds use that manifest
and validate all references before clearing tables. Add new fixture imagery by
importing it into Oxy first and recording the returned ID; never fabricate IDs.
The local ignored backend environment has the authorized application credentials.

The listing create/update service and HTTP schemas now reject URLs as file IDs.
Connector/channel and canonical import services already synchronize sources before
writes. Live browser acceptance is `scripts/e2e/storefront/live-catalog-media.spec.ts`:
1440/390 px, no request interception, actual loaded image dimensions and no supplier
CDN requests. Both passed. Successful byte delivery was also verified directly
from `cloud.oxy.so`. This closes the earlier live-media import prerequisite;
negative fixture tests remain error-boundary tests only.

The dashboard now uploads new product photos through the authenticated store
media endpoint, deriving ownership from the persisted store. A real local-service
probe uploaded JPEG bytes through Oxy and fetched the returned public file with
HTTP 200 (`image/jpeg`, 19,828 bytes). This verifies the storage integration,
not a signed-in merchant browser journey; the latter still needs a real session.
Backend integration validation passed 814 files / 12,770 tests (five skipped).
Test workers explicitly clear application service credentials so local development
credentials cannot make mocked suites contact production.

The illustrated-category browser acceptance also passes with the real imported
files: every chip image loads and its Oxy URL contains a file ID returned by the
feed. A separate failure case aborts the actual imported category file and retains
the fallback and navigation. The old same-web-origin assertion described bundled
fixtures and was replaced with the catalog's Oxy ownership boundary.

## Configuration controls and official Bloom adoption — 2026-10-10

All three apps now pin official Bloom 7.26.0 and Services 11.1.12, with one
physical Bloom copy shared by the apps and Services. Services retains its
11.1.11 implementation; this maintenance release updates its tested Bloom peer
range. Named configurations and catalog axes use the published radio-chip API,
without application keyboard handlers or hidden radio indicators.

Four browser cases cover keyboard selection at 1440px/en and 390px/ar, including
disabled values, Home/End, clearing a named configuration, one tab stop, stable
history and mounted gallery. Seven existing selection/failure cases also pass.
All app/UI typechecks and 148 storefront unit tests pass. Full Shop parity,
successful author-owned review-media acceptance and import of description HTML
images remain outstanding; these control checks do not prove those workflows.

## GoWay buyer address selection — 2026-10-10

Saved addresses and inline guest/signed-in checkout now share an official-SDK
address picker (`geocode.forward`, installed published SDK 0.3.0). It presents
explicit results, copies structured postal fields, opens review for missing
facts, and retains a manual recovery path. Recipient, apartment, phone and email
are separate; no residential Place is created. Searches have debounce,
cancellation and term/locale identity, stay out of persistent query state, and
never change checkout validation or immutable order snapshots.

Five browser cases passed: desktop/en and mobile/ar selection, superseded/error/
partial responses, actual GoWay HTTP/CORS from localhost, and saved-address form
submission. Cart/auth/address-write fixtures in the form cases are isolated
transport fixtures, not evidence of a real account write. The live geocoding case
does not intercept GoWay. All 151 frontend unit tests, frontend types/lint (five
existing warnings), i18n/RTL/route gates passed. Apps remain on 8160/8161 with the
local backend on 4160. No SDK patch was needed for address lookup.

## GoWay Wholesale business locations — 2026-10-10

The location editor uses the official GoWay SDK's search and structured geocoder.
Changing postal fields invalidates the selected position; selecting a fresh
result is required before creating the public business place. Provider-omitted
postal fields can retain the merchant's reviewed structured input. Search and
lookup requests are cancellable, late results cannot select a position, and
failed creation preserves the draft. Pending creation disables draft changes.
Selecting or creating a place does not publish a Mercaria location or establish
a business claim; ADR 0013's claimed-business backlink remains authoritative.
The public-business CTA is explicit. Private buyer addresses use the separate
transient geocoder flow above, never public place creation.

Validation: 35 dashboard GoWay unit tests, dashboard types/lint (two existing
channel warnings), and two isolated browser scenarios at 1440px English and
390px Arabic passed. Those scenarios exercise SDK transport failures/retries,
late lookup results, keyboard selection, pending controls and zero Mercaria
publication writes. They also caught and fixed a mobile overflow in pickup
identity options by using Bloom RadioGroup. Global i18n 66, RTL 12 and route
checks passed. A separate real read-only SDK structured lookup for Passeig de
Gràcia 43, Barcelona returned two candidates from photon/goway; no real public
place, claim or publication was created. Authenticated merchant writes remain
unverified live. The installed headless SDK does not provide a map renderer;
this editor does not invent one.

## Description image imports — 2026-10-10

Pull connectors, push channels and canonical source observations now import
description image bytes through the same durable Oxy importer as galleries.
`parse5` handles the HTML tree and decoded attributes; standard HTML `src` values
use the SDK's public URL, while file-ID columns remain IDs. External responsive
candidates are removed after importing their fallback. Unsupported source-only
markup is refused, not silently dropped. Direct catalog writers reject
unprepared external description images and never import inside transactions.
The storefront's existing sanitized renderer remains the rendering boundary.

Canonical observations retain the supplier's original HTML as provenance and
enforce media rights before IO. Pinned descriptions and merchant overrides cause
no image fetch. Import failures cannot replace existing facts or restore archived
products. Local read-only inspection found zero descriptions requiring import in
12 listings and 4,918 canonical products; no historical or production catalog
backfill was performed.

Validation: the full backend suite passed 815 files / 12,782 tests (five skipped),
then the final description/canonical suites passed 52 tests, including added
pin and description-only rights cases. Backend types pass; lint has zero errors
and ten warnings in unchanged files. A real importer call downloaded supplier
bytes, uploaded through the authorized Oxy account and fetched the resulting
public JPEG successfully (HTTP 200, 19,828 bytes). Two desktop/mobile browser
cases load actual Oxy description images with positive natural dimensions and
no supplier requests. Only description metadata is varied in those browser
cases; image requests and bytes are not intercepted. This closes the description
import prerequisite above, not the still-open full Shop parity or real
author-owned review-media acceptance.

## Wholesale variant headings — 2026-10-10

Long variant option titles no longer force a horizontal overflow in the product
editor. On mobile the price follows the wrapping title; desktop retains a
flexible row. Before the correction an ordinary 83-character title widened a
390px viewport to 737px and shifted the Arabic page beyond its left edge.
`variant-layout.spec.ts` now passes at 390px English/Arabic and 1440px English,
including an unbroken option value, full title retention, visible price and zero
writes. Dashboard types and RTL checks pass. This is independent of the archive
dialog's pending upstream Bloom keyboard fix.

## Public store contact sheet — 2026-10-10

Listing More actions now exposes contact for stores with published locations.
The Bloom marketplace sheet reads public Mercaria locations and official GoWay
SDK place facts, refreshed on each opening. It checks the current active place's
trusted location backlink before displaying phone, email, website or address;
a revoked link hides them and an outage offers retry. Person-to-person listings
and stores without published locations do not gain invented contacts. Clipboard
success/failure is visible; cancellation reaches both public read transports.
Private store-admin/Oxy profile data is never a source.

Validation: frontend/UI types, 153 frontend unit tests, frontend lint (zero
errors/five existing warnings), i18n, RTL and route gates pass. Two browser
scenarios pass at desktop English/mobile Arabic with actual clipboard reads,
keyboard focus restoration, an outage/retry and a revoked backlink. Only public
location/GoWay metadata is varied; listing data and image delivery remain real.
This does not prove a live merchant's authenticated GoWay contact publication.

The extra bidi guard exposed a stale test assumption: ICU 78.3 resolves bare
`ar` to Latin digits. The formatter already follows Intl correctly. The guard
now covers exact Arabic-Indic output for `ar-EG` and `ar-u-nu-arab`, exact Latin
output for `ar-u-nu-latn`, and the runtime's CLDR default for bare `ar`, retaining
isolation assertions. No production formatter behavior was changed.

## Store collection image identity — 2026-10-10

Store collection chips, grid tiles and menu rows now resolve `imageFileId`
through the shared Bloom/Oxy resolver. An invalid present ID cannot fall back to
`imageUrl`; older URL-only DTOs are accepted only when the current resolver
produces that exact Oxy URL. External URLs never become image requests.
Collection create/update request schemas and the service boundary reject URL
values in `imageFileId`, including direct service calls. The DTO documentation
now describes an opaque ID rather than permitting absolute URLs.

Validation: 18 service tests and six request-schema tests, frontend/backend
checks of types and lint (zero errors; existing warnings), plus two real-image
browser cases at 390/1440px pass. Browser tests vary only collection metadata;
the synchronized file ID and delivered image bytes come from the real local
catalog. Local read-only census found two collections, neither carrying an
image; no historical data or production database was rewritten.

The same public-contact sheet is also reachable from the store menu. Desktop
English and mobile Arabic browser scenarios now check the nested Bloom sheet:
Escape closes contact and returns focus to its menu row; a second Escape closes
the store menu. Both pass, along with frontend types and lint. No second contact
store or private profile lookup was introduced.

## Product return-policy sheet — 2026-10-10

The listing's published merchant policy now opens from Shop's 40px tertiary
action in an opaque Bloom marketplace sheet instead of printing HTML inside an
accordion. Existing safe rich-text rendering preserves headings, paragraphs,
lists and links; plain policies remain selectable. Commercial-mode authority is
unchanged: only the selected connected-store offer supplies this policy.

Validation: two browser cases at 390/1440px check final sheet geometry, opaque
paint, authored formatting, script exclusion, keyboard open/close and focus,
and omission for person/retail offers. The existing policy/share journey also
passes. Frontend/UI types, frontend lint, 153 frontend unit tests and i18n/RTL/
route gates pass. Policy metadata alone is varied; catalog images remain actual
Oxy delivery. Separate nested-contact focus validation is being investigated;
this policy validation does not establish full Shop parity.

## Official Bloom 7.26.1 and Wholesale archive — 2026-10-10

All three apps now pin published Bloom 7.26.1 with Services 11.1.12. The public
npm tarball SHA1 is `0de148e516354069b467b51cc743ded94311cecf`; installation
uses the registry and yields one physical Bloom copy. Bloom PR305 fixes empty
focus traps and focusable chat fallback panels. No dependency files were patched.

Wholesale archive is committed in `187250f1`: cancel/error preserve drafts,
pending edits and archive exclude each other, and failures remain retryable.
With official Bloom, dashboard types, 13 hook tests and both desktop/mobile
archive browser scenarios pass, including focus retention while all actions are
disabled. Browser archive transport is isolated; no real product was archived.
All other app/UI typechecks and 153 frontend unit tests also pass.

The expanded storefront run passes descriptions/policy cases and Arabic mobile
contact, but desktop nested contact failed to return focus to its parent menu
row once. The Bloom agent is isolating the focus lifecycle before classifying a
regression or publishing another fix. Preserve that assertion and do not treat
the dependency update as complete acceptance of all dialogs.

## Remaining Mercaria worktree integration — 2026-10-10

`edb4cc5a` merges the remaining `chore/remove-mongo-mentions` branch, including
`020ba163` and its prior `7efb37e0` ancestry. The branch was clean and merged
without conflicts. Its runtime TypeScript is unchanged after comment removal;
the four semantic deltas are test descriptions and the census of deleted legacy
guards. The related 72 tests, AGENTS budget and 287 bidi assertions pass.

Every current local branch/worktree commit (including the detached SDK release
worktree) is now an ancestor of main. The SDK tarball and publisher-census
`.integration-evidence/` remain in their original worktrees as untracked build/
verification artifacts; neither was deleted or added to application source.
This is local integration, not a production deployment.

## Wholesale concurrent drafts and refund reads — 2026-10-10

`13716799` fixes three distinct state bugs. Place contact edits use GoWay SDK
0.3.0's merge-patch contract: only edited fields are sent, and an explicit empty
field sends `null`. The acknowledged response updates the query cache before
clearing only the submitted edits; newer in-flight edits remain. Publication
forms retain stable location identity across the first persisted ID, combine
untouched values with the current DTO, retain later edits and remain mounted
through recoverable refetch errors. Permission/not-found failures still hide
protected cached data.

Order refund history now distinguishes failed reads from confirmed empty data,
shows a retry, retains cached history only for recoverable errors, and keeps a
confirmed empty card hidden during background refresh. Four browser cases pass
at desktop English/light and mobile Arabic/dark, along with 44 form/cache tests,
dashboard and E2E types, lint (two existing warnings) and i18n/RTL/routes. Their
API writes are isolated fixtures, not real GoWay or commercial mutations. The
refund fixture is a typed physical order with a valid immutable destination;
absence of an address was an incomplete fixture, not evidence of a production
address bug under the database's digital-order invariant.

## Bloom rapid-close focus correction adopted — 2026-10-10

All three apps now pin official Bloom 7.26.2 with Services 11.1.12 and resolve
one physical Bloom copy. The public npm tarball's SHA1 is
`ff14bb164c90e3f8c6238e6d20bdd07d8b7c9238`; published main/tag is
`51d1982819427c3ece3dc1da0e42834a9298a21d`. PR307 closes the entry-RAF focus race
with an already-closing child; PR306's touch-scrolling correction is included.
The combined upstream tree passed 109 tests, 19 focus scenarios and nine swipe
checks before publication. Local Metros were restarted after the Bun install.

Mercaria acceptance: all three app/UI types, 155 frontend tests, two nested
store-contact browser cases (desktop English/mobile Arabic), and four Wholesale
Archive/GoWay-address browser cases pass. The nested contact cases retain both
focus assertions and use actual catalog images. These results establish this
upgrade's acceptance, not full Shop parity or native-device acceptance.

Further store-menu review found that its custom `vars(storeThemeVars(...))`
wrapper is still separate from Bloom's current scope APIs; the page applies it
to a plain View. Bloom documents that react-native-css v3 can drop those native
variables. This needs a measured native/theming audit, not an unverified CSS
workaround. Store policies also still print their authored body as plain Text.
These are further parity work, separate from the validated listing-policy sheet.

## Store-menu page motion — 2026-10-10

`StoreMenuTransition` now reproduces the public merchant bundle's incoming
push/pop movement (40% of page width, 300ms, `.32,.72,0,1`) and initial 150ms
fade through Reanimated. Progress is bounded and RTL mirrors its direction.
Bloom's `useDialogFrame` declares the navigation changes and morphs mobile
sheet height; the mounted Dialog retains its focus ownership. Four browser
cases pass at desktop English/mobile Arabic with motion enabled/disabled,
including actual intermediate page positions and mobile height interpolation,
final geometry, overflow and Escape focus. No image interception. Frontend
types/lint and i18n/RTL/route guards pass. Native device acceptance is outstanding.

## Product category recommendations — 2026-10-10

The listing page now includes the missing “You might also like” wrapping grid
below its same-store carousel. This is category discovery, not a personalized
ranking claim: it uses the existing `/discovery/signal` `new` ordering and its
server-owned ProductSummary projection, filters the current listing, and keeps
real prices/ratings/Oxy file IDs. Empty/missing categories omit the section.
Pagination retains mounted cards through a failed next-page read and offers
retry; it never substitutes global products for a failed category lookup.

FeedGrid gained an opt-in container-measured column layout: mobile two columns
and 16px gaps; desktop auto-fit 220px minimum columns and 32px gaps, measured
from Shop's public product markup. Existing callers retain their class layout.
All 12 storefront locales have the heading. Two live browser cases verify
real image bytes, links, category changes and layout; two isolated read-failure
cases split the real category DTO into pages and prove retry/card retention.
A fifth browser case fills rows with real root-discovery DTOs under isolated
category membership and verifies resizing at 390/768/1024/1440/1920px.
No image request is intercepted. The initial desktop failure was an invalid
Button appearance in the new component, corrected to Bloom's public outline
appearance before final types and rerun. Current native acceptance is unproven.

## Merchant reading surfaces and Wholesale recovery — 2026-10-10

MarketplaceSheet now takes its surface from Bloom's resolved background (using
its public `withAlpha` for the translucent web recipe). The close control and
rich-text links/tables read canonical tokens, so a local palette can reach them
without inheriting a root-resolved alias. The shared typography registers the
missing Shop `heroNormal` (36/42, 600) and `bodyLarge` (16/22, 400) tokens in both
CSS, the legacy preset and class merging. Eleven description/return-policy/
contact browser cases, 155 frontend unit tests and UI types pass. Return-policy
acceptance still requires an opaque surface, now compared with the actual Bloom
recipe rather than assuming every light theme is white.

Wholesale recovery is committed separately as c6ef5297. Its inner error boundary
uses the active Bloom context/Button; the outer recovery uses the public
`buildTheme` with Wholesale's orange recipe and the system mode, without requiring
a healthy provider. Four isolated real-component browser tests cover both modes
and keyboard retry; dashboard types/lint and direct i18n/RTL/routes pass.

Exact merchant scope adoption is NOT complete. Bloom PR308 is green and queued
for merge; no candidate dependency was installed. Working-tree store-policy HTML
rendering has passed content/motion checks, but two new opposite-mode theme
checks deliberately still reproduce the old manual scope defect. The prepared
`/tmp/mercaria-official-color-scope.patch` replaces that manual scope with the
public 7.27 API after official Bloom and compatible Services publication. Do not
call those color checks passing or the native-device acceptance complete.

## Policy media write boundary — 2026-10-10

Both `updateStore` and `updateStoreSettings` synchronize images in supplied
policy bodies through the existing store-owned description importer before the
single column update. An import failure prevents all requested settings/profile
writes; omitted fields remain untouched, plain copy is preserved and an empty
string still clears a policy. Existing policy rows are not backfilled or mutated
on reads. No new image transport or browser supplier fallback was introduced.

Forty service/HTML-import tests and 37 storage-port/real-Postgres repository tests
pass, with backend types and lint. The new service tests use the real HTML parser
and replace the byte-storage port; they do not establish a new live upload run.

## Native appearance dependency — 2026-10-10

Added Expo SDK 56's `expo-system-ui` 56.0.5 to all three apps. Each declares
automatic appearance, which Android otherwise ignores. Official prebuild now
emits `expo_system_ui_user_interface_style=automatic` without the missing-module
warning; all three app typechecks pass. Local native build directories stay
ignored. A connected Pixel 8a loaded the JavaScript bundle in Expo Go, but its
unsupported native notifications stopped startup. A real development build is
being prepared; that failed Expo Go launch is not native UI acceptance.

## Native lazy imports — 2026-10-10

The real development build reproduced Expo 56.0.11's upstream lazy-import
failure (`Requiring unknown module`), including after a fresh Metro graph.
Updated the shared Expo pin and all app manifests to SDK 56 patch 56.0.23;
the official runtime includes expo/expo#46870's native load-before-import fix.
Native entry files now use the public `expo-router/entry`. No runtime patch,
disabled lazy loading or error suppression was introduced. All app/UI types,
155 storefront units and nine browser selection/return-policy cases pass.
The rebuilt APK starts on the Pixel 8a without that red screen. Its first home
inspection still shows missing imagery and excessive vertical spacing; native
visual acceptance remains open. Do not treat successful startup as full parity.

Wholesale accessibility was corrected separately in 6a3821a0: drafts contain
only explicit flags, retain edits made while a save is pending, and reconcile
with the authoritative GoWay reread after DELETE204. Forty-four unit tests and
two isolated browser cases pass; no live writes were made in those checks.

## Official merchant color scope — 2026-10-10

Adopted registry Bloom 7.27.0 (cb6fece83594380464151201872a7ed2d86c53e8)
and compatible Services 11.1.13 (5271367057682732f542c25572d93bdea0659426)
in all apps. All resolve one physical Bloom installation. Store pages now use
public `BloomColorScope` tokens/mode; removed Mercaria's duplicate token aliases,
parser and portal scope plumbing. Authored policy HTML renders with the shared
safe rich-text tree. Eight contact/policy/motion browser cases pass, including
opposite app/store modes, nested contact colors, global-theme preservation and
RTL/reduced motion. The initial two final assertions captured the global theme
before app hydration; the test now waits for the visible menu and resolved app
theme before comparing it across the interaction. All app/UI types pass.

## Native media and routed surfaces — 2026-10-10

The Pixel's blank images were a styling boundary error: raw Expo Image does not
resolve NativeWind className into its native style. All three apps and shared
components now consume one shared `Image = styled(ExpoImage, {className: 'style'})`
adapter. Category chips/mosaics and a product photo/logo are visibly loaded on
the physical Pixel from actual Oxy files; neither media responses nor file IDs
were substituted. Seven hero/contact/policy browser cases, all app/UI types,
frontend lint and i18n/RTL/routes pass. Native nested stacks now have transparent
scene backgrounds so Bloom's AppShell paints the surface; this fixes dark-mode text
tokens appearing on React Navigation's default light background. The Pixel
product screen confirms the dark Bloom surface and readable foreground.

Native typography is still incorrect in installed react-native-css 3.0.7:
its compiler/runtime multiplies a 20px line height by font size18 to produce360.
This was reproduced from the actual compiler and native hierarchy. Upstream's
official NativeWind5.0.0-rc.0/react-native-css3.1.0-rc.0 pair fixes it, but Bloom
and Services must adopt compatible declarations and pass their checks before
Mercaria upgrades. That work is in progress; no local runtime patch was applied.

Wholesale hours need an upstream contract fix before changing the editor:
published GoWay SDK0.3.0 updates the entire `openingHours.intervals` collection
without a revision condition. A client GET followed by PATCH can still overwrite
another day's concurrent change. The merchant agent is inspecting current GoWay
remote main in an isolated worktree for an atomic day-level patch and SDK support.
It must preserve opening-day ownership of overnight/24-hour intervals and reject
partial edits of unknown raw schedules. No production rollout or client use of
an unavailable endpoint has been authorized by this implementation step.

## Review rail, theme authority and upstream release state — 2026-10-10

853e1ce5 fixes the review viewer's horizontal thumbnail offsets in RTL. The
new actual-browser regression passed in English and failed in Arabic before
the fix; afterwards all five review-media cases pass, including resize and
return to the first attachment. Missing-file fixtures exercise navigation only,
never successful media delivery. Shared UI types and RTL gates pass.
489b56fd removes duplicate NativeWind mode resolution from `useColorScheme`;
Bloom's `theme.mode`/`theme.isDark` now accompany its own color values. Ten browser
review/policy/theme checks pass, including opposite merchant/app scopes.

Bloom 7.28.0 is now published from OxyHQ/Bloom#309, with the official NativeWind
5.0.0-rc.0 / react-native-css 3.1.0-rc.0 pair. Public tarball SHA1 is
870befb9be7c22b5e18ed408f541c1146da36eb4. Compatible Services 11.1.14 is publicly verified too (SHA1
8c705291be418c8a79617cc3c55f3e12ce366e1d). It passed 1040 tests on both SDK56 and
SDK57. Commit e5244298 installs Bloom7.28.0/Services11.1.14 with the official RC
pair in all three apps. Four client typechecks, doctor and nine theme/typography
checks pass. Metro was restarted. Autolinking differs only in the Services JS
package version, so the existing Pixel development build remains usable.

The RC fixes alpha-color compilation but DOES NOT fix Tailwind's pixel-valued
`var(--tw-leading, 20px)` fallback. A real runtime probe still produced360px.
Commit d5b2a25c adopts Bloom's standard unitless line-height convention in both
Mercaria token definitions: 20/18 means20px at18px font size, consistently on
web/native and under font scaling. Three browser cases measure all20 roles.
After clearing Metro, the physical Pixel8a's Recently viewed text frame shrank
from945px to58px including native font padding. Evidence:
`/tmp/mercaria-native-relative-typography-{loaded.png,fresh.xml}`. The price-pill
background remains broken even AFTER RC adoption: the direct compiler tests
pass, but the actual Metro serialization boundary does not. See the native alpha
follow-up below; those compiler checks are not native rendering acceptance.

Commit c07201f0 keeps common product detail photos when selecting a variant,
excludes photos explicitly assigned to other configurations, and prepends the
selected photos. Nine unit checks and two browser cases pass; the gallery stays
mounted and opaque throughout the change at390px/1440px. Video DTOs landed as
3e00470e, but backend/video editor/player integration is still in progress in
`/tmp/mercaria-catalog-video-media`. Videos are not yet a completed feature.

GoWay's atomic weekday update is ready in OxyHQ/GoWay#110 (bcddf0c), with all
remote CI checks green, 943 backend tests and 192 SDK tests passing. It extends
the existing authenticated PATCH with `openingHoursDays`, preserves omitted
days under the existing row lock, rejects partial edits to unknown schedules,
and checks the resulting weekly interval limit. Current GoWay treats every
empty week as unknown; the change preserves that contract rather than claiming
an all-week closure. The isolated worktree is `/tmp/goway-atomic-weekday-hours`.
An asynchronous user approval question is pending: merging this PR automatically
deploys the shared production API through GoWay's `.github/workflows/ci.yml`.
Do not merge/deploy until answered. After rollout, publish the SDK and update
all Mercaria pins together before using the new field. GoWay main's SDK0.4 has
taxonomy changes, but the audit found no removed exports in Mercaria's consumers;
recheck visit-us capability labels because 0.4 translates all twelve locales.


## Native alpha serialization and web image boundary — 2026-10-10

Commit 04a77bfa gives the shared image adapter a web entry that forwards Expo
Image directly. Adapting web className into style mixed RN Web compiled markers
with absolute-fill values, producing styleq errors and a zero-sized merchant
cover. The browser regression verifies the real 330×397 cover and no such errors.
Metro needed a restart to pick the new platform entry. Commit c0b3bc12 enables
Bloom AppShell safeArea on native; the physical Pixel home now clears the status
bar. The nested settings header does not apply safeArea twice.

Native price backgrounds are still unresolved. The actual Android bundle
`/tmp/mercaria-728-native.bundle` has the current RC runtime, but JSON serializes
omitted color-mix weights as null. Runtime then rejects that descriptor and
removes backgroundColor. A temporary native style probe confirmed the missing
property with valid theme variables; it was removed from ProductCard after the
diagnosis. JSON-roundtrip native renderer probes reproduce all four failures.
`bun scripts/probes/native-alpha-serialization.mjs` is a standalone diagnostic
that currently exits1 for all twelve app/color pairs, using the actual Metro
inlineVariables:false setting. It does not alter dependencies or hide the error.
Official fix remains open at https://github.com/nativewind/react-native-css/pull/464
and the matching issue is https://github.com/nativewind/nativewind/issues/1870.
No later official release was available when checked. Do not mark native alpha
fixed based on in-memory compilation, or replace it with a local dependency patch.

Bloom7.29/Services11.1.15 is being released separately for the public gallery
onOpenChange lifecycle contract (OxyHQ/Bloom#310). This does not fix NativeWind
serialization. Catalog video integration remains incomplete until backend/editor
changes and the storefront player lifecycle are integrated and verified.

Wholesale/catalog-media review also found that Oxy GET/assets/:id omits its
existing visibility field. Draft OxyHQ/oxy#1625 adds the real persisted value,
with seven route tests and API build passing. It has not been merged/deployed.
Mercaria continues to require active, public, owner-authorized media; do not
assume public visibility when absent. Successful live merchant/review uploads
remain unverified until that upstream contract is deployed and exercised.


## Mixed catalog/editor integrated, storefront playback work — 2026-10-10

Backend417a131f and Wholesale0d0c798e are on main. Migration0167 was applied ONLY
to local mercaria_dev_canonical_20261010 through src/db/migrate.ts after dry-run
confirmed exactly one pending migration. CATALOG_VIDEO_WRITES_ENABLED remains
off. The merchant worktree is clean and preserved at /tmp/mercaria-catalog-video-media.
Its full suite had817 passing files and only two migration marker gates failing
before correction; both gates plus canonical-only video/condition concurrency
now pass in149 targeted tests. Seven merchant browser cases pass. A separate
404/retry/close probe on integrated8161 records no pageerror and no retained video.

Bloom7.29/Services11.1.15 official tarballs are installed by bde419f8. SHA1s:
276458e2ba5eec9dde54b3c8759696884ba95acc and
6795b8297e9d01479398c68cb769d45d6df125e2. All four clients typechecked before
the final gallery loading-state change; UI/frontend types pass again afterwards.
Doctor passes with the existing core/contracts October18 upgrade warnings.
Metro storefront8160 and Wholesale8161 were restarted for these packages.

Storefront mixed gallery now uses app-owned Expo players and Bloom surfaces.
Nine selection/missing-video browser cases pass; three video cases pass after
729 adoption, including inline detach/reattach through fullscreen close. These
are negative transport/lifecycle acceptance, NOT successful playback. Constructor
sessions avoid Expo web replaceAsync's unconditional play/unhandled rejection;
retries replace only the failed session and retain the active gallery slot.
A follow-up Bloom7.30 public renderVideoOverlay slot is in development by the
Bloom agent to show errors that occur while fullscreen is already open. Do not
claim that case or real playback complete yet. Native alpha remains independently
blocked on react-native-css upstream464, with no local dependency patch.

OxyPR1625 now has all remote CI green. A NEW asynchronous approval question asks
whether to merge/deploy it; API changes trigger production deploy via Oxy's
.github/workflows/deploy-aws.yml. No answer yet. This is separate from the still
pending GoWayPR110 approval; do not deploy either on elapsed time alone.

## Native Lucide token delivery — 2026-10-10

Shared Icon now uses NativeWind's public nativeStyleMapping to deliver resolved
text color to Lucide's color prop (and currentColor fills); explicit colors do
not acquire a competing default foreground class. Direct Lucide className uses
in storefront, shared marketplace and Wholesale collection mapping now use it,
including dynamic notification/feedback glyphs. ProductGallery's expand button
uses Bloom's public renderLeadingIcon size/color contract.

All four client typechecks pass. Eight existing policy/theme browser checks
pass; the theme compiler checks still do NOT establish native serialized alpha
acceptance (see upstream464 above). Separate actual-page light/dark probes show
product-menu/report SVG strokes match their theme text. Pixel8a screenshots
/tmp/mercaria-native-icon-after.png and /tmp/mercaria-native-icon-menu.png confirm
the previously black ellipsis and destructive report glyph now have theme color.
Wholesale's existing toBloomIcon adapters were independently checked against
Bloom's documented contract and in both browser themes; no replacement needed.

## Bloom7.30 adoption waiting for public registry — 2026-10-10 13:26UTC

Icon correction4507df39 is complete and running on both local Metros. BloomPR311
merged as d7d4f5e7bda631ff8d7eeec917c2edcbda7c7621; the agent reports bun publish
exit0 at13:19:32UTC, expected SHA1 b5c9c5f9d6a30629ce02d459f49523011bf3ce3c
(30,859,430bytes). At13:26:07, independent public version and packument reads
still omit730/return404, including no-cache/fresh-query reads. Installed packages
remain729/Services1115; do not use a local tarball or republish to bypass this.
Bloom agent watchers37973/8287 own publication and verification; Services1116
waits for public730 (forward-port1626 merged19c0308f). No production approval
has arrived for Oxy1625 or GoWay110.

Two new browser cases in scripts/e2e/storefront/product-video.spec.ts are an
UNCOMMITTED regression test for the pending overlay integration. Both fail on729
at the expected missing fullscreen alert, at390/1440px:
/tmp/mercaria-open-video-before.log. Preserve this work and complete it after
verified official730/1116 adoption: pass renderVideoStatus through Bloom's new
renderVideoOverlay, render inline status only for the active non-fullscreen
surface, rerun the five video cases. Retry intentionally disposes the viewer
snapshot and returns to the same inline slot; Bloom has no public replacement
API for an already-open snapshot. Do not add timed reopening or mutate internals.
Then update docs/catalog-media.md and all app/UI pins, validate types and doctor,
restart Metros and commit the tested implementation with these cases.

## Official Bloom7.30 adopted and fullscreen errors fixed — 2026-10-10

Supersedes the registry-wait section above: public Bloom7.30.0 and
Services11.1.16 tarballs independently downloaded and SHA1-verified before normal
bun install. Bloom b5c9c5f9d6a30629ce02d459f49523011bf3ce3c;
Services f9c9246b7679613a68907297fb058a2184792899. All three apps pin these
versions; UI's peer floor is7.30. The public renderVideoOverlay slot now receives
app-owned status/retry controls, with inline status only for the active surface.
Both previously red fullscreen-failure cases pass; retry replaces the failed
session and returns to its inline slot. Five video plus seven selection browser
cases pass (/tmp/mercaria-bloom730-browser.log); all four client typechecks pass
(/tmp/mercaria-bloom730-types.log). Doctor passes with existing Core/Contracts
upgrade warnings only. Real authenticated upload and successful playback remain
unverified; Oxy1625 and GoWay110 production approvals are still unanswered.

Metro restart exposed an ENOENT race when Playwright removes its previous output
directories during Metro's crawl. da0dd878 excludes only this checkout's generated
test-results/playwright-report and nested .worktrees in all three Metro configs.
Both apps stayed running through the passing browser suite (8160/8161).

## Native variant grid height isolated — 2026-10-10

Pixel8a's twelve shade pills occupy three40dp rows separated by8dp, but their
container measures568dp instead of136dp, leaving432dp blank before Quantity.
An actual-device control gives136dp with plain RN Pressable; adding Bloom's
same inner content View produces568dp, as do Bloom style/className controls.
Temporary measurement components were restored from a pristine backup: none
are in the app. Logs /tmp/mercaria-native-variant-intrinsic-proof.log and native
screens /tmp/mercaria-product-buy.png document the original issue.

Bloom agent reproduced this with RN0.85.3's exact Yoga plus YGErrataAll (RN's
compatibility mode); the default engine mode alone did not reproduce it. Work is
in a separate Bloom branch: preserve content/loading identity and explicit-width
justification while removing intrinsic growth inflation. Do not patch installed
packages, change Mercaria spacing to conceal the error, or claim it fixed before
an official release and another physical-device check. Native serialized alpha
remains independently unresolved upstream (react-native-css PR464).

## Merchant scroll ownership and Wholesale exceptions — 2026-10-10

Wholesale fbccdc2c fixes dated-hours request races with the current GoWay SDK:
fields are disabled during POST, errors retain the draft, deleting cannot issue
duplicate pending requests, GET errors offer Retry and drafts belong to placeId.
Types/lint,26 pure tests and2 browser scenarios (1440EN/390AR) pass. No deployment
or live service write; the separate atomic weekly-hours rollout stays pending.

Pixel8a exposed invisible merchant review pages after menu→reviews. The header
and expanded panel remained visible, but UIAutomator reported only5 text nodes;
no review content appeared. Temporary probes showed incoming progress=1 and a
fully measured4287dp page. Fade-only and slide-only controls rendered; the full
transition plus an inner ScrollView detached its content. All probes are restored.
The actual correction removes the three nested ScrollViews (menu/reviews/policy):
Bloom Dialog already owns scrolling and natural-height measurement. Page Views
preserve all spacing and full fade/translation. No clipping override, animation
delay or dependency patch remains. Pixel now exposes44 text nodes including the
first review, and eight upward swipes reach Page1of2/Next. Screenshot before:
/tmp/mercaria-native730-store-reviews.png; after:
/tmp/mercaria-native-store-reviews-scroll-owner.png. Six browser motion/policy
cases pass and frontend types pass. The toolbar currently still scrolls with the
body on native; moving it to Bloom Dialog's official header.left/right slots is
remaining work (avoid claiming pinned-header acceptance).

Bloom Button release continuation: PR312
https://github.com/OxyHQ/Bloom/pull/312 headc4cb4d692ee384ad9212b77a7edaf49a16c80e08
is in CI38057179679 (build+nine shards, no failure reported). Local17 Yoga cases
pass on RN0.83.2 and0.85.3,225 other tests and16 Chromium cases pass, source and
consumer types/build/package/freshness pass. Agent-owned publisher73259 waits for
merge/rebuild; watcher87953 waits for official7.30.1 metadata/tgz verification.
Services11.1.16 already admits the patch. Do not adopt unpublished bits or start
another publisher. After public verification, pin all3apps and UIpeer floor, bun
install, repeat affected checks and Pixel grid136dp acceptance. Main is local
118commits ahead of origin at8df62ecb; do not treat that as a production rollout.

## Native merchant header and card typography — 2026-10-10

273e60de completes the previously pending merchant header: public Bloom Dialog
header.left/right own the memoized Back/Close and Share/Follow controls. Pixel8a
Back bounds [42,132][158,247] and Share [923,132][1038,247] remain unchanged after
eight review-list swipes to pagination; Back returns to the menu. Eight browser
motion/policy/sticky-header cases pass, frontend types pass, lint has no errors.
Native RTL/reduced-motion timing is still unverified. Screenshot:
/tmp/mercaria-native-store-sticky-end.png.

06aa9601 fixes the i18n guard's bundle ownership lookup for t('ui.*'): shared keys
are checked against the shared bundle instead of each app. No alias workaround
or duplicated strings. Full guard and all68 mutation cases pass.

f392a61d removes inherited leading-[16px] from ProductCard's wrapping Pressable;
each child already owns text-xs typography. Pixel title bounds shrink from504px
to48px. Direct leading-[40px] on Explore's heading correctly measures105physical
pixels (40dp), so there is no indiscriminate replacement of direct text classes.
UI typecheck and two real-catalog keyboard/new-tab browser cases pass. Evidence:
/tmp/mercaria-native-card-leading-{before,after}.png and
/tmp/mercaria-card-{before,after}.xml. No fixed-height or clipping workaround.

Bloom PR312 head d38d9a8e12ee782e4ae3bb0a04055774e43b21d6 passed head CI after
regenerating its adoption matrix. Merge-group38057973742 is still running; agent
owns publisher37872 and public watcher87953. Installed Bloom remains official
7.30.0 until7.30.1 is published and independently verified. Native alpha remains
separately blocked on upstream react-native-css PR464 (still open).

Wholesale f3b0caa0 distinguishes pending/failed/empty GoWay claim reads. A failed
read offers SDK refetch, preserves cached claim data, and does not expose the
claim-creation form; only a confirmed successful eligible state does. Dashboard
types/lint and two browser cases (1440EN/390AR) pass, without real GoWay writes or
deployment. Logs /tmp/mercaria-merchant-claims-{types,lint,browser}.log.

68c268b2 fixes native locale persistence: the provisional device locale could
write the opposite next-launch direction, then hydration skipped restoring the
saved locale because the RUNNING process's isRTL already matched. Always persist
forceRTL; only the restart-required result compares the running constant. Three
new boundary cases fail before/four pass after, direction guard/frontend types
pass and lint has0errors/5existingwarnings. Pixel Arabic picker + repeated cold
launches now leave forceRTL=true and mirror merchant and bottom navigation.
English was restored through the real picker afterward (forceRTL=false).

dc0d60b4 adopts PUBLIC Bloom7.30.1 in all3apps/UIpeer; Services11.1.16 unchanged.
Metadata/tarball independently verified SHA1
3e76f0787baeb604acc6f596e1f0afdaf752ee42,30861406bytes. Four client typechecks,
Oxy Doctor (existing Core/Contracts upgrade warnings only) and13browser cases
(selection + merchant motion/stickyheader, EN/AR) pass. Local Metro PIDs now
1845054 storefront8160 (session93826),1845043 dashboard8161 (session94139).

Cold-start Arabic revealed merchant review body still invisible while header
works. /tmp/mercaria-rtl-reviews.png and /tmp/mercaria-7301-rtl-reviews.xml expose
no body text. Temporary logs report incoming progress1,rtltrue,width411.43,
height4286.86,x0,y0. Removing page overflow:hidden appeared to help after Fast
Refresh (25visibletextnodes), but FAILED cold-start acceptance, so that change
and all transition probes were restored. Do NOT claim it fixed. Bloom agent
investigates read-only; suggested next control is Dialog morph={false} (not
useDialogFrame morph:false, which keeps its fade). No dependency patch is allowed.

Official7.30.1 Pixel acceptance: temporary onLayout on the unmodified swatch grid
reports Shade height136,width379.4286,y26.2857 (before568dp). Probe was restored
from /tmp/mercaria-variant-before-7301-measure.tsx. Evidence line BLOOM_7301_GRID
in /tmp/mercaria-metro.log and /tmp/mercaria-7301-product.png. No sizing override.
