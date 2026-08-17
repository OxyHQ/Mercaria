/**
 * The reads the public routing and SEO surface needs (#75).
 *
 * READ ONLY. This domain owns no table, adds no projection and no materialized
 * view — the #71 precedent, for the same reason: #61 measured the canonical
 * graph at a million offers and adopted neither, and a sitemap is a keyset scan
 * over rows that already exist.
 *
 * ## `lastmod` is a MEANINGFUL change, and `updated_at` is not one
 *
 * #75 sitemap rule 2 asks for a `lastmod` from meaningful public changes rather
 * than from every offer poll, and the obvious column is a trap:
 * `canonical_products.updated_at` moves on EVERY source observation, because
 * `applyProductSourceObservation` always writes `last_seen_at`. A sitemap built
 * on it would tell a crawler that every product in the catalogue changed
 * whenever the feed ran, which is precisely how a large site loses its crawl
 * budget.
 *
 * So {@link productSitemapLastmod} is composed from four timestamps that move
 * only when something a VISITOR would see changed:
 *
 *  - `canonical_products.created_at` — the floor; the page came into existence.
 *  - `canonical_products.last_reviewed_at` — an operator correction. The only
 *    path that renames a product or changes its brand sets it, and nothing
 *    else does.
 *  - `max(canonical_field_provenance.selected_at)` — a source-applied field
 *    that actually CHANGED. `recordFieldProvenance` is called once per APPLIED
 *    field, so a re-delivered identical feed writes none.
 *  - `max(canonical_images.updated_at)` over the ACTIVE images — a new picture
 *    or a withdrawn one. `insertCanonicalImage` is `onConflictDoNothing`, so a
 *    repeat observation of the same image moves nothing.
 *
 * `canonical_variants` is deliberately absent from that list: a variant row's
 * `updated_at` does move on an observation, and including it would reintroduce
 * exactly the poll sensitivity the whole computation exists to avoid. A new
 * configuration therefore does not itself move `lastmod` — the field
 * provenance and image rows that arrive with it usually do, and a `lastmod`
 * that is occasionally early is a smaller error than one that is always wrong.
 *
 * A realdb test drives it: an observation that changes nothing must leave
 * `lastmod` where it was, and an operator correction must move it.
 */

import { and, asc, count, eq, inArray, isNotNull, max, sql } from 'drizzle-orm';
import { qualified } from '@oxyhq/db';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  canonicalFieldProvenance,
  canonicalImages,
  canonicalProducts,
  canonicalProductSourceLinks,
  productIdentifiers,
} from '../schema/canonicalCatalog.js';
import { categories, listings } from '../schema/catalog.js';
import { catalogSourceConfigs, catalogSourcePolicies } from '../schema/ingestion.js';
import { brands } from '../schema/organizations.js';
import { merchants } from '../schema/merchants.js';
import { sourceRecords } from '../schema/provenance.js';

/**
 * One candidate row for a sitemap, with everything the indexability policy
 * needs about it.
 *
 * The policy runs in TypeScript over these rows rather than as a SQL predicate,
 * because the same function decides what a document's `robots` tag says. Two
 * implementations of "is this indexable" would eventually disagree, and the
 * symptom — a sitemap full of `noindex` URLs — is invisible without a crawler
 * to report it.
 */
export interface SeoSitemapCandidateRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly categoryId: string | null;
  readonly lastmod: Date | null;
  /** Whether every contributing catalogue source grants the `index` right. */
  readonly indexRightGranted: boolean;
  /** What the entity's own content amounts to — a description length, a count. */
  readonly descriptionLength: number;
  readonly imageCount: number;
  readonly identifierCount: number;
  /** Products beneath a brand or merchant. Zero for a product row. */
  readonly catalogueEntryCount: number;
}

/**
 * The `lastmod` expression for one product, as SQL.
 *
 * A single scalar subquery per component rather than a join, so a product with
 * forty images and twelve provenance rows produces one row and not four
 * hundred and eighty. Every correlated reference is qualified — an unqualified
 * drizzle column in a correlated subquery renders bare and silently compares
 * the subquery's own columns to each other (`CONVENTIONS.md`).
 */
