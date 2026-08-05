# Mercaria

Mercaria is Oxy's buy/sell marketplace: users buy and sell new items (from shops)
and secondhand items (from people), eBay or Wallapop style. The backend is a
Shopify-grade commerce platform serving three Expo apps (storefront, dashboard,
POS) and a shared UI package.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Mercaria specifically. Versions are in `package.json`, never here.

See `HANDOFF.md` for deferred work (infra, Oxy client registration, the domain).

## Monorepo structure

| Package | Path | Role |
|---|---|---|
| `@mercaria/frontend` | `packages/frontend/` | Expo storefront, mercaria.co |
| `@mercaria/dashboard` | `packages/dashboard/` | Expo merchant/store admin, dashboard.mercaria.co |
| `@mercaria/pos` | `packages/pos/` | Expo point of sale, pos.mercaria.co |
| `@mercaria/ui` | `packages/ui/` | Shared component library, consumed FROM SOURCE with no dist |
| `@mercaria/backend` | `packages/backend/` | Express API (TypeScript, MongoDB, Socket.IO) |
| `@mercaria/shared-types` | `packages/shared-types/` | TypeScript DTOs shared by all packages |

Stack: Expo, NativeWind (Tailwind v4 plus postcss), Reanimated, Zustand, TanStack
Query and expo-router on all three apps; Express, Mongoose, optional Redis and
Socket.IO on the backend; `@oxyhq/core` (including `@oxyhq/core/server`) and
`@oxyhq/services` for device-first auth; `@oxyhq/bloom` plus `@mercaria/ui` for
UI. Client ids: storefront `EXPO_PUBLIC_OXY_CLIENT_ID`, dashboard
`EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, POS `EXPO_PUBLIC_OXY_CLIENT_ID_POS`.

### `@mercaria/ui` is consumed from source

`@mercaria/ui` is NOT built to dist. Apps consume it directly through Metro
`watchFolders` pointing at `packages/ui`, the Tailwind preset
`@mercaria/ui/theme/tailwind.preset`, and a `tsconfig.paths` alias.

Do NOT add a build step or dist output. Apps must NOT keep local copies of any
component or utility that lives in `@mercaria/ui`; it is the single source of
truth for `formatMoney`, `formatReviewCount`, `PriceDisplay`, `FxContext` and all
marketplace UI primitives.

### `@mercaria/shared-types`

Domain DTOs (`Listing`, `ListingCondition`, `Seller`, `Money`, `CurrencyCode`,
`CURRENCY_PRECISION`, `CURRENCY_SYMBOLS`, `ApiResponse`, pagination). Build with
`bun run build:shared-types`.

## Currency: multi-currency presentment plus shop, FAIR settlement

Mercaria is **multi-currency**, Shopify-Markets style (presentment plus shop).
FairCoin (`FAIR`, symbol) is the canonical **SETTLEMENT** currency, NOT the
stored catalog currency. The currency set is data driven: `CurrencyCode`,
`CURRENCY_PRECISION`, `CURRENCY_SYMBOLS` and `ALL_CURRENCY_CODES` in
`@mercaria/shared-types`, and adding a code there propagates, because the Mongo
`MoneySchema` enum reads `ALL_CURRENCY_CODES`.

- **The catalog stores NATIVE currency.** `catalog-write.service` persists a
  variant or listing price in its own `.currency` exactly as given and does NOT
  convert to FAIR.
- **`DualMoney { shop, presentment }`** (shared-types) carries every TRANSACTED
  amount on orders and refunds. `shop` is the store's settlement currency
  (`Store.defaultCurrency`, or for a P2P order the seller's listing currency) and
  is the basis for reports and payout; `presentment` is what the buyer saw and
  paid (their `preferredCurrency`, else FAIR). Order line `unitPrice`,
  `lineTotal` and `discountTotal`, `totals.*`, `shipping.cost`, and refund line
  amounts and `totalRefunded` are all `DualMoney`. The order also snapshots
  `fxRate` (shop to presentment) for reproducibility.
- **Pricing engine** (`pricing.service.calculateTotals`) prices in the SHOP
  currency, converting native line prices to it, and returns `DualMoney` for
  every total; it takes a `presentmentCurrency` and FAIR-based `rates` from the
  caller. Discount and tax BREAKDOWN lines (`appliedDiscounts`, `taxLines`) stay
  single-currency SHOP amounts, since those are the settlement and refund basis.
- **Cart is not currency-pinned.** It holds items priced in different native
  currencies and converts each to the buyer's presentment currency at hydration.
- **Reports and customer stats sum the SHOP side**, `$match`ed to the store's
  `defaultCurrency` (`report.service`, `order.storeStats`,
  `customer.stats.totalSpent`), never mixing currencies.
- **Settlement seam** (`order.service.transition('paid')`) converts the order's
  shop grandTotal to FAIR via `convertToFair` and persists `settlement` (FAIR
  amount plus rate). This is the **ONLY** remaining `convertToFair` use, and it
  fails closed if there is no rate.
- **FX service** (`fx.service`): `getRates` and `convert` pivot through FAIR for
  any pair; `toDualMoney` and `pairRate` build the presentment side. The FX
  source is the FairCoin Explorer API (`explorer.fairco.in/api/price`, 1 FAIR in
  USD), Redis cached with last-good and stale fallback, with `StaticFxProvider`
  for dev and tests. `getRates` never throws.
- **DISPLAY** goes through `PriceDisplay` and `FxContext` in `@mercaria/ui` (do
  NOT duplicate), converting a native `Money` to the chosen display currency
  (primary is preferred or FAIR, plus an optional secondary fiat).

## Payments

Oxy Pay (FAIR, and cards in fiat) is currently a seam only, NOT integrated. A POS
sale completes via a draft order with `payment.provider: 'oxy_pay'`.

## Shipping: Moovo, not ready

Shipping UI is HIDDEN everywhere. The backend retains only a seam (the
`order.shipping` snapshot, cost zero). Do NOT build shipping zones or rates;
Moovo owns that entirely.

## Backend domain model

One unified API (`packages/backend`) serves storefront, dashboard and POS.

- `Listing`, with ownerType `user | store`, including `ProductVariant`
  sub-documents.
- `Location` plus `InventoryLevel` for multi-location inventory; the `$inc` guard
  is race-safe at the location grain.
- `Collection`, manual plus automated rules, materialized into
  `Listing.collectionIds`.
- `Discount`: code or automatic, percentage/fixed/BOGO, scopes, usage limits,
  combinability.
- `TaxRate` per jurisdiction.
- `Customer`, including POS walk-ins, upserted on paid with running stats.
- `DraftOrder` for a POS sale; `complete` converts it to a paid Order,
  idempotently.
- `Refund`: partial or full, per-line restock at location,
  `partially_refunded` status, no double restock.
- Store settings (policies, notifications, tax config) and reports
  (`/reports/summary`, `/reports/sales`, `/reports/top-products`).

**Pricing engine** (`pricing.service.calculateTotals`): subtotal, then discounts,
then taxes, then shipping, then grand total, with exact half-even reconciliation.

**Store permissions:** 16 perms. Role matrix: `owner` gets 16, `admin` gets 15
(no `store:manage`), `staff` gets 9 operational. All cross-collection references
are `String` ids.

**Admin API prefix:** `/admin/stores/:storeId/*`, consumed by dashboard and POS.

## MongoDB

Database `mercaria-production`, passed to `mongoose.connect()` via `dbName` and
**not** embedded in `MONGODB_URI`. See `packages/backend/src/lib/db.ts`.

## CORS: critical origins

The Mercaria backend's `PRODUCTION_ORIGINS` lives in
`packages/backend/src/app.ts` and must include `https://mercaria.co`,
`https://dashboard.mercaria.co` and `https://pos.mercaria.co`.

The central Oxy API
(`OxyHQServices/packages/api/src/config/allowedOrigins.ts`) must include
`https://mercaria.co` and the pattern
`/^https:\/\/[a-z0-9-]+\.mercaria\.co$/`. Without these,
`api.oxy.so/auth/refresh-all` fails with CORS errors from every Mercaria app.

## CrowdSource moderation: reports, cases, decisions, enforcement

Abuse reports leave Mercaria durably, CrowdSource decides them with a randomly
drawn jury, and decisions come back signed. **CrowdSource owns cases, reviews and
decisions; Oxy Trust owns reputation; Mercaria owns only its own catalogue
enforcement.** Mercaria never computes reputation and never suspends an Oxy
account.

Code lives in `packages/backend/src/services/moderation/`, over four models
(`abuse-report`, `moderation-outbox`, `moderation-event`,
`moderation-enforcement`) and two routes (`routes/reports.ts`,
`routes/crowdsource-webhook.ts`).

### "Report" is two unrelated things in this repo

`report.service.ts`, `shared-types/src/report.ts` and
`/admin/stores/:storeId/reports/*` are the store **SALES ANALYTICS** surface and
have nothing to do with moderation. Abuse reports are `AbuseReport`,
`services/moderation/` and `POST /reports`. Never merge them.

### The four rules that are load-bearing

- **A 201 from `POST /reports` means stored, never "CrowdSource accepted it."**
  `report-intake.service` commits the `AbuseReport` and its `ModerationOutbox`
  row in ONE transaction; no outbound request is made in the handler.
  **`enqueueModerationOutboxEvent` throws unless `session.inTransaction()`**: a
  bare `startSession()` type-checks, commits the row alone, and passes any test
  that only asserts the row exists. It is also the ONLY writer of that
  collection, so the row IS the job.
- **`routes/crowdsource-webhook.ts` MUST stay mounted before `express.json()`**
  in `app.ts`, beside `/channels/webhooks`, which is there for the same reason.
  The SDK reads the stream itself and REFUSES if a parser got there first, so a
  wrong order breaks every delivery rather than weakening the check.
- **Enforcement is idempotent on `decisionId + revision + action`**, enforced by
  the unique index on `ModerationEnforcement`. Each action CLAIMS its row before
  acting. `revision` is in the key so a correction's `restore` is a *different*
  action from the removal it supersedes; drop it and an accepted appeal can never
  relist the item.
- **Evidence carries bare Oxy `fileId`s, never a `mercaria.co` URL.** A
  reviewer's browser fetching such a URL would tell this host when its content is
  under review.

### Mercaria's enforcement levers

`CROWDSOURCE_ENFORCEMENT_MODE` is `observe`, `manual` or `automatic`, defaulting
to **`observe`**, which computes and RECORDS the identical plan and changes
nothing. The mapping lives in `enforcement-plan.ts` (pure, table tested).
Mercaria maps `recommendedActions`, not findings, with severity as a fallback
only.

- `restrict` sets `Listing.status = 'restricted'` (or `Review.status = 'hidden'`).
  Every catalogue read filters `status: 'active'`, the cart marks a non-active
  line stale, and checkout refuses stale lines, so ONE field delists AND unsells
  with **no query to edit**. The seller's real status survives in the enforcement
  row for the restore.
- `freeze_transaction` sets `Order.moderationHold`, refused by
  `order.service.transition`. **This is distinct from `restrict`**, which only
  stops NEW sales; the two survive collapse together, because a delisted
  counterfeit whose in-flight orders still ship is the bug that pairing prevents.
  `cancelled` stays reachable so a buyer is never trapped.
- `request_changes` returns the listing to `draft` and notifies the seller
  (`listing_changes_requested`). It is the commerce-only middle ground: the
  seller can fix and republish it themselves.
- `label`, `age_gate` and `reduce_distribution` become `manual_review`. Mercaria
  has no middle setting between listed and unlisted, and recording an effect that
  did not happen is worse than mapping honestly.

**Two enforcement ESCAPES are closed in pre-existing commerce code**, and a
reviewer reading `services/moderation/` would never see them, so do not remove
them: `catalog-write.service.updateListing` refuses to set `restricted` or to
move a listing out of it (a seller could otherwise PATCH `status:'active'` and
undo a jury silently), and `order.service.transition` refuses to advance a held
order.

### Subject providers: what Mercaria sends, and what it deliberately does not

`subjects/registry.ts` decides DELIVERY and nothing else. **A reported type with
no provider is stored locally, NOT refused**: gating the route on the registry
would make adopting CrowdSource a breaking change for every report surface not
yet wired to it.

- Delivered: `listing` to `commerce.listing`, `review` to `commerce.review`.
  Pinned by a test.
- Stored only: `seller`, `store`. `SellerProfile` stores no user-authored
  identity to pin (display name and avatar are read live from Oxy) and
  `applicationId` comes off the credential, so a case would open in Mercaria's
  tenant naming an object only Oxy can act on. That is a missing provider, not a
  refused report.

**Evidence is declared, not attached.** `AssetRef` requires a `sha256`; Mercaria
stores `{fileId, alt, position}` and never calls `configureServiceAuth`, so
`getServiceAssetMetadataByIds` would throw. Closing it needs Oxy service
credentials and nothing else, and then the digest MUST also enter the snapshot
hash.

**Nothing the envelope builder composes may vary between two deliveries of one
report.** Ingress fingerprints it, so an invented timestamp or an unsorted list
turns a legitimate outbox retry into a permanent 409, silently, days later. Hence
`submittedAt` is the report's own `createdAt`, and allegation codes are sorted
and deduped.

### Environment

Names come from the packages, not from a plan table:

```
CROWDSOURCE_ENABLED=false
CROWDSOURCE_SERVICE_KEY=            # applicationId:credentialId:secret, ONE opaque value
CROWDSOURCE_BASE_URL=               # optional
CROWDSOURCE_WEBHOOK_SECRET=
CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS=   # both accepted during a rotation
CROWDSOURCE_OUTBOX_BATCH_SIZE=50
CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS=5000
CROWDSOURCE_ENFORCEMENT_MODE=observe
```

**There is no `CROWDSOURCE_APP_ID`, and never add one.** `applicationId` is read
off the credential; a variable holding it could only ever disagree, and a surface
able to carry one independently is a cross-tenant IDOR. `CROWDSOURCE_ENABLED=true`
requires BOTH the service key and the webhook secret (enforced in
`config/index.ts`), because a half-configured integration sends reports that can
never come back.

### Lifecycle

`startModerationOutboxDispatcher` runs on EVERY task, since claims are Mongo
leases with an owner check, so N tasks share the work and a dead task's lease is
reclaimed. It no-ops when CrowdSource is off: the LOOP is gated, never the
durable record, so reports taken while disabled deliver once it is switched on.
The webhook dedupe store is **Mongo backed** (`moderation-event.store.ts`)
because Mercaria runs several ECS tasks, and the SDK's in-process default would
dedupe only the task that received both copies.

`app.ts` exists so the app can be built without listening, which is what lets the
raw-body invariant be asserted against the REAL middleware chain.

### Testing: the moderation writes run against a REAL replica set

`vitest.globalSetup.ts` starts one `MongoMemoryReplSet` for the suite, and the
`*.realdb.test.ts` files use it. **Do not convert those tests to mocks.**

The rest of this backend's tests mock their Mongoose models, which is fine for
logic and has one blind spot that matters enormously here: **a mocked `updateOne`
accepts any update document, including one the server rejects outright.**
Verified in this repo by injecting the bug and running both suites: the mocked
moderation tests passed 16/16 while the real-server tests failed 6 with
`MongoServerError: Updating the path 'updatedAt' would create a conflict at
'updatedAt'`.

That bug is worth knowing by name because it is total and silent: naming BOTH
`createdAt` and `updatedAt` inside `$setOnInsert` on a schema declaring
`{ timestamps: true }` makes Mongoose add the same path under `$set` too, Mongo
refuses the whole write, and inside the intake transaction the abort takes the
report row with it, so every `POST /reports` 500s from the first one, with a
green suite. `createdAt` alone is harmless.

**There are two ways to fix it and they are NOT interchangeable.** The enqueue
passes `timestamps: false` **as an option on that one `updateOne`** and writes
both timestamps in `$setOnInsert` itself. The tempting alternative, dropping the
explicit timestamps and letting `timestamps: true` own them, also clears the
server error and is wrong: it leaves Mongoose's `$set: { updatedAt }` on the
update, so a repeated enqueue for a row that ALREADY EXISTS becomes a real write
instead of a no-op. A repeat is ordinary (a transaction retry, two concurrent
duplicate submissions, a reconciliation sweep re-deriving an event) and runs
while the dispatcher holds leases on those same rows, so a write nobody needed
contends with a live lease update. Being a genuine no-op is the whole property
the deterministic event id exists to give. Measured here: without the flag a
repeat bumps `updatedAt`; with it the row is untouched, pinned by `leaves an
existing row COMPLETELY untouched on a repeated enqueue`. Credit: `homiio`, via
CrowdSource PR #34.

A replica SET, not a standalone: transactions and unique indexes are the two
properties under test and neither exists without one.

**CI typechecks all three Expo apps**, not just the API and UI. A build is not a
substitute: Babel strips types, so `expo export` happily bundles code `tsc`
rejects, and a `shared-types` change that broke the dashboard passed every build
job.

## Gotchas

**Dockerfile node-gyp pin.** The API Dockerfile lives at the **repo root**, not
under `packages/backend/`, and pins `node-gyp` explicitly in the builder stage.
`ws`'s optional native accelerators have no musl-arm64 prebuild, and an on-demand
`bunx node-gyp@latest` races and fails intermittently on ARM. Do NOT remove this
pin.

## Deploy

- **API** to AWS ECS Fargate, `.github/workflows/deploy-aws.yml`
  (`linux/arm64`, ECR `oxy/mercaria`). The ECS service, task definition, ALB
  rule, ECR repo and SSM params must be provisioned in `oxy-infra` first
  (handoff).
- **Web apps go to Cloudflare Workers (Static Assets), NOT Pages.** Each app
  deploys a Worker (`mercaria`, `mercaria-dashboard`, `mercaria-pos`) via
  `bunx wrangler deploy` using the per-package `wrangler.jsonc`. Workflows:
  `deploy-cloudflare.yml` (storefront, `mercaria.co`), `deploy-dashboard.yml`
  (`dashboard.mercaria.co`), `deploy-pos.yml` (`pos.mercaria.co`). Pages was
  abandoned because its `*.pages.dev` production URL cannot be removed; Workers
  with `workers_dev:false` and `preview_urls:false` serve ONLY the custom domain.
- **Each `wrangler.jsonc` is advanced-mode static assets:** `main: ./dist/_worker.js`
  (the repo's SPA and MIME-fix worker), `assets.binding: ASSETS`,
  `run_worker_first: true`, `not_found_handling: single-page-application`.
  `public/.assetsignore` (containing `_worker.js`) stops the script being
  re-uploaded as an asset. **Do NOT use `cloudflare/wrangler-action`**: its
  `npm i wrangler` chokes on the monorepo's `workspace:*` deps. Run `bunx
  wrangler` directly.
- Custom domains are Worker Custom Domains (managed DNS plus cert), bound on the
  `mercaria.co` zone. No `*.pages.dev` or `*.workers.dev` is exposed anywhere.
- CI (`.github/workflows/ci.yml`) runs lint, tests, the API build and the app
  build on every push and PR.

### Deploy handoff

- Register 2 Oxy RP client ids (dashboard, POS):
  `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, `EXPO_PUBLIC_OXY_CLIENT_ID_POS`.
- Provision the ECS service, task definition, ALB rule, ECR repo and SSM params
  in `oxy-infra`.
