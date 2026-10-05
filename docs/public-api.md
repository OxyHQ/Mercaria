# The public integration API (`/public/v1`, #1017)

The canonical boundary another Oxy application — Mention, Goway, an agent —
reads Mercaria through. `@mercaria.co/sdk` calls these routes and nothing else.
It follows Oxy's shared API conventions (`~/Oxy/docs/api-conventions.md`): one
zod contract, bare success bodies, `{ error: { code, message, details? } }`
failures with snake_case codes, `{ items, nextCursor }` pages, and an OpenAPI
3.1 document generated from a route registry.

| Piece | Where |
|---|---|
| Contract: request schemas, DTOs, refs, sorts, limits, error codes, cursor kinds — zod 4, types by `z.infer` | `packages/contracts/src/` (`@mercaria/contracts`) |
| Route registry (method, path, params, query, response, errors) | `packages/contracts/src/routes.ts` |
| OpenAPI 3.1, generated from the registry, committed and served | `packages/contracts/src/openapi.ts` → `packages/contracts/openapi.json` → `GET /public/v1/openapi.json` |
| Router (mounts the registry), `unknown_route` fallback | `packages/backend/src/routes/public-api.ts` |
| Controller (handler per `operationId`, request parsing, response parsing, defaults) | `packages/backend/src/controllers/public-api.controller.ts` |
| Refusals in the contract's codes (`PublicApiError`) | `packages/backend/src/services/public-api/errors.ts` |
| Reads and status rules | `packages/backend/src/services/public-api/public-api.service.ts` |
| Location rows and per-location stock | `packages/backend/src/db/pickup/publicLocationRepository.ts` |
| Field-by-field projection | `packages/backend/src/services/public-api/projection.ts` |
| URL builders | `packages/backend/src/services/public-api/urls.ts` |
| Cursor | `packages/backend/src/services/public-api/cursor.ts` |
| CORS decision | `isPublicReadCorsRequest` in `packages/backend/src/lib/allowed-origins.ts` |
| Proof | `routes/__tests__/public-api.realdb.test.ts` (the wire), `routes/__tests__/public-api-locations.realdb.test.ts` (the location reads, against a fake GoWay), `routes/__tests__/public-api-sdk-contract.realdb.test.ts` (the SDK against both), `services/public-api/__tests__/urls-and-cursor.test.ts`, `packages/contracts/test/`, `validate:openapi` and `validate:contract-json-schemas` |

## Routes

