/**
 * The reads a brand or family PAGE issues (#72).
 *
 * Everything here is a bounded, indexed read over tables #53/#56 own. There is
 * no table, no projection and no materialized view in this domain — #61
 * measured the alternative at one million offers, adopted none, and its brand
 * page is the read it indexed for
 * (`canonical_products_brand_page_idx` on `(brand_id, name, id)
 * WHERE status <> 'merged'`, 5.011 ms → 0.097 ms, 17,945 rows scanned → 20).
 * These readers keep that index's exact shape rather than inventing a second
 * ordering it cannot serve.
 *
 * ## Why a SECOND reader beside `listProductsForBrand`
 *
 * #56's reader takes a LIMIT and no cursor, which is right for the reverse
 * lookup it was written for and cannot page a big brand. #72 product-browse
 * rule 6 asks for stable cursors, so this one carries a keyset — over the SAME
 * `(name, id)` ordering and the SAME `status <> 'merged'` predicate, so the two
 * cannot disagree about which products exist or in what order.
 *
 * ## The ordering is `(name, id)` and never the primary key
 *
 * A uuid v7's leading bits are a timestamp, so ordering by id is ordering by
 * INGESTION TIME — which #74 policy rule 7 forbids by name for offers and which
 * would be a worse claim here: a brand page ordered by id says "these are the
 * newest products" while actually saying "these are the ones we crawled last".
 * `id` appears only as the TIEBREAK that makes the order total, and only
 * between products whose names are byte-identical.
 */

import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { SHOPPER_VISIBLE_CATALOG_STATUSES } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { categories } from '../schema/catalog.js';
import {
  canonicalAttributeValues,
  canonicalProductFamilies,
  canonicalProducts,
} from '../schema/canonicalCatalog.js';
import { merchants } from '../schema/merchants.js';

/** Which scope a browse is over. A union, so a caller cannot pass both. */
export type CatalogBrowseScope =
  | { readonly kind: 'brand'; readonly brandId: string }
  | { readonly kind: 'family'; readonly familyId: string };

/** The keyset position a page resumes from. */
export interface CatalogBrowseCursorPosition {
  readonly name: string;
  readonly id: string;
  /** Present only under the `release_desc` ordering, which requires it. */
  readonly releasedAt?: string;
}

export interface CatalogBrowseQuery {
  readonly scope: CatalogBrowseScope;
  readonly ordering: 'catalog_name' | 'release_desc';
  readonly limit: number;
  readonly after?: CatalogBrowseCursorPosition;
  /** Category ids a product must be in. Empty array means "no category filter". */
  readonly categoryIds?: readonly string[];
  /** Family ids a product must belong to. Only meaningful on a brand scope. */
  readonly familyIds?: readonly string[];
}

export type CatalogProductRow = typeof canonicalProducts.$inferSelect;

/** The scope predicate, stated once so both readers and both counts share it. */
function scopePredicate(scope: CatalogBrowseScope): SQL {
  return scope.kind === 'brand'
    ? eq(canonicalProducts.brandId, scope.brandId)
    : eq(canonicalProducts.familyId, scope.familyId);
}

/**
 * The keyset predicate.
 *
 * `catalog_name` is a plain row comparison, which is safe here because BOTH
 * columns are `NOT NULL` — a row comparison with a NULL member yields NULL
 * rather than true and would silently drop rows (the `listings` keyset lesson,
 * #92). `release_desc` cannot use one at all: its directions are mixed, so the
 * comparison is written out.
 */
function keysetPredicate(
  ordering: CatalogBrowseQuery['ordering'],
  after: CatalogBrowseCursorPosition,
): SQL {
  if (ordering === 'catalog_name') {
    return sql`(${canonicalProducts.name}, ${canonicalProducts.id}) > (${after.name}, ${after.id})`;
  }
  // Only reachable under an ordering the service chooses when every product in
  // scope carries a release date, so `released_at` is never NULL on either side.
  const releasedAt = after.releasedAt ?? null;
  return sql`(
    ${canonicalProducts.releasedAt} < ${releasedAt}::timestamptz
    or (
      ${canonicalProducts.releasedAt} = ${releasedAt}::timestamptz
      and (${canonicalProducts.name}, ${canonicalProducts.id}) > (${after.name}, ${after.id})
    )
  )`;
}

