# Mercaria — Project Conventions

Mercaria is a buy/sell marketplace by [Oxy](https://oxy.so) — users buy and sell both
**new** items (from shops) and **secondhand** items (from people), eBay / Wallapop
style. The backend is a Shopify-grade commerce platform serving three Expo apps
(storefront, dashboard, POS) and a shared UI package.

See `HANDOFF.md` for the deferred work (infra, Oxy client registration, the domain).

## Monorepo Structure

| Package | Path | Role |
|---------|------|------|
| `@mercaria/frontend` | `packages/frontend/` | Expo storefront — mercaria.co |
| `@mercaria/dashboard` | `packages/dashboard/` | Expo merchant/store admin — dashboard.mercaria.co |
| `@mercaria/pos` | `packages/pos/` | Expo point-of-sale — pos.mercaria.co |
| `@mercaria/ui` | `packages/ui/` | **Shared** component library (consumed FROM SOURCE — no dist; see below) |
| `@mercaria/backend` | `packages/backend/` | Express API (TypeScript, MongoDB, Socket.IO) |
| `@mercaria/shared-types` | `packages/shared-types/` | TypeScript DTOs shared by all packages |

Bun workspaces. **Always use `bun`, never npm/yarn. Use `bunx`, not `npx`.**

### `@mercaria/ui` — consumed from source

`@mercaria/ui` is NOT built to dist. Apps consume it directly via:
- Metro `watchFolders` pointing at `packages/ui`
- Tailwind preset: `@mercaria/ui/theme/tailwind.preset`
- `tsconfig.paths` alias

This mirrors the `@mercaria/shared-types` pattern. Do NOT add a build step or
dist output to `@mercaria/ui`. Apps must NOT keep local copies of any component
or utility that lives in `@mercaria/ui` — it is the single source of truth for
`formatMoney`, `formatReviewCount`, `PriceDisplay`, `FxContext`, and all
marketplace UI primitives.

### `@mercaria/shared-types`

TypeScript domain DTOs (`Listing`, `ListingCondition`, `Seller`, `Money`,
`CurrencyCode`, `CURRENCY_PRECISION`, `CURRENCY_SYMBOLS`, `ApiResponse`,
pagination) shared by frontend, dashboard, pos, and backend. Build with
`bun run build:shared-types`.

## Tech Stack

- **Frontend / Dashboard / POS**: Expo SDK 56, React Native 0.85.3, NativeWind 5 (Tailwind v4 + postcss), Reanimated, Zustand, TanStack Query, expo-router (file-based)
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Redis (optional), Socket.IO
- **Auth**: `@oxyhq/core` (incl. `@oxyhq/core/server`), `@oxyhq/services` (`OxyProvider`, `useOxy`/`useAuth`), `@oxyhq/auth` where the web SSO RP provider is used
- **UI**: `@oxyhq/bloom` shared component library (`BloomThemeProvider`, `useTheme`, `ImageResolverProvider`, etc.) + `@mercaria/ui`

## Currency — FairCoin (FAIR, ⊜)

FairCoin (`FAIR`, symbol **⊜**) is the **OFFICIAL canonical currency** across all
of Oxy and the only stored/settlement currency in Mercaria.

**Rules:**
- ALL prices are stored as **integer minor units in FAIR** (precision 8 dp).
- `CurrencyCode`, `CURRENCY_PRECISION`, and `CURRENCY_SYMBOLS` live in `@mercaria/shared-types`.
- The backend NEVER converts stored FAIR money for display.
- Two conversion boundaries exist; FAIR is always what gets stored:
  1. **WRITE-side (catalog)** — stores may enter prices in EUR/USD; the backend calls
     `convertToFair` and stores the FAIR value.
  2. **DISPLAY-side (storefront only)** — show ⊜ + optional secondary fiat via
     `PriceDisplay`/`FxContext`. FX default = on. Source = FairCoin Explorer API
     (`explorer.fairco.in/api/price`; 1 FAIR in USD), Redis-cached with last-good/stale
     fallback. `StaticFxProvider` for dev/tests.
- `PriceDisplay` and `FxContext` live in `@mercaria/ui`. Do NOT duplicate them in apps.

## Payments

Oxy Pay (FAIR; also cards in fiat) is the payment integration — currently a **seam
only, NOT integrated**. POS sale completes via the draft-order path with
`payment.provider: 'oxy_pay'`.

## Shipping — Moovo (external, in development)

Moovo provides shipping prices, labels, and fulfillment. It is **NOT ready** — shipping
UI is **HIDDEN everywhere**. The backend retains only a seam (`order.shipping` snapshot,
cost ⊜0). Do NOT build shipping zones or rates — Moovo owns that entirely.

## Backend Domain Model (Shopify-grade)

One unified API (`packages/backend`) serves storefront, dashboard, and POS.

**Core entities:**
- `Listing` — unified ownerType `user | store`; includes `ProductVariant` sub-documents
- `Location` + `InventoryLevel` — multi-location inventory; variant scalar is a
  rollup; P2P stays single-location; `$inc` guard is race-safe at the level grain
- `Collection` — manual + automated rules, materialized into `Listing.collectionIds`
- `Discount` — code/automatic, %/fixed/BOGO, scopes, usage limits, combinability
- `TaxRate` — per-jurisdiction tax configuration
- `Customer` — incl. POS walk-ins; upsert-on-paid with running stats
- `DraftOrder` — POS sale; `complete` converts to a paid Order (idempotent)
- `Refund` — partial/full; per-line restock at location; `partially_refunded` status; no double-restock
- Store settings — policies, notifications, tax config
- Reports — `/reports/summary`, `/reports/sales`, `/reports/top-products`

**Pricing engine** (`pricing.service.calculateTotals`):
subtotal → discounts → taxes → shipping (⊜0) → grand total;
exact half-even reconciliation.

**Store permissions:** `StorePermission` catalog = 16 perms.
Role matrix: `owner` = 16 / `admin` = 15 (no `store:manage`) / `staff` = 9 operational.

All cross-collection references are `String` ids.

**Admin API prefix:** `/admin/stores/:storeId/*` — consumed by dashboard and POS.

## MongoDB Database Naming

All Oxy ecosystem apps share the same MongoDB cluster. Each app uses its own
database named `{appName}-{NODE_ENV}` (here: `mercaria-production`). The
`dbName` is passed to `mongoose.connect()` (see `packages/backend/src/lib/db.ts`), NOT
embedded in `MONGODB_URI`.

## Oxy Auth / Session Contract (do not reinvent)

- Frontend/dashboard/POS auth state belongs to `OxyProvider` with a registered `clientId`.
  - Storefront: `EXPO_PUBLIC_OXY_CLIENT_ID`
  - Dashboard: `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`
  - POS: `EXPO_PUBLIC_OXY_CLIENT_ID_POS`
- The SDK cold boot owns the `/__oxy/sso-callback` consume, stored-session restore,
  FedCM/silent restore, and the SSO bounce. Apps are zero-config.
- Do NOT add app-local SSO helpers, callback routes, token providers, auth
  interceptors, manual `Authorization` plumbing, refresh retries, or session
  invalidation. SSO helpers live ONLY in `@oxyhq/core`.
- The web SSO callback bootstrap is injected in `app/+html.tsx` via
  `getSsoCallbackBootstrapScript()` from `@oxyhq/core`.
- Backend APIs use `@oxyhq/core/server`: `createOxyAuthMiddleware`,
  `createOptionalOxyAuth`, `createOxyRateLimit`, `requireOxyAuth`,
  `getRequiredOxyUserId`, and `authSocket` (see `packages/backend/src/middleware/auth.ts`).
  Do NOT define app-local `AuthRequest`, `requireAuth`, `getUserId`, bearer
  parsers, or token-decoding middleware.
- Bearer-authenticated writes do NOT fetch app-local CSRF tokens.

## CORS — Critical Origins

**Mercaria backend** (`packages/backend/src/index.ts` `PRODUCTION_ORIGINS`) must include:
- `https://mercaria.co`
- `https://dashboard.mercaria.co`
- `https://pos.mercaria.co`

**Central Oxy API** (`OxyHQServices/packages/api/src/config/allowedOrigins.ts`) must include:
- `https://mercaria.co`
- Pattern `/^https:\/\/[a-z0-9-]+\.mercaria\.co$/` (covers dashboard + pos subdomains)

These were added this session. Without them, `api.oxy.so/auth/refresh-all` fails
with a CORS error from all Mercaria apps.

## Known Gotchas

**Dockerfile node-gyp pin:** The API Dockerfile pins `node-gyp@10` in the builder stage.
`ws`'s optional native accelerators (`bufferutil`, `utf-8-validate`) have no musl-arm64
prebuild; bun's on-the-fly `bunx node-gyp@latest` fetch races and fails intermittently,
breaking the AWS deploy. The explicit pin makes it deterministic — do NOT remove it.

## Quality Standards

- Production-grade, clean, scalable code. No hacks, no workarounds, no half-baked
  solutions. Fix root causes.
- NEVER use `as any`, `@ts-ignore`/`@ts-expect-error`, non-null `!` assertions,
  silent `catch {}`, `var`, `console.log` debugging, or hardcoded URLs/keys/magic
  numbers. NEVER leave TODO/FIXME/HACK comments.
- Avoid `useEffect` for data — prefer derived state, event handlers, `useMemo`, or
  TanStack Query.
- Fix bugs in shared packages (`@oxyhq/core`, `@oxyhq/services`, `@oxyhq/bloom`)
  UPSTREAM, never patch downstream in this app.
- After installing/updating packages, run `bun install` and commit the updated
  `bun.lock` in the SAME commit as the `package.json` change.

## Display Names (API contract)

Render `name.displayName` from Oxy user/profile DTOs directly. Do NOT recompute
names from `name.first`/`name.last`/`name.full` or add local
`displayName || username` fallbacks.

## Deploy

- **API** → AWS ECS Fargate via `.github/workflows/deploy-aws.yml` (builds
  `linux/arm64`, pushes to ECR, force-new-deployment). The ECS service +
  task def + ALB rule + ECR repo + SSM params must be provisioned in `oxy-infra`
  first (handoff).
- **Storefront web** → Cloudflare Pages via `.github/workflows/deploy-cloudflare.yml`
  (Expo web export → `pages deploy`). CF Pages project `mercaria` + DNS.
- **Dashboard web** → Cloudflare Pages project `mercaria-dashboard` + DNS for `dashboard.mercaria.co` (handoff).
- **POS web** → Cloudflare Pages project `mercaria-pos` + DNS for `pos.mercaria.co` (handoff).
- CI (`.github/workflows/ci.yml`) runs lint + tests + API build + app build on
  every push/PR. Bun is pinned to `1.3.14` everywhere a lockfile is consumed.

### Deploy handoff checklist (pending)

- Register 2 Oxy RP client IDs (dashboard, POS) and set as repo vars:
  `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD` and `EXPO_PUBLIC_OXY_CLIENT_ID_POS`.
- Create CF Pages projects `mercaria-dashboard` and `mercaria-pos` + DNS records.
- Provision ECS service, task def, ALB rule, ECR repo, SSM params in `oxy-infra`.
