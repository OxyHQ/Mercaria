# @mercaria.co/sdk

The canonical TypeScript client for [Mercaria](https://mercaria.co)'s public
commerce API. If an Oxy app — Mention, Goway, Nilo, an assistant or a service —
needs Mercaria products, stores or collections, it reads them through this
package instead of knowing Mercaria's HTTP routes, copying its types or
building its URLs.

- **Headless and isomorphic.** Node 18+, Bun, browsers and React Native (Expo)
  from one entry. No React, no runtime dependencies.
- **Typed end to end.** The public contract's types ship with the package;
  every response is validated field by field before you see it.
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
| `fetch` | the global `fetch` | Looked up at request time. Pass one for tests or old runtimes. |
| `getAccessToken` | none | Supplies the current Oxy access token. See below. |
| `locale` | none | Default locale for the list reads that take one; each call can override it. |
| `timeoutMs` | `15000` | Per request, token acquisition and body included. |
| `headers` | none | Extra non-auth headers (a tracing id, say). `Authorization` and `Accept` are refused. |

Create one client per configuration and reuse it; it holds no connection and
no state beyond its options.

## Anonymous and Oxy-authenticated reads

With no `getAccessToken`, every request is anonymous. Every read in this
release works anonymously.

To act as the signed-in Oxy user, hand the SDK a function that returns the
current access token:

```ts
const mercaria = createMercariaClient({
  getAccessToken: () => currentOxyAccessToken(), // however your app reads its Oxy session
});
```

- It is called before **every** request and its result is never cached,
  stored or logged. Return `null`, `undefined` or `''` when there is no session:
  that request is sent anonymously.
- The token is sent as `Authorization: Bearer <token>` and nowhere else. The SDK
  sends no cookies (`credentials: 'omit'`).
- **Session ownership stays with Oxy.** Sign-in, refresh and sign-out belong to
  Oxy's auth packages. The SDK never refreshes a token; if a request fails with
  `MercariaUnauthorizedError`, refresh through Oxy and try again.
- An error thrown by your getter is passed through unchanged.
- Today the only authenticated difference is `product.viewer`, which is
  `{ saved }` for a signed-in caller and `null` for an anonymous one.

**Service-to-service authority is not provided.** There is no client secret,
API key or service token option, and the SDK does not fake one. When a
Mercaria method needs service authority, it will use Oxy's canonical service
authorization and be added here explicitly.

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
store.name;
store.logoUrl;
store.brandColor;  // CSS hex
store.rating;      // 0–5 or null
store.url;

const products = await mercaria.stores.products(store.ref, { sort: 'newest', limit: 24 });
const collections = await mercaria.stores.collections(store.ref);
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

## Links

Never build Mercaria URLs by hand. The link helpers produce the same strings the
server puts in each DTO's `url`:

```ts
mercaria.links.product(product);             // or a product ref, or an id
mercaria.links.store(store);                 // or a handle, or a store seller
mercaria.links.collection(collection, store); // a collection needs its store's handle
```

A store link needs the store's current **handle**, which a ref deliberately
does not carry — hydrate the store (or use the `handle` on a product's store
seller) first. When you already have the DTO, its `url` is the same string.

## References

A ref names an entity and nothing else — no title, image, price or
availability, and no store handle. That is what makes it safe to persist.

```ts
import {
  productRef, variantRef, storeRef, collectionRef,
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
`MercariaValidationError`. Changing `limit` between pages is fine. A list ends
after 10,000 items; narrow the filters to reach further.

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

It applies to `products.search` and `stores.products`. Detail reads
(`products.get`, `stores.get`, `collections.get` and the `resolve*` helpers) and
collection product pages take no locale, and the SDK never sends one on them.
Locale changes presentation only, never which entity a ref names.

**There is no market or currency option, on purpose.** Public reads serve each
price in the listing's native currency and convert nothing, so there is no
server-side currency or market to select. A consumer that wants to show another
currency does its own labelled conversion; the SDK will not invent one.

## Errors

Every failure is a `MercariaError` with a stable `code`, the HTTP `status`
(or `null`), and `retryable`. Branch on the class or the code — never on
`message`.

| Class | When | `retryable` |
| --- | --- | --- |
| `MercariaNotFoundError` | 404 `NOT_FOUND`: no such entity, never existed | no |
| `MercariaGoneError` | 410 `GONE`: existed, no longer publicly available (archived, withdrawn, store closed) | no |
| `MercariaUnavailableError` | 500, 502, 503, 504…: Mercaria is temporarily unable to answer | yes |
| `MercariaNetworkError` | the request never completed (offline, DNS, reset) | yes |
| `MercariaTimeoutError` | exceeded `timeoutMs` (a network error) | yes |
| `MercariaAbortError` | your `signal` aborted it | no |
| `MercariaRateLimitError` | 429; `retryAfterSeconds` when the server said | yes |
| `MercariaUnauthorizedError` | 401 | no |
| `MercariaForbiddenError` | 403 | no |
| `MercariaValidationError` | 400, or refused before sending (empty id, bad limit) | no |
| `MercariaResponseError` | the response was not the contract | no |
| `MercariaApiError` | any other non-2xx — including 404 `UNKNOWN_ROUTE` (this SDK version and the server disagree about a route) and a 404/410 with no Mercaria error body (a proxy); neither ever means the entity is gone | usually no |

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
gives `{ name, code, status, retryable, message }`. `instanceof` works even when
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

const mercaria = createMercariaClient({ getAccessToken: () => session.accessToken ?? null });

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
