# Changelog

All notable changes to `@mercaria.co/sdk`. The package follows semantic
versioning with the 0.x rule: while the major version is 0, a MINOR release may
break the API or the contract, and a PATCH release never does.

## 0.2.0

The SDK now parses with the contract's own schemas, and speaks Oxy's shared API
conventions (`~/Oxy/docs/api-conventions.md`), which `/public/v1` adopted in the
same change. Every 0.1 install stops understanding the server's errors, so
upgrade before (or with) the server.

### Breaking

- **Error codes are snake_case**, from the shared Oxy list: `bad_request`,
  `unauthorized`, `forbidden`, `not_found`, `unknown_route`, `gone`,
  `conflict`, `validation_failed`, `rate_limited`, `internal_error`,
  `service_unavailable`. The SDK's own codes are `network_error`, `timeout`,
  `aborted`, `malformed_response` and `http_error`. `MercariaErrorCode` and
  `MERCARIA_PUBLIC_ERROR_CODES` changed accordingly.
- **`MercariaValidationError` is now 422 `validation_failed`** — well-formed, but
  a value was refused (a `limit` out of range, `relevance` without a query, an
  unknown `sort`). A request that is not well-formed — a wrong type, a missing,
  unknown or repeated parameter, a cursor from another list — is the new
  **`MercariaBadRequestError`** (400 `bad_request`). The SDK refuses both before
  sending, with `status: null`, by the same rules the server applies.
- **`unknown_route` is `MercariaUnknownRouteError`** (a subclass of
  `MercariaApiError`), never `MercariaNotFoundError`.
- **The wire changed**: success bodies are the value itself (no
  `{ success, data }` envelope), and every error is
  `{ error: { code, message, details? } }`, the 429 included. The 0.1 envelope is
  read as a malformed response, and a 0.1-shaped error body as a bare status.
- **`Money` is renamed `MercariaMoney`.**
- **`zod` is a runtime dependency** (`^4.5.4`): responses are parsed with the
  contract's zod schemas. The type declarations import zod's, which name the
  `URL` global, so a TypeScript consumer needs either the DOM lib or
  `@types/node` (or `skipLibCheck`).
- A persisted ref is still parsed strictly (`parseMercariaRef`), but a ref
  inside a RESPONSE now drops an unknown key like every other response object,
  rather than being rebuilt by hand.

### Added

- `MercariaBadRequestError`, `MercariaUnknownRouteError`, `MercariaConflictError`.
- `details` on every `MercariaError`: the server's scalar details (`field` on a
  refused request, `retryAfterSeconds` on a rate limit), included in `toJSON()`.
- `MercariaRateLimitError.retryAfterSeconds` reads `details.retryAfterSeconds`
  first, then `Retry-After` / `RateLimit-Reset`.
- `MERCARIA_PUBLIC_LIST_MAX_OFFSET` (10,000): the deepest item a list serves.
- `MercariaErrorDetails` type.

### Unchanged

- Every client method and its arguments, refs and their string form, link
  helpers, `iterateMercariaPages`, `getAccessToken`, timeouts and cancellation,
  and the cross-copy `instanceof`.

## 0.1.0

First release — the public read surface Mention's commerce integration
(OxyHQ/Mention#951) needs, and the integration boundary every other Oxy app
uses from now on (OxyHQ/Mercaria#1017).

### Added

- `createMercariaClient` for Node 18+, Bun, browsers and React Native, with no
  runtime dependencies. ESM and CommonJS builds with bundled type declarations.
- Anonymous reads, and Oxy-user reads through `getAccessToken` (called before
  every request, never cached or logged).
- Products: `products.get`, `products.resolveRef`, `products.resolveVariant`,
  `products.search` (query, store, collection, in-stock, sort, locale, cursor
  pagination).
- Stores: `stores.get`, `stores.resolveRef`, `stores.lookup` (by handle),
  `stores.products`, `stores.collections`.
- Collections: `collections.get`, `collections.resolveRef`,
  `collections.products`.
- Canonical web links: `links.product`, `links.store`, `links.collection`.
- Portable references: `productRef`, `variantRef`, `storeRef`, `collectionRef`,
  `isMercariaRef`, `parseMercariaRef`, and the string form
  `formatMercariaRef` / `parseMercariaRefString` (`mercaria:product:<id>`).
- `iterateMercariaPages` for walking a cursor-paginated read.
- Typed errors: `MercariaError` and `MercariaNetworkError`,
  `MercariaTimeoutError`, `MercariaAbortError`, `MercariaApiError`,
  `MercariaValidationError`, `MercariaUnauthorizedError`,
  `MercariaForbiddenError`, `MercariaNotFoundError`, `MercariaGoneError`,
  `MercariaRateLimitError`, `MercariaUnavailableError`,
  `MercariaResponseError`, with `code`, `status` and `retryable`, and
  `instanceof` that holds across the ESM and CJS copies.
- Defensive response parsing that builds fresh objects with only contract keys
  and rejects unknown enum values.
- The public contract types and closed value sets, re-exported.
