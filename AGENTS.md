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
