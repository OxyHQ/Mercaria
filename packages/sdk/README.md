# @mercaria.co/sdk

The canonical TypeScript client for [Mercaria](https://mercaria.co)'s public
commerce API. If an Oxy app — Mention, Goway, Nilo, an assistant or a service —
needs Mercaria products, stores, collections or a store's locations, it reads them through this
package instead of knowing Mercaria's HTTP routes, copying its types or
building its URLs.

- **Headless and isomorphic.** Node 18+, Bun, browsers and React Native (Expo)
  from one entry. No React; one runtime dependency, `zod`.
- **Typed end to end.** The public contract's types ship with the package, and
  every response is parsed with the contract's own zod schemas — the same ones
  the server validates with — before you see it. TypeScript consumers need the
  DOM lib or `@types/node` (zod's declarations name `URL`).
- **Refs are identity; reads are current truth.** Persist a ref, hydrate it
  every time you render.

```sh
bun add @mercaria.co/sdk     # or: npm install @mercaria.co/sdk
```

## Contents

- [Create a client](#create-a-client)
- [Anonymous and Oxy-authenticated reads](#anonymous-and-oxy-authenticated-reads)
- [Products and search](#products-and-search)
- [Variants](#variants)
- [Stores](#stores)
- [Collections](#collections)
- [Locations: products at a shop on a map](#locations-products-at-a-shop-on-a-map)
- [Catalog: one product, every seller](#catalog-one-product-every-seller)
- [Links](#links)
- [References](#references)
- [Pagination](#pagination)
- [Locale](#locale)
- [Errors](#errors)
- [Freshness and caching](#freshness-and-caching)
- [Privacy and security boundaries](#privacy-and-security-boundaries)
- [Example: a Mention-like integration](#example-a-mention-like-integration)
- [Do not do this](#do-not-do-this)

## Create a client

```ts
import { createMercariaClient } from '@mercaria.co/sdk';

const mercaria = createMercariaClient();
```

Every option is optional:

| Option | Default | |
| --- | --- | --- |
| `apiBaseUrl` | `https://api.mercaria.co` | The API origin. |
| `webBaseUrl` | `https://mercaria.co` | The origin links are built on. |
| `fetch` | the global `fetch` | Own apps pass the shared linked transport; also usable for tests. |
| `getAccessToken` | none | Explicit external credential callback; own apps use shared transport. |
| `locale` | none | Default locale for the list reads that take one; each call can override it. |
| `timeoutMs` | `15000` | Per request, token acquisition and body included. |
| `headers` | none | Extra non-auth headers (a tracing id, say). `Authorization` and `Accept` are refused. |

Create one client per configuration and reuse it; it holds no connection and
no state beyond its options.

## Anonymous and Oxy-authenticated reads

With the default fetch and no credential callback, requests are anonymous.
Public catalogue reads remain available anonymously.

**An Oxy app using the person's session** supplies its existing provider's linked
transport. Oxy owns refresh, account-switch cancellation and destination checks:

```ts
const apiBaseUrl = 'https://api.mercaria.co';
const linked = oxyServices.createLinkedClient({ baseURL: apiBaseUrl });
const mercaria = createMercariaClient({
  apiBaseUrl,
  fetch: linked.fetchOptional,
});
// Keep both for the owning component's lifetime; on its cleanup:
// linked.dispose();
```

Use `linked.fetch` instead when the operation must require authentication.
Do not copy `session.accessToken` or add an app-local refresh/retry loop. Bind the
client to the current Oxy provider, and dispose it when that owner unmounts or is
replaced. This identity transport omits cookies and follows no redirects. The
separate Mercaria storefront guest/cart/portal cookie decision is not covered
by this SDK example.

**Explicit external credentials** retain the `getAccessToken` option. The
callback is resolved for every request and is never cached, stored or logged;
a missing value produces an anonymous request. The SDK sends a supplied token
only as a bearer header and does not refresh it or promote it to own authority.
Callback failures propagate unchanged. External credentials retain their server
scope, revocation and account checks.

The public catalogue's authenticated `product.viewer` value is `{ saved }` for
a signed-in caller and `null` for an anonymous one.

**An Oxy service reading the public catalogue** uses the shared workload client:

```ts
import { mercariaForOxyService } from '@mercaria.co/sdk/server';
const mercaria = mercariaForOxyService(oxyServer);
const page = await mercaria.catalog.search({ query: 'headphones' });
// Dispose when the owning service/component closes, not after every request.
mercaria.dispose();
```

The factory pins Mercaria's receiving audience. Oxy owns workload authentication,
refresh and origin protection; no internal scopes or customer keys are passed.
Public payloads and visibility stay identical to anonymous reads. The verified
application supplies the rate-budget identity, never a fabricated user. This
factory exposes public catalogue reads, not account-private materials operations.
The existing `createMercariaClient({ getAccessToken })` API remains available for
external/user credentials. Its meaning is not promoted by an Oxy brand.

Deploy the receiver that understands canonical workload identity before enabling
this factory in a backend. SDK publication by itself changes no running caller.

## Products and search

```ts
const page = await mercaria.products.search({
  query: 'Cyberpunk 2077',
  inStock: true,
  sort: 'relevance',        // 'relevance' (needs a query) | 'newest' | 'price_asc' | 'price_desc'
  limit: 20,                // 1–50
});

for (const item of page.items) {
  item.ref;            // { kind: 'product', id } — persist this
  item.title;
  item.primaryImage;   // { url, alt } | null
  item.price;          // { amount, currency } — integer minor units, native currency
  item.availability;   // 'in_stock' | 'out_of_stock' | 'sold'
  item.seller;         // a store (with its ref and current handle) or a person (Oxy user id)
  item.url;            // canonical web URL
}

const product = await mercaria.products.get(page.items[0].ref); // or an id string
product.description;
product.images;
product.purchaseOptions; // each with its own variant ref, price and availability
product.updatedAt;
```

`search` also filters by `store` and `collection`, each a ref or an id. A
filter naming a store or collection that does not exist, or is no longer
public, rejects with `MercariaNotFoundError` / `MercariaGoneError` rather than
returning an empty page.

`inStock: true` keeps only products that can be bought now. There is no "only
out of stock" filter: `inStock: false` is the same as leaving it out, and is not
sent.

`price.amount` is an integer count of the currency's minor units (1999 EUR is
€19.99; FAIR has 8 decimals; JPY has none). Format it with your app's money
formatter; never print the raw number.

A **sold** one-off product still reads successfully, with
`availability: 'sold'`: show it, but do not offer to buy it.

## Variants

A variant (purchase option) is resolved through its product:

```ts
import { variantRef } from '@mercaria.co/sdk';

const { product, option } = await mercaria.products.resolveVariant(variantRef(productId, variantId));
option.title;        // e.g. 'Blue / M'
option.price;
option.availability; // 'in_stock' | 'out_of_stock'
```

If the product no longer offers that option, it rejects with
`MercariaNotFoundError` (with `status: null`, because the product itself was
found).

## Stores

```ts
const store = await mercaria.stores.get(storeRef);            // by ref or id
const same = await mercaria.stores.lookup({ handle: 'night-city-games' });

store.ref;         // persist this, never the handle
store.handle;      // current handle; a merchant can change it
store.oxyAccountId; // the owning Oxy account — the cross-app key for the business
store.name;
store.logoUrl;
store.brandColor;  // CSS hex
store.rating;      // 0–5 or null
store.url;

const products = await mercaria.stores.products(store.ref, { sort: 'newest', limit: 24 });
const collections = await mercaria.stores.collections(store.ref);
const locations = await mercaria.stores.locations(store.ref); // its public shop fronts
```

A closed or suspended store rejects with `MercariaGoneError`.

## Collections

```ts
const collection = await mercaria.collections.get(collectionRef);
collection.store;  // the store's ref
collection.title;
collection.image;

const items = await mercaria.collections.products(collection.ref, { limit: 12 });
```

## Locations: products at a shop on a map

A store's physical shop fronts are **locations**. Where a location is — its
name, address, hours, photos and rating — belongs to the GoWay place it trades
from, and is read from GoWay with `location.goWayPlaceId`
(`@goway.to/sdk`); Mercaria serves its own half only: the store, the
collection terms and what is on the shelf.

```ts
// A GoWay place page: which Mercaria shop fronts trade from this place?
const { items } = await mercaria.locations.list({ goWayPlaceId: place.id });
for (const location of items) {
  location.ref;            // persist this — { kind: 'location', id }
  location.store;          // { ref, handle, name, logoUrl }
  location.pickup;         // { identityRequirement, paymentRequirement, instructions } or null
  location.discoverable;   // Mercaria's own nearby search routes shoppers here now
  location.url;            // the store page, opened on this shop front

  // What is on the shelf there, bounded.
  const page = await mercaria.locations.products(location.ref, { inStock: true, limit: 12 });
  for (const item of page.items) {
    item.product;            // a product summary, as everywhere else
    item.availability;       // 'in_stock' | 'low_stock' | 'out_of_stock' AT THIS LOCATION
    item.exactQuantity;      // a number ONLY where the merchant discloses it, else absent
    item.stockConfirmedAt;   // when the shop last confirmed it
  }
}
```

- **A location is listed only while its GoWay place names it back** (as its
  business, at the claimant's or GoWay's tier). A place nobody trades from is an
  empty page, never an error.
- **`locations.get` / `resolveRef` reject with `MercariaGoneError`** once a
  location is withdrawn, restricted, closed with its store, or its place stops
  naming it; `MercariaNotFoundError` when it was never public.
- **`MercariaUnavailableError` (503) means Mercaria could not ask GoWay**, and is
  NOT a reason to drop a stored ref — retry later.
- **A stale count is `out_of_stock`.** Availability is derived from counts the
  shop confirmed within its own declared interval; an older count proves nothing
  about the shelf and carries no number.
- `inStock: true` keeps what is on THIS shelf now; `query`, `sort`, `locale`,
  `limit` and `cursor` work as on `stores.products`.

## Catalog: one product, every seller

`products` reads ONE seller's listing. `catalog` reads the comparison
catalogue: the canonical product — the model, "Phone X 128 GB" — and every
current offer for it, from Mercaria's own stores and people and from the
retailers and open-data sources Mercaria ingests.

```ts
const page = await mercaria.catalog.search({ query: 'phone x', market: 'ES' });
const card = page.items[0];          // { ref, name, image, url, offers: { count, availability, lowestPrice } | null }

const product = await mercaria.catalog.get(card.ref);
product.variants;                    // [{ id, name, gtins: ['00012345678905'] }]
for (const offer of product.offers ?? []) {
  offer.kind;                        // 'native' | 'external' | 'affiliate' | 'informational'
  offer.price;                       // native currency, or null
  mercaria.links.offer(offer);       // where following it goes, or null
}
```

- **A barcode is a query.** `catalog.search({ query: '8412345678905' })` is
  answered by exact identifier.
- **Order is Mercaria's.** Offers arrive in the versioned comparison's ranked
  order; do not present a re-ranking as Mercaria's "best offer".
- **Prices are native and never converted.** A price in a currency Mercaria
  does not model is `null`, never a number in the wrong precision.
- **`offers: null` means comparison is not being served**, never "nobody sells
  it". A search card's `offers: null` means no current offer: the product is
  still a real answer.
- **Follow an external offer only through `links.offer`.** It is Mercaria's
  redirect, which re-checks the offer at click time; the retailer's own URL is
  not published. Render it with the action's `rel` and name `destinationHost`
  beside it. A native offer's link is its Mercaria product page, and its
  `purchaseOption` is the variant ref `products.resolveVariant` hydrates.
- **Show `source` when present.** An open-data offer's licence requires the
  attribution (`name`, `licenceLabel`, `homepage`).
- **A merged product answers as its winner.** Persist the `ref` the body
  carries, and drop a ref only on `MercariaGoneError`.
  `MercariaUnavailableError` means the catalogue is not being served right now.

## Links

Never build Mercaria URLs by hand. The link helpers produce the same strings the
server puts in each DTO's `url`:

```ts
mercaria.links.product(product);             // or a product ref, or an id
mercaria.links.store(store);                 // or a handle, or a store seller
mercaria.links.collection(collection, store); // a collection needs its store's handle
mercaria.links.location(location, location.store); // a location, on its store's page
mercaria.links.offer(offer);                 // a catalog offer: the redirect, the product page, or null
```

A catalog product has no builder: its page is addressed by a slug a ref does
not carry, so use the `url` its body serves.

A store link needs the store's current **handle**, which a ref deliberately
does not carry — hydrate the store (or use the `handle` on a product's store
seller) first. When you already have the DTO, its `url` is the same string.

## References

A ref names an entity and nothing else — no title, image, price or
availability, and no store handle. That is what makes it safe to persist.

```ts
import {
  productRef, variantRef, storeRef, collectionRef, locationRef, catalogProductRef,
  parseMercariaRef, isMercariaRef,
  formatMercariaRef, parseMercariaRefString,
} from '@mercaria.co/sdk';

productRef('prod_1');               // { kind: 'product', id: 'prod_1' } (frozen)
variantRef('prod_1', 'var_1');      // { kind: 'variant', productId, variantId }

// Reading back from your own database or a request body: strict, returns null on anything off.
const ref = parseMercariaRef(row.mercariaRef);

// As a string column or a URL parameter: one canonical string per ref.
formatMercariaRef(productRef('prod_1'));          // 'mercaria:product:prod_1'
parseMercariaRefString('mercaria:store:store_1'); // { kind: 'store', id: 'store_1' }
formatMercariaRef(locationRef('loc_1'));          // 'mercaria:location:loc_1'
formatMercariaRef(catalogProductRef('cp_1'));     // 'mercaria:catalog_product:cp_1'
```

`parseMercariaRef` accepts only a plain object with exactly the keys of its
kind and non-empty string ids; an extra key (a cached title, a price) makes it
`null`. Ids in the string form are percent-encoded, so any id round-trips.

## Pagination

List reads return `{ items, nextCursor }`. The cursor is opaque: pass it back
verbatim, and stop when it is `null`.

A cursor belongs to the list and the filters that produced it. Send it back
with the **same** `query`, `inStock`, `sort`, `locale` and store or collection —
a cursor from a different list or different filters is refused with
`MercariaBadRequestError`. Changing `limit` between pages is fine. A list ends
after 10,000 items (`MERCARIA_PUBLIC_LIST_MAX_OFFSET`); narrow the filters to
reach further.

```ts
const first = await mercaria.stores.products(store.ref, { limit: 50 });
const second = first.nextCursor
  ? await mercaria.stores.products(store.ref, { limit: 50, cursor: first.nextCursor })
  : null;
```

Or walk every page:

```ts
import { iterateMercariaPages } from '@mercaria.co/sdk';

for await (const page of iterateMercariaPages((cursor) => mercaria.collections.products(ref, { cursor }))) {
  render(page.items);
}
```

## Locale

Locale is the one request-context dimension the public API supports. Set a
default on the client and override it per call:

```ts
const mercaria = createMercariaClient({ locale: 'es' });
await mercaria.products.search({ query: 'zapatillas' });            // locale=es
await mercaria.stores.products(store.ref, { locale: 'pt-BR' });     // per-call override
```

It applies to `products.search`, `stores.products` and `locations.products`.
Detail reads (`products.get`, `stores.get`, `collections.get`, `locations.get`
and the `resolve*` helpers), collection product pages and the location lists
take no locale, and the SDK never sends one on them.
Locale changes presentation only, never which entity a ref names.

**There is no market or currency option, on purpose.** Public reads serve each
price in the listing's native currency and convert nothing, so there is no
server-side currency or market to select. A consumer that wants to show another
currency does its own labelled conversion; the SDK will not invent one.

## Errors

Every failure is a `MercariaError` with a stable snake_case `code`, the HTTP
`status` (or `null`), `retryable`, and `details` — the server's scalars, such as
the refused `field`, or `null`. Branch on the class or the code — never on
`message`. The server's error body is `{ error: { code, message, details? } }`.

| Class | When | `retryable` |
| --- | --- | --- |
| `MercariaNotFoundError` | 404 `not_found`: no such entity, never existed | no |
| `MercariaGoneError` | 410 `gone`: existed, no longer publicly available (archived, withdrawn, store closed) | no |
| `MercariaUnavailableError` | 500 `internal_error`, 503 `service_unavailable`, 502, 504…: Mercaria is temporarily unable to answer | yes |
| `MercariaNetworkError` | `network_error`: the request never completed (offline, DNS, reset) | yes |
| `MercariaTimeoutError` | `timeout`: exceeded `timeoutMs` (a network error) | yes |
| `MercariaAbortError` | `aborted`: your `signal` aborted it | no |
| `MercariaRateLimitError` | 429 `rate_limited`; `retryAfterSeconds` from the body or `Retry-After` | yes |
| `MercariaUnauthorizedError` | 401 `unauthorized` | no |
| `MercariaForbiddenError` | 403 `forbidden` | no |
| `MercariaConflictError` | 409 `conflict` | no |
| `MercariaBadRequestError` | 400 `bad_request`: not well-formed — a wrong type, an unknown or repeated parameter, a cursor from another list; or refused before sending | no |
| `MercariaValidationError` | 422 `validation_failed`: well-formed, but a value is refused (a `limit` out of range, `relevance` without a query, an empty id); or refused before sending | no |
| `MercariaResponseError` | `malformed_response`: the response was not the contract | no |
| `MercariaUnknownRouteError` | 404 `unknown_route`: this SDK version and the server disagree about a route — never a missing entity | no |
| `MercariaApiError` | `http_error`: any other non-2xx, including a 404/410 with no Mercaria error body (a proxy); never means the entity is gone. `MercariaUnknownRouteError` extends it | usually no |

A query the server would refuse is refused before it is sent, by the same
contract schema the server validates with: `MercariaBadRequestError` or
`MercariaValidationError` with `status: null` and `details.field` naming the
parameter.

```ts
import { MercariaGoneError, MercariaNotFoundError, isMercariaError } from '@mercaria.co/sdk';

try {
  return { state: 'ok', product: await mercaria.products.resolveRef(ref) };
} catch (error) {
  if (error instanceof MercariaGoneError) return { state: 'no-longer-available' };
  if (error instanceof MercariaNotFoundError) return { state: 'not-found' };
  if (isMercariaError(error) && error.retryable) return { state: 'temporarily-unavailable' };
  throw error;
}
```

Two rules worth knowing:

- **Not found and gone are only reported when Mercaria says so.** A 404 or 410
  without a Mercaria error body (a proxy, a misrouted gateway) is a
  `MercariaApiError`, because it proves nothing about the product. Even on
  `MercariaNotFoundError`, prefer hiding an attachment to deleting the stored
  ref: a hidden ref costs nothing if the answer was wrong.
- **The SDK never retries.** Use `retryable` (and `retryAfterSeconds`) to decide
  whether and when to try again.

Cancel with an `AbortSignal` on any call: `{ signal: controller.signal }`.

Messages never contain your token, request headers or response bodies; a
server message is included only as a bounded single line. `JSON.stringify(error)`
gives `{ name, code, status, retryable, details, message }`. `instanceof` works even when
your app loads both the ESM and the CommonJS build.

## Freshness and caching

Every read returns **current** Mercaria truth at the moment it was served.

- **Price and availability are perishable.** Show them from a fresh read, or
  from a short-lived cache you are willing to be wrong from; never store them as
  authoritative and never treat a cached price as what a buyer will pay — the
  price a buyer pays is decided by Mercaria at checkout.
- **Refs are what you persist.** Store `product.ref`, `store.ref`,
  `collection.ref` (or their string form) and hydrate when you render.
- **Order and payment history is not reconstructed from these reads.** A past
  order's price lives in Mercaria's order records, not in the current product.
- The SDK does no caching. Use your own layer (TanStack Query, Redis) with short
  lifetimes, and handle `MercariaGoneError` by showing "no longer available".
- **Responses vary by caller.** Every response carries `Vary: Authorization`:
  an authenticated product read includes `viewer` facts about that user. Key any
  shared cache by user (or cache only anonymous reads); never serve one user's
  cached authenticated response to another.

## Privacy and security boundaries

The public reads are built field by field from a dedicated public projection,
and the SDK parses them again into fresh objects holding only contract fields,
so a field the server leaked could still not reach you. Through this package
you can never receive:

- wholesale or supplier cost, supplier identity or supplier references
- procurement offers, activation keys, license keys or download secrets
- variant SKUs, barcodes or connector provenance
- inventory counts, except a location's `exactQuantity` where its merchant
  chose to disclose it
- a location's operational name or address, or why it is paused or restricted
- a manual collection's raw member ids or automation rules
- moderation evidence, risk or fraud signals
- payment credentials, guest order-access tokens, or buyer identity
- anything under Mercaria's private or admin APIs

A person seller is identified by their public Oxy user id, display name and
username only. Image and link URLs are always absolute `http(s)`.

## Example: a Mention-like integration

A post attachment persists a ref and hydrates it into a card:

```ts
import {
  createMercariaClient, parseMercariaRef, isMercariaError,
  MercariaGoneError, MercariaNotFoundError,
} from '@mercaria.co/sdk';

const linked = oxyServices.createLinkedClient({ baseURL: 'https://api.mercaria.co' });
const mercaria = createMercariaClient({ fetch: linked.fetchOptional });
// Dispose linked when this integration's owner closes.

// Writing: persist only the ref.
await db.attachments.insert({ postId, mercariaRef: picked.ref });

// Reading: validate what came back from storage, then hydrate current facts.
export async function productCard(stored: unknown) {
  const ref = parseMercariaRef(stored);
  if (ref?.kind !== 'product') return { state: 'invalid' as const };
  try {
    const product = await mercaria.products.resolveRef(ref);
    return {
      state: 'ok' as const,
      title: product.title,
      image: product.primaryImage,
      price: product.price,             // render now; do not store
      buyable: product.availability === 'in_stock',
      href: mercaria.links.product(product),
    };
  } catch (error) {
    if (error instanceof MercariaGoneError) return { state: 'unavailable' as const };
    if (error instanceof MercariaNotFoundError) return { state: 'missing' as const };
    if (isMercariaError(error) && error.retryable) return { state: 'retry-later' as const };
    throw error;
  }
}
```

An account linked to a store renders its storefront:

```ts
// The account stores a store REF (never the handle, which can change).
export async function shopTab(linkedStoreRef: unknown, cursor?: string) {
  const ref = parseMercariaRef(linkedStoreRef);
  if (ref?.kind !== 'store') return null;
  const [store, products, collections] = await Promise.all([
    mercaria.stores.resolveRef(ref),
    mercaria.stores.products(ref, { sort: 'newest', limit: 24, cursor }),
    mercaria.stores.collections(ref),
  ]);
  return {
    header: { name: store.name, logo: store.logoUrl, color: store.brandColor, href: store.url },
    products: products.items,
    nextCursor: products.nextCursor,
    collections: collections.items.map((c) => ({ title: c.title, href: mercaria.links.collection(c, store) })),
  };
}
```

A product picker is `mercaria.products.search({ query, limit: 20 })`, storing
`item.ref` for the picked item.

## Do not do this

- **Do not persist the current price or availability as truth.** Store the ref;
  hydrate every render. A stored price is wrong the moment the seller changes it.
- **Do not copy Mercaria DTOs or types into your app.** Import them from
  `@mercaria.co/sdk`. A local copy drifts silently.
- **Do not call Mercaria's private backend routes.** Only what this package
  exposes is a supported contract; everything else can change or disappear, and
  may be authorized differently.
- **Do not build Mercaria URLs by hand.** Use `links.*` or the DTO's `url`.
- **Do not store a store handle as its identity.** Handles change; refs do not.
- **Do not expose, infer or proxy supplier or procurement information.** The
  public contract has none, by design; do not try to reconstruct it.
- **Do not put the SDK's token getter behind a cache.** Return the live session
  token; Oxy owns its lifetime.

## Versioning

0.x releases follow the rule that a minor version may break and a patch never
does. See `CHANGELOG.md`.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.

### Donated materials

`client.materials` supports free offers, quantity requests, donor acceptance,
cancellation and recipient-confirmed receipt. Supply `getAccessToken` for every
private read or mutation, and preserve each mutation's `idempotencyKey` when
retrying a lost response. The SDK does not automatically retry writes.

```ts
for await (const page of client.materials.iterateReservations({
  accountId: authorizedAccountId,
  status: 'accepted',
})) {
  // Persist only reservation.id; resolve its current facts through Mercaria.
  showPendingPickups(page.items);
}
```

The recipient calls `confirmDelivery` only after receiving the materials.
Accepted quantities are committed; recipient-confirmed quantities are received.
There is no payment for the donated items.

### Material transport reference

`client.materials.linkTransport(reservationId, { actingAccountId, transportId })`
attaches only the opaque Moovo reference after Moovo verifies the reservation.
Use Moovo's SDK to propose, quote, authorize and book transport directly as the
user, and to read its current status. Cancelling a Mercaria reservation preserves
this reference and does not cancel an existing courier booking.

### Display a catalog price

Use `formatMoney(product.price, locale)` from `@mercaria.co/sdk`. It is the same formatter Mercaria uses: amounts stay in their catalog currency, FAIR uses its eight-decimal minor-unit scale, and the returned display string includes bidirectional isolation. Do not infer precision with `Intl` currency mode: FAIR is not an ISO currency code.

### Lightweight portable references

Persisted identities and list keys can import `productRef`, `collectionRef`,
`parseMercariaRef` and `formatMercariaRef` from `@mercaria.co/sdk/refs`. This entry
ships the canonical reference rules without the response validators or HTTP
client, so rendering a feed does not eagerly download Zod. The root exports
remain available and have identical behavior. References still contain identity
only; hydrate current price and availability through the client when needed.
