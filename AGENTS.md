# Mercaria

Oxy's buy/sell marketplace — new items from shops, secondhand from people, eBay
or Wallapop style. A Shopify-grade commerce backend serving three Expo apps
(storefront, dashboard, POS) and a shared UI package.

> **For anything about how this project WORKS, read `docs/index.mdx`** — every
> domain has a file there, `docs/adr/` holds the binding decisions, and
> `packages/backend/src/db/schema/CONVENTIONS.md` binds every schema decision.
> Two you will want on almost any backend task: `docs/house-invariants.md` and
> `docs/postgres-testing-and-migrations.md`. `HANDOFF.md` holds deferred work.
>
> **This file carries only RULES — things that break silently if you get them
> wrong.** Design notes, model inventories and per-issue write-ups go in `docs/`,
> never here. Org-wide standards are in `~/AGENTS.md` and `~/Oxy/AGENTS.md`; do
> not repeat them. Versions live in `package.json`.
>
> **Budget: under 12 KB**, enforced by `scripts/check-agents-md-size.mjs`. An
> addition that pushes it over is paid for in the SAME edit.

## Commands

`bun` only, from the repo root. Postgres must be up for the backend suite:
`docker compose -f docker-compose.postgres.yml up -d` (port 5435).

```bash
bun install
bun run build:shared-types                # ALWAYS before db:generate
bun run --cwd packages/backend test        # vitest, incl. the *.realdb.test.ts suites
bun run --cwd packages/backend typecheck   # also --filter @mercaria/{ui,frontend,dashboard,pos}
bun run --filter @mercaria/backend lint
bun run validate:agents-md                # budget; ci.yml names all 15
bun run --cwd packages/backend db:generate # drizzle-kit; needs the marker below
```

## Layout

`packages/` — `frontend` (mercaria.co) · `dashboard` · `pos` (Expo apps) ·
`ui` (shared components) · `backend` (Express + PostgreSQL) · `shared-types`
(DTOs and every closed value set).

- **`@mercaria/ui` is NOT built to dist.** Apps consume it through Metro
  `watchFolders`, the `@mercaria/ui/theme/tailwind.preset` preset and a
  `tsconfig.paths` alias. Do NOT add a build step, and never keep a local copy of
  anything it owns (`formatMoney`, `PriceDisplay`, `FxContext`, every marketplace
  primitive).
- **CI typechecks all three Expo apps.** A build is not a substitute: Babel
  strips types, so `expo export` bundles code `tsc` rejects.
