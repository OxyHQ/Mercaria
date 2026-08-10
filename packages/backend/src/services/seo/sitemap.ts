/**
 * Sitemaps (#75 §"Sitemaps and crawling") — four paginated collections, an
 * index over them, and membership decided by the SAME policy the `<head>`
 * decides `robots` with.
 *
 * ## Membership IS indexability
 *
 * {@link sitemapEntriesFor} runs `decideIndexability` over each candidate row
 * rather than expressing the predicate again in SQL. Two implementations would
 * eventually disagree, and the symptom — a sitemap advertising pages that
 * answer `noindex` — is invisible without a crawler to report it. So #75
 * sitemap rule 3 ("remove merged, suppressed and non-indexable pages") is not a
 * filter anybody has to remember: a row the policy refuses produces no entry,
 * whatever refused it.
 *
 * ## Resumable means STATELESS, not checkpointed
 *
 * #75 acceptance 7 asks that generation scale and resume after failure. There
 * is no generation JOB to resume: `/sitemaps/products/7.xml` is an ordinary
 * read, ordered by primary key with an offset, and a crawler that failed to
 * fetch it fetches it again. Nothing is written, nothing is staged, and a page
 * holds the same rows across a regeneration unless the catalogue changed.
 *
 * The cost is the offset: the last page of a million-row collection skips
 * 975,000 index entries. That is an index-only scan of a btree Mercaria already
 * maintains, it happens at most once per collection per crawl, and the response
 * is cacheable for an hour. A keyset cursor would be cheaper and could not be
 * addressed by page number, which is what a sitemap index has to name.
 *
 * ## A collection with no ROWS is omitted from the index
 *
 * `sitemap.service.ts` derives each collection's page count from its row count,
 * so a collection with nothing in it contributes no child at all. It
 * deliberately does NOT derive the count from how many pages turn out to hold
 * an INDEXABLE url — computing that means reading every row of every collection
 * in order to build an index, which is the one thing an index exists to avoid.
 * A page whose rows the policy all refuses therefore renders an empty
 * `<urlset>`, which is valid, cheap and honest.
 */

import type {
  SeoIndexability,
  SeoSitemapCollection,
  SeoSitemapEntry,
  SeoSitemapIndexEntry,
} from '@mercaria/shared-types';
import { SEO_SITEMAP_COLLECTIONS } from '@mercaria/shared-types';
import type { SeoSitemapCandidateRow } from '../../db/seo/seoRepository.js';
import { assessCatalogueContent, assessVisibleContent, decideIndexability } from './indexability.js';
import type { SeoIdentityQuality, SeoModerationState } from './indexability.js';
import { buildRoutePath, publicRoute } from './routes.js';

/**
 * Which route each collection's URLs are built from.
 *
 * EXPORTED, because `sitemap.service.ts` has to ask the same question when it
 * decides whether a collection may be read at all (#256). Two copies of this
 * map is two answers to "which route is this collection about", and the one
 * that drifts is the one nobody reads.
 */
export const ROUTE_BY_COLLECTION = Object.freeze({
  products: 'canonical_product',
  brands: 'brand',
  merchants: 'merchant',
  categories: 'category_browse',
} as const);

/**
 * A canonical lifecycle status → the two policy inputs it decides.
 *
 * `merged` is an identity fact and `suppressed` is a moderation one, and they
 * are separate inputs because an operator debugging a missing page needs to
 * know which. `draft`, `inactive` and `discontinued` are all "not published as
 * a live page" and land on the moderation input — `discontinued` is the
 * interesting one: a discontinued PRODUCT still has a page worth reading, but
 * Mercaria does not ask a crawler to index a catalogue entry it has withdrawn.
 */
function classifyStatus(status: string): {
  identity: SeoIdentityQuality;
  moderation: SeoModerationState;
} {
  if (status === 'merged') return { identity: 'merged', moderation: 'clear' };
  if (status === 'active') return { identity: 'canonical', moderation: 'clear' };
  return { identity: 'canonical', moderation: 'suppressed' };
}

/**
 * Whether the rollout lever authorises indexing one entity.
 *
 * Passed IN rather than read here, the `offerComparisonPermitted` device: this
 * module stays pure, `services/seo/rollout.ts` stays the ONE place the flags
 * are interpreted, and a test can drive every lever state without a second
 * process. `sitemap.service.ts` supplies `indexingPermittedFor` and nothing
 * else does.
 */
export type IndexingPermission = (categoryId: string | null) => boolean;

/** One candidate row, the URL it would occupy and what the policy said. */
export interface SeoSitemapRowVerdict {
  readonly id: string;
  readonly loc: string;
  readonly indexability: SeoIndexability;
  readonly lastmod?: string;
}

/**
 * Run the indexability policy over one page of candidate rows.
 *
 * The shared step under BOTH the public sitemap and `/internal/seo`'s coverage
 * read, so an operator counting refusals by reason is counting the verdicts the
 * sitemap itself acted on — not a second predicate that agrees today.
 *
 * `pageIsCatalogue` distinguishes a brand or merchant page — whose content IS
 * its product list — from a product page, whose content is its own description,
 * images and identifiers. Judging a brand by a description it does not have
 * would delist every brand; judging a product by a product count would index
 * every stub.
 */
