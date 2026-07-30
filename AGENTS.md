# Mercaria — Marketplace

Mercaria is a buy/sell marketplace by Oxy — users buy and sell new items (from shops) and secondhand items (from people), eBay/Wallapop style. The backend is a Shopify-grade commerce platform serving three Expo apps (storefront, dashboard, POS) and a shared UI package.

See `HANDOFF.md` for deferred work (infra, Oxy client registration, the domain).

## Monorepo Structure

| Package | Path | Role |
|---------|------|------|
| `@mercaria/frontend` | `packages/frontend/` | Expo storefront — mercaria.co |
| `@mercaria/dashboard` | `packages/dashboard/` | Expo merchant/store admin — dashboard.mercaria.co |
| `@mercaria/pos` | `packages/pos/` | Expo point-of-sale — pos.mercaria.co |
| `@mercaria/ui` | `packages/ui/` | Shared component library (consumed FROM SOURCE — no dist) |
| `@mercaria/backend` | `packages/backend/` | Express API (TypeScript, MongoDB, Socket.IO) |
| `@mercaria/shared-types` | `packages/shared-types/` | TypeScript DTOs shared by all packages |

### `@mercaria/ui` — consumed from source

`@mercaria/ui` is NOT built to dist. Apps consume it directly via Metro `watchFolders` pointing at `packages/ui`, Tailwind preset `@mercaria/ui/theme/tailwind.preset`, and `tsconfig.paths` alias.

Do NOT add a build step or dist output. Apps must NOT keep local copies of any component or utility that lives in `@mercaria/ui` — it is the single source of truth for `formatMoney`, `formatReviewCount`, `PriceDisplay`, `FxContext`, and all marketplace UI primitives.

### `@mercaria/shared-types`

Domain DTOs (`Listing`, `ListingCondition`, `Seller`, `Money`, `CurrencyCode`, `CURRENCY_PRECISION`, `CURRENCY_SYMBOLS`, `ApiResponse`, pagination). Build: `bun run build:shared-types`.

## Tech Stack

