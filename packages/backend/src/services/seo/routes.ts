/**
 * The public route registry (#75 §"Route plan") — ONE table, and the only place
 * a public path is spelled.
 *
 * ## Why a registry rather than a router
 *
 * expo-router already knows which screens exist; what it cannot answer is which
 * of them are PUBLIC, which entity each addresses, which of them a crawler may
 * index, which sitemap they belong to and what their canonical spelling is.
 * Those five answers have to agree with each other — a page in a sitemap that
 * the policy says is `noindex` is a crawl budget spent on a contradiction — so
 * they are one row rather than five lists.
 *
 * ## `availability` is the honesty column
 *
 * A pattern is recorded here BEFORE its screen exists, because #75 owns the
 * route plan and the pages it plans for land in other issues. A `planned` route
 * is never indexable, never in a sitemap and never served metadata: emitting a
 * title and a canonical tag for an address that renders "This screen does not
 * exist" is worse than emitting nothing, and it is the "unknown is never a soft
 * yes" rule applied to a route.
 *
 * `seo-route-registry.test.ts` is the gate, and it fails in BOTH directions: a
 * `live` route with no screen file, and a screen file that no row mentions and
 * no not-applicable list excuses. A hand-maintained map that skips what is
 * missing is not a gate.
 *
 * ## Identity is an id; a slug is presentation
 *
 * Every entity route takes ONE dynamic segment and resolves it to an id first.
 * `handle` accepts either spelling and answers with the canonical one; `id`
 * accepts only the id, because the thing has no slug at all. There is no route
 * whose only key is a slug, which is #75 route plan rule 9 held by the registry
 * rather than by whoever adds the next page.
 */

import type { PublicRoute, PublicRouteId } from '@mercaria/shared-types';
import { PUBLIC_ROUTE_IDS } from '@mercaria/shared-types';

/**
 * Every public route pattern, in the issue's own order.
 *
 * Frozen: a mutation would change what is indexable and what is redirected at
 * once, from anywhere in the process.
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = Object.freeze([
  {
    id: 'home',
    pattern: '/',
    identity: 'none',
    availability: 'live',
    screen: 'app/(app)/index.tsx',
  },
  /**
   * The canonical product page. `handle` because a product's slug is unique
   * FOREVER (ADR 0002 D12) and its id resolves too — so a link built from
   * either spelling survives, and the canonical URL states the slug.
   */
  {
    id: 'canonical_product',
    pattern: '/p/:handle',
    identity: 'handle',
    availability: 'live',
    screen: 'app/(app)/p/[handle].tsx',
    sitemapCollection: 'products',
  },
  {
    id: 'product_family',
    pattern: '/families/:handle',
    identity: 'handle',
    availability: 'planned',
  },
  {
    id: 'brand',
    pattern: '/brands/:handle',
    identity: 'handle',
    availability: 'planned',
    sitemapCollection: 'brands',
  },
  {
    id: 'merchant',
    pattern: '/merchants/:handle',
    identity: 'handle',
    availability: 'live',
    screen: 'app/(app)/merchants/[idOrSlug].tsx',
    sitemapCollection: 'merchants',
  },
  /**
   * A NATIVE Mercaria store. Its handle is deliberately NOT adoptable by
   * linkage (`store_linkage_profile_adoptions` has two members and the handle
   * is not one), which is exactly why this route can be keyed on it.
   */
  {
    id: 'native_store',
    pattern: '/stores/:handle',
    identity: 'handle',
    availability: 'live',
    screen: 'app/(app)/stores/[handle].tsx',
  },
  /**
   * The historical native-store address. Redirect only, and permanently: the
   * handle in it is the SAME handle `/stores/:handle` takes, so the redirect is
   * a pure path rewrite that can never send anybody to a different store.
   */
  {
    id: 'native_store_legacy',
    pattern: '/m/:handle',
    identity: 'handle',
    availability: 'redirect_only',
  },
  /**
   * The legacy native listing detail, and it does NOT redirect. #75 legacy rule
   * 5 forbids sending a historical order link to a different live product or
   * seller, and a canonical product page shows every seller of that model — so
   * a listing with a confident canonical mapping stays where it is and points
   * `rel=canonical` at the product instead. `docs/seo.md` §"Legacy listings"
   * carries the whole argument.
   */
  {
    id: 'legacy_listing',
    pattern: '/products/:id',
    identity: 'id',
    availability: 'live',
    screen: 'app/(app)/products/[id].tsx',
  },
  {
    id: 'seller',
    pattern: '/sellers/:oxyUserId',
    identity: 'id',
    availability: 'live',
    screen: 'app/(app)/sellers/[oxyUserId].tsx',
  },
  /**
   * Category and filtered browse. RECORDED and not built: no storefront screen
   * renders one today, in this repository or in either page issue in flight.
   * The row exists so the pattern is reserved and its sitemap collection is
   * named; it emits no URL and no metadata until a screen lands.
   */
  {
    id: 'category_browse',
    pattern: '/categories/:handle',
    identity: 'handle',
    availability: 'planned',
    sitemapCollection: 'categories',
  },
] satisfies readonly PublicRoute[]);

