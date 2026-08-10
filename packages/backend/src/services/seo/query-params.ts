/**
 * Query-parameter policy (#75 validation rule 5, legacy rule 6).
 *
 * Two jobs that pull in opposite directions, which is why they are one module:
 *
 *  - **A canonical URL must not multiply.** `?utm_source=newsletter`,
 *    `?currency=EUR` and `?sort=price` all address the same page, and a
 *    canonical tag that repeated them would tell a crawler there are four
 *    products where there is one. So the canonical builder accepts ONLY the
 *    parameters that are part of the address.
 *  - **A redirect must not lose attribution, and must not carry a secret.**
 *    #75 legacy rule 6 asks for both halves in one sentence. Attribution and
 *    preference parameters survive a redirect; an UNCLASSIFIED parameter does
 *    not, because a parameter nobody has classified may be a token, an email
 *    address or a session id.
 *
 * ## The prohibition is a TYPE
 *
 * `SeoCanonicalQueryKind` and `SeoNonCanonicalQueryKind` are disjoint unions in
 * `@mercaria/shared-types`, and {@link buildCanonicalUrl} takes only the first.
 * There is no argument an emitter could pass to put a tracking parameter in a
 * canonical URL, and `seo-isolation.test.ts` asserts the two tuples share no
 * member — the `CATALOG_SOURCE_PAYLOAD_FIELDS` device.
 *
 * ## The classification is a hand-maintained map, and it FAILS on a miss
 *
 * An unrecognised parameter is `unclassified` and is dropped from everything.
 * That is the only safe default: the alternative — carrying what we do not
 * recognise — is how a password-reset token ends up in a `Referer` header on
 * somebody else's domain.
 */

import type {
  PublicRouteId,
  SeoCanonicalQueryKind,
  SeoQueryKind,
} from '@mercaria/shared-types';
import { SEO_CANONICAL_QUERY_KINDS, SEO_NON_CANONICAL_QUERY_KINDS } from '@mercaria/shared-types';

/**
 * The parameters that are part of an ADDRESS, by name.
 *
 * Deliberately tiny. Every addition widens the set of URLs a crawler may treat
 * as distinct pages, so each one has to earn it by naming genuinely different
 * content.
 */
const CANONICAL_PARAM_KINDS: ReadonlyMap<string, SeoCanonicalQueryKind> = new Map([
  // `/p/:handle?variant=` is a variant-scoped read, not a filter: the offers
  // are a different set and the page says so (#71 acceptance 4).
  ['variant', 'variant'],
  // Page 2 of a browse is its own address with its own content.
  ['page', 'page'],
]);

/**
 * The parameters Mercaria RECOGNISES but never canonicalises.
 *
 * `attribution` is carried across a redirect so a campaign keeps its credit;
 * `preference` is carried because a shopper who chose a currency chose it and a
 * redirect is not a reason to forget. Neither ever reaches a canonical URL.
 */
const NON_CANONICAL_PARAM_KINDS: ReadonlyMap<string, 'attribution' | 'preference'> = new Map([
  ['utm_source', 'attribution'],
  ['utm_medium', 'attribution'],
  ['utm_campaign', 'attribution'],
  ['utm_term', 'attribution'],
  ['utm_content', 'attribution'],
  ['utm_id', 'attribution'],
  // Mercaria's own referral parameter (#125) and the two ad-network click ids
  // a browser arrives with. Recognised so they SURVIVE a redirect; excluded
  // from canonical so they cannot mint a second address.
  ['ref', 'attribution'],
  ['gclid', 'attribution'],
  ['fbclid', 'attribution'],
  ['msclkid', 'attribution'],
  // Shopper choices the page reads and the address does not describe.
  ['currency', 'preference'],
  ['intent', 'preference'],
  ['experience', 'preference'],
  ['sort', 'preference'],
  ['market', 'preference'],
]);

/** Classify one observed parameter name. */
export function classifyQueryParam(name: string): SeoQueryKind {
  const canonical = CANONICAL_PARAM_KINDS.get(name);
  if (canonical !== undefined) return canonical;
  return NON_CANONICAL_PARAM_KINDS.get(name) ?? 'unclassified';
}