export function classifySitemapRows(
  collection: SeoSitemapCollection,
  rows: readonly SeoSitemapCandidateRow[],
  origin: string,
  indexingPermitted: IndexingPermission,
): SeoSitemapRowVerdict[] {
  const routeId = ROUTE_BY_COLLECTION[collection];
  const route = publicRoute(routeId);
  const pageIsCatalogue = collection !== 'products';

  const verdicts: SeoSitemapRowVerdict[] = [];
  for (const row of rows) {
    const { identity, moderation } = classifyStatus(row.status);
    const content = pageIsCatalogue
      ? assessCatalogueContent(row.name, row.catalogueEntryCount)
      : assessVisibleContent({
          title: row.name,
          entityName: row.name,
          // The sitemap scan reads lengths and counts rather than the strings
          // themselves — it is judging sufficiency, not composing a page — so a
          // synthetic value of the right length is handed to the same assessor
          // the document uses. The alternative is a second sufficiency rule.
          description: 'x'.repeat(row.descriptionLength),
          imageUrls: Array.from({ length: row.imageCount }, (_, index) => `image-${index}`),
          gtins: Array.from({ length: row.identifierCount }, (_, index) => `gtin-${index}`),
          breadcrumbs: [],
          offers: [],
          variantNames: [],
        });

    const indexability = decideIndexability({
      routeAvailability: route.availability,
      indexingPermitted: indexingPermitted(row.categoryId),
      identity,
      moderation,
      sourceIndexRight: row.indexRightGranted ? 'granted' : 'withheld',
      content,
      // A catalogue page is not about offers; a product with no offer at all is
      // still worth a page while it has identity, images and identifiers —
      // "historically useful offer information" is exactly the case #75 policy
      // rule 3 names, and #78 keeps the history whether or not an offer is
      // current today.
      offerInformation: pageIsCatalogue ? 'not_applicable' : 'historical',
      locale: 'complete',
      filterUniqueness: 'not_a_filter_page',
    });
    verdicts.push({
      id: row.id,
      loc: new URL(buildRoutePath(routeId, row.slug), origin).toString(),
      indexability,
      ...(row.lastmod === null ? {} : { lastmod: row.lastmod.toISOString() }),
    });
  }
  return verdicts;
}

/**
 * The entries a sitemap page carries — the indexable verdicts, projected.
 *
 * A thin filter over {@link classifySitemapRows} rather than its own pass, so
 * "sitemap membership IS the indexability policy" is a line of code rather than
 * a claim two functions have to keep agreeing on.
 */
export function sitemapEntriesFor(
  collection: SeoSitemapCollection,
  rows: readonly SeoSitemapCandidateRow[],
  origin: string,
  indexingPermitted: IndexingPermission,
): SeoSitemapEntry[] {
  const entries: SeoSitemapEntry[] = [];
  for (const verdict of classifySitemapRows(collection, rows, origin, indexingPermitted)) {
    if (verdict.indexability.outcome !== 'indexable') continue;
    entries.push({
      loc: verdict.loc,
      ...(verdict.lastmod === undefined ? {} : { lastmod: verdict.lastmod }),
    });
  }
  return entries;
}

/** XML-escape a value for a text node. */
function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/** Render one `<urlset>`. */
export function renderUrlset(entries: readonly SeoSitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const lastmod =
        entry.lastmod === undefined ? '' : `<lastmod>${escapeXml(entry.lastmod)}</lastmod>`;
      return `<url><loc>${escapeXml(entry.loc)}</loc>${lastmod}</url>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    `${urls}</urlset>`
  );
}

/** Render the `<sitemapindex>`. */
export function renderSitemapIndex(entries: readonly SeoSitemapIndexEntry[]): string {
  const children = entries
    .map((entry) => {
      const lastmod =
        entry.lastmod === undefined ? '' : `<lastmod>${escapeXml(entry.lastmod)}</lastmod>`;
      return `<sitemap><loc>${escapeXml(entry.loc)}</loc>${lastmod}</sitemap>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    `${children}</sitemapindex>`
  );
}

/** The PUBLIC path one collection page is served at. */
export function sitemapPagePath(collection: SeoSitemapCollection, page: number): string {
  return `/sitemaps/${collection}/${page}.xml`;
}

/**
 * How many pages a collection of `total` rows produces.
 *
 * At least one when there is anything at all, and ZERO when there is nothing:
 * an index entry for an empty collection advertises a crawl target with no URLs
 * in it.
 */
export function sitemapPageCount(total: number, pageSize: number): number {
  if (total <= 0) return 0;
  return Math.ceil(total / pageSize);
}

/** Is this a collection name the registry knows? */
export function isSitemapCollection(value: string): value is SeoSitemapCollection {
  return (SEO_SITEMAP_COLLECTIONS as readonly string[]).includes(value);
}
