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
- **Auth**: `@oxyhq/core` (incl. `@oxyhq/core/server`), `@oxyhq/services`, `@oxyhq/auth` (web SSO RP)
- **UI**: `@oxyhq/bloom` + `@mercaria/ui`
- **Client IDs**: storefront `EXPO_PUBLIC_OXY_CLIENT_ID`, dashboard `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, POS `EXPO_PUBLIC_OXY_CLIENT_ID_POS`

## Currency — FairCoin (FAIR, ⊜)

FairCoin (`FAIR`, symbol **⊜**) is the OFFICIAL canonical currency — the only stored/settlement currency in Mercaria.

- ALL prices stored as integer minor units in FAIR (precision 8 dp).
- `CurrencyCode`, `CURRENCY_PRECISION`, and `CURRENCY_SYMBOLS` live in `@mercaria/shared-types`.
- The backend NEVER converts stored FAIR money for display.
- Two conversion boundaries (FAIR is always what gets stored):
  1. **WRITE-side (catalog)** — stores may enter prices in EUR/USD; backend calls `convertToFair` and stores FAIR.
  2. **DISPLAY-side (storefront only)** — `PriceDisplay`/`FxContext` show ⊜ + optional secondary fiat. FX source: FairCoin Explorer API (`explorer.fairco.in/api/price`; 1 FAIR in USD), Redis-cached with last-good/stale fallback. `StaticFxProvider` for dev/tests.
- `PriceDisplay` and `FxContext` live in `@mercaria/ui`. Do NOT duplicate them in apps.

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
- **Storefront web** → CF Pages project `mercaria`, `.github/workflows/deploy-cloudflare.yml`.
- **Dashboard web** → CF Pages project `mercaria-dashboard` + DNS `dashboard.mercaria.co` (handoff).
- **POS web** → CF Pages project `mercaria-pos` + DNS `pos.mercaria.co` (handoff).
- CI (`.github/workflows/ci.yml`) runs lint + tests + API build + app build on every push/PR.

### Deploy handoff

- Register 2 Oxy RP client IDs (dashboard, POS): `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, `EXPO_PUBLIC_OXY_CLIENT_ID_POS`.
- Create CF Pages projects `mercaria-dashboard` + `mercaria-pos` + DNS records.
- Provision ECS service, task def, ALB rule, ECR repo, SSM params in `oxy-infra`.
