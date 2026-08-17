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
  ProductFamily,
  PublicRouteId,
  SeoIndexability,
  SeoResolution,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { findListingById } from '../../db/catalog/listingRepository.js';
import { findStoreByHandle } from '../../db/stores/storeRepository.js';
import { findCanonicalProductIdForListing } from '../../db/reviews/reviewTargetResolver.js';
import {
  countActiveListingsInCategories,
  findCategorySeoRow,
  findProductSeoFacts,
  listCategoryBreadcrumb,
} from '../../db/seo/seoRepository.js';
import { getPublicBrand } from '../canonical/brand.service.js';
import { getPublicProductFamily } from '../canonical/product-family.service.js';
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
  catalogueEntityFacts,
  categoryPageFacts,
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

  const resolver = ROUTE_RESOLVERS[route.id];
  // A route this domain publishes no document for. The shell is served exactly
  // as it is today — `no_document`, never `not_found`, because the page is real
  // and only its metadata is absent.
  if (resolver === null) return { resolution: { outcome: 'no_document' } };
  return resolver({ handle: handle ?? '', request, origin: config.web.origin });
}

/** Everything a per-route resolver is given. */
interface RouteResolverInput {
  /** The route's single dynamic segment, decoded. Empty on a static route. */
  readonly handle: string;
  readonly request: ResolveSeoRequest;
  readonly origin: string;
}

type RouteResolver = (input: RouteResolverInput) => Promise<SeoDiagnosis> | SeoDiagnosis;

/**
 * Which routes this domain publishes a document for — a TABLE, not a `switch`.
 *
 * A switch answers "what do I do for this route" and cannot answer "which
 * routes do I serve at all". That second question is the one #256 turned out to
 * need: `sitemap.service.ts` has to know, before it reads a single row, whether
 * a collection's pages will carry any metadata — and with the answer buried in
 * control flow the only way to find out was to call the resolver, which needs a
 * database and an entity that may not exist.
 *
 * `null` is a DECISION and every one is explained where it sits. The table is
 * total over `PublicRouteId`, so a new route cannot be added without stating
 * which it is — the property the switch also had, kept.
 */
const ROUTE_RESOLVERS: Readonly<Record<PublicRouteId, RouteResolver | null>> = Object.freeze({
  home: ({ origin }) => resolveHome(origin),
  canonical_product: ({ handle, request, origin }) =>
    resolveCanonicalProduct(handle, request, origin),
  legacy_listing: ({ handle, origin }) => resolveLegacyListing(handle, origin),
  native_store: ({ handle, origin }) => resolveNativeStore(handle, origin),
  merchant: ({ handle, request, origin }) => resolveMerchant(handle, request, origin),
  brand: ({ handle, request, origin }) => resolveBrandPage(handle, request, origin),
  product_family: ({ handle, request, origin }) => resolveFamilyPage(handle, request, origin),
  /**
   * A seller page is a person whose identity Oxy owns, and #92 derives its
   * visibility PER REQUEST from Oxy's own privacy and trust state. A title
   * composed here would either duplicate that decision or outlive it — and a
   * search result for an account that later goes private is not something a
   * later read can withdraw.
   */
  seller: null,
  category_browse: ({ handle, request, origin }) => resolveCategoryPage(handle, request, origin),
  /** Reserved patterns: `planned` and `redirect_only` are answered above. */
  native_store_legacy: null,
});

/**
 * Does this domain publish a server-rendered document for this route?
 *
 * Read by `sitemap.service.ts` before it opens a collection. A sitemap entry is
 * an invitation to crawl a URL, and a URL this domain serves no metadata for is
 * a bare SPA shell with the generic title, the generic canonical and no
 * `noindex` — a thin duplicate advertised by the very policy built to refuse
 * one. That is #256, and this function is what makes it unrepresentable.
 */
