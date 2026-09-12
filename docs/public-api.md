# The public integration API (`/public/v1`, #1017)

The canonical boundary another Oxy application — Mention, Goway, an agent —
reads Mercaria through. `@mercaria.co/sdk` calls these routes and nothing else;
the wire shapes are `packages/shared-types/src/public-api.ts`, and that file's
header is the contract's own statement of why it exists.

| Piece | Where |
|---|---|
| Contract (refs, DTOs, sorts, limits, error codes) | `packages/shared-types/src/public-api.ts` |
| Router, 404 fallback, path-scoped error handler | `packages/backend/src/routes/public-api.ts` |
| Query schemas | `packages/backend/src/middleware/public-api-schemas.ts` |
| Controller (envelope, defaults) | `packages/backend/src/controllers/public-api.controller.ts` |
| Reads and status rules | `packages/backend/src/services/public-api/public-api.service.ts` |
| Field-by-field projection | `packages/backend/src/services/public-api/projection.ts` |
| URL builders | `packages/backend/src/services/public-api/urls.ts` |
| Cursor | `packages/backend/src/services/public-api/cursor.ts` |
| CORS decision | `isPublicReadCorsRequest` in `packages/backend/src/lib/allowed-origins.ts` |
| Proof | `routes/__tests__/public-api.realdb.test.ts`, `services/public-api/__tests__/urls-and-cursor.test.ts` |

## Routes

GET only (HEAD is answered by the same handlers). Mounted unconditionally in
`app.ts`, after `express.json()`, with `optionalAuth` and the `public-api`
rate-limit scope.

| Route | Query | `data` |
|---|---|---|
| `GET /public/v1/products` | `q` `storeId` `collectionId` `inStock` `sort` `locale` `limit` `cursor` | `MercariaPage<MercariaProductSummary>` |
| `GET /public/v1/products/:id` | — | `MercariaProduct` |
| `GET /public/v1/stores/lookup` | `handle` (required) | `MercariaStore` |
| `GET /public/v1/stores/:id` | — | `MercariaStore` |
| `GET /public/v1/stores/:id/products` | `q` `inStock` `sort` `locale` `limit` `cursor` | `MercariaPage<MercariaProductSummary>` |
| `GET /public/v1/stores/:id/collections` | `limit` `cursor` | `MercariaPage<MercariaCollection>` — published only |
| `GET /public/v1/collections/:id` | — | `MercariaCollection` |
| `GET /public/v1/collections/:id/products` | `limit` `cursor` | `MercariaPage<MercariaProductSummary>` — the collection's own sort order |

`/stores/lookup` is registered before `/stores/:id`.

## The envelope

Success is `{ "success": true, "data": … }`. Failure is
`{ "success": false, "error": <MercariaPublicErrorCode>, "message": "…" }`, and a
consumer branches on `error`, never on `message`.

| Status | `error` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | a query the schema refuses, a foreign or malformed cursor, a body that will not parse |
| 404 | `NOT_FOUND` | see the status rules |
| 404 | `UNKNOWN_ROUTE` | any unmatched path or non-GET method under `/public/v1` — never `NOT_FOUND`, so a client/server route mismatch cannot read as a missing entity |
| 410 | `GONE` | see the status rules |
| 500 | `INTERNAL_ERROR` | anything unexpected — the message is a fixed generic string |

Every failure under the prefix is JSON. The router ends in a JSON `NOT_FOUND`
fallback, every handler catches its own errors, and `app.ts` mounts a
path-scoped error handler right behind the router so an error raised ABOVE it (a
malformed body on a GET) does not reach the global handler's non-contract
`{ error: 'Something went wrong!' }`.

**One exception, stated rather than hidden: a 429.** Both limiters on the path —
`general` above every route and `public-api` on the router — come from
`createOxyRateLimit`, whose refusal body is a plain string, not JSON. A consumer
must map HTTP 429 to `RATE_LIMITED` from the STATUS, whatever the body says — and
so must the SDK.
Making it JSON would change the 429 body of every route on the API, which is a
decision about all of them rather than about this surface.

## Status semantics

A consumer holds a persisted reference and hydrates it on every render, so the
distinction it cannot live without is "never existed" versus "existed and is
gone". Decided once per kind in `public-api.service.ts`:

| Entity | 200 | 410 `GONE` | 404 `NOT_FOUND` |
|---|---|---|---|
| product | `active`; `sold` (availability `sold`) | `archived`, `restricted`, a `draft` whose `published_at` is set, or its store `suspended`/`closed` | no row, a malformed id, a `draft` never published |
| store (by id or handle) | `active` | `suspended`, `closed` | no row, a malformed id, an unknown handle |
| collection | published, store `active` | unpublished with `published_at` set, or store not `active` | no row, a malformed id, never published |

- **"Was published" is a stored fact, not a guess.** `listings.published_at` is
  the FIRST activation (one writer, `listingRepository`), and
  `collections.published_at` is stamped on first publish and never cleared.