/** One keyset page of a brand's or a family's live canonical products. */
export async function listCatalogBrowsePage(
  db: DatabaseOrTransaction,
  query: CatalogBrowseQuery,
): Promise<CatalogProductRow[]> {
  const filters: (SQL | undefined)[] = [
    scopePredicate(query.scope),
    // The set the facet COUNT and the search LIST use, not `<> 'merged'` (#628).
    // The looser predicate admitted a `suppressed` product — the operator's own
    // "do not show" — and a `draft` one, which #60's backfill mints and nothing
    // has published, onto a page whose facet counts excluded both. The partial
    // index `canonical_products_brand_page_idx` (`where status <> 'merged'`) is
    // still used: Postgres proves `= any('{active,discontinued}')` implies it.
    inArray(canonicalProducts.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
    query.categoryIds === undefined || query.categoryIds.length === 0
      ? undefined
      : inArray(canonicalProducts.categoryId, [...query.categoryIds]),
    query.familyIds === undefined || query.familyIds.length === 0
      ? undefined
      : inArray(canonicalProducts.familyId, [...query.familyIds]),
    query.after === undefined ? undefined : keysetPredicate(query.ordering, query.after),
  ];

  const ordered =
    query.ordering === 'catalog_name'
      ? [asc(canonicalProducts.name), asc(canonicalProducts.id)]
      : [
          sql`${canonicalProducts.releasedAt} desc`,
          asc(canonicalProducts.name),
          asc(canonicalProducts.id),
        ];

  return db
    .select()
    .from(canonicalProducts)
    .where(and(...filters.filter((filter): filter is SQL => filter !== undefined)))
    .orderBy(...ordered)
    .limit(query.limit);
}

/** How many live products the scope holds, and how many of them state a release date. */
export async function countCatalogScopeProducts(
  db: DatabaseOrTransaction,
  scope: CatalogBrowseScope,
): Promise<{ total: number; withReleaseDate: number }> {
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      withReleaseDate: sql<number>`count(*) filter (where ${canonicalProducts.releasedAt} is not null)::int`,
    })
    .from(canonicalProducts)
    .where(
      and(
        scopePredicate(scope),
        // The number rendered beside the list must count the same rows it shows.
        inArray(canonicalProducts.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
      ),
    );
  const row = rows[0];
  return { total: row?.total ?? 0, withReleaseDate: row?.withReleaseDate ?? 0 };
}

export interface BrandCategoryRollupRow {
  readonly categoryId: string;
  readonly slug: string;
  readonly name: string;
  readonly productCount: number;
}

/**
 * The categories a brand's live catalogue actually reaches (#72 brand rule 5).
 *
 * Products with no category are excluded rather than bucketed into an "other"
 * row: "we have not categorised these yet" is a fact about Mercaria's data and
 * not a category a shopper can browse into.
 */
export async function listBrandCategoryRollup(
  db: DatabaseOrTransaction,
  brandId: string,
  limit: number,
): Promise<BrandCategoryRollupRow[]> {
  const rows = await db
    .select({
      categoryId: categories.id,
      slug: categories.slug,
      name: categories.name,
      productCount: sql<number>`count(*)::int`,
    })
    .from(canonicalProducts)
    .innerJoin(categories, eq(categories.id, canonicalProducts.categoryId))
    .where(and(eq(canonicalProducts.brandId, brandId), ne(canonicalProducts.status, 'merged')))
    .groupBy(categories.id, categories.slug, categories.name)
    .orderBy(sql`count(*) desc`, asc(categories.name))
    .limit(limit);
  return rows.map((row) => ({ ...row }));
}

export interface BrandFamilyRow {
  readonly familyId: string;
  readonly slug: string;
  readonly name: string;
  readonly productCount: number;
}

/** The brand's live families (#72 brand rule 3), biggest first then by name. */
export async function listBrandFamilies(
  db: DatabaseOrTransaction,
  brandId: string,
  limit: number,
): Promise<BrandFamilyRow[]> {
  const rows = await db
    .select({
      familyId: canonicalProductFamilies.id,
      slug: canonicalProductFamilies.slug,
      name: canonicalProductFamilies.name,
      productCount: canonicalProductFamilies.productCount,
    })
    .from(canonicalProductFamilies)
    .where(
      and(
        eq(canonicalProductFamilies.brandId, brandId),
        ne(canonicalProductFamilies.status, 'merged'),
      ),
    )
    .orderBy(sql`${canonicalProductFamilies.productCount} desc`, asc(canonicalProductFamilies.name))
    .limit(limit);
  return rows.map((row) => ({ ...row }));
}

export interface SharedAttributeRow {
  readonly key: string;
  readonly value: string;
}