function productLastmodExpression() {
  return sql<Date | null>`greatest(
    ${qualified(canonicalProducts.createdAt)},
    ${qualified(canonicalProducts.lastReviewedAt)},
    (
      select max(${qualified(canonicalFieldProvenance.selectedAt)})
      from ${canonicalFieldProvenance}
      where ${qualified(canonicalFieldProvenance.productId)} = ${qualified(canonicalProducts.id)}
    ),
    (
      select max(${qualified(canonicalImages.updatedAt)})
      from ${canonicalImages}
      where ${qualified(canonicalImages.productId)} = ${qualified(canonicalProducts.id)}
        and ${qualified(canonicalImages.status)} = 'active'
    )
  )`;
}

/**
 * Does EVERY catalogue source behind this product grant the `index` right?
 *
 * `not exists (a contributing source that withholds it)`, and the two joins
 * decide who is even asked.
 *
 * **A source with no ingestion CONFIG is not governed by a rights policy**, and
 * the join onto `catalog_source_configs` is INNER for exactly that reason. The
 * operator surface and #60's backfill mint `catalog_sources` rows that are
 * Mercaria's own provenance registry entries with no agreement behind them;
 * applying #62's "no active policy means NO rights" to those would answer
 * `noindex` for the entire backfilled catalogue, which is the permissive rule
 * failing in the destructive direction. A CONFIGURED source is a commercial
 * relationship and gets #62's rule verbatim: no active policy permits nothing.
 *
 * The conjunction is conservative the other way round — ONE feed that forbids
 * indexing withdraws the page, because Mercaria cannot tell a crawler to ignore
 * the paragraph that feed supplied.
 *
 * The right is read from the ACTIVE policy version, exactly as
 * `resolveSourceRights` does: `catalog_sources` projects three coarse columns
 * and `may_index` is not one of them, so reading the projection would answer a
 * different question. The status is the CONFIG's, the same argument the
 * derivation takes.
 */
function indexRightExpression() {
  return sql<boolean>`not exists (
    select 1
    from ${canonicalProductSourceLinks}
    join ${sourceRecords}
      on ${qualified(sourceRecords.id)} = ${qualified(canonicalProductSourceLinks.sourceRecordId)}
    join ${catalogSourceConfigs}
      on ${qualified(catalogSourceConfigs.sourceId)} = ${qualified(sourceRecords.sourceId)}
    left join ${catalogSourcePolicies}
      on ${qualified(catalogSourcePolicies.sourceId)} = ${qualified(sourceRecords.sourceId)}
     and ${qualified(catalogSourcePolicies.status)} = 'active'
    where ${qualified(canonicalProductSourceLinks.productId)} = ${qualified(canonicalProducts.id)}
      and ${qualified(canonicalProductSourceLinks.status)} = 'active'
      and (
        ${qualified(catalogSourcePolicies.id)} is null
        or ${qualified(catalogSourcePolicies.mayIndex)} = false
        or ${qualified(catalogSourceConfigs.status)} not in ('active', 'paused', 'failed')
      )
  )`;
}

/** How many products in this ordered page of the catalogue. */
export async function countCanonicalProductsForSitemap(
  db: DatabaseOrTransaction,
): Promise<number> {
  const [row] = await db.select({ total: count() }).from(canonicalProducts);
  return row?.total ?? 0;
}

/**
 * One page of product sitemap candidates, ordered by id.
 *
 * `ORDER BY id` with `OFFSET` rather than a keyset cursor: a sitemap index has
 * to name its children by a stable, addressable URL, and a cursor changes the
 * moment a row is inserted. The order is the primary key's, so page N holds the
 * same rows across a regeneration unless the catalogue itself changed — which
 * is what makes a failed fetch of `/seo/sitemaps/products/7.xml` resumable by
 * fetching that one URL again, with no job state anywhere.
 */
