<p align="center">
  <b>Mercaria</b> is a buy and sell marketplace by <a href="https://oxy.so">Oxy</a>.<br>
  New items from shops, secondhand items from people, one commerce backend behind all of it.
</p>

<p align="center">
  <a href="https://mercaria.co">mercaria.co</a> ·
  <a href="https://dashboard.mercaria.co">dashboard.mercaria.co</a> ·
  <a href="https://pos.mercaria.co">pos.mercaria.co</a>
</p>

<p align="center">
  <img alt="Expo SDK 56" src="https://img.shields.io/badge/Expo-SDK%2056-440151?style=flat-square&logo=expo&logoColor=white">
  <img alt="React Native 0.85" src="https://img.shields.io/badge/React%20Native-0.85-440151?style=flat-square&logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-440151?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.3-440151?style=flat-square&logo=bun&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-4-440151?style=flat-square&logo=express&logoColor=white">
  <img alt="MongoDB" src="https://img.shields.io/badge/MongoDB-Mongoose-440151?style=flat-square&logo=mongodb&logoColor=white">
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### 🛒 Three apps, one API

The storefront, the merchant dashboard and the point of sale are three separate Expo apps built from one codebase, and they all talk to a single Express API.

Selling is not a bolted on mode. A listing can be owned by a person or by a store, so a secondhand sale and a shop order run through the same catalogue, cart, checkout and refund paths.

</td>
<td valign="top" width="50%">

### 🔑 Identity comes from Oxy

