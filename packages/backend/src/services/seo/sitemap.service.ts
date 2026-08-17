/**
 * Reading one sitemap page (#75 §"Sitemaps and crawling") — the ONE place a
 * collection is paged and the ONE place its size is counted.
 *
 * Separated from `sitemap.ts` for the reason `document.ts` is separated from
 * `visible-facts.ts`: the rendering and the membership rule are pure and
 * testable without a database, and this is the thin layer that hands them rows.
 */

import type {
  SeoSitemapCollection,
  SeoSitemapEntry,
  SeoSitemapIndexEntry,
} from '@mercaria/shared-types';
import { SEO_SITEMAP_COLLECTIONS } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  countBrandsForSitemap,
  countCategoriesForSitemap,
  countCanonicalProductsForSitemap,
  countMerchantsForSitemap,
  latestProductLastmod,
  listBrandSitemapPage,
  listCategorySitemapPage,
  listCanonicalProductSitemapPage,
  listMerchantSitemapPage,
  type SeoSitemapCandidateRow,
} from '../../db/seo/seoRepository.js';
import { indexingPermittedFor } from './rollout.js';
import { routeServesDocument } from './seo.service.js';
import { publicRoute } from './routes.js';
import {
  classifySitemapRows,
  ROUTE_BY_COLLECTION,
  sitemapEntriesFor,
  sitemapPageCount,
  sitemapPagePath,
} from './sitemap.js';

type CollectionReader = {
  readonly count: () => Promise<number>;
  readonly page: (offset: number, limit: number) => Promise<SeoSitemapCandidateRow[]>;
};

/**
 * The rows a collection lists, or `null` when it lists nothing.
 *
 * ## Why resolvability gates this, and #256
 *
 * A sitemap entry is an INVITATION TO CRAWL a URL. If this domain publishes no
 * document for that route, the crawler is handed the bare SPA shell at 200 —
 * the generic title, the generic canonical, no `noindex` — which is a thin
 * duplicate advertised by the very policy built to refuse one.
 *
 * That is not hypothetical: #72 shipped the brand screens, the route registry's
 * gate correctly forced `brand` to `live`, and the dormant `brands` collection
 * woke up while `seo.service.ts` still answered `no_document` for it. Route
 * AVAILABILITY and document RESOLVABILITY are different facts, and membership
 * depends on the second.
 *
 * So the reader is `null` unless the collection's route actually resolves a
 * document, and `assertSitemapCollectionsResolve` below makes that a BOOT
 * failure rather than a quiet empty page — the `redirects.ts` precedent. A
 * reader that exists but whose route cannot serve is unrepresentable rather
 * than merely unlikely.
 *
 * `categories` needs no special case any more: its route is `planned`, so it
 * has no resolver, so it has no reader. What used to be a hardcoded exception
 * now falls out of the rule.
 */
function readerFor(collection: SeoSitemapCollection): CollectionReader | null {
  if (!routeServesDocument(ROUTE_BY_COLLECTION[collection])) return null;
  const db = getDb();
  switch (collection) {
    case 'products':
      return {
        count: () => countCanonicalProductsForSitemap(db),
        page: (offset, limit) => listCanonicalProductSitemapPage(db, offset, limit),
      };
    case 'brands':
      return {
        count: () => countBrandsForSitemap(db),
        page: (offset, limit) => listBrandSitemapPage(db, offset, limit),
      };
    case 'merchants':
      return {
        count: () => countMerchantsForSitemap(db),
        page: (offset, limit) => listMerchantSitemapPage(db, offset, limit),
      };
    case 'categories':
      return {
        count: () => countCategoriesForSitemap(db),
        page: (offset, limit) => listCategorySitemapPage(db, offset, limit),
      };
  }
}

/**
 * Every sitemap collection's route must resolve a document — asserted at MODULE
 * LOAD, so the process refuses to boot rather than advertising a URL it serves
 * no metadata for.
 *
 * A boot failure and not a test-only gate for the reason `redirects.ts` states
 * about its own loop proof: the two facts live in different files and drift
 * silently, and the visible symptom here is a crawler indexing thin pages,
 * which nobody sees without a crawler telling them.
 */
export function assertSitemapCollectionsResolve(): void {
  for (const collection of SEO_SITEMAP_COLLECTIONS) {
    const routeId = ROUTE_BY_COLLECTION[collection];
    const route = publicRoute(routeId);
    if (route.availability === 'live' && !routeServesDocument(routeId)) {
      throw new Error(
        `Sitemap collection '${collection}' lists '${routeId}', which is live but has no ` +
          'document resolver — every URL it advertises would be served as a bare shell. ' +
          'Add a resolver to ROUTE_RESOLVERS in seo.service.ts.',
      );
    }
  }
}

assertSitemapCollectionsResolve();