export async function listCanonicalProductSitemapPage(
  db: DatabaseOrTransaction,
  offset: number,
  limit: number,
): Promise<SeoSitemapCandidateRow[]> {
  const rows = await db
    .select({
      id: canonicalProducts.id,
      slug: canonicalProducts.slug,
      name: canonicalProducts.name,
      status: canonicalProducts.status,
      categoryId: canonicalProducts.categoryId,
      description: canonicalProducts.description,
      modelCode: canonicalProducts.modelCode,
      lastmod: productLastmodExpression(),
      indexRightGranted: indexRightExpression(),
      imageCount: sql<number>`(
        select count(*)::int
        from ${canonicalImages}
        where ${qualified(canonicalImages.productId)} = ${qualified(canonicalProducts.id)}
          and ${qualified(canonicalImages.status)} = 'active'
      )`,
      identifierCount: sql<number>`(
        select count(*)::int
        from ${productIdentifiers}
        where ${qualified(productIdentifiers.productId)} = ${qualified(canonicalProducts.id)}
          and ${qualified(productIdentifiers.status)} = 'active'
      )`,
    })
    .from(canonicalProducts)
    .orderBy(asc(canonicalProducts.id))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    categoryId: row.categoryId,
    lastmod: row.lastmod === null ? null : new Date(row.lastmod),
    indexRightGranted: row.indexRightGranted,
    descriptionLength: (row.description ?? '').trim().length,
    imageCount: Number(row.imageCount),
    identifierCount: Number(row.identifierCount) + (row.modelCode === null ? 0 : 1),
    catalogueEntryCount: 0,
  }));
}

/** How many brands the sitemap considers. */
export async function countBrandsForSitemap(db: DatabaseOrTransaction): Promise<number> {
  const [row] = await db.select({ total: count() }).from(brands);
  return row?.total ?? 0;
}

/**
 * One page of brand sitemap candidates.
 *
 * A brand's own `updated_at` is safe here in a way a product's is not: nothing
 * polls a brand row per offer, and `applyBrandSourceObservation` writes only
 * when a field changes. Its content is judged by `product_count` — a brand page
 * IS its product list, and a brand with one product duplicates that product's
 * own page.
 */
export async function listBrandSitemapPage(
  db: DatabaseOrTransaction,
  offset: number,
  limit: number,
): Promise<SeoSitemapCandidateRow[]> {
  const rows = await db
    .select({
      id: brands.id,
      slug: brands.slug,
      name: brands.name,
      status: brands.status,
      description: brands.description,
      productCount: brands.productCount,
      logoFileId: brands.logoFileId,
      updatedAt: brands.updatedAt,
      lastReviewedAt: brands.lastReviewedAt,
    })
    .from(brands)
    .orderBy(asc(brands.id))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    categoryId: null,
    lastmod: row.lastReviewedAt ?? row.updatedAt,
    // A brand is Mercaria's own canonical organisation record; it carries no
    // per-source display right of its own, and the products beneath it carry
    // theirs on their own pages.
    indexRightGranted: true,
    descriptionLength: (row.description ?? '').trim().length,
    imageCount: row.logoFileId === null ? 0 : 1,
    identifierCount: 0,
    catalogueEntryCount: row.productCount,
  }));
}

/** How many merchants the sitemap considers. */
export async function countMerchantsForSitemap(db: DatabaseOrTransaction): Promise<number> {
  const [row] = await db.select({ total: count() }).from(merchants);
  return row?.total ?? 0;
}

/** One page of merchant sitemap candidates. */
export async function listMerchantSitemapPage(
  db: DatabaseOrTransaction,
  offset: number,
  limit: number,
): Promise<SeoSitemapCandidateRow[]> {
  const rows = await db
    .select({
      id: merchants.id,
      slug: merchants.slug,
      name: merchants.name,
      status: merchants.status,
      description: merchants.description,
      offerCount: merchants.offerCount,
      updatedAt: merchants.updatedAt,
      lastReviewedAt: merchants.lastReviewedAt,
    })
    .from(merchants)
    .orderBy(asc(merchants.id))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    categoryId: null,
    lastmod: row.lastReviewedAt ?? row.updatedAt,
    indexRightGranted: true,
    descriptionLength: (row.description ?? '').trim().length,
    imageCount: 0,
    identifierCount: 0,
    catalogueEntryCount: row.offerCount,
  }));
}