- **A never-published draft is a 404 even inside a suspended store.** It never
  publicly existed, so no reference to it can have been legitimately minted.
- **A 410 carries no entity data and does not say why.** Whether a seller
  archived a listing or a moderation jury withdrew it is not a fact another
  application may read.
- **A malformed id is a 404, not a 400.** A persisted reference with a bad id is
  simply not found; `isLiveEntityId` decides the shape before any query.
- **A list scoped to an entity applies that entity's gate first.**
  `/stores/:id/products` over a closed store is a 410, and so is
  `/products?storeId=` naming one; `/products?collectionId=` naming an unpublished
  collection is a 404 or 410 — never an empty page, and never a way to enumerate
  the members of a collection its merchant has not published.

**Lists only contain publicly live products.** Every list reads
`status = 'active'`, and the product search sets `liveStoresOnly`, which drops a
store-owned listing whose store is not `active`. The storefront's own
`GET /listings` does NOT set it and serves exactly what it served before — a
foreign application must simply never be handed a card whose detail read is a
410.

## Queries

Every schema is `.strict()`: an unknown parameter is a 400, because a caller who
misspells `inStock` must not receive an unfiltered page it reads as filtered. A
repeated parameter is a 400. Exact spellings, never `z.coerce`:

- `q` — 1..200 characters after trimming.
- `sort` — one of `MERCARIA_PRODUCT_SORTS`. Default `relevance` when `q` is
  present, `newest` otherwise. `sort=relevance` without `q` is a 400.
- **What `relevance` orders by is not part of the contract.** The listing search
  treats a text match as a predicate and orders matches newest-first — what
  `GET /listings?q=` has always served — so `relevance` maps onto that order
  today. `newest` is `published_at desc nulls last, id desc`; `price_asc` and
  `price_desc` order the listing's lowest price, then `id`.
- `inStock` — the string `true` or `false`. `true` keeps listings with at least
  one buyable variant; `false` applies no filter.
- `locale` — 2..35 characters, shape-checked like `GET /listings`; also searches
  that locale's translations. No effect without `q`.
- `limit` — decimal digits, 1..`MERCARIA_PUBLIC_PAGE_LIMIT_MAX` (50), default
  `MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT` (20).
- `storeId`, `collectionId`, `handle` — opaque strings, resolved by the read.

## Pagination

`nextCursor` is opaque and `null` on the last page. Pass it back verbatim with the
SAME filters.

- Today it is a base64url JSON payload carrying a version, the list kind, a
  fingerprint and an OFFSET. None of that is a promise.
- **The fingerprint** digests the list kind, its scope (store or collection id)
  and its filters and sort. A cursor minted by a different list or under
  different filters is a 400, not a first page — resuming an offset that means
  nothing there would silently drop results.
- **`limit` may change between pages.** It is not in the fingerprint; the offset
  counts items, so no page duplicates or skips.
- **Deterministic** for an unchanging catalogue: every ordering ends in `id`, and
  equal requests mint identical cursors. Under concurrent writes a product
  published or withdrawn between two reads shifts the boundary by one item.
- **A list ends at 10,000 items** (`PUBLIC_CURSOR_MAX_OFFSET`). OFFSET cost grows
  with depth, so the page reaching the ceiling is cut short and carries
  `nextCursor: null`. A consumer that needs a whole store's catalogue beyond that
  wants an export, not this surface.
- Reads fetch `limit + 1` rows and run no `count(*)`.

## The projection is field by field, and why

`projection.ts` names every output field and the one input it comes from. It
never spreads a `Listing`, a `StoreRow` or a `CollectionRow`, and never returns an
input object. The storefront DTOs carry connector provenance, variant SKUs and
barcodes, tags, vendor and product-type strings, a manual collection's raw member
ids (including non-active ones) and its automation rules, SEO overrides and raw
Oxy file ids — so the premise is `docs/house-invariants.md`'s "DTOs are
ALLOW-lists that REFUSE", applied at a wire boundary: a field added to `Listing`
tomorrow reaches no other application unless somebody adds it to the contract and
to this file on purpose.

The product half reads the HYDRATED `Listing` rather than rows, because each fact
below is decided once in `catalog-hydration.service` and a second derivation would
drift from the product page a shopper sees:

| Field | Source |
|---|---|
| `price` | the cheapest PRICED variant, else the listing's price facet |
| `compareAtPrice` | the cheapest variant's compare-at price, else `null` |
| `priceRange` | the range across priced variants; `null` when min equals max |
| `availability` | `sold` for a sold listing; else `in_stock` when any variant is buyable (untracked, or stock above zero), else `out_of_stock` |
| `purchaseOptions[].availability` | the variant's own; every option of a SOLD product is `out_of_stock` |
| `primaryImage`, `images` | the gallery in position order, resolved through `resolveMedia`; `alt` is `null` when absent or blank |
| `condition` | `itemCondition.key` and `.group` |
| `seller` (store) | the store ROW the read already loaded to gate it — id, current handle, name, resolved logo |
| `seller` (person) | the hydrated Oxy identity — `oxyUserId`, display name, username, resolved avatar, `isVerified` |
| `viewer` | `null` anonymously; `{ saved }` from the caller's favourites when `optionalAuth` verified a session |

