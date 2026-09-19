# Changelog

All notable changes to `@mercaria.co/sdk`. The package follows semantic
versioning with the 0.x rule: while the major version is 0, a MINOR release may
break the API or the contract, and a PATCH release never does.

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