- **Frontend / Dashboard / POS**: Expo SDK 56, NativeWind 5 (Tailwind v4 + postcss), Reanimated, Zustand, TanStack Query, expo-router
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Redis (optional), Socket.IO
- **Auth**: `@oxyhq/core` (incl. `@oxyhq/core/server`), `@oxyhq/services` (device-first session)
- **UI**: `@oxyhq/bloom` + `@mercaria/ui`
- **Client IDs**: storefront `EXPO_PUBLIC_OXY_CLIENT_ID`, dashboard `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, POS `EXPO_PUBLIC_OXY_CLIENT_ID_POS`

## Currency — multi-currency (presentment + shop), FAIR settlement

Mercaria is **multi-currency** (Shopify-Markets style: presentment + shop). FairCoin
(`FAIR`, symbol **⊜**) is the canonical **SETTLEMENT** currency, NOT the stored catalog
currency. The currency set is data-driven: `CurrencyCode`, `CURRENCY_PRECISION`,
`CURRENCY_SYMBOLS`, `ALL_CURRENCY_CODES` in `@mercaria/shared-types`; adding a code there
propagates (the Mongo `MoneySchema` enum reads `ALL_CURRENCY_CODES`).

- **Catalog stores NATIVE currency.** `catalog-write.service` persists a variant/listing
  price in its own `.currency` exactly as given — it does NOT convert to FAIR. (The old
  8 `convertToFair` catalog calls were removed.)
- **`DualMoney { shop, presentment }`** (shared-types) carries every TRANSACTED amount on
  orders/refunds: `shop` = the store's settlement currency (`Store.defaultCurrency`; for a
  P2P order the seller's listing currency) — the basis for reports/payout; `presentment` =
  what the buyer saw and paid (their `preferredCurrency`, else FAIR). Order line
  `unitPrice`/`lineTotal`/`discountTotal`, `totals.*`, `shipping.cost`, and refund line
  amounts/`totalRefunded` are all `DualMoney`. The order also snapshots `fxRate`
  (shop→presentment) for reproducibility.
- **Pricing engine** (`pricing.service.calculateTotals`) prices in the SHOP currency
  (converting native line prices to it) and returns `DualMoney` for every total; it takes a
  `presentmentCurrency` + FAIR-based `rates` from the caller. Discount/tax BREAKDOWN lines
  (`appliedDiscounts`/`taxLines`) stay single-currency SHOP amounts (the settlement/refund
  basis).
- **Cart** is not currency-pinned: it holds items priced in different native currencies and
  converts each to the buyer's presentment currency at hydration (`addItem` no longer rejects
  a differing currency).
- **Reports/customer stats** sum the SHOP side, `$match`ed to the store's `defaultCurrency`
  (`report.service`, `order.storeStats`, `customer.stats.totalSpent`) — never mixing
  currencies.
- **Settlement seam** (`order.service.transition('paid')`): converts the order's shop
  grandTotal → FAIR via `convertToFair` and persists `settlement` (FAIR amount + rate). This
  is the **ONLY** remaining `convertToFair` use (fails closed if no rate).
- **FX service** (`fx.service`): `getRates`/`convert` pivot through FAIR for any pair;
  `toDualMoney`/`pairRate` build the presentment side. FX source: FairCoin Explorer API
  (`explorer.fairco.in/api/price`; 1 FAIR in USD), Redis-cached with last-good/stale
  fallback; `StaticFxProvider` for dev/tests. `getRates` never throws.
- **DISPLAY** — `PriceDisplay`/`FxContext` (in `@mercaria/ui`, do NOT duplicate) convert a
  native `Money` to the chosen display currency (primary = preferred/FAIR + optional
  secondary fiat).

## Payments

Oxy Pay (FAIR; also cards in fiat) — currently a seam only, NOT integrated. POS sale completes via draft-order with `payment.provider: 'oxy_pay'`.

## Shipping — Moovo (not ready)

Shipping UI is HIDDEN everywhere. Backend retains only a seam (`order.shipping` snapshot, cost ⊜0). Do NOT build shipping zones or rates — Moovo owns that entirely.

## Backend Domain Model

One unified API (`packages/backend`) serves storefront, dashboard, and POS.

- `Listing` — ownerType `user | store`; includes `ProductVariant` sub-documents
- `Location` + `InventoryLevel` — multi-location inventory; `$inc` guard is race-safe at the location grain
- `Collection` — manual + automated rules, materialized into `Listing.collectionIds`
- `Discount` — code/automatic, %/fixed/BOGO, scopes, usage limits, combinability
- `TaxRate` — per-jurisdiction tax
- `Customer` — incl. POS walk-ins; upsert-on-paid with running stats
- `DraftOrder` — POS sale; `complete` converts to a paid Order (idempotent)
- `Refund` — partial/full; per-line restock at location; `partially_refunded` status; no double-restock
- Store settings — policies, notifications, tax config
- Reports — `/reports/summary`, `/reports/sales`, `/reports/top-products`

**Pricing engine** (`pricing.service.calculateTotals`): subtotal → discounts → taxes → shipping (⊜0) → grand total; exact half-even reconciliation.

**Store permissions:** 16 perms. Role matrix: `owner` = 16 / `admin` = 15 (no `store:manage`) / `staff` = 9 operational. All cross-collection references are `String` ids.

**Admin API prefix:** `/admin/stores/:storeId/*` — consumed by dashboard and POS.

## MongoDB

Database: `mercaria-production` (passed to `mongoose.connect()` via `dbName`, NOT embedded in `MONGODB_URI`). See `packages/backend/src/lib/db.ts`.

## CORS — Critical Origins

**Mercaria backend** (`packages/backend/src/index.ts` `PRODUCTION_ORIGINS`) must include `https://mercaria.co`, `https://dashboard.mercaria.co`, `https://pos.mercaria.co`.

**Central Oxy API** (`OxyHQServices/packages/api/src/config/allowedOrigins.ts`) must include `https://mercaria.co` and pattern `/^https:\/\/[a-z0-9-]+\.mercaria\.co$/`. Without these, `api.oxy.so/auth/refresh-all` fails with CORS errors from all Mercaria apps.

## CrowdSource Moderation (reports → cases → decisions → enforcement)

Abuse reports leave Mercaria durably, CrowdSource decides them with a randomly drawn
jury, and decisions come back signed. **CrowdSource owns cases, reviews and decisions;
Oxy Trust owns reputation; Mercaria owns only its own catalogue enforcement.** Mercaria
never computes reputation and never suspends an Oxy account.

Code: `packages/backend/src/services/moderation/`, four models (`abuse-report`,
`moderation-outbox`, `moderation-event`, `moderation-enforcement`) and two routes
(`routes/reports.ts`, `routes/crowdsource-webhook.ts`).

### "Report" is two unrelated things in this repo

`report.service.ts`, `shared-types/src/report.ts` and `/admin/stores/:storeId/reports/*`
are the store **SALES ANALYTICS** surface and have nothing to do with moderation. Abuse
reports are `AbuseReport` / `services/moderation/` / `POST /reports`. Never merge them.

### The four rules that are load-bearing

- **A 201 from `POST /reports` means stored — never "CrowdSource accepted it."**
  `report-intake.service` commits the `AbuseReport` and its `ModerationOutbox` row in ONE
  transaction; no outbound request is made in the handler. **`enqueueModerationOutboxEvent`
  throws unless `session.inTransaction()`** — a bare `startSession()` type-checks, commits
  the row alone, and passes any test that only asserts the row exists. It is also the ONLY
  writer of that collection, so the row IS the job.
- **`routes/crowdsource-webhook.ts` MUST stay mounted before `express.json()`** in `app.ts`
  (beside `/channels/webhooks`, which is there for the same reason). The SDK reads the
  stream itself and REFUSES if a parser got there first, so a wrong order breaks every
  delivery rather than weakening the check.
- **Enforcement is idempotent on `decisionId + revision + action`**, enforced by the unique
  index on `ModerationEnforcement`. Each action CLAIMS its row before acting. `revision` is
  in the key so a correction's `restore` is a *different* action from the removal it
  supersedes — drop it and an accepted appeal can never relist the item.
- **Evidence carries bare Oxy `fileId`s, never a `mercaria.co` URL.** A reviewer's browser
  fetching such a URL would tell this host when its content is under review.

### Mercaria's enforcement levers (the commerce actions are real here)

`CROWDSOURCE_ENFORCEMENT_MODE` (`observe` | `manual` | `automatic`, default **`observe`**).
`observe` computes and RECORDS the identical plan and changes nothing. Mapping lives in
`enforcement-plan.ts` (pure, table-tested); Mercaria maps `recommendedActions`, not
findings, with severity as a fallback only.

- `restrict` → `Listing.status = 'restricted'` (or `Review.status = 'hidden'`). Every
  catalogue read filters `status: 'active'`, the cart marks a non-active line stale and
  checkout refuses stale lines — so ONE field delists AND unsells, with **no query to
  edit**. The seller's real status survives in the enforcement row for the restore.
- `freeze_transaction` → `Order.moderationHold`, refused by `order.service.transition`.
  **Distinct from `restrict`**, which only stops NEW sales; the two survive collapse
  together, because a delisted counterfeit whose in-flight orders still ship is the bug
  that pairing prevents. `cancelled` stays reachable so a buyer is never trapped.
- `request_changes` → the listing returns to `draft` and the seller is notified
  (`listing_changes_requested`). The commerce-only middle ground: the seller can fix and
  republish it themselves.
- `label` / `age_gate` / `reduce_distribution` → `manual_review`. Mercaria has no middle
  setting between listed and unlisted, and recording an effect that did not happen is worse
  than mapping honestly.

**Two enforcement ESCAPES are closed in pre-existing commerce code** — a reviewer reading
`services/moderation/` would never see them, so do not remove them:
`catalog-write.service.updateListing` refuses to set `restricted` or to move a listing out
of it (a seller could otherwise PATCH `status:'active'` and undo a jury silently), and
`order.service.transition` refuses to advance a held order.

### Subject providers — what Mercaria sends, and what it deliberately does not

`subjects/registry.ts` decides DELIVERY and nothing else. **A reported type with no
provider is stored locally, NOT refused** — gating the route on the registry would make
adopting CrowdSource a breaking change for every report surface not yet wired to it.

- Delivered: `listing` → `commerce.listing`, `review` → `commerce.review`. Pinned by a test.
- Stored-only: `seller`, `store`. `SellerProfile` stores no user-authored identity to pin
  (display name/avatar are read live from Oxy), and `applicationId` comes off the
  credential — so a case would open in Mercaria's tenant naming an object only Oxy can act
  on. A missing provider, not a refused report.

**Evidence is declared, not attached.** `AssetRef` requires a `sha256`; Mercaria stores
`{fileId, alt, position}` and never calls `configureServiceAuth`, so
`getServiceAssetMetadataByIds` would throw. Closing it needs Oxy service credentials and
nothing else — then the digest MUST also enter the snapshot hash.

**Nothing the envelope builder composes may vary between two deliveries of one report.**
Ingress fingerprints it, so an invented timestamp or an unsorted list turns a legitimate
outbox retry into a permanent 409 — silently, days later. Hence `submittedAt` is the
report's own `createdAt` and allegation codes are sorted and deduped.

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

**There is no `CROWDSOURCE_APP_ID`, and never add one.** `applicationId` is read off the
credential; a variable holding it could only ever disagree, and a surface able to carry one
independently is a cross-tenant IDOR. `CROWDSOURCE_ENABLED=true` requires BOTH the service
key and the webhook secret (enforced in `config/index.ts`) — a half-configured integration
sends reports that can never come back.

### Lifecycle

`startModerationOutboxDispatcher` runs on EVERY task (claims are Mongo leases with an owner
check, so N tasks share the work and a dead task's lease is reclaimed). It no-ops when
CrowdSource is off — the LOOP is gated, never the durable record, so reports taken while
disabled deliver once it is switched on. The webhook dedupe store is **Mongo-backed**
(`moderation-event.store.ts`) because Mercaria runs several ECS tasks; the SDK's in-process
default would dedupe only the task that received both copies.

`app.ts` exists so the app can be built without listening — that is what lets the raw-body
invariant be asserted against the REAL middleware chain.

## Gotchas

**Dockerfile node-gyp pin:** API Dockerfile pins `node-gyp@10` in the builder stage. `ws`'s optional native accelerators have no musl-arm64 prebuild; `bunx node-gyp@latest` races and fails intermittently on ARM. Do NOT remove this pin.

## Deploy

- **API** → AWS ECS Fargate, `.github/workflows/deploy-aws.yml` (`linux/arm64`, ECR `oxy/mercaria`). ECS service + task def + ALB rule + ECR repo + SSM params must be provisioned in `oxy-infra` first (handoff).
- **Web apps → Cloudflare Workers (Static Assets), NOT Pages.** Each app deploys a
  Worker (`mercaria` / `mercaria-dashboard` / `mercaria-pos`) via `bunx wrangler@4 deploy`
  using the per-package `wrangler.jsonc`. Workflows: `deploy-cloudflare.yml` (storefront,
  `mercaria.co`), `deploy-dashboard.yml` (`dashboard.mercaria.co`), `deploy-pos.yml`
  (`pos.mercaria.co`). Pages was abandoned because its `*.pages.dev` production URL cannot
  be removed; Workers `workers_dev:false` + `preview_urls:false` serve ONLY the custom domain.
- **wrangler.jsonc per app is advanced-mode static assets:** `main: ./dist/_worker.js`
  (the repo's SPA/MIME-fix worker), `assets.binding: ASSETS`, `run_worker_first: true`,
  `not_found_handling: single-page-application`. `public/.assetsignore` (`_worker.js`) stops
  the script being re-uploaded as an asset. Do NOT use `cloudflare/wrangler-action` — its
  `npm i wrangler` chokes on the monorepo's `workspace:*` deps; run `bunx wrangler` directly.
- Custom domains are Worker Custom Domains (managed DNS + cert), bound on the `mercaria.co`
  zone. No `*.pages.dev` / `*.workers.dev` is exposed anywhere.
- CI (`.github/workflows/ci.yml`) runs lint + tests + API build + app build on every push/PR.

### Deploy handoff

- Register 2 Oxy RP client IDs (dashboard, POS): `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, `EXPO_PUBLIC_OXY_CLIENT_ID_POS`.
- Provision ECS service, task def, ALB rule, ECR repo, SSM params in `oxy-infra`.