Stores: `description` is `null` when empty; `rating` comes from
`resolveStoreRatingSource` (the merchant aggregate when linked, the store's own
figures otherwise — the one place the store page chooses it) and is `null` when
`reviewCount` is 0. Collections carry no type, rules, member ids, handle or SEO.
Collection lists and collection lookups load the row WITHOUT its rules
(`findCollectionRowById`, `findPublishedCollectionsSlice`), and the store lookup
loads the row WITHOUT members (`findStoreRowByHandle`): a value that is never
loaded cannot be serialized by mistake.

The realdb suite proves both halves: every body's key set EQUALS the contract's,
recursively, and a set of private sentinels seeded into the fixtures (SKU,
barcode, connector external id, tag, vendor, product type, collection rule value,
SEO title, listing and collection handles, a store member's Oxy id, the ids of a
manual collection's draft and archived members) appears in no serialized body.

## URLs

The server is the authority for these strings, and the SDK's link helpers mirror
them exactly. `urls.ts` is three pure functions with no config read inside:

```
product     ${origin}/products/${encodeURIComponent(productId)}
store       ${origin}/stores/${encodeURIComponent(storeHandle)}
collection  ${origin}/stores/${encodeURIComponent(storeHandle)}?collection=${encodeURIComponent(collectionId)}
```

- `origin` is `config.web.origin` (`WEB_URL`, default `https://mercaria.co`) with
  every trailing `/` removed.
- A store is addressed by its CURRENT handle — the storefront route is
  `/stores/[handle]` — which is why the SDK should build store and collection
  links from a freshly read `handle`, never a persisted one.
- `app/(app)/stores/[handle].tsx` honours `?collection=<id>` as the initial
  selection, and filters by it only when it names a published collection of that
  store.

## CORS

Browsers on other Oxy origins must be able to call these GETs, with a bearer token
rather than cookies. `isPublicReadCorsRequest(method, path)` in
`lib/allowed-origins.ts` — the ONE origin authority — admits a request to a
separate policy when the path is `/public/v1` or under `/public/v1/` AND the
method is GET, HEAD or OPTIONS:

- `Access-Control-Allow-Origin: *`, and NO `Access-Control-Allow-Credentials` — a
  browser refuses to attach cookies to a wildcard response.
- Allowed methods `GET,HEAD,OPTIONS`; a preflight for any other method is answered
  with that list and the browser refuses it.
- Allowed request headers `Authorization`, `Content-Type`, `Accept`,
  `Accept-Language`.

Nothing else moves. `ALLOWED_ORIGINS` and `isAllowedBrowserOrigin` are unchanged,
so every other route keeps the credentialed allow-list and the guest CSRF gate —
which guards cookie-authenticated WRITES, none of which live under this prefix —
reads exactly the list it read before. The prefix match is case-sensitive while
Express routing is not, so `/PUBLIC/v1/...` reaches the router under the
credentialed policy: the restrictive direction.

## Auth, rate limiting, caching

- `optionalAuth` attaches a verified Oxy caller; a token that fails verification
  is read as anonymous (the SDK middleware's documented behaviour, see
  `middleware/auth.ts`). Nothing on this surface requires a session.
- `public-api` is its own rate-limit scope (`rl:public-api:`), so an integration's
  backfill does not spend the storefront's `listings` or `stores` budget. At the
  SDK defaults it is dominated by `general` above every route; the scope exists so
  this surface can be tuned without re-metering the storefront. A server-side
  integration calling from one address shares one anonymous per-IP budget.
- Every response carries `Vary: Authorization`, because `viewer` depends on it.
  No `Cache-Control` is set.

## Freshness

Every read is CURRENT truth. Prices are the listing's NATIVE currency and nothing
converts them — no FX, no presentment guess. A price or an availability read here
is a fact about the moment it was served and must not be persisted as
authoritative; order and payment snapshots live in the order domain and are never
reconstructed from these reads.

## Deliberately not exposed

- Connector provenance, variant SKUs and barcodes, inventory counts, tags, vendor,
  product type, category strings, listing and collection handles, SEO overrides,
  collection type, rules and member ids, store policies, members, currency and
  tax settings, offer, affiliate and retail-binding provenance.
- Writes of any kind — carts, checkout, saves, follows. `viewer.saved` is read
  only.
- Reviews, seller profiles and seller ratings. A person seller's card carries
  identity only.
- **The canonical product grain (ADR 0002)** — canonical products, families,
  offers and comparison. A `MercariaProductRef` names the SELLABLE listing, and a
  multi-seller canonical identity is a different grain this contract does not
  carry yet.
- **P2P seller visibility rules** beyond what `GET /listings/:id` applies. This
  surface serves a person-owned listing exactly when the storefront product page
  does; the seller-profile visibility derivation (`docs/seller-profiles.md`)
  governs the profile page and is not applied here, as it is not applied there.
