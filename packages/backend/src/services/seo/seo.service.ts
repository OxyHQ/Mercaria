/**
 * Resolving one public URL (#75) — the composition, and the only module here
 * that reads anything.
 *
 * ## The order is the design
 *
 * 1. Match the path against the registry. No match means Mercaria publishes no
 *    metadata for that address and the shell is served unchanged.
 * 2. Apply the ROUTE-level redirect (`/m/:handle`), which needs no entity.
 * 3. Refuse a route with no screen behind it — a `planned` pattern is reserved,
 *    not served.
 * 4. Read the entity through the SAME public read the storefront's own screen
 *    calls, so the facts and the page cannot disagree.
 * 5. Answer an IDENTITY redirect (a merge tombstone, or an address that named
 *    the thing by id) before composing anything.
 * 6. Run the indexability policy over stated facts and compose the document.
 *
 * ## Why the product page goes through `readCanonicalProductPage`
 *
 * Because that IS the page. `/product-page/:idOrSlug` serves the value, the
 * screen renders it, and this reads the same function — so "emit only facts
 * visible on the page" is a statement about one call rather than about two
 * implementations agreeing. It costs a ranked comparison per crawl, which is
 * why the response is cacheable and why the worker caches it.
 *
 * ## Legacy listings do NOT redirect
 *
 * #75 legacy rule 5 forbids sending a historical order link to a different live
 * product or seller, and a canonical product page shows every seller of that
 * model. So `/products/:id` keeps serving its own page and, when the listing
 * maps confidently to one canonical product, points `rel=canonical` there. The
 * consolidation is the canonical tag's job; the redirect would be a different,
 * worse thing.
 */