/**
 * The attributes EVERY live product of a family agrees on (#72 family rule 3).
 *
 * "Shared" is unanimity, not frequency: `having count(distinct product_id) = $n`
 * against the family's own live product count, so an attribute four of five
 * products carry is simply absent. Anything less would state a fact of the
 * generation that does not have it.
 *
 * PRODUCT-grain values only. A variant-grain attribute is an option AXIS —
 * storage, colour — which by construction varies within a product, so
 * asserting one of a whole family would be wrong in the loudest possible place.
 *
 * `min(source_display_value)` picks the display form deterministically when two
 * products spell one normalized value differently; the unanimity itself is
 * decided on `normalized_text`, which is the comparable value.
 */
export async function listFamilySharedAttributes(
  db: DatabaseOrTransaction,
  familyId: string,
  liveProductCount: number,
  limit: number,
): Promise<SharedAttributeRow[]> {
  if (liveProductCount === 0) return [];
  const rows = await db
    .select({
      key: canonicalAttributeValues.attributeKey,
      value: sql<string>`min(${canonicalAttributeValues.sourceDisplayValue})`,
    })
    .from(canonicalAttributeValues)
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalAttributeValues.productId))
    .where(
      and(
        eq(canonicalProducts.familyId, familyId),
        ne(canonicalProducts.status, 'merged'),
        eq(canonicalAttributeValues.selectionState, 'selected'),
        sql`${canonicalAttributeValues.normalizedText} is not null`,
      ),
    )
    .groupBy(canonicalAttributeValues.attributeKey, canonicalAttributeValues.normalizedText)
    .having(sql`count(distinct ${canonicalProducts.id}) = ${liveProductCount}`)
    .orderBy(asc(canonicalAttributeValues.attributeKey))
    .limit(limit);
  return rows.map((row) => ({ ...row }));
}

export type ProductPrimaryImageRow = {
  productId: string;
  fileId: string | null;
  sourceRecordId: string | null;
  alt: string | null;
};

/**
 * One primary image per product, WITH the observation it came from.
 *
 * #70's `loadPrimaryProductImages` is the same read without
 * `source_record_id`, which is right for a search result (it renders the image
 * and states no rights) and insufficient here: #72 identity rule 3 says a
 * visual asset is shown only under recorded rights, and the rights are a
 * property of the source that supplied it. A type ALIAS rather than an
 * interface because `db.execute`'s row generic is constrained to
 * `Record<string, unknown>`, which an interface does not satisfy.
 */
export async function listPrimaryProductImages(
  db: DatabaseOrTransaction,
  productIds: readonly string[],
): Promise<ProductPrimaryImageRow[]> {
  if (productIds.length === 0) return [];
  const rows = await db.execute<ProductPrimaryImageRow>(sql`
    select distinct on (product_id)
      product_id as "productId",
      file_id as "fileId",
      source_record_id as "sourceRecordId",
      alt as "alt"
    from canonical_images
    where product_id = any(${sql.param([...productIds])}::text[])
      and status = 'active'
    order by product_id, position, id`);
  return [...rows];
}

export interface MerchantRefRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * The display identity of the merchants a brand's channel lists name.
 *
 * ONE batched read rather than a lookup per relationship: a brand with thirty
 * authorized resellers would otherwise issue thirty statements to render one
 * list. The projection is three columns and no more — a channel entry is a
 * LINK, and the merchant's own page (#73) is where the rest of it belongs.
 */
export async function findMerchantRefs(
  db: DatabaseOrTransaction,
  merchantIds: readonly string[],
): Promise<MerchantRefRow[]> {
  if (merchantIds.length === 0) return [];
  const rows = await db
    .select({ id: merchants.id, slug: merchants.slug, name: merchants.name })
    .from(merchants)
    .where(inArray(merchants.id, [...merchantIds]));
  return rows.map((row) => ({ ...row }));
}

/** The live families a set of ids resolves to — the browse's family filter check. */
export async function findLiveFamilyIds(
  db: DatabaseOrTransaction,
  familyIds: readonly string[],
): Promise<string[]> {
  if (familyIds.length === 0) return [];
  const rows = await db
    .select({ id: canonicalProductFamilies.id })
    .from(canonicalProductFamilies)
    .where(
      and(
        inArray(canonicalProductFamilies.id, [...familyIds]),
        isNull(canonicalProductFamilies.mergedIntoId),
      ),
    );
  return rows.map((row) => row.id);
}