/**
 * Which canonical parameters a route may carry.
 *
 * A route-scoped allow-list rather than a global one: `?variant=` names a real
 * configuration on a product page and names nothing at all on a brand page, so
 * `/brands/apple?variant=x` is a duplicate of `/brands/apple` and must
 * canonicalise to it.
 */
const CANONICAL_PARAMS_BY_ROUTE: Readonly<Record<PublicRouteId, readonly SeoCanonicalQueryKind[]>> =
  Object.freeze({
    home: [],
    canonical_product: ['variant'],
    product_family: ['page'],
    brand: ['page'],
    merchant: ['page'],
    native_store: ['page'],
    native_store_legacy: [],
    legacy_listing: [],
    seller: ['page'],
    category_browse: ['page'],
  });

/** The canonical parameter kinds one route recognises. */
export function canonicalParamsForRoute(
  routeId: PublicRouteId,
): readonly SeoCanonicalQueryKind[] {
  return CANONICAL_PARAMS_BY_ROUTE[routeId];
}

/**
 * The canonical parameters actually present on a request, filtered to the ones
 * this route recognises and normalised into a stable order.
 *
 * Order is the tuple's, never the request's: two crawlers that arrived at
 * `?page=2&variant=v` and `?variant=v&page=2` must be told the same canonical
 * address, and sorting by the declared tuple is what makes that true without a
 * second sort rule to keep in step.
 */
export function canonicalQueryOf(
  routeId: PublicRouteId,
  query: URLSearchParams,
): readonly (readonly [SeoCanonicalQueryKind, string])[] {
  const permitted = new Set(canonicalParamsForRoute(routeId));
  const kept: (readonly [SeoCanonicalQueryKind, string])[] = [];
  for (const kind of SEO_CANONICAL_QUERY_KINDS) {
    if (!permitted.has(kind)) continue;
    const value = query.get(kind);
    if (value === null || value.trim() === '') continue;
    kept.push([kind, value]);
  }
  return kept;
}

/**
 * The absolute canonical URL for one page.
 *
 * Takes a route path and the CANONICAL parameters only — there is no argument
 * for anything else, which is the prohibition. The origin comes from the
 * caller so this stays a pure function; `document.ts` passes `config.web.origin`
 * and nothing else does.
 */
export function buildCanonicalUrl(
  origin: string,
  path: string,
  canonicalQuery: readonly (readonly [SeoCanonicalQueryKind, string])[] = [],
): string {
  const url = new URL(path, origin);
  // Drop anything the path itself carried: a caller that handed us
  // `/p/x?utm_source=y` gets a canonical URL without it rather than a silent
  // pass-through.
  url.search = '';
  for (const [kind, value] of canonicalQuery) url.searchParams.set(kind, value);
  return url.toString();
}

/**
 * The query string a redirect carries forward.
 *
 * Canonical parameters survive because they are part of the address;
 * attribution and preference survive because #75 legacy rule 6 asks that
 * attribution be preserved across redirects and a shopper's choice is not
 * something a redirect should undo. Everything else is DROPPED — the same rule
 * asks that sensitive query data not leak, and the only parameters that can be
 * shown not to be sensitive are the ones somebody classified.
 *
 * Returns the string WITHOUT a leading `?`; empty when nothing survives.
 */
export function carryQueryAcrossRedirect(query: URLSearchParams): string {
  const carried = new URLSearchParams();
  // `URLSearchParams` preserves insertion order, and iterating the source
  // preserves the shopper's — which is what a campaign report expects to see.
  for (const [name, value] of query) {
    if (classifyQueryParam(name) === 'unclassified') continue;
    carried.append(name, value);
  }
  return carried.toString();
}

/**
 * The two tuples are disjoint, asserted at MODULE LOAD.
 *
 * A member that appeared in both would make `classifyQueryParam` answer
 * "canonical" for a tracking parameter, and every canonical URL downstream
 * would carry it. That is a boot failure, not a test failure.
 */
for (const kind of SEO_CANONICAL_QUERY_KINDS) {
  if ((SEO_NON_CANONICAL_QUERY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`'${kind}' is both a canonical and a non-canonical query kind.`);
  }
}
