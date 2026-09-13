/**
 * The canonical Mercaria web URLs the public integration surface serves (#1017).
 *
 * The server is the AUTHORITY for these strings, and `@mercaria.co/sdk`'s link
 * helpers mirror them exactly — `docs/public-api.md` §URLs states the rules the
 * SDK codes against. They are therefore three PURE functions of their inputs,
 * in one place, with no config read inside: a builder that consulted the
 * environment would be a builder the SDK could not reproduce.
 *
 * The rules:
 *
 *  - the origin loses every trailing `/`;
 *  - every path segment and query value is `encodeURIComponent`-escaped;
 *  - a store is addressed by its CURRENT handle (the storefront's route is
 *    `/stores/[handle]`), and a collection by its id on its store's page, which
 *    `app/(app)/stores/[handle].tsx` honours as the initial selection.
 */

/** Strip trailing slashes so `https://mercaria.co/` and `https://mercaria.co` agree. */
export function normalizeWebOrigin(origin: string): string {
  return origin.replace(/\/+$/u, '');
}

/** `${origin}/products/${id}` — the product page. */
export function productWebUrl(origin: string, productId: string): string {
  return `${normalizeWebOrigin(origin)}/products/${encodeURIComponent(productId)}`;
}

/** `${origin}/stores/${handle}` — the store page, by its CURRENT handle. */
export function storeWebUrl(origin: string, storeHandle: string): string {
  return `${normalizeWebOrigin(origin)}/stores/${encodeURIComponent(storeHandle)}`;
}

/** `${origin}/stores/${handle}?collection=${id}` — the store page, opened on one collection. */
export function collectionWebUrl(origin: string, storeHandle: string, collectionId: string): string {
  return `${storeWebUrl(origin, storeHandle)}?collection=${encodeURIComponent(collectionId)}`;
}