- **`typedRoutes` is armed** (`generate-router-types.mjs` runs in each app's
  `typecheck`; `typed-routes-armed.test.ts` fails the build if it stops) and it
  checks the OBJECT form COMPLETELY — a wrong `{ pathname }` is TS2820. A
  TEMPLATE LITERAL is checked ONLY when no dynamic route sits above the mistyped
  segment, so `` `/products/wizrd/${id}` `` exits 0, absorbed by `/products/[id]`
  (#456). Spell a dynamic target as the object form; `validate:route-targets`
  resolves each against the real route tree and covers the wall #330 retired
  (`docs/product-page.md`).

## Money

- **The catalog stores NATIVE currency** and converts nothing. **`paid` converts
  NOTHING** — no FX call in `order.service.transition('paid')`.
- **`DualMoney { shop, presentment }`** carries every TRANSACTED amount, with an
  `FxRateSnapshot` that identifies the conversion completely; a later rate move
  can never alter a stored amount.
- **Every money column is `bigint({ mode: 'number' })`**, and
  `assertSafeMoneyAmount` is called at every construction boundary —
  `z.number().int()` alone accepts `1e300`.
- **Adding a `CurrencyCode` is a code change PLUS `bun run db:generate` PLUS an
  additive (`pre`) migration in the same PR.** Every currency column carries a
  CHECK rendered from the shared-types tuple, so skipping the migration makes the
  first write of the new code fail in production with a green build.
- **The ledger is the ONLY record of Mercaria's commission** (ADR 0001 D3 gives
  up Stripe's `application_fee_amount` reporting).
  `db/payments/ledgerRepository.ts` is its only writer and refuses an unbalanced
  set; a trigger raises on UPDATE and DELETE. A correction is a REVERSING
  transaction — there is deliberately no `reverseTransaction(id)`. Positive is a
  debit, negative a credit, every transaction sums to zero PER CURRENCY.
- **Nothing auto-deletes or rewrites financial history.** Repairs are explicit,
  audited operator actions from a CLOSED set.
- **Use `constructEventAsync`, never `constructEvent`** — under Bun the
  synchronous Stripe crypto entry points throw while production on Node works.

## PostgreSQL

`DATABASE_URL` is **required to boot**. There is no second store: legacy
Mongo/Mongoose is GONE (PR #136, database dropped 2026-08-08) — no `src/models/`,
no `mongoose` dependency, no `MONGODB_URI`, and no rollback target.

- **`bun run db:generate` writes migrations; `src/db/migrate.ts` is the ONLY
  thing that applies them** — never `drizzle-kit migrate`. Every generated `.sql`
  needs exactly one `-- oxy:deploy-phase=pre` (additive) or `=post`
  (drops/renames/narrows) marker; no default.
- **`bun run build:shared-types` BEFORE `db:generate`, always.** drizzle-kit
  renders every closed-value-set CHECK from the BUILT `@mercaria/shared-types`,
  so a stale `dist/` silently emits `DROP`/`ADD CONSTRAINT` pairs narrowing a
  sibling branch's tuple back, in a diff that looks plausible.
- **Never hand-rename a migration, hand-edit `meta/_journal.json` or hand-write a
  snapshot**, and after any regeneration READ the file for statements you did not
  intend — regeneration DROPS every hand-written trigger, function, backfill and
  the marker, pure DDL included; verify its count is 1.
- **Do not convert `*.realdb.test.ts` suites to mocks.** A mocked insert/update
  accepts a statement the server rejects; CHECKs, unique indexes,
  `requireTransaction` and `FOR UPDATE SKIP LOCKED` have no mocked counterpart.
- **The test database is SHARED across parallel files.** Scope every aggregate to
  ids your file owns, floor every count equality, never widen a global config
  bound, hold the advisory-lock mutex for the global active matching policy, and
  keep a trigger-toggle window to exactly ONE table.

## Auth and the identity surfaces

- **There is no Mercaria service principal.** `middleware/auth.ts` is three
  exports composed from `@oxyhq/core/server`. A real Oxy-to-Oxy caller mounts
  `oxyClient.serviceAuth(...)` on the route that needs it; there is deliberately
  no pre-exported unmounted service-auth middleware. **Never build a second
  verifier.** A provider webhook is a different principal and verifies its own
  signature.
- **Every `/internal/*` surface is gated by an Oxy-user-id allow-list, and empty
  means NOT MOUNTED (404, never 401).** A new surface joins the list whose power
  it already shares — the code records two that were refused on exactly that
  test. Enumeration: `docs/house-invariants.md`.
- **`store:manage` is the one permission an `admin` does not hold**, which is why
  payment onboarding, fee acceptance and merchant-identity routes use it rather
  than `settings:write`.
- **Every buyer id, seller id and `oxy_user_id` is a foreign SERVICE's primary
  key** (Oxy owns identity) and carries no foreign key.
- **CORS:** `packages/backend/src/lib/allowed-origins.ts` is the ONE origin
  authority (CORS and the guest CSRF gate) and must carry `mercaria.co`,
  `dashboard.mercaria.co` and `pos.mercaria.co`. The central Oxy API's
  `allowedOrigins.ts` must carry `https://mercaria.co` and
  `/^https:\/\/[a-z0-9-]+\.mercaria\.co$/`, or `auth/refresh-all` fails with CORS
  from every Mercaria app.

## Things that break silently if you change them

- **Four routers must stay mounted BEFORE `express.json()`** — the CrowdSource,
  Stripe (two), channel and supplier webhooks, plus the feed-import upload route,
  which buffers its own body. Listed in `docs/house-invariants.md`, asserted
  against the real middleware chain by
  `routes/__tests__/stripe-webhook.integration.test.ts`.
- **Three moderation ESCAPES are closed in pre-existing commerce code**, and a
  reviewer reading `services/moderation/` would never see them:
  `catalog-write.service.updateListing` refuses to set `restricted` or to move a
  listing out of it; `archiveListing` refuses to archive a restricted listing at
  all, because a soft delete CLEARED the status that first guard reads, so
  DELETE-then-PATCH laundered a jury's decision in two ordinary calls (#402); and
  `order.service.transition` refuses to advance a held order. Do not remove any
  of them. Archiving a restricted listing is a one-way door unless a restore can
  reach it, so `restoreSubject` relists from `archived` too, and
  `listing-archive-census.test.ts` fails the build on a new archiver.
- **"Report" is two unrelated things here.** `report.service.ts` and
  `/admin/stores/:storeId/reports/*` are SALES ANALYTICS; abuse reports are
  `AbuseReport` + `services/moderation/`. Never merge them.
- **`product_variants.sku` and `.barcode` are unique at NO grain and must not be
  re-narrowed** — two merchants selling one trade item share a GTIN by
  definition. GTIN identity is `product_identifiers`' collision gate; the
  ambiguity check lives in `matchIncomingVariant`/`resolveInventoryVariant`,
  which REFUSE to pick and report `ambiguous`, never `skipped`.
- **A connector collection mapping may target only a MANUAL collection.**
  `applyCollectionMapping` and `reconcileAutomatedMembership` both write a NULL
  `position` into `listing_collections`, so on an automated target each silently
  deletes the other's rows and whichever ran last wins. Refused at write time AND
  filtered at import time — the second is not redundant, it catches a target
  deleted or made automatic after a valid mapping was stored. Detail:
  `docs/channels.md`.
- **`listings.published_at` is the FIRST activation, never the row's birthday.**
  `db/catalog/listingRepository.ts` is its only author and
  `listing-publication-chokepoint.test.ts` fails the build on a fourth writer.
- **Shipping UI is HIDDEN everywhere and Moovo owns logistics entirely** — do NOT
  build shipping zones or rates, and the Moovo logistics port is registered on no
  deployment. Pickup/collection is a different thing and IS built
  (`docs/pickup.md`).
- **ONE locale registry, `@mercaria/ui/src/i18n/`**; module-scope data holds
  KEYS, never sentences. App copy is per app; **`@mercaria/ui`'s own copy is in
  ITS bundles**, merged under the reserved `ui` namespace for the locales that
  app SHIPS — never the union, or the dashboard gains an `ar` it cannot mirror
  — and read through `SharedUiTranslationProvider`, mounted at every app root.
  `validate:i18n-strings` gates all of it plus hardcoded strings, parity and
  unreferenced keys in all three apps. `docs/app-i18n.md`; #437.
- **All four client packages mirror for Arabic from LOGICAL utilities only**
  (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `rounded-s-`);
  `validate:rtl-classes` gates all four; a physical `ml-2` half-mirrors its
  screen with every build green. Direction follows the SHIPPED BUNDLES, never the
  tag (#434). `border-s-*`/`text-start` do NOT survive react-native-css/RN 0.85
  and stay physical, as do a panel's `translateX` sign and divider edge (LOGICAL
  `side` in `ui/src/lib/logical-side.ts`); `validate-rtl-upstream-premises.mjs`
  re-measures both premises against the INSTALLED packages. Residual: #429 item 2
  — nothing renders, #486 blocks review, Arabic NOT fully supported.
- **Dockerfile node-gyp pin.** The API Dockerfile is at the repo ROOT and pins
  `node-gyp` in the builder stage; `ws`'s optional native accelerators have no
  musl-arm64 prebuild and an on-demand `bunx node-gyp@latest` fails
  intermittently on ARM. Do NOT remove it.
- **`ci.yml`'s `Lint & Test` must stay on x86** (`deploy-aws.yml` builds on ARM)
  — ARM runners support no service containers and `postgis/postgis` is
  amd64-only. Don't "fix" the mismatch.
- **Web apps deploy to Cloudflare Workers, NOT Pages**, and via **`bunx wrangler`
  directly, never `cloudflare/wrangler-action`** — its `npm i wrangler` chokes on
  `workspace:*`. All four deploys gate on `ci.yml`'s verdict for that commit;
  none may run a copy of the suite (#518). Topology, gating and handoff:
  `docs/deploy.md`.
