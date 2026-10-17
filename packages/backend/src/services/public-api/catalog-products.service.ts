/**
 * The comparison catalogue's public reads (`/public/v1/catalog/*`): what
 * another Oxy application — Clarity searching products, an agent comparing
 * prices — may learn about canonical products and their offers.
 *
 * ## Mercaria's own reads, nothing parallel
 *
 * The search is `runCanonicalSearch` restricted to products, the pipeline
 * `GET /search` runs; the detail is `readCanonicalProductPage`, the page
 * mercaria.co renders. Each lever that governs those surfaces governs these:
 *
 * | lever | effect here |
 * |---|---|
 * | `CANONICAL_SEARCH` not `on` | search is `service_unavailable` |
 * | `CANONICAL_READS` not `on`, or `CANONICAL_PUBLIC_ROUTES_ENABLED` off | detail is `service_unavailable` |
 * | the read cohorts exclude the product's category | detail is `not_found`, as on mercaria.co |
 * | `CANONICAL_OFFER_COMPARISON` not `on` | detail answers with `offers: null` |
 *
 * `service_unavailable` rather than 404 for an off lever, unlike the
 * storefront: a consumer holding a persisted ref may discard it on a 404, and
 * a rollout decision is not a fact about the product.
 *
 * ## Status semantics
 *
 * | catalog product | 200 | 410 `gone` | 404 `not_found` |
 * |---|---|---|---|
 * | resolved through any merge chain | `active`, `discontinued` | `suppressed` | no row, `draft` (never publicly existed) |
 *
 * A merged product answers as its winner, so a consumer persists the `ref` the
 * body carries — the same rule `getPublicCanonicalProduct` applies for every
 * other public surface.
 *
 * ## Ordering and money
 *
 * The comparison ranks in ONE currency, so it is run in the deployment default
 * (`DEFAULT_PRESENTMENT_CURRENCY`) — what a crawler and an anonymous shopper
 * get, and what keeps one product's order stable between two reads. Prices are
 * served in each offer's NATIVE currency: the comparison currency decides the
 * order, never an amount.
 */

import {
  MERCARIA_PUBLIC_PAGE_LIMIT_MAX,
  type MercariaCatalogProduct,
  type MercariaCatalogProductSummary,
  type MercariaPage,
} from '@mercaria/contracts';
import { CANONICAL_IDENTIFIER_SCHEMES, type SearchProductResult } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { listIdentifiersForVariants } from '../../db/canonical/productIdentifierRepository.js';
import { resolveCanonicalProduct } from '../canonical/canonical-product.service.js';
import { isPubliclyVisibleIdentifier } from '../canonical/product-identifier.service.js';
import {
  canonicalReadPermitted,
  resolveCanonicalSearchMode,
  resolveOfferComparisonMode,
} from '../backfill/read-mode.js';
import { readCanonicalProductPage } from '../product-page/product-page.service.js';
import { runCanonicalSearch } from '../search/canonical-search.service.js';
import { DEFAULT_PRESENTMENT_CURRENCY } from '../user-preference.service.js';
import { resolveMedia } from '../catalog-hydration.service.js';
import { gone, notFound, serviceUnavailable } from './errors.js';
import {
  encodePublicKeysetCursor,
  publicCursorFingerprint,
  resolvePublicKeysetCursor,
} from './cursor.js';
import {
  projectCatalogProduct,
  projectCatalogProductSummary,
} from './catalog-products.projection.js';

const CATALOG_PRODUCT_NOT_FOUND = 'Catalog product not found';
const CATALOG_PRODUCT_GONE = 'This catalog product is no longer available';
const SEARCH_UNAVAILABLE = 'Catalogue search is not being served right now';
const READS_UNAVAILABLE = 'The catalogue is not being served right now';

/** A catalogue search request, as the controller parsed it. */
export interface PublicCatalogSearchParams {
  readonly q: string;
  readonly market?: string;
  readonly limit: number;
  readonly cursor?: string;
}

/** `GET /catalog/products`: canonical products only, in the search's own relevance order. */
export async function searchPublicCatalogProducts(
  params: PublicCatalogSearchParams,
): Promise<MercariaPage<MercariaCatalogProductSummary>> {
  if (resolveCanonicalSearchMode() !== 'on') throw serviceUnavailable(SEARCH_UNAVAILABLE);

  const fingerprint = publicCursorFingerprint('catalog-products', {
    q: params.q,
    market: params.market,
  });
  const innerCursor = resolvePublicKeysetCursor(params.cursor, 'catalog-products', fingerprint);
  const outcome = await runCanonicalSearch({
    term: params.q,
    kinds: ['product'],
    filters: params.market === undefined ? {} : { market: params.market },
    limit: params.limit,
    ...(innerCursor === undefined ? {} : { cursor: innerCursor }),
  });

  const origin = config.web.origin;
  const items = outcome.response.results
    .filter((result): result is SearchProductResult => result.kind === 'product')
    .map((result) => projectCatalogProductSummary(result, resolveMedia, origin));
  const next = outcome.response.nextCursor;
  return {
    items,
    nextCursor:
      next === undefined ? null : encodePublicKeysetCursor('catalog-products', fingerprint, next),
  };
}

/** Each variant's active, public GTINs, in assertion order. */
async function publicGtinsByVariant(variantIds: readonly string[]): Promise<Map<string, string[]>> {
  const gtins = new Map<string, string[]>();
  for (const row of await listIdentifiersForVariants(getDb(), variantIds)) {
    if (row.variantId === null || row.canonicalValue === null) continue;
    if (!CANONICAL_IDENTIFIER_SCHEMES.includes(row.canonicalScheme as 'gtin')) continue;
    if (!isPubliclyVisibleIdentifier(row.status)) continue;
    const list = gtins.get(row.variantId) ?? [];
    if (!list.includes(row.canonicalValue)) list.push(row.canonicalValue);
    gtins.set(row.variantId, list);
  }
  return gtins;
}

/** `GET /catalog/products/{id}`: identity, configurations and every current offer, ranked. */
export async function getPublicCatalogProduct(id: string): Promise<MercariaCatalogProduct> {
  const mode = config.canonicalRollout.reads;
  if (mode !== 'on' || !config.canonicalRollout.publicRoutesEnabled) {
    throw serviceUnavailable(READS_UNAVAILABLE);
  }

  const row = await resolveCanonicalProduct(id);
  if (!row || row.status === 'draft') throw notFound(CATALOG_PRODUCT_NOT_FOUND);
  if (row.status === 'suppressed') throw gone(CATALOG_PRODUCT_GONE);

  const result = await readCanonicalProductPage({
    handle: row.id,
    comparisonCurrency: DEFAULT_PRESENTMENT_CURRENCY,
    limit: MERCARIA_PUBLIC_PAGE_LIMIT_MAX,
    offerComparisonPermitted: resolveOfferComparisonMode() === 'on',
  });
  // The status moved between the two reads.
  if (result === undefined) throw gone(CATALOG_PRODUCT_GONE);
  if (!canonicalReadPermitted(mode, { categoryId: result.page.product.categoryId ?? null })) {
    throw notFound(CATALOG_PRODUCT_NOT_FOUND);
  }

  const gtins = await publicGtinsByVariant(result.page.variants.map((variant) => variant.id));
  return projectCatalogProduct(result.page, gtins, resolveMedia, config.web.origin);
}