/**
 * The `lastmod` and the source `index` right for ONE product.
 *
 * The same two expressions the sitemap page uses, so a document and the sitemap
 * entry beside it cannot disagree about either.
 */
export async function findProductSeoFacts(
  db: DatabaseOrTransaction,
  productId: string,
): Promise<{ lastmod: Date | null; indexRightGranted: boolean } | undefined> {
  const [row] = await db
    .select({
      lastmod: productLastmodExpression(),
      indexRightGranted: indexRightExpression(),
    })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, productId))
    .limit(1);
  if (!row) return undefined;
  return {
    lastmod: row.lastmod === null ? null : new Date(row.lastmod),
    indexRightGranted: row.indexRightGranted,
  };
}

/**
 * How many products each of several brands has, in one round trip.
 *
 * Read from the products themselves rather than from `brands.product_count`
 * when a caller needs the live number — the rollup is maintained by the write
 * chokepoints and is the right thing for a sitemap scan, but a page rendering
 * "3 products" beside a count of 4 is the kind of disagreement a shopper
 * notices.
 */
export async function countProductsByBrand(
  db: DatabaseOrTransaction,
  brandIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (brandIds.length === 0) return new Map();
  const rows = await db
    .select({ brandId: canonicalProducts.brandId, total: count() })
    .from(canonicalProducts)
    .where(
      and(
        isNotNull(canonicalProducts.brandId),
        inArray(canonicalProducts.brandId, [...brandIds]),
        eq(canonicalProducts.status, 'active'),
      ),
    )
    .groupBy(canonicalProducts.brandId);
  return new Map(rows.map((row) => [row.brandId ?? '', row.total]));
}

