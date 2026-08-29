# Mercaria architecture

The monorepo, the backend domain model, the CORS origin authority and the
shipping boundary. Domain-by-domain references live beside this file in
`docs/`; the schema ledger is `packages/backend/src/db/schema/CONVENTIONS.md`.

## Monorepo structure

| Package | Path | Role |
|---|---|---|
| `@mercaria/frontend` | `packages/frontend/` | Expo storefront, mercaria.co |
| `@mercaria/dashboard` | `packages/dashboard/` | Expo merchant/store admin, dashboard.mercaria.co |
| `@mercaria/pos` | `packages/pos/` | Expo point of sale, pos.mercaria.co |
| `@mercaria/ui` | `packages/ui/` | Shared component library, consumed FROM SOURCE with no dist |
| `@mercaria/backend` | `packages/backend/` | Express API (TypeScript, PostgreSQL, Socket.IO) |
| `@mercaria/shared-types` | `packages/shared-types/` | TypeScript DTOs shared by all packages |

Stack: Expo, NativeWind (Tailwind v4 plus postcss), Reanimated, Zustand, TanStack
Query and expo-router on all three apps; Express, PostgreSQL (drizzle-orm +
postgres.js via `@oxyhq/db`), optional Redis and Socket.IO on the backend;
`@oxyhq/core` (including `@oxyhq/core/server`) and
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
## Backend domain model

One unified API (`packages/backend`) serves storefront, dashboard and POS.

- `Listing`, with ownerType `user | store`, including `ProductVariant` child
  rows.
- **`listings.published_at` is the FIRST activation, never the row's birthday**
  (#261). NULL until a listing is `active`, stamped by the first transition to
  it, never restamped and never cleared — `created_at` is where "when was the row
  written" lives. `db/catalog/listingRepository.ts` is the only author: the three
  statements that can write `listings.status` (`insertListing`,
  `updateListingColumns`, `setListingStatusIfIn`) each derive it, the stamp is a
  SQL `coalesce` rather than a read-then-write, and
  `listing-publication-chokepoint.test.ts` fails the build on a fourth production
  writer of that table. **No backfill, deliberately**: nothing distinguishes a
  draft that was never published from one that was `active` and was returned to
  `draft` by moderation's `request_changes`, so a pre-#261 draft may carry a
  stamp. The feed-ordering change was accepted — every read ordering by the
  column filters `status='active'`, and the two draft-showing screens order by
  `created_at`.
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

**Store permissions:** 17 perms (`STORE_PERMISSIONS` in
`db/schema/stores.ts`, includes `channels:write`). Role matrix: `owner` gets
17/17, `admin` gets 16/17 (no `store:manage`), `staff` gets 9/17 operational.
**`store:manage` is the one permission an `admin` does not hold**, which is why
the payment-onboarding routes use it rather than `settings:write`. Every buyer
id, seller id and `oxy_user_id` is a foreign SERVICE's primary key (Oxy owns
identity) and carries no foreign key; see `CONVENTIONS.md` below.

**Admin API prefix:** `/admin/stores/:storeId/*`, consumed by dashboard and POS.
## CORS: critical origins

The Mercaria backend's `PRODUCTION_ORIGINS` lives in
`packages/backend/src/lib/allowed-origins.ts` (imported by `app.ts` for CORS
and by the guest CSRF gate — ONE origin authority, ADR 0003 D10) and must
include `https://mercaria.co`, `https://dashboard.mercaria.co` and
`https://pos.mercaria.co`.

The central Oxy API
(`OxyHQServices/packages/api/src/config/allowedOrigins.ts`) must include
`https://mercaria.co` and the pattern
`/^https:\/\/[a-z0-9-]+\.mercaria\.co$/`. Without these,
`api.oxy.so/auth/refresh-all` fails with CORS errors from every Mercaria app.
## Shipping: Moovo, not ready

Shipping UI is HIDDEN everywhere. The backend retains only a seam (the
`order.shipping` snapshot, cost zero). Do NOT build shipping zones or rates;
Moovo owns that entirely.
