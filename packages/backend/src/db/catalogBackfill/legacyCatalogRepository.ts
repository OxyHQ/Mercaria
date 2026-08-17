/**
 * READ access to the legacy catalogue facts #367 workstream 13 classifies.
 *
 * There is no insert, no update and no delete anywhere in this file, and
 * `catalog-backfill-isolation.test.ts` fails the build if one appears. The one
 * write this domain performs — re-deriving `listings.category_slugs` — goes
 * through `db/catalog/listingRepository.ts`'s `updateListingColumns`, which is
 * the sanctioned writer `listing-publication-chokepoint.test.ts` already counts.
 * A second drizzle update against that table here would be a fourth writer of a
 * table whose `published_at` and archive provenance are DERIVED in exactly three
 * statements, and it would fail that census — correctly.
 *
 * The statement shape is described rather than SPELLED, which is not fussiness:
 * `listing-publication-chokepoint.test.ts` deliberately scans raw source without
 * stripping comments (its own docblock explains why), so a docblock quoting the
 * call would name this file as a writer. It did, on the first full run.
 *
 * ## The category map is loaded transitively, and it has to be
 *
 * A page of listings names a set of category ids; classifying a MERGED one needs
 * the node its identity ended in, which is not in that set. So
 * {@link loadCategoryFactsFor} follows `merged_into_category_id` outward until
 * the frontier is empty or the depth bound is reached. A chain that leaves the
 * map answers `merge_chain_unresolved` rather than throwing — a bounded loader
 * that gave up loudly would stop a whole pass on one long chain.
 */