/**
 * One page of one collection.
 *
 * Returns `undefined` for a page number past the end, which the controller
 * answers 404 — a crawler asking for page 40 of a 12-page collection has a
 * stale index and should be told so rather than handed an empty document it
 * will keep re-fetching.
 */
export async function readSitemapPage(
  collection: SeoSitemapCollection,
  page: number,
  origin: string,
): Promise<readonly SeoSitemapEntry[] | undefined> {
  const reader = readerFor(collection);
  if (reader === null) return undefined;

  const pageSize = config.seo.sitemapPageSize;
  if (page < 1) return undefined;

  const total = await reader.count();
  if (page > sitemapPageCount(total, pageSize)) return undefined;

  const rows = await reader.page((page - 1) * pageSize, pageSize);
  return sitemapEntriesFor(collection, rows, origin, indexingPermittedFor);
}

/**
 * The sitemap index.
 *
 * A collection with no rows contributes NO entry: an index naming a child that
 * holds no URL costs a crawler a fetch to learn nothing, and for a route with
 * no screen behind it would advertise a target that does not exist.
 *
 * The page COUNT is derived from the row count rather than from how many pages
 * turn out to hold an indexable URL — computing the latter means reading every
 * row of every collection to build an index, which is the one thing an index
 * exists to avoid. A page whose rows are all refused therefore renders an empty
 * `<urlset>`, which is valid and honest.
 */
export async function readSitemapIndex(origin: string): Promise<SeoSitemapIndexEntry[]> {
  const pageSize = config.seo.sitemapPageSize;
  const lastmod = await latestProductLastmod(getDb());
  const entries: SeoSitemapIndexEntry[] = [];

  for (const collection of SEO_SITEMAP_COLLECTIONS) {
    const reader = readerFor(collection);
    if (reader === null) continue;
    const pages = sitemapPageCount(await reader.count(), pageSize);
    for (let page = 1; page <= pages; page += 1) {
      entries.push({
        collection,
        page,
        loc: new URL(sitemapPagePath(collection, page), origin).toString(),
        // The catalogue's own most recent meaningful change. A per-page value
        // would need the page read, which is the cost the index avoids; a
        // per-collection one is still a true statement about every child, and
        // it is what tells a crawler whether re-fetching is worth it at all.
        ...(collection === 'products' && lastmod !== null
          ? { lastmod: lastmod.toISOString() }
          : {}),
      });
    }
  }
  return entries;
}

/**
 * What the indexability policy said about ONE page of one collection.
 *
 * Bounded to a page ON PURPOSE. "How many pages of the whole catalogue are
 * indexable" is a full scan of every row of every collection, which is the one
 * thing the paginated design exists to avoid — offering it would be offering an
 * operator a request that times out on the catalogue it matters for. So the
 * answer states the collection's TOTAL row count exactly, and tallies the
 * verdicts for the page that was asked for.
 */
export interface SeoSitemapCoverage {
  readonly collection: SeoSitemapCollection;
  readonly page: number;
  /** Rows in the whole collection, before any policy is applied. */
  readonly totalRows: number;
  readonly totalPages: number;
  /** Rows on THIS page. */
  readonly pageRows: number;
  readonly indexable: number;
  /**
   * How many rows each reason refused, on this page.
   *
   * Only the reasons that actually fired appear. A zero for every other reason
   * would read as a measurement of them, and the policy answers with the FIRST
   * failing reason — so a row refused for two reasons is counted under one.
   */
  readonly refusedByReason: Readonly<Record<string, number>>;
}

/**
 * Read one collection page's coverage.
 *
 * Returns `undefined` for a collection with no reader or a page past the end —
 * the same two answers the public page read gives, from the same functions, so
 * an operator cannot be told a page exists that a crawler cannot fetch.
 */
export async function readSitemapCoverage(
  collection: SeoSitemapCollection,
  page: number,
  origin: string,
): Promise<SeoSitemapCoverage | undefined> {
  const reader = readerFor(collection);
  if (reader === null || page < 1) return undefined;

  const pageSize = config.seo.sitemapPageSize;
  const totalRows = await reader.count();
  const totalPages = sitemapPageCount(totalRows, pageSize);
  if (page > totalPages) return undefined;

  const rows = await reader.page((page - 1) * pageSize, pageSize);
  const verdicts = classifySitemapRows(collection, rows, origin, indexingPermittedFor);

  const refusedByReason: Record<string, number> = {};
  let indexable = 0;
  for (const verdict of verdicts) {
    if (verdict.indexability.outcome === 'indexable') {
      indexable += 1;
      continue;
    }
    const reason = verdict.indexability.reason;
    refusedByReason[reason] = (refusedByReason[reason] ?? 0) + 1;
  }

  return {
    collection,
    page,
    totalRows,
    totalPages,
    pageRows: rows.length,
    indexable,
    refusedByReason,
  };
}