import type {
  Brand,
  CurrencyCode,
  SeoIndexability,
  SeoResolution,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { findListingById } from '../../db/catalog/listingRepository.js';
import { findStoreByHandle } from '../../db/stores/storeRepository.js';
import { findCanonicalProductIdForListing } from '../../db/reviews/reviewTargetResolver.js';
import { findProductSeoFacts } from '../../db/seo/seoRepository.js';
import { getPublicBrand } from '../canonical/brand.service.js';
import { getMerchantPublic } from '../commerce-graph/merchant.service.js';
import { getPublicCanonicalProduct } from '../canonical/canonical-product.service.js';
import { hydrateListings } from '../catalog-hydration.service.js';
import { readCanonicalProductPage } from '../product-page/product-page.service.js';
import { resolveOfferComparisonMode } from '../backfill/read-mode.js';
import { DEFAULT_PRESENTMENT_CURRENCY } from '../user-preference.service.js';
import { composeDocument } from './document.js';
import {
  assessCatalogueContent,
  assessVisibleContent,
  decideIndexability,
} from './indexability.js';
import type { SeoOfferInformation } from './indexability.js';
import { buildCanonicalUrl, canonicalQueryOf, carryQueryAcrossRedirect } from './query-params.js';
import { buildIdentityRedirect, resolveRouteRedirect } from './redirects.js';
import { buildRoutePath, matchPublicRoute } from './routes.js';
import { indexingPermittedFor } from './rollout.js';
import {
  homeFacts,
  listingPageFacts,
  merchantPageFacts,
  nativeStoreFacts,
  productPageFacts,
} from './visible-facts.js';

/** The home page's one sentence. Also the storefront shell's own description. */
const HOME_TAGLINE =
  'Buy and sell new and secondhand items from shops and people — one page per product, ' +
  'every seller compared.';

/**
 * The listing statuses whose public detail page resolves.
 *
 * The same pair `listings.controller.ts` serves — `draft` and `archived` 404
 * there, so a document for one would describe a page that does not exist.
 */
const PUBLICLY_VIEWABLE_LISTING_STATUSES: readonly string[] = ['active', 'sold'];

/** The store statuses whose public storefront resolves. */
const PUBLICLY_VIEWABLE_STORE_STATUSES: readonly string[] = ['active'];

/** What the resolver was asked about. */
export interface ResolveSeoRequest {
  /** The request path, absolute, without the origin. */
  readonly pathname: string;
  /** The request's query string, exactly as received. */
  readonly query: URLSearchParams;
}

/**
 * The presentment currency a CRAWLER prices in.
 *
 * A crawler has no preference and no session, so the deployment default is the
 * only honest answer — and it is what makes a canonical page's structured data
 * stable between two crawls. A `?currency=` in the URL is deliberately ignored
 * here: it is a non-canonical parameter, so the page it addresses IS the
 * default-currency page.
 */
const CRAWLER_CURRENCY: CurrencyCode = DEFAULT_PRESENTMENT_CURRENCY;

/**
 * What the resolver decided, INCLUDING the indexability verdict.
 *
 * The verdict is deliberately not on {@link SeoDocument}: a document is served
 * to the edge and from there to a crawler, and the reason a page was refused is
 * operator-only — a client that could read WHICH input refused could vary one
 * at a time and read the switchboard out of the catalogue. So the public entry
 * point projects it away and `/internal/seo`, behind the catalogue operator
 * allow-list, is the ONE caller that sees it.
 *
 * `indexability` is absent exactly when no document was composed: a redirect
 * and a 404 have no page to have a verdict about.
 */
export interface SeoDiagnosis {
  readonly resolution: SeoResolution;
  readonly indexability?: SeoIndexability;
}

/**
 * Resolve one public URL.
 *
 * A path matching NO registered pattern answers `no_document`, NOT `not_found`,
 * and the difference is what keeps the rollout safe: `/cart`, `/checkout` and
 * `/settings/general` are real screens this domain deliberately publishes no
 * metadata for, and answering `not_found` for them would have the edge serve
 * every one of them with a 404 status. `not_found` is reserved for an address
 * that matched a live pattern and named a thing that does not exist — the one
 * case where a 404 is the truth a crawler needs.
 */
export async function resolveSeoUrl(request: ResolveSeoRequest): Promise<SeoResolution> {
  return (await diagnoseSeoUrl(request)).resolution;
}

/**
 * The same resolution, with the verdict the public entry point drops.
 *
 * ONE code path, not a second implementation: `resolveSeoUrl` is a projection
 * of this. An operator asking "why is this page not indexed" and a crawler
 * being told `noindex` are therefore answers to the same computation, which is
 * the only arrangement in which the answer is worth anything.
 */
export async function diagnoseSeoUrl(request: ResolveSeoRequest): Promise<SeoDiagnosis> {
  const matched = matchPublicRoute(request.pathname);
  if (!matched) return { resolution: { outcome: 'no_document' } };

  const { route, handle } = matched;
  const carriedQuery = carryQueryAcrossRedirect(request.query);

  const routeRedirect = resolveRouteRedirect(route.id, handle, carriedQuery);
  if (routeRedirect) return { resolution: { outcome: 'redirect', redirect: routeRedirect } };

  // A reserved pattern with no screen behind it. Composing a title and a
  // canonical tag for an address that renders "This screen does not exist" is
  // worse than answering nothing — and `no_document` rather than `not_found`
  // because the day the screen ships is a registry edit, not an edge change.
  if (route.availability !== 'live') {
    // A reserved pattern has no page, so it has no verdict either — but the
    // POLICY still has an answer about it, and an operator asking why nothing
    // is served deserves the named reason rather than silence.
    return {
      resolution: { outcome: 'no_document' },
      indexability: { outcome: 'refused', reason: 'route_not_live' },
    };
  }

  const origin = config.web.origin;

  switch (route.id) {
    case 'home':
      return resolveHome(origin);
    case 'canonical_product':
      return resolveCanonicalProduct(handle ?? '', request, origin);
    case 'legacy_listing':
      return resolveLegacyListing(handle ?? '', origin);
    case 'native_store':
      return resolveNativeStore(handle ?? '', origin);
    case 'merchant':
      return resolveMerchant(handle ?? '', request, origin);
    /**
     * A seller page is a person whose identity Oxy owns, and #92 derives its
     * visibility PER REQUEST from Oxy's own privacy and trust state. A title
     * composed here would either duplicate that decision or outlive it — and a
     * search result for an account that later goes private is not something a
     * later read can withdraw. So Mercaria publishes no server-rendered
     * document for it and the shell is served exactly as it is today.
     */
    case 'seller':
      return { resolution: { outcome: 'no_document' } };
    case 'brand':
    case 'product_family':
    case 'category_browse':
    case 'native_store_legacy':
      // Unreachable: every one of these is `planned` or `redirect_only` and was
      // answered above. The branch exists so adding a route without deciding
      // what it resolves fails `tsc` rather than falling into a default.
      return { resolution: { outcome: 'no_document' } };
  }
}

/** The home page. Static facts, and indexable whenever indexing is on at all. */
function resolveHome(origin: string): SeoDiagnosis {
  const facts = homeFacts(HOME_TAGLINE);
  const verdict = decideIndexability({
    routeAvailability: 'live',
    // The home page belongs to no category, so `canary` withholds it — the same
    // fail-closed answer every uncategorised entity gets. A canary that
    // published the front page would not be a canary.
    indexingPermitted: indexingPermittedFor(null),
    identity: 'canonical',
    moderation: 'clear',
    sourceIndexRight: 'granted',
    content: 'sufficient',
    offerInformation: 'not_applicable',
    locale: 'complete',
    filterUniqueness: 'not_a_filter_page',
  });
  return {
    resolution: {
      outcome: 'document',
      document: composeDocument({
        routeId: 'home',
        facts,
        canonicalUrl: buildCanonicalUrl(origin, buildRoutePath('home')),
        origin,
        indexability: verdict,
      }),
    },
    indexability: verdict,
  };
}

/** `/p/:handle`. */
async function resolveCanonicalProduct(
  handle: string,
  request: ResolveSeoRequest,
  origin: string,
): Promise<SeoDiagnosis> {
  if (config.canonicalRollout.reads !== 'on' || !config.canonicalRollout.publicRoutesEnabled) {
    // The storefront's own read answers 404 in these states, so the page a
    // crawler would land on does not exist either.
    return { resolution: { outcome: 'not_found' } };
  }

  const result = await readCanonicalProductPage({
    handle,
    comparisonCurrency: CRAWLER_CURRENCY,
    limit: config.pagination.defaultPageSize,
    offerComparisonPermitted: resolveOfferComparisonMode() === 'on',
  });
  if (result === undefined) return { resolution: { outcome: 'not_found' } };

  const page = result.page;
  const product = page.product;
  const carriedQuery = carryQueryAcrossRedirect(request.query);

  // A merged tombstone's handle, or an address that named the product by id.
  // Both are permanent facts about identity, so both are a 301 — and the reason
  // differs because an operator reading a redirect log needs to tell "somebody
  // linked the id" from "this product was merged away".
  if (handle !== product.slug) {
    const reason = handle === product.id ? 'canonical_spelling' : 'merged';
    return {
      resolution: {
        outcome: 'redirect',
        redirect: buildIdentityRedirect(
          buildRoutePath('canonical_product', product.slug),
          carriedQuery,
          reason,
        ),
      },
    };
  }

  const brand = await readBrand(product.brandId);
  const facts = productPageFacts(page, brand);
  const seoFacts = await findProductSeoFacts(getDb(), product.id);

  const verdict = decideIndexability({
    routeAvailability: 'live',
    indexingPermitted: indexingPermittedFor(product.categoryId ?? null),
    identity: 'canonical',
    moderation: product.status === 'active' ? 'clear' : 'suppressed',
    sourceIndexRight: seoFacts?.indexRightGranted === false ? 'withheld' : 'granted',
    content: assessVisibleContent(facts),
    offerInformation: productOfferInformation(facts.offers.length),
    locale: 'complete',
    filterUniqueness: 'not_a_filter_page',
  });

  return {
    resolution: {
      outcome: 'document',
      document: composeDocument({
        routeId: 'canonical_product',
        facts,
        canonicalUrl: buildCanonicalUrl(
          origin,
          buildRoutePath('canonical_product', product.slug),
          canonicalQueryOf('canonical_product', request.query),
        ),
        origin,
        indexability: verdict,
      }),
    },
    indexability: verdict,
  };
}

/**
 * Offers now, or offers once.
 *
 * `historical` rather than `none` for a product with no current offer, and the
 * distinction is #75 policy rule 3's own: a real product with identity, images
 * and identifiers is worth a result even between sellers, and #78 keeps the
 * price history that makes the page useful. `none` is reserved for a page that
 * has never had commercial information at all, which today no product reaches —
 * the branch exists so the policy asks the question rather than assuming it.
 */
function productOfferInformation(offerCount: number): SeoOfferInformation {
  return offerCount > 0 ? 'current' : 'historical';
}

/** `/products/:id` — the legacy native listing detail. */
async function resolveLegacyListing(id: string, origin: string): Promise<SeoDiagnosis> {
  const row = await findListingById(id);
  if (!row || !PUBLICLY_VIEWABLE_LISTING_STATUSES.includes(row.status)) {
    return { resolution: { outcome: 'not_found' } };
  }
  const [listing] = await hydrateListings([row]);
  if (listing === undefined) return { resolution: { outcome: 'not_found' } };

  const facts = listingPageFacts(listing);

  /**
   * The confident canonical mapping, and the ONE thing it changes.
   *
   * `findCanonicalProductIdForListing` resolves only when EVERY barcoded
   * variant resolves to the SAME canonical product — the same gate the listing
   * detail read uses for `Listing.canonicalProductId`, so the page and its
   * canonical tag are answering one question. When it resolves, the canonical
   * URL is the PRODUCT's; the listing page still renders, still serves and
   * still answers 200.
   */
  const canonicalProductId = await findCanonicalProductIdForListing(row.id);
  const canonicalProductSlug =
    canonicalProductId === null ? undefined : await readProductSlug(canonicalProductId);

  const canonicalUrl =
    canonicalProductSlug === undefined
      ? buildCanonicalUrl(origin, buildRoutePath('legacy_listing', row.id))
      : buildCanonicalUrl(origin, buildRoutePath('canonical_product', canonicalProductSlug));

  const verdict = decideIndexability({
    routeAvailability: 'live',
    // A listing's category is a slug on the listing itself rather than a
    // canonical category id, so a canary keyed on categories withholds it. That
    // is the fail-closed direction and it is what a canary is for.
    indexingPermitted: indexingPermittedFor(null),
    identity: 'canonical',
    moderation: 'clear',
    sourceIndexRight: 'granted',
    content: assessVisibleContent(facts),
    offerInformation: 'current',
    locale: 'complete',
    filterUniqueness: 'not_a_filter_page',
  });

  return {
    resolution: {
      outcome: 'document',
      document: composeDocument({
        routeId: 'legacy_listing',
        facts,
        canonicalUrl,
        origin,
        indexability: verdict,
      }),
    },
    indexability: verdict,
  };
}

/** `/stores/:handle` — a native Mercaria store's own storefront. */
async function resolveNativeStore(handle: string, origin: string): Promise<SeoDiagnosis> {
  const store = await findStoreByHandle(handle);
  if (!store || !PUBLICLY_VIEWABLE_STORE_STATUSES.includes(store.status)) {
    return { resolution: { outcome: 'not_found' } };
  }

  const facts = nativeStoreFacts({
    handle: store.handle,
    name: store.name,
    description: store.description,
    logoFileId: store.logoFileId,
  });

  const verdict = decideIndexability({
    routeAvailability: 'live',
    indexingPermitted: indexingPermittedFor(null),
    identity: 'canonical',
    moderation: 'clear',
    sourceIndexRight: 'granted',
    // A storefront IS its catalogue, and this read does not count it — so the
    // page is judged on its own description and logo, exactly as a brand page
    // would be if it had one. A store with neither is thin, which is the right
    // answer for an empty shop.
    content: assessVisibleContent(facts),
    offerInformation: 'not_applicable',
    locale: 'complete',
    filterUniqueness: 'not_a_filter_page',
  });

  return {
    resolution: {
      outcome: 'document',
      document: composeDocument({
        routeId: 'native_store',
        facts,
        canonicalUrl: buildCanonicalUrl(origin, buildRoutePath('native_store', store.handle)),
        origin,
        indexability: verdict,
      }),
    },
    indexability: verdict,
  };
}

/**
 * `/merchants/:handle` — a canonical merchant's page (#73).
 *
 * `getMerchantPublic` is the SAME read the screen's own API call makes, and it
 * already answers the two identity questions this domain needs: it refuses a
 * suppressed merchant outright, and it reports `redirectedFrom` when the
 * requested handle was a merge tombstone. So the 301 is composed from the read
 * rather than from a second traversal of the merge chain.
 *
 * A merchant page is judged by its CATALOGUE — it has no description worth
 * indexing on its own and no image at all — so `assessCatalogueContent` decides
 * whether it is worth a result, on the offer rollup #57 maintains.
 */
async function resolveMerchant(
  handle: string,
  request: ResolveSeoRequest,
  origin: string,
): Promise<SeoDiagnosis> {
  let profile: Awaited<ReturnType<typeof getMerchantPublic>>;
  try {
    profile = await getMerchantPublic(handle);
  } catch {
    // `getMerchantPublic` throws `notFound` for an absent or suppressed
    // merchant, which is the same answer this surface owes either way — a
    // suppressed merchant must not be distinguishable from one that never
    // existed.
    return { resolution: { outcome: 'not_found' } };
  }

  const merchant = profile.merchant;
  const carriedQuery = carryQueryAcrossRedirect(request.query);

  // A merge tombstone, or an address that named the merchant by id. Both are
  // permanent identity facts, and `redirectedFrom` is the read's own answer to
  // the first — this domain does not re-walk the chain.
  if (handle !== merchant.slug) {
    const reason = profile.redirectedFrom === undefined ? 'canonical_spelling' : 'merged';
    return {
      resolution: {
        outcome: 'redirect',
        redirect: buildIdentityRedirect(
          buildRoutePath('merchant', merchant.slug),
          carriedQuery,
          reason,
        ),
      },
    };
  }

  const facts = merchantPageFacts({
    slug: merchant.slug,
    name: merchant.name,
    description: merchant.description,
    rating: merchant.rating,
    ratingCount: merchant.ratingCount,
  });

  const verdict = decideIndexability({
    routeAvailability: 'live',
    // A merchant belongs to no category, so `canary` withholds it — the
    // fail-closed answer every uncategorised entity gets.
    indexingPermitted: indexingPermittedFor(null),
    identity: 'canonical',
    moderation: merchant.status === 'active' ? 'clear' : 'suppressed',
    // A merchant is Mercaria's own canonical organisation record; the products
    // beneath it carry their sources' rights on their own pages.
    sourceIndexRight: 'granted',
    content: assessCatalogueContent(merchant.name, merchant.offerCount),
    offerInformation: 'not_applicable',
    locale: 'complete',
    filterUniqueness: 'not_a_filter_page',
  });

  return {
    resolution: {
      outcome: 'document',
      document: composeDocument({
        routeId: 'merchant',
        facts,
        canonicalUrl: buildCanonicalUrl(
          origin,
          buildRoutePath('merchant', merchant.slug),
          canonicalQueryOf('merchant', request.query),
        ),
        origin,
        indexability: verdict,
      }),
    },
    indexability: verdict,
  };
}

/** The product's brand, when it has one and the read resolves. */
async function readBrand(brandId: string | undefined): Promise<Brand | undefined> {
  if (brandId === undefined) return undefined;
  return getPublicBrand(brandId);
}

/** One canonical product's slug, for the legacy listing's canonical tag. */
async function readProductSlug(productId: string): Promise<string | undefined> {
  const product = await getPublicCanonicalProduct(productId);
  return product?.slug;
}