import { and, asc, count, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { LegacyCatalogCoverage } from '@mercaria/shared-types';
import { categories, listingOptions, listings } from '../schema/catalog.js';
import {
  cohortListingPredicate,
  withCohort,
  type BackfillCohort,
} from '../../services/backfill/cohort.js';
import { productTypeCategoryScopes, productTypeDefinitions } from '../schema/productTypes.js';
import type { DatabaseOrTransaction } from '../postgres.js';
import type {
  CategoryFacts,
  LegacyListingFacts,
  ProductTypeFacts,
} from '../../services/catalog-backfill/classification.js';
import { MERGE_CHAIN_MAX_DEPTH } from '../../services/catalog-backfill/classification.js';

/** One keyset page of listings, with the cursor to resume after. */
export interface LegacyListingPage {
  readonly listings: readonly LegacyListingFacts[];
  /** `null` when the page reached the end of the catalogue. */
  readonly resumeAfterListingId: string | null;
}

/**
 * How much of the catalogue carries a legacy value at all.
 *
 * One statement with six aggregates rather than six statements: the figures are
 * compared against each other in the report (`withCategory + withoutCategory`
 * must equal `listingsTotal`), and taking them at six different instants would
 * make that comparison fail on a live catalogue for a reason that is not a bug.
 *
 * `withLegacyOptions` is a distinct count over a join, so it is taken beside
 * them rather than inside the same scan — it is the one figure that counts
 * listings by the existence of a row in another table.
 */
export async function readLegacyCatalogCoverage(
  db: DatabaseOrTransaction,
  cohort: BackfillCohort,
): Promise<LegacyCatalogCoverage> {
  const [totals] = await db
    .select({
      listingsTotal: count(),
      withCategory: sql<number>`count(*) filter (where ${listings.categoryId} is not null)::int`,
      withoutCategory: sql<number>`count(*) filter (where ${listings.categoryId} is null)::int`,
      withProductTypeText: sql<number>`count(*) filter (where ${listings.productType} is not null and btrim(${listings.productType}) <> '')::int`,
      withVendorText: sql<number>`count(*) filter (where ${listings.vendor} is not null and btrim(${listings.vendor}) <> '')::int`,
    })
    .from(listings)
    .where(cohortListingPredicate(cohort));

  const [options] = await db
    .select({
      withLegacyOptions: sql<number>`count(distinct ${listingOptions.listingId})::int`,
    })
    .from(listingOptions)
    .innerJoin(listings, eq(listings.id, listingOptions.listingId))
    .where(cohortListingPredicate(cohort));

  return {
    listingsTotal: totals?.listingsTotal ?? 0,
    withCategory: totals?.withCategory ?? 0,
    withoutCategory: totals?.withoutCategory ?? 0,
    withProductTypeText: totals?.withProductTypeText ?? 0,
    withVendorText: totals?.withVendorText ?? 0,
    withLegacyOptions: options?.withLegacyOptions ?? 0,
  };
}

/**
 * One keyset page of listings, ordered by id.
 *
 * A SHORT page ends the pass, compared against the limit rather than by looking
 * for an empty one: it saves a round trip per pass and cannot loop forever on a
 * page that happens to be exactly empty (`nextKeysetCursor`'s rule, #60).
 */
export async function listLegacyListingPage(
  db: DatabaseOrTransaction,
  input: {
    readonly cohort: BackfillCohort;
    readonly afterListingId: string | null;
    readonly limit: number;
  },
): Promise<LegacyListingPage> {
  const rows = await db
    .select({
      id: listings.id,
      categoryId: listings.categoryId,
      categorySlugs: listings.categorySlugs,
      productType: listings.productType,
    })
    .from(listings)
    .where(
      withCohort(
        input.cohort,
        input.afterListingId === null ? undefined : gt(listings.id, input.afterListingId),
      ),
    )
    .orderBy(asc(listings.id))
    .limit(input.limit);

  const page: LegacyListingFacts[] = rows.map((row) => ({
    id: row.id,
    categoryId: row.categoryId,
    categorySlugs: row.categorySlugs ?? [],
    productType: row.productType,
  }));

  return {
    listings: page,
    resumeAfterListingId:
      page.length < input.limit ? null : (page[page.length - 1]?.id ?? null),
  };
}

/** Project a `categories` row onto the facts the classifier reads. */
function toCategoryFacts(row: {
  id: string;
  slug: string;
  ancestorSlugs: string[] | null;
  ancestorIds: string[] | null;
  lifecycle: CategoryFacts['lifecycle'];
  selectable: boolean;
  mergedIntoCategoryId: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}): CategoryFacts {
  return {
    id: row.id,
    slug: row.slug,
    ancestorSlugs: row.ancestorSlugs ?? [],
    ancestorIds: row.ancestorIds ?? [],
    lifecycle: row.lifecycle,
    selectable: row.selectable,
    mergedIntoCategoryId: row.mergedIntoCategoryId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

/** Load a set of categories, and every node their merge chains reach. */
export async function loadCategoryFactsFor(
  db: DatabaseOrTransaction,
  categoryIds: readonly string[],
): Promise<ReadonlyMap<string, CategoryFacts>> {
  const loaded = new Map<string, CategoryFacts>();
  let frontier = [...new Set(categoryIds)];

  for (let depth = 0; depth <= MERGE_CHAIN_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const rows = await db
      .select({
        id: categories.id,
        slug: categories.slug,
        ancestorSlugs: categories.ancestorSlugs,
        ancestorIds: categories.ancestorIds,
        lifecycle: categories.lifecycle,
        selectable: categories.selectable,
        mergedIntoCategoryId: categories.mergedIntoCategoryId,
        effectiveFrom: categories.effectiveFrom,
        effectiveTo: categories.effectiveTo,
      })
      .from(categories)
      .where(inArray(categories.id, frontier));

    const next: string[] = [];
    for (const row of rows) {
      const facts = toCategoryFacts(row);
      loaded.set(facts.id, facts);
      if (facts.mergedIntoCategoryId !== null && !loaded.has(facts.mergedIntoCategoryId)) {
        next.push(facts.mergedIntoCategoryId);
      }
    }
    frontier = [...new Set(next)].filter((id) => !loaded.has(id));
  }

  return loaded;
}

/**
 * Every version of each named product-type key, with the scopes of each.
 *
 * All versions, not only the published one: `product_type_key_unpublished` — a
 * key that exists and has no published version — is a different verdict from
 * `product_type_no_registered_key`, and collapsing them would send somebody to
 * draft a product type that is already drafted.
 */
export async function loadProductTypeFactsFor(
  db: DatabaseOrTransaction,
  keys: readonly string[],
): Promise<ReadonlyMap<string, readonly ProductTypeFacts[]>> {
  const distinct = [...new Set(keys)];
  const byKey = new Map<string, ProductTypeFacts[]>();
  if (distinct.length === 0) return byKey;

  const versions = await db
    .select({
      id: productTypeDefinitions.id,
      key: productTypeDefinitions.key,
      lifecycle: productTypeDefinitions.lifecycle,
    })
    .from(productTypeDefinitions)
    .where(inArray(productTypeDefinitions.key, distinct));

  const scopeRows =
    versions.length === 0
      ? []
      : await db
          .select({
            productTypeDefinitionId: productTypeCategoryScopes.productTypeDefinitionId,
            categoryId: productTypeCategoryScopes.categoryId,
            includeDescendants: productTypeCategoryScopes.includeDescendants,
          })
          .from(productTypeCategoryScopes)
          .where(
            inArray(
              productTypeCategoryScopes.productTypeDefinitionId,
              versions.map((version) => version.id),
            ),
          );

  const scopesByVersion = new Map<
    string,
    { readonly categoryId: string; readonly includeDescendants: boolean }[]
  >();
  for (const scope of scopeRows) {
    const list = scopesByVersion.get(scope.productTypeDefinitionId) ?? [];
    list.push({ categoryId: scope.categoryId, includeDescendants: scope.includeDescendants });
    scopesByVersion.set(scope.productTypeDefinitionId, list);
  }

  for (const version of versions) {
    const list = byKey.get(version.key) ?? [];
    list.push({
      key: version.key,
      lifecycle: version.lifecycle,
      scopes: scopesByVersion.get(version.id) ?? [],
    });
    byKey.set(version.key, list);
  }
  return byKey;
}

/** One distinct vendor string and how many listings carry it. */
export interface LegacyVendorValue {
  readonly vendor: string;
  readonly listingCount: number;
}

/**
 * Every distinct non-blank `listings.vendor`, with its listing count.
 *
 * The same aggregate #60's `extractVendorBrandCandidates` opens with, and for
 * the same reason: a vendor string is a VALUE, and a cohort-scoped or paged
 * version of this query would produce groups that are not the real groups.
 */
export async function listLegacyVendorValues(
  db: DatabaseOrTransaction,
  /**
   * Deliberately NOT cohort-scoped, and the caller is the one that enforces it:
   * `runLegacyCatalogClassification` runs this pass only for the `all` cohort.
   * A cohort-scoped aggregate produces groups that are not the real groups —
   * #60's `vendor_brand_candidates` refuses a cohort for the same reason — so
   * the honest options are "whole catalogue" or "not in this pass", and there is
   * no parameter here through which a caller could pick a third.
   */
): Promise<readonly LegacyVendorValue[]> {
  const rows = await db
    .select({ vendor: listings.vendor, listingCount: count() })
    .from(listings)
    .where(sql`${listings.vendor} is not null and btrim(${listings.vendor}) <> ''`)
    .groupBy(listings.vendor);
  return rows.flatMap((row) =>
    row.vendor === null ? [] : [{ vendor: row.vendor, listingCount: row.listingCount }],
  );
}

/** A category that is live enough for a browse comparison to be meaningful. */
export interface ReconcilableCategory {
  readonly id: string;
  readonly slug: string;
}

/**
 * Categories a browse-reconciliation probe may compare, newest-first by id.
 *
 * Restricted to nodes a listing may actually sit on, because the probe compares
 * "what the slug filter returns" against "what the id and its descendants
 * return", and a structural node returns nothing either way — a probe whose
 * subjects all answer zero on both sides reports perfect agreement having
 * measured nothing.
 */
export async function listReconcilableCategories(
  db: DatabaseOrTransaction,
  input: { readonly afterCategoryId: string | null; readonly limit: number },
): Promise<readonly ReconcilableCategory[]> {
  return db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(
      and(
        eq(categories.lifecycle, 'published'),
        eq(categories.selectable, true),
        isNull(categories.mergedIntoCategoryId),
        input.afterCategoryId === null ? undefined : gt(categories.id, input.afterCategoryId),
      ),
    )
    .orderBy(asc(categories.id))
    .limit(input.limit);
}

/** One category's v1 `is_active` column beside the lifecycle it is derived from. */
export interface CategoryActivityProjection {
  readonly id: string;
  readonly isActive: boolean;
  readonly lifecycle: CategoryFacts['lifecycle'];
}

/**
 * Every category's `is_active` beside its `lifecycle`, keyset-paged.
 *
 * ADR 0007 D13 makes `is_active` a DERIVATION of `lifecycle = 'published'`
 * retained as a v1 read contract, and `taxonomy-write-chokepoint.test.ts` states
 * plainly that the cross-column CHECK which would hold them together is a
 * `post`-phase statement that has NOT been applied. So this pair is a legacy
 * read and a new read with nothing in the database keeping them in step — which
 * makes it exactly the comparison a reconciliation report exists to make, and
 * the one whose failure mode is a category that is live and invisible.
 */
export async function listCategoryActivityProjections(
  db: DatabaseOrTransaction,
  input: { readonly afterCategoryId: string | null; readonly limit: number },
): Promise<readonly CategoryActivityProjection[]> {
  return db
    .select({
      id: categories.id,
      isActive: categories.isActive,
      lifecycle: categories.lifecycle,
    })
    .from(categories)
    .where(
      input.afterCategoryId === null ? undefined : gt(categories.id, input.afterCategoryId),
    )
    .orderBy(asc(categories.id))
    .limit(input.limit);
}

/**
 * The two answers a browse read can give for one category, side by side.
 *
 * - `viaSlugPath` is the LEGACY read: `listings.category_slugs @> [slug]`, the
 *   contract `listingRepository`, `seoRepository`, `collectionRules`,
 *   `conditionPolicyRepository` and `searchCandidateRepository` all filter on.
 * - `viaCategoryTree` is the AUTHORITY: the category itself plus every category
 *   whose `ancestor_ids` contains it.
 *
 * They must agree. When they do not, a shopper browsing that shelf sees a
 * different set of products depending on which service answered — which is the
 * failure `moveCategory` introduces silently, because it rewrites
 * `categories.ancestor_slugs` for a whole subtree and touches no listing.
 */
export async function countListingsBothWays(
  db: DatabaseOrTransaction,
  category: ReconcilableCategory,
  cohort: BackfillCohort,
): Promise<{ viaSlugPath: number; viaCategoryTree: number }> {
  const [slugCount] = await db
    .select({ total: count() })
    .from(listings)
    .where(withCohort(cohort, sql`${listings.categorySlugs} @> array[${category.slug}]::text[]`));

  const [treeCount] = await db
    .select({ total: count() })
    .from(listings)
    .where(
      withCohort(
        cohort,
        and(
          isNotNull(listings.categoryId),
          sql`exists (
            select 1 from ${categories} c
            where c.id = ${listings.categoryId}
              and (c.id = ${category.id} or c.ancestor_ids @> array[${category.id}]::text[])
          )`,
        ),
      ),
    );

  return { viaSlugPath: slugCount?.total ?? 0, viaCategoryTree: treeCount?.total ?? 0 };
}