/** The most recent meaningful change across the whole product catalogue. */
export async function latestProductLastmod(db: DatabaseOrTransaction): Promise<Date | null> {
  const [row] = await db
    .select({ latest: max(canonicalFieldProvenance.selectedAt) })
    .from(canonicalFieldProvenance)
    .where(isNotNull(canonicalFieldProvenance.productId));
  return row?.latest ?? null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Categories (#367 workstream 9)                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One category, as the SEO resolver needs it.
 *
 * A narrow projection rather than the taxonomy DTO: this domain composes a
 * title, a trail and an indexability verdict, and a row carrying a lifecycle it
 * does not read is a row somebody eventually reads.
 */
export interface CategorySeoRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly lifecycle: string;
  readonly isActive: boolean;
  /** Root-first, excluding this row — the taxonomy's own authority (ADR 0007 D2). */
  readonly ancestorIds: readonly string[];
  readonly mergedIntoCategoryId: string | null;
  readonly updatedAt: Date | null;
}

const CATEGORY_SEO_COLUMNS = {
  id: categories.id,
  slug: categories.slug,
  name: categories.name,
  lifecycle: categories.lifecycle,
  isActive: categories.isActive,
  ancestorIds: categories.ancestorIds,
  mergedIntoCategoryId: categories.mergedIntoCategoryId,
  updatedAt: categories.updatedAt,
} as const;

/**
 * One category by its public handle — its ID or its current SLUG.
 *
 * The id is tried FIRST and in its own statement. An id is opaque and a slug is
 * chosen, so one query `where id = $1 or slug = $1` would let a category whose
 * slug happened to equal another's id shadow it — and the shadowing row is the
 * one a shopper never asked for. Two statements make the precedence explicit
 * rather than dependent on which row the planner returned.
 *
 * Every lifecycle is returned, including `merged` and `suppressed`: the caller
 * decides what to do with a withdrawn category, and a read that hid them would
 * make a tombstone indistinguishable from an address that never existed.
 */
export async function findCategorySeoRow(
  db: DatabaseOrTransaction,
  handle: string,
): Promise<CategorySeoRow | undefined> {
  const [byId] = await db
    .select(CATEGORY_SEO_COLUMNS)
    .from(categories)
    .where(eq(categories.id, handle))
    .limit(1);
  if (byId) return byId;

  const [bySlug] = await db
    .select(CATEGORY_SEO_COLUMNS)
    .from(categories)
    .where(eq(categories.slug, handle))
    .limit(1);
  return bySlug;
}

/**
 * The ancestors of one category, root-first, for its breadcrumb trail.
 *
 * Ordered in TypeScript from `ancestorIds` rather than by any column: that
 * array IS the root-first order, and an `order by position` would re-derive it
 * from sibling ordering, which says nothing about depth. An ancestor row that
 * has gone missing is simply absent from the trail — a breadcrumb with a hole
 * is better than one that invents a level.
 */
export async function listCategoryBreadcrumb(
  db: DatabaseOrTransaction,
  ancestorIds: readonly string[],
): Promise<readonly { readonly id: string; readonly slug: string; readonly name: string }[]> {
  if (ancestorIds.length === 0) return [];
  const rows = await db
    .select({ id: categories.id, slug: categories.slug, name: categories.name })
    .from(categories)
    .where(inArray(categories.id, [...ancestorIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ancestorIds.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}

/**
 * How many active listings each of these categories' pages shows.
 *
 * Counted on `category_slugs`, which carries the category's own slug plus every
 * ancestor's, because that is what the browse read filters on — so this is the
 * number a shopper sees rather than a different one computed from
 * `category_id`. A parent's page legitimately counts its descendants' listings;
 * counting only direct assignments would call every grouping level thin.
 */
export async function countActiveListingsInCategories(
  db: DatabaseOrTransaction,
  slugs: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (slugs.length === 0) return new Map();
  const totals = new Map<string, number>();
  for (const slug of slugs) {
    const [row] = await db
      .select({ total: count() })
      .from(listings)
      .where(
        and(
          eq(listings.status, 'active'),
          sql`${listings.categorySlugs} @> array[${slug}]::text[]`,
        ),
      );
    totals.set(slug, row?.total ?? 0);
  }
  return totals;
}

/** Every category the sitemap may consider. */
export async function countCategoriesForSitemap(db: DatabaseOrTransaction): Promise<number> {
  const [row] = await db.select({ total: count() }).from(categories);
  return row?.total ?? 0;
}

/**
 * One page of category sitemap candidates.
 *
 * `catalogueEntryCount` is the listing count its page shows, so the same
 * `assessCatalogueContent` that judges a brand judges a category — a shelf with
 * one item on it duplicates that item's own page, which is #75 policy rule 8
 * arriving through the taxonomy's door.
 *
 * `categoryId` is the row's OWN id, which is what makes a canary cohort able to
 * include a category at all: every other candidate type answers `null` there
 * unless it carries somebody else's category.
 */
export async function listCategorySitemapPage(
  db: DatabaseOrTransaction,
  offset: number,
  limit: number,
): Promise<SeoSitemapCandidateRow[]> {
  const rows = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      lifecycle: categories.lifecycle,
      isActive: categories.isActive,
      updatedAt: categories.updatedAt,
    })
    .from(categories)
    .orderBy(asc(categories.id))
    .limit(limit)
    .offset(offset);

  const counts = await countActiveListingsInCategories(
    db,
    rows.map((row) => row.slug),
  );

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    // The policy reads a `status`, and a category states its state in two
    // columns. `published AND is_active` is the conjunction the public
    // navigation read already uses (`docs/navigation.md`): the derived flag and
    // the lifecycle can disagree until the `post` migration lands, and a page
    // should be withheld when EITHER says withdrawn.
    status: row.lifecycle === 'published' && row.isActive ? 'active' : 'suppressed',
    categoryId: row.id,
    lastmod: row.updatedAt,
    // A category is Mercaria's own taxonomy record; the listings beneath it
    // carry their sources' rights on their own pages.
    indexRightGranted: true,
    // A category has no description column, so its content IS its catalogue.
    descriptionLength: 0,
    imageCount: 0,
    identifierCount: 0,
    catalogueEntryCount: counts.get(row.slug) ?? 0,
  }));
}