export function routeServesDocument(routeId: PublicRouteId): boolean {
  return ROUTE_RESOLVERS[routeId] !== null;
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

/**
 * `/brands/:handle` — a canonical brand's page (#72), closing #256.
 *
 * `getPublicBrand` does NOT resolve a merge tombstone — unlike
 * `getPublicProductFamily` beside it, which does — so the hop is taken here,
 * explicitly, and a winner that fails to resolve answers 404 rather than
 * composing a 301 to a page that is not there. Asymmetries between two reads
 * this similar are exactly what a caller assumes away.
 */
async function resolveBrandPage(
  handle: string,
  request: ResolveSeoRequest,
  origin: string,
): Promise<SeoDiagnosis> {
  const requested = await getPublicBrand(handle);
  if (!requested || requested.status === 'suppressed') {
    return { resolution: { outcome: 'not_found' } };
  }

  let brand = requested;
  if (requested.status === 'merged') {
    const winner =
      requested.mergedIntoId === undefined ? undefined : await getPublicBrand(requested.mergedIntoId);
    if (!winner || winner.status === 'suppressed') return { resolution: { outcome: 'not_found' } };
    brand = winner;
  }

  const redirect = catalogueRedirect('brand', handle, brand.id, brand.slug, request);
  if (redirect) return redirect;

  return catalogueDiagnosis({
    routeId: 'brand',
    slug: brand.slug,
    name: brand.name,
    description: brand.description,
    logoFileId: brand.logoFileId,
    entryCount: brand.productCount,
    // A brand belongs to no category, so `canary` withholds it — the
    // fail-closed answer every uncategorised entity gets.
    categoryId: null,
    active: brand.status === 'active',
    request,
    origin,
  });
}

/**
 * `/families/:handle` — a product line's page (#72), closing #256.
 *
 * `getPublicProductFamily` resolves the merge chain itself, so a tombstone
 * arrives already pointing at its winner and the only redirect left to compose
 * is the canonical spelling.
 */
async function resolveFamilyPage(
  handle: string,
  request: ResolveSeoRequest,
  origin: string,
): Promise<SeoDiagnosis> {
  const family: ProductFamily | undefined = await getPublicProductFamily(handle);
  if (!family || family.status === 'suppressed') {
    return { resolution: { outcome: 'not_found' } };
  }

  const redirect = catalogueRedirect('product_family', handle, family.id, family.slug, request);
  if (redirect) return redirect;

  return catalogueDiagnosis({
    routeId: 'product_family',
    slug: family.slug,
    name: family.name,
    description: family.description,
    logoFileId: undefined,
    entryCount: family.productCount,
    // A family DOES carry a category, so a canary can include one — the only
    // catalogue entity of the three that can.
    categoryId: family.categoryId ?? null,
    active: family.status === 'active',
    request,
    origin,
  });
}

/**
 * `/categories/:handle` — a category landing page (#367 workstream 9).
 *
 * ## Three lifecycles, three different answers
 *
 * A `merged` category follows its successor and answers a 301, exactly as a
 * merged brand does — the merge history is what `category_redirects` exists to
 * make resolvable, and a shopper who followed an old link should land on the
 * shelf that replaced it. Every other withdrawn state answers `not_found`
 * rather than a suppressed document: a category nobody may browse into is not a
 * page with a `noindex` on it, it is an address that leads nowhere.
 *
 * `published AND is_active` is the conjunction, not either alone — the derived
 * flag and the lifecycle can disagree until `categories_is_active_derived_check`
 * lands in its `post` migration, and a page should be withheld when either says
 * withdrawn. That is `docs/navigation.md`'s rule, applied to the same rows.
 *
 * ## What judges it
 *
 * Its CATALOGUE, like a brand and a merchant: a category has no description
 * column of its own, so the only thing it can be thin on is what is filed under
 * it. The count comes from `category_slugs`, which is what the browse read
 * filters on — so the number the policy judges is the number a shopper sees.
 *
 * ## Why the canary can include one
 *
 * `indexingPermittedFor` takes the row's OWN id here. Every other catalogue
 * entity answers `null` unless it carries somebody else's category, so a
 * category is the one page class a category-scoped canary can actually name.
 */
async function resolveCategoryPage(
  handle: string,
  request: ResolveSeoRequest,
  origin: string,
): Promise<SeoDiagnosis> {
  const db = getDb();
  const requested = await findCategorySeoRow(db, handle);
  if (!requested) return { resolution: { outcome: 'not_found' } };

  let category = requested;
  if (requested.lifecycle === 'merged') {
    const winner =
      requested.mergedIntoCategoryId === null
        ? undefined
        : await findCategorySeoRow(db, requested.mergedIntoCategoryId);
    if (!winner) return { resolution: { outcome: 'not_found' } };
    category = winner;
  }

  if (category.lifecycle !== 'published' || !category.isActive) {
    return { resolution: { outcome: 'not_found' } };
  }

  if (handle !== category.slug) {
    // The same discrimination `catalogueRedirect` makes: an address naming the
    // category's OWN id is a canonical-spelling correction, and anything else
    // that resolved here came through a merge.
    const reason = handle === category.id ? 'canonical_spelling' : 'merged';
    return {
      resolution: {
        outcome: 'redirect',
        redirect: buildIdentityRedirect(
          buildRoutePath('category_browse', category.slug),
          carryQueryAcrossRedirect(request.query),
          reason,
        ),
      },
    };
  }

  const ancestors = await listCategoryBreadcrumb(db, category.ancestorIds);
  const counts = await countActiveListingsInCategories(db, [category.slug]);
  const facts = categoryPageFacts({
    slug: category.slug,
    name: category.name,
    ancestors: ancestors.map((step) => ({ slug: step.slug, name: step.name })),
  });

  const verdict = decideIndexability({
    routeAvailability: 'live',
    indexingPermitted: indexingPermittedFor(category.id),
    identity: 'canonical',
    moderation: 'clear',
    sourceIndexRight: 'granted',
    content: assessCatalogueContent(category.name, counts.get(category.slug) ?? 0),
    offerInformation: 'not_applicable',
    locale: 'complete',
    // A bare `/categories/:handle` is the shelf itself. #75's filter-uniqueness
    // rule is about the FILTERED variants of it, and `canonicalQueryOf` already
    // strips every non-canonical parameter out of the URL below — so what this
    // document is canonical for is the unfiltered shelf, whatever the shopper
    // arrived with.
    filterUniqueness: 'not_a_filter_page',
  });

  return {
    resolution: {
      outcome: 'document',
      document: composeDocument({
        routeId: 'category_browse',
        facts,
        canonicalUrl: buildCanonicalUrl(
          origin,
          buildRoutePath('category_browse', category.slug),
          canonicalQueryOf('category_browse', request.query),
        ),
        origin,
        indexability: verdict,
      }),
    },
    indexability: verdict,
  };
}

/**
 * The 301 a catalogue page owes when the address was not the canonical one.
 *
 * The reason is discriminated the way `resolveCanonicalProduct` already does
 * it: an address naming the entity's OWN id is a canonical-spelling correction,
 * and anything else that resolved here — a tombstone's id or its slug — came
 * through a merge. Comparing against the SLUG cannot tell them apart, because
 * by this point the handle differs from the slug in both cases.
 */
function catalogueRedirect(
  routeId: 'brand' | 'product_family',
  handle: string,
  entityId: string,
  slug: string,
  request: ResolveSeoRequest,
): SeoDiagnosis | undefined {
  if (handle === slug) return undefined;
  const reason = handle === entityId ? 'canonical_spelling' : 'merged';
  return {
    resolution: {
      outcome: 'redirect',
      redirect: buildIdentityRedirect(
        buildRoutePath(routeId, slug),
        carryQueryAcrossRedirect(request.query),
        reason,
      ),
    },
  };
}

/** Everything a brand and a family answer identically. */
interface CatalogueDiagnosisInput {
  readonly routeId: 'brand' | 'product_family';
  readonly slug: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly logoFileId: string | undefined;
  readonly entryCount: number;
  readonly categoryId: string | null;
  readonly active: boolean;
  readonly request: ResolveSeoRequest;
  readonly origin: string;
}

/**
 * Compose a catalogue entity's document.
 *
 * Judged by its CATALOGUE, like a merchant: neither page has a description
 * worth indexing on its own, and a brand with one product duplicates that
 * product's own page — which is #75 policy rule 8 arriving through a different
 * door.
 */
function catalogueDiagnosis(input: CatalogueDiagnosisInput): SeoDiagnosis {
  const facts = catalogueEntityFacts({
    routeId: input.routeId,
    slug: input.slug,
    name: input.name,
    description: input.description,
    logoFileId: input.logoFileId,
  });

  const verdict = decideIndexability({
    routeAvailability: 'live',
    indexingPermitted: indexingPermittedFor(input.categoryId),
    identity: 'canonical',
    moderation: input.active ? 'clear' : 'suppressed',
    // Mercaria's own canonical record; the products beneath it carry their
    // sources' rights on their own pages.
    sourceIndexRight: 'granted',
    content: assessCatalogueContent(input.name, input.entryCount),
    offerInformation: 'not_applicable',
    locale: 'complete',
    filterUniqueness: 'not_a_filter_page',
  });

  return {
    resolution: {
      outcome: 'document',
      document: composeDocument({
        routeId: input.routeId,
        facts,
        canonicalUrl: buildCanonicalUrl(
          input.origin,
          buildRoutePath(input.routeId, input.slug),
          canonicalQueryOf(input.routeId, input.request.query),
        ),
        origin: input.origin,
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