/** The registry, by id — built once, so a lookup is not a scan. */
const ROUTES_BY_ID: ReadonlyMap<PublicRouteId, PublicRoute> = new Map(
  PUBLIC_ROUTES.map((route) => [route.id, route]),
);

/** One recorded route, by id. Throws when the id is not in the registry. */
export function publicRoute(id: PublicRouteId): PublicRoute {
  const route = ROUTES_BY_ID.get(id);
  if (!route) throw new Error(`No public route is registered under '${id}'.`);
  return route;
}

/**
 * Does a storefront screen render this route today?
 *
 * Read before composing any LINK — a breadcrumb, a structured-data `item`, a
 * sitemap URL. `typedRoutes` is inert on this expo-router major (`~/Oxy/AGENTS.md`),
 * so nothing else would catch a link into a route that has not shipped, and the
 * failure lands under a shopper's thumb as "This screen does not exist".
 */
export function routeIsLive(id: PublicRouteId): boolean {
  return publicRoute(id).availability === 'live';
}

/** What a matched path yielded: which route, and the value of its one segment. */
export interface MatchedRoute {
  readonly route: PublicRoute;
  /** The single dynamic segment's value, decoded. Absent on a static route. */
  readonly handle?: string;
}

/**
 * Split a path into decoded segments, refusing anything that is not a plain
 * absolute path.
 *
 * A segment that fails to decode is a malformed request, not a route: returning
 * `undefined` makes the caller answer 404 rather than matching a pattern
 * against bytes nobody can read.
 */
function decodeSegments(pathname: string): string[] | undefined {
  if (!pathname.startsWith('/')) return undefined;
  const raw = pathname.split('/').filter((segment) => segment !== '');
  const decoded: string[] = [];
  for (const segment of raw) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  return decoded;
}

/**
 * Match a request path against the registry.
 *
 * Literal segments win over dynamic ones by construction: every pattern here
 * has at most ONE dynamic segment and no two patterns share a literal prefix
 * with different arities, so the first match is the only match. A test asserts
 * that property rather than trusting it, because the day somebody adds
 * `/p/compare` it stops being true silently.
 */
export function matchPublicRoute(pathname: string): MatchedRoute | undefined {
  const segments = decodeSegments(pathname);
  if (segments === undefined) return undefined;

  for (const route of PUBLIC_ROUTES) {
    const pattern = route.pattern.split('/').filter((segment) => segment !== '');
    if (pattern.length !== segments.length) continue;

    let handle: string | undefined;
    let matched = true;
    for (const [index, patternSegment] of pattern.entries()) {
      const actual = segments[index] ?? '';
      if (patternSegment.startsWith(':')) {
        if (actual === '') {
          matched = false;
          break;
        }
        handle = actual;
        continue;
      }
      if (patternSegment !== actual) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    return handle === undefined ? { route } : { route, handle };
  }
  return undefined;
}

/**
 * Build the path for one route, with its segment filled in.
 *
 * The ONE place a public path is composed. A caller that interpolated a pattern
 * itself would be a second spelling of the route, and the first thing to rot
 * when a pattern changes.
 */
export function buildRoutePath(id: PublicRouteId, handle?: string): string {
  const route = publicRoute(id);
  const segments = route.pattern.split('/').filter((segment) => segment !== '');
  const dynamic = segments.filter((segment) => segment.startsWith(':'));

  if (dynamic.length === 0) {
    if (handle !== undefined) {
      throw new Error(`Route '${id}' takes no segment, but one was supplied.`);
    }
    return route.pattern;
  }
  if (handle === undefined || handle === '') {
    throw new Error(`Route '${id}' needs a segment value.`);
  }
  return `/${segments
    .map((segment) => (segment.startsWith(':') ? encodeURIComponent(handle) : segment))
    .join('/')}`;
}

/**
 * Every registered id is in the tuple and every tuple member is registered.
 *
 * Asserted at MODULE LOAD rather than only in a test: a registry missing a row
 * would make `publicRoute` throw at the first request for that page, in
 * production, and a boot-time failure is the cheaper way to find out.
 */
for (const id of PUBLIC_ROUTE_IDS) {
  if (!ROUTES_BY_ID.has(id)) {
    throw new Error(`PUBLIC_ROUTE_IDS names '${id}', which the registry does not define.`);
  }
}
if (ROUTES_BY_ID.size !== PUBLIC_ROUTE_IDS.length) {
  throw new Error('The public route registry defines a route PUBLIC_ROUTE_IDS does not name.');
}