There is no Mercaria account. Sign in is the device first Oxy session, handled end to end by [`@oxyhq/services`](https://www.npmjs.com/package/@oxyhq/services) on the client and [`@oxyhq/core`](https://www.npmjs.com/package/@oxyhq/core) on the server.

No local token providers, no auth interceptors, no hand rolled bearer parsing. See the [Oxy platform repo](https://github.com/OxyHQ/oxy) for how the session itself works.

</td>
</tr>
</table>

## Packages

| Package | Path | What it is |
|---|---|---|
| `@mercaria/frontend` | [`packages/frontend/`](packages/frontend/) | Expo storefront: browse, search, cart, checkout, orders |
| `@mercaria/dashboard` | [`packages/dashboard/`](packages/dashboard/) | Expo merchant and store admin: catalogue, inventory, discounts, reports |
| `@mercaria/pos` | [`packages/pos/`](packages/pos/) | Expo point of sale: in person sales through draft orders |
| `@mercaria/ui` | [`packages/ui/`](packages/ui/) | Shared marketplace UI, consumed from source with no build step |
| `@mercaria/backend` | [`packages/backend/`](packages/backend/) | Express API: TypeScript, MongoDB via Mongoose, Socket.IO |
| `@mercaria/shared-types` | [`packages/shared-types/`](packages/shared-types/) | Domain DTOs every package imports |

Every app renders [`@oxyhq/bloom`](https://www.npmjs.com/package/@oxyhq/bloom) primitives with NativeWind on top of `@mercaria/ui`.

> `@mercaria/ui` is never built to `dist`. Apps resolve it through Metro `watchFolders`, a Tailwind preset and a tsconfig path alias, which is what keeps `formatMoney`, `PriceDisplay` and `FxContext` from being copied into three apps.

## Quick start

```bash
bun install
cp packages/backend/.env.example packages/backend/.env
bun run dev:backend
bun run dev:frontend
```

Bun 1.3.14 and Node 22. Use `bun` and `bunx`, never npm, yarn or npx.

<details>
<summary><b>All the commands</b></summary>

<br>

```bash
bun run dev              # every workspace at once
bun run dev:frontend     # storefront
bun run dev:dashboard    # merchant dashboard
bun run dev:pos          # point of sale
bun run dev:backend      # API

bun run build            # shared-types, then backend, then frontend
bun run build:dashboard  # Expo web export for the dashboard
bun run build:pos        # Expo web export for the POS
bun run lint             # every workspace

bun run --filter @mercaria/backend test        # Vitest
bun run --filter @mercaria/backend typecheck   # tsc --noEmit
```

`bun run android`, `bun run ios` and `bun run web` target the storefront. Each app pins its own Metro port, so all three can run side by side.

**The API test suite needs a PostgreSQL server running.** Mercaria is mid-migration from MongoDB to PostgreSQL, and the ported repositories are tested against a real PostGIS database rather than a mock — a mocked query cannot tell whether the server would accept the SQL. Start one before `test`:

```bash
docker compose -f docker-compose.postgres.yml up -d postgres
```

The suite never writes to that database. `TEST_DATABASE_URL` (falling back to `DATABASE_URL`, and defaulting to the compose server) names a SERVER, on which the harness creates a throwaway, fully-migrated database per run and drops it afterwards. Mongo's replica set is started in-process by the harness itself and needs nothing installed.

</details>

<details>
<summary><b>What the API actually models</b></summary>

<br>

One backend serves the storefront, the dashboard and the point of sale. The admin surface lives under `/admin/stores/:storeId/*`.

| Concept | Notes |
|---|---|
| `Listing` | Owned by a user or a store, carries product variants |
| `Location` and `InventoryLevel` | Multi location inventory, race safe at the location grain |
| `Collection` | Manual and rule based, materialized onto the listing |
| `Discount` | Code and automatic, percentage, fixed and BOGO, with usage limits |
| `TaxRate` | Per jurisdiction |
| `Customer` | Includes point of sale walk ins, with running spend stats |
| `DraftOrder` | A point of sale sale, converted to a paid order idempotently |
| `Refund` | Partial and full, restocked per line at the right location |
| Reports | Sales summary, sales, top products |

Store access is a 16 permission matrix: owner has all of them, admin has all but store management, staff has the 9 operational ones.

</details>

<details>
<summary><b>Money: multi currency, provider neutral, FAIR preferred</b></summary>

<br>

The catalogue stores each price in its own native currency and never converts it on write. Every transacted amount on an order or refund is a `DualMoney` carrying two sides: `shop`, the seller's own accounting currency and the basis for reports and refunds, and `presentment`, what the buyer actually saw and paid. The order also snapshots the rate between them, naming the source that quoted it and the moment it was taken, so a later rate move can never alter a placed order.

No currency is a settlement invariant. FairCoin (`FAIR`, ⊜) is the preferred default — the presentment currency a buyer gets when they have chosen none, and the display default — which is a product decision, not an architectural one. What a payment settles in is a property of the payment provider handling it and lives in the payment domain, so an order priced in euros completes with no FairCoin rate available at all.

Amounts are integer minor units with an enforced ceiling (`MAX_MONEY_MINOR_UNITS`), asserted everywhere an amount is formed: request validation, the pricing engine, currency conversion, refund proration and persistence.

The currency set is data driven from `@mercaria/shared-types`, so adding a code there propagates to the Mongo schema, the pricing engine and the UI.

</details>

<details>
<summary><b>Abuse reports go to CrowdSource</b></summary>

<br>

Mercaria does not run a moderation panel. Abuse reports are committed locally with a durable outbox row in the same transaction, then delivered to [CrowdSource](https://github.com/OxyHQ/CrowdSource), which decides them with a randomly drawn jury and returns signed decisions over a webhook.

CrowdSource owns cases and decisions, Oxy Trust owns reputation, and Mercaria only ever enforces against its own catalogue: restricting a listing, holding an order, or sending a listing back to draft for the seller to fix. Enforcement defaults to `observe`, which computes and records the identical plan without changing anything.

Built on [`@oxyhq/crowdsource`](https://www.npmjs.com/package/@oxyhq/crowdsource) and [`@oxyhq/crowdsource-express`](https://www.npmjs.com/package/@oxyhq/crowdsource-express).

</details>

<details>
<summary><b>Deploy</b></summary>

<br>

Everything ships from GitHub Actions in [`.github/workflows/`](.github/workflows/):

| Workflow | Target |
|---|---|
| `ci.yml` | Lint, tests, API build and app builds on every push and pull request |
| `deploy-aws.yml` | API to AWS ECS Fargate on `linux/arm64` |
| `deploy-cloudflare.yml` | Storefront to a Cloudflare Worker serving static assets |
| `deploy-dashboard.yml` | Dashboard Worker |
| `deploy-pos.yml` | Point of sale Worker |

The web apps are Workers with static assets rather than Pages, so only the custom domain is ever reachable.

</details>

## Conventions

TypeScript first, with no `as any`, no `@ts-ignore` and no non null assertions. Styling is NativeWind classes rather than inline styles. State is Zustand, data fetching is TanStack Query, routing is expo-router. Backend auth is `@oxyhq/core/server` middleware and is never hand rolled.

Longer form docs live in [`docs/`](docs/), the full working agreement in [`AGENTS.md`](AGENTS.md), and setup details in [`CONTRIBUTING.md`](CONTRIBUTING.md).

<br>

<div align="center">
<sub>Part of the <a href="https://github.com/OxyHQ">Oxy</a> ecosystem</sub>
</div>
