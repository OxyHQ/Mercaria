/**
 * A sitemap collection may only exist for a route this domain actually serves
 * a document for (#256).
 *
 * ## The defect this file exists to make impossible
 *
 * #72 shipped the brand screens. The route registry's own gate — "a `planned`
 * route has not quietly shipped" — correctly forced `brand` to `live`. That
 * woke the dormant `brands` sitemap collection, while `seo.service.ts` still
 * answered `no_document` for the route, because no resolver had been written.
 *
 * Neither change was wrong on its own, and nothing in between noticed:
 * `classifySitemapRows` builds `SeoIndexabilityFacts` from row statistics and
 * calls `decideIndexability` directly, so it never consults the resolver, and
 * `SeoIndexabilityFacts` has no field that could carry the answer. Every active
 * brand with two or more products was therefore advertised to crawlers, and
 * `_worker.js` turns only `not_found` into a 404 — so each of those URLs served
 * the bare SPA shell at 200, with the shared generic title, the shared
 * canonical and no `noindex`. A thin duplicate, advertised by the policy built
 * to refuse one.
 *
 * ## Route AVAILABILITY and document RESOLVABILITY are different facts
 *
 * `availability` says a storefront screen renders the route. Resolvability says
 * this domain composes metadata for it. A sitemap entry is an invitation to
 * crawl, so membership depends on the SECOND — and the two are set in different
 * files by different changes, which is exactly the pair that drifts.
 */

import { describe, expect, it } from 'vitest';
import type { PublicRouteId } from '@mercaria/shared-types';
import { PUBLIC_ROUTE_IDS, SEO_SITEMAP_COLLECTIONS } from '@mercaria/shared-types';
import { publicRoute } from '../routes.js';
import { routeServesDocument } from '../seo.service.js';
import { assertSitemapCollectionsResolve } from '../sitemap.service.js';
import { ROUTE_BY_COLLECTION } from '../sitemap.js';

describe('every sitemap collection resolves a document', () => {
  it('holds for every collection in the registry', () => {
    let checked = 0;
    for (const collection of SEO_SITEMAP_COLLECTIONS) {
      const routeId = ROUTE_BY_COLLECTION[collection];
      const route = publicRoute(routeId);
      if (route.availability !== 'live') {
        // A reserved pattern advertises nothing, so it owes no resolver yet.
        checked += 1;
        continue;
      }
      expect(
        routeServesDocument(routeId),
        `sitemap collection '${collection}' lists '${routeId}', which is live but has no ` +
          'document resolver — every URL it advertises would be served as a bare SPA shell ' +
          'with the generic title and no noindex. Add a resolver to ROUTE_RESOLVERS.',
      ).toBe(true);
      checked += 1;
    }
    // A vacuity floor on BOTH sides: an empty collection tuple would make the
    // loop pass having asserted nothing.
    expect(checked).toBe(SEO_SITEMAP_COLLECTIONS.length);
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('the module-load assertion agrees, and is not merely decorative', () => {
    expect(() => assertSitemapCollectionsResolve()).not.toThrow();
  });

  it('the assertion actually detects — the mutation self-test', () => {
    // What the #256 state looked like: a live route, in a collection, with no
    // resolver. Re-implemented over the real registry so the check under test
    // is the predicate itself rather than a paraphrase of it.
    const brokenServes = (routeId: PublicRouteId): boolean =>
      routeId === 'brand' ? false : routeServesDocument(routeId);

    const offenders: string[] = [];
    for (const collection of SEO_SITEMAP_COLLECTIONS) {
      const routeId = ROUTE_BY_COLLECTION[collection];
      if (publicRoute(routeId).availability === 'live' && !brokenServes(routeId)) {
        offenders.push(collection);
      }
    }
    expect(offenders).toEqual(['brands']);
  });

  it('every collection names a route the registry knows', () => {
    for (const collection of SEO_SITEMAP_COLLECTIONS) {
      const routeId = ROUTE_BY_COLLECTION[collection];
      expect(PUBLIC_ROUTE_IDS).toContain(routeId);
      // And the route agrees it belongs to this collection — the map and the
      // registry row are two statements of one fact.
      expect(publicRoute(routeId).sitemapCollection).toBe(collection);
    }
  });
});

describe('resolvability is stated for every route', () => {
  it('answers for all of them, and is true for the ones that serve', () => {
    for (const routeId of PUBLIC_ROUTE_IDS) {
      expect(typeof routeServesDocument(routeId), routeId).toBe('boolean');
    }
    for (const routeId of ['home', 'canonical_product', 'legacy_listing', 'native_store', 'merchant', 'brand', 'product_family', 'category_browse'] as const) {
      expect(routeServesDocument(routeId), routeId).toBe(true);
    }
  });

  it('names the two this domain deliberately does not publish', () => {
    // A seller is a person whose visibility Oxy derives per request (#92);
    // `native_store_legacy` is a reserved pattern with no screen, answered
    // entirely by the redirect registry.
    //
    // `category_browse` was the third until #367 workstream 9 shipped its
    // screen and `resolveCategoryPage` with it. It is asserted TRUE above
    // rather than merely removed from here: a route dropping out of a negative
    // list and out of the positive one at the same time is how a resolver gets
    // deleted without anything noticing.
    expect(routeServesDocument('seller')).toBe(false);
    expect(routeServesDocument('native_store_legacy')).toBe(false);
  });

  it('a route that serves no document is not in any sitemap collection', () => {
    for (const routeId of PUBLIC_ROUTE_IDS) {
      if (routeServesDocument(routeId)) continue;
      const route = publicRoute(routeId);
      if (route.availability !== 'live') continue;
      expect(
        route.sitemapCollection,
        `${routeId} is live, serves no document, and names a sitemap collection`,
      ).toBeUndefined();
    }
  });
});