GET only (HEAD is answered by the same handlers). Mounted unconditionally in
`app.ts`, after `express.json()`, with `optionalAuth` and the `public-api`
rate-limit scope. The router mounts every entry of `MERCARIA_PUBLIC_ROUTES` in
registry order against the controller's handler for its `operationId`, so a
route cannot be served without being documented, nor documented without a
handler (the controller's handler map is typed by the registry).

| Route | Query | 200 body |
|---|---|---|
| `GET /public/v1/products` | `q` `storeId` `collectionId` `inStock` `sort` `locale` `limit` `cursor` | `MercariaPage<MercariaProductSummary>` |
| `GET /public/v1/products/:id` | — | `MercariaProduct` |
| `GET /public/v1/stores/lookup` | `handle` (required) | `MercariaStore` |
| `GET /public/v1/stores/:id` | — | `MercariaStore` |
| `GET /public/v1/stores/:id/products` | `q` `inStock` `sort` `locale` `limit` `cursor` | `MercariaPage<MercariaProductSummary>` |
| `GET /public/v1/stores/:id/collections` | `limit` `cursor` | `MercariaPage<MercariaCollection>` — published only |
| `GET /public/v1/stores/:id/locations` | `limit` `cursor` | `MercariaPage<MercariaLocation>` — the store's public shop fronts |
| `GET /public/v1/collections/:id` | — | `MercariaCollection` |
| `GET /public/v1/collections/:id/products` | `limit` `cursor` | `MercariaPage<MercariaProductSummary>` — the collection's own sort order |
| `GET /public/v1/locations` | `goWayPlaceId` (required) `limit` `cursor` | `MercariaPage<MercariaLocation>` — the shop fronts trading from one GoWay place |
| `GET /public/v1/locations/:id` | — | `MercariaLocation` |
| `GET /public/v1/locations/:id/products` | `q` `inStock` `sort` `locale` `limit` `cursor` | `MercariaPage<MercariaLocationProduct>` — the store's live products stocked there |
| `GET /public/v1/openapi.json` | — | this surface's OpenAPI 3.1 document |

`/stores/lookup` is registered before `/stores/:id` (registry order).

## Bodies and errors

A success body IS the value — no envelope. Before it is sent the controller
parses it with the route's response schema, so a projection that drifted from
the contract is an `internal_error` in our logs, never a malformed body in a
consumer.

Every failure is `{ "error": { "code", "message", "details"? } }`. A consumer
branches on `code`, never on `message`; `details` holds scalars only (`field` on
a refused request, `retryAfterSeconds` on a 429) and never user content.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | not well-formed: a wrong type, a missing, unknown or repeated query parameter, a foreign or malformed cursor, a body that will not parse |
| 422 | `validation_failed` | well-formed, but a value is refused: a `limit` out of range, an unknown `sort`, `relevance` without `q`, a blank `q` or `handle` |
| 404 | `not_found` | see the status rules |
| 404 | `unknown_route` | any unmatched path or non-GET method under `/public/v1` — never `not_found`, so a client/server route mismatch cannot read as a missing entity |
| 410 | `gone` | see the status rules |
| 429 | `rate_limited` | a limiter refused it; `details.retryAfterSeconds` equals the `Retry-After` header |
| 503 | `service_unavailable` | a location read could not ask GoWay whether the location's place still names it, and nothing recent is cached |
| 500 | `internal_error` | anything unexpected — the message is a fixed generic string |

The closed list (`MERCARIA_PUBLIC_ERROR_CODES`) is the shared Oxy set; renaming a
code is a breaking change, and `validate:openapi` pins it. Shape versus value is
decided ONCE, by `classifyRequestIssues` in the contract — an issue about the
request's shape (`invalid_type`, `unrecognized_keys`, `invalid_format`, …) wins —
and the SDK applies the same function to refuse a query before sending it.

Every failure under the prefix is JSON. The router ends in a JSON
`unknown_route` fallback; every handler catches its own errors; an error raised
ABOVE the router (a malformed body sent with a GET) reaches `app.ts`'s global
handler, which answers in the same shape (`bad_request` for a body-parser 4xx,
`internal_error` otherwise).

**The 429 is JSON too.** Both limiters on the path — `general` above every
route and `public-api` on the router — come from `makeRateLimiter`
(`createOxyRateLimit`), and every limiter in `lib/rate-limit.ts` answers with
`rateLimitedBody`: the convention's shape, with `details.retryAfterSeconds` read
back from the `Retry-After` header express-rate-limit has just set. Because
`general` meters every route, this is the 429 body of the whole API, not just
of this surface. `@oxy.so/core` 4.2.0's `createOxyRateLimit` types its `message`
option as a string while passing it to express-rate-limit unchanged, so the body
function is passed through a cast that a wider upstream type would retire.

## Status semantics

A consumer holds a persisted reference and hydrates it on every render, so the
distinction it cannot live without is "never existed" versus "existed and is
gone". Decided once per kind in `public-api.service.ts`:

| Entity | 200 | 410 `gone` | 404 `not_found` |
|---|---|---|---|
| product | `active`; `sold` (availability `sold`) | `archived`, `restricted`, a `draft` whose `published_at` is set, or its store `suspended`/`closed` | no row, a malformed id, a `draft` never published |
| store (by id or handle) | `active` | `suspended`, `closed` | no row, a malformed id, an unknown handle |
| collection | published, store `active` | unpublished with `published_at` set, or store not `active` | no row, a malformed id, never published |
| location | published, active, unrestricted, store `active`, and its GoWay place names it back | withdrawn or returned to draft after publishing, restricted, deactivated, store not `active`, or its place no longer vouches for it | no row or no publication, a malformed id, never published |

- **"Was published" is a stored fact, not a guess.** `listings.published_at` is
  the FIRST activation (one writer, `listingRepository`), and
  `collections.published_at` is stamped on first publish and never cleared.
  So is `location_publications.published_at`, stamped by `setPublicationState`
  on any move into or out of `published` (`0160` backfilled it from the
  publication trail).
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

### Locations: the trust link, and GoWay down

A location is a shop front trading from a GoWay place (ADR 0013), and it is
public only while that place names it back: `commerce.mercaria.store` = the
location id, at `business_asserted` or `oxy_verified` (`docs/pickup.md` §3).
That clause is checked against GoWay on every location read — through the
cached place read, fresh for at most a minute — so a place that stops naming
the location turns its detail read into a 410 and drops it from every list at
the next read, and a place that names it again brings it back. Nothing is
stored.

- **A broken link is a 410, not a 404.** The location existed and was public;
  a consumer holding its ref must learn it is gone, and the 410 does not say
  whether the merchant withdrew it, an operator restricted it or the place
  stopped vouching.
- **GoWay unable to answer is a 503, never a 410.** With nothing recent cached
  (a last-good place serves for a day), Mercaria cannot say yes or no, and a
  consumer may act on `gone` by discarding a good ref. The SDK maps it to the
  retryable `MercariaUnavailableError`.
- **A place nobody trades from is an empty page.** `?goWayPlaceId=` is a filter
  over another product's id space; there is no Mercaria entity to 404. A list
  asks GoWay only when it has a row to ask about — once per distinct place on
  the page — so a place with no Mercaria location never depends on GoWay, and a
  page may come back shorter than `limit` with a next cursor.
- **One place, at most one location today.** A place names one location at its
  strongest tier, so the place list has at most one item; it is a page so a
  shared place (a mall) would change nothing for a consumer.
- **`discoverable`** is the location half of #93's collection conjunction
  (`locationCollectionBlockers`): collection offered and not paused, the place
  complete enough to take one. `false` says nothing about which.

**Lists only contain publicly live products.** Every list reads
`status = 'active'`, and the product search sets `liveStoresOnly`, which drops a
store-owned listing whose store is not `active`. The storefront's own
`GET /listings` does NOT set it and serves exactly what it served before — a
foreign application must simply never be handed a card whose detail read is a
410.

## Queries

The query schemas are the contract's (`packages/contracts/src/requests.ts`), and
every one is strict: an unknown parameter is a 400 `bad_request`, because a
caller who misspells `inStock` must not receive an unfiltered page it reads as
filtered. A repeated parameter is a 400. Exact spellings, never `z.coerce`:

- `q` — 1..200 characters after trimming.
- `sort` — one of `MERCARIA_PRODUCT_SORTS`. Default `relevance` when `q` is
  present, `newest` otherwise. `sort=relevance` without `q` is a 422.
- **What `relevance` orders by is not part of the contract.** The listing search
  treats a text match as a predicate and orders matches newest-first — what
  `GET /listings?q=` has always served — so `relevance` maps onto that order
  today. `newest` is `published_at desc nulls last, id desc`; `price_asc` and
  `price_desc` order the listing's lowest price, then `id`.
- `inStock` — the string `true` or `false` (anything else is a 422). `true`
  keeps listings with at least one buyable variant; `false` applies no filter.
- `locale` — 2..35 characters, shape-checked like `GET /listings`; also searches
  that locale's translations. No effect without `q`.
- `limit` — decimal digits (anything else is a 400),
  1..`MERCARIA_PUBLIC_PAGE_LIMIT_MAX` (50, outside it a 422), default
  `MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT` (20).
- `storeId`, `collectionId`, `handle` — opaque strings, resolved by the read.
- `goWayPlaceId` — GoWay's opaque place id, 1..128 characters after trimming
  (GoWay's own bound). Required on `GET /locations`: there is no list of every
  location.
- On `GET /locations/:id/products`, `inStock=true` keeps products with a fresh,
  positive count AT THE LOCATION (`in_stock` or `low_stock`), not the listing's
  stock anywhere.

## Pagination

`nextCursor` is opaque and `null` on the last page. Pass it back verbatim with the
SAME filters.

- Today it is a base64url JSON payload carrying a version, the list kind, a
  fingerprint and an OFFSET. None of that is a promise.
- **The fingerprint** digests the list kind (`MERCARIA_PUBLIC_CURSOR_KINDS`, one
  per list route in the registry), its scope (store or collection id) and its
  filters and sort. A cursor minted by a different list or under different
  filters is a 400 `bad_request` with `details.field: "cursor"`, not a first
  page — resuming an offset that means nothing there would silently drop
  results.
- **`limit` may change between pages.** It is not in the fingerprint; the offset
  counts items, so no page duplicates or skips.
- **Deterministic** for an unchanging catalogue: every ordering ends in `id`, and
  equal requests mint identical cursors. Under concurrent writes a product
  published or withdrawn between two reads shifts the boundary by one item.
- **A list ends at 10,000 items** (`MERCARIA_PUBLIC_LIST_MAX_OFFSET`). OFFSET cost grows
  with depth, so the page reaching the ceiling is cut short and carries
  `nextCursor: null`. A consumer that needs a whole store's catalogue beyond that
  wants an export, not this surface.
- Reads fetch `limit + 1` rows and run no `count(*)`.

## The OpenAPI document

`mercariaPublicOpenApiDocument()` builds it from the registry and the named
schemas (`CONTRACT_JSON_SCHEMA_NAMES`, each a `#/components/schemas/<name>`
component, `$ref`-linked, from `z.toJSONSchema` on the INPUT side: response
objects stay open to added fields, persisted refs and queries stay closed). Paths
and components are sorted, so a regeneration diff is the semantic diff.

- **Committed** as `packages/contracts/openapi.json`. `bun run openapi:generate`
  writes it; read the diff for REMOVED lines.
- **Served** at `GET /public/v1/openapi.json`, built once per process — the same
  document, which the wire suite asserts against the committed file. CORS and
  rate limiting as every other route.
- **Gated** by `validate:openapi` (`scripts/check-public-openapi.mjs`): the
  operations by NAME in both directions, every operation's payloads, the error
  code enum, the 3.1 dialect, and freshness against the contract. And by
  `validate:contract-json-schemas`: every named schema converts. Each has a
  `test-check-*.mjs` proving it fails.
- **Refinements are not in it.** A condition key belonging to its group, a
  purchase option naming its own product, `relevance` requiring `q`: the zod
  schema is the authority, and a body that passes the JSON Schema is
  well-formed, not accepted.

Adding a route is a cursor kind (for a list) and any new schema in the contract, an entry in `MERCARIA_PUBLIC_ROUTES`,
a handler for its `operationId` in the controller, the operation's name in the
gate's `EXPECTED_OPERATIONS`, and a regeneration.

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

### Locations, and availability at one

`MercariaLocation` is Mercaria's half of a shop front: its ref, its
`goWayPlaceId`, its store (ref, current handle, name, resolved logo), its
collection terms (`pickup`: identity and payment requirements and the
merchant's instructions; `null` when collection is not offered),
`discoverable`, and its `url`. **No place fact is projected** — not the name,
the address, the hours, the photos or the rating: those are GoWay's, and a
consumer reads them from GoWay with `goWayPlaceId`. Nothing of the OPERATIONAL
location (its internal name, type and delivery address) is even selected, nor a
pause reason, a restriction reason or the operator behind one.

`MercariaLocationProduct` is a product summary plus its availability at the
location, decided per product by the derivation nearby discovery applies
(`services/pickup/eligibility.ts`):

| Field | Source |
|---|---|
| `availability` | the units the product's FRESH level rows there vouch for (`inventoryBlockers`: a count older than the location's `stock_confirmation_interval_seconds` vouches for nothing), summed across its options and cut by `locationAvailabilityState` at the location's `low_stock_threshold`: `out_of_stock` at 0, `low_stock` up to the threshold, `in_stock` above |
| `exactQuantity` | that sum — present ONLY where the location's `discloses_exact_stock` is on AND some count is fresh; absent otherwise |
| `stockConfirmedAt` | the OLDEST fresh confirmation the figure rests on, or the LATEST confirmation when none is fresh |

"Stocked at the location" is a level row there; the list is the store's live
products with one, in the store list's orders.

Stores: `description` is `null` when empty; `rating` comes from
`resolveStoreRatingSource` (the merchant aggregate when linked, the store's own
figures otherwise — the one place the store page chooses it) and is `null` when
`reviewCount` is 0. Collections carry no type, rules, member ids, handle or SEO.
`oxyAccountId` is the owning Oxy account (ADR 0012) — public on purpose, as
the cross-app key another Oxy product (GoWay) matches a business on. Who may
ACT for the store is not: the caller's `access` and the store's permission
overrides live only on `/admin` and are never loaded here. Collection lists and
collection lookups load the row WITHOUT its rules (`findCollectionRowById`,
`findPublishedCollectionsSlice`): a value that is never loaded cannot be
serialized by mistake.

The realdb suite proves both halves: every body's key set EQUALS the contract's,
recursively, and a set of private sentinels seeded into the fixtures (SKU,
barcode, connector external id, tag, vendor, product type, collection rule value,
SEO title, listing and collection handles, a permission override's Oxy user id, the ids of a
manual collection's draft and archived members) appears in no serialized body.

## URLs

The server is the authority for these strings, and the SDK's link helpers mirror
them exactly. `urls.ts` is three pure functions with no config read inside:

```
product     ${origin}/products/${encodeURIComponent(productId)}
store       ${origin}/stores/${encodeURIComponent(storeHandle)}
collection  ${origin}/stores/${encodeURIComponent(storeHandle)}?collection=${encodeURIComponent(collectionId)}
location    ${origin}/stores/${encodeURIComponent(storeHandle)}?location=${encodeURIComponent(locationId)}
```

- `origin` is `config.web.origin` (`WEB_URL`, default `https://mercaria.co`) with
  every trailing `/` removed.
- A store is addressed by its CURRENT handle — the storefront route is
  `/stores/[handle]` — which is why the SDK should build store and collection
  links from a freshly read `handle`, never a persisted one.
- `app/(app)/stores/[handle].tsx` honours `?collection=<id>` as the initial
  selection, and filters by it only when it names a published collection of that
  store; and `?location=<id>` by listing that shop front first in its "Visit us"
  section.

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

- **Inventory counts, except by the merchant's choice.** Stock reaches this
  surface only as a location's BOUNDED availability (`in_stock | low_stock |
  out_of_stock`), and as a number (`exactQuantity`) only where that location's
  merchant opted in to disclosing exact stock and the count is fresh. A
  product's own `availability` is never a count.
- **A location's place facts** — they are GoWay's (ADR 0013) — and its
  operational name and address, pause and restriction reasons.
- Connector provenance, variant SKUs and barcodes, tags, vendor,
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
