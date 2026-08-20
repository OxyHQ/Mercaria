/**
 * Reads and writes for `canonical_products` and its alias, source-link and
 * redirect children (#56). Same conventions as `productFamilyRepository.ts`:
 * `db` first, convergence writes are `ON CONFLICT DO NOTHING`, and the merge
 * stamp is a one-statement CAS.
 */

import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  CanonicalAliasKind,
  CanonicalRedirectReason,
  SourceLinkMethod,
  SourceLinkStatus,
} from '@mercaria/shared-types';
import { SHOPPER_VISIBLE_CATALOG_STATUSES } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  canonicalProductAliases,
  canonicalProductRedirects,
  canonicalProductSourceLinks,
  canonicalProducts,
} from '../schema/canonicalCatalog.js';

export type CanonicalProductRow = typeof canonicalProducts.$inferSelect;
export type CanonicalProductAliasRow = typeof canonicalProductAliases.$inferSelect;
export type CanonicalProductSourceLinkRow = typeof canonicalProductSourceLinks.$inferSelect;
export type CanonicalProductRedirectRow = typeof canonicalProductRedirects.$inferSelect;
export type InsertCanonicalProductInput = typeof canonicalProducts.$inferInsert;

/** The columns an update may touch. Identity columns are absent on purpose. */
export type CanonicalProductPatch = Partial<
  Pick<
    CanonicalProductRow,
    | 'name'
    | 'normalizedName'
    | 'description'
    | 'brandId'
    | 'familyId'
    | 'categoryId'
    | 'releasedAt'
    | 'discontinuedAt'
    | 'modelYear'
    | 'modelCode'
    | 'searchTokens'
    | 'variantDefiningAttributeKeys'
    | 'rating'
    | 'ratingCount'
    | 'variantCount'
    | 'status'
    | 'firstSeenAt'
    | 'lastSeenAt'
    | 'lastReviewedAt'
    | 'pinnedFields'
  >
>;

export async function insertCanonicalProduct(
  db: DatabaseOrTransaction,
  values: InsertCanonicalProductInput,
): Promise<CanonicalProductRow> {
  const rows = await db.insert(canonicalProducts).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertCanonicalProduct returned no row.');
  return row;
}

export async function updateCanonicalProduct(
  db: DatabaseOrTransaction,
  id: string,
  patch: CanonicalProductPatch,
): Promise<CanonicalProductRow | undefined> {
  const rows = await db
    .update(canonicalProducts)
    .set(patch)
    .where(eq(canonicalProducts.id, id))
    .returning();
  return rows[0];
}

export async function findCanonicalProductById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CanonicalProductRow | undefined> {
  const rows = await db.select().from(canonicalProducts).where(eq(canonicalProducts.id, id)).limit(1);
  return rows[0];
}

export async function findCanonicalProductBySlug(
  db: DatabaseOrTransaction,
  slug: string,
): Promise<CanonicalProductRow | undefined> {
  const rows = await db
    .select()
    .from(canonicalProducts)
    .where(eq(canonicalProducts.slug, slug))
    .limit(1);
  return rows[0];
}

export async function findCanonicalProductsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<CanonicalProductRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(canonicalProducts).where(inArray(canonicalProducts.id, [...ids]));
}

export async function findCanonicalProductsByNormalizedName(
  db: DatabaseOrTransaction,
  normalizedName: string,
): Promise<CanonicalProductRow[]> {
  return db
    .select()
    .from(canonicalProducts)
    .where(eq(canonicalProducts.normalizedName, normalizedName));
}

/**
 * Trigram candidates with pg_trgm's own score, ordered strongest first.
 *
 * ## The ordering is spelled as a DISTANCE, and that spelling is the index (#61)
 *
 * The obvious spelling is `ORDER BY similarity(name, $1) DESC`, and it is what
 * this read used until #61 measured it: no index can serve that ordering, so
 * Postgres fetched every row above `pg_trgm.similarity_threshold` and top-N
 * sorted it — 32,476 rows examined to return 25, at 87 ms, on the read #58 runs
 * for every candidate retrieval.
 *
 * `<->` is pg_trgm's distance operator, defined as `1 - similarity(a, b)`, so
 * ascending distance and descending similarity are the SAME ordering — and the
 * GiST index (`canonical_products_normalized_name_gist_trgm_idx`) supports it as
 * a real index scan. The plan becomes one scan carrying both `Index Cond: name %
 * $1` and `Order By: name <-> $1`, no Sort node, 25 rows touched, 13 ms.
 *
 * The `%` predicate is unchanged, so the candidate SET is unchanged; only its
 * ordering is computed differently. Ties among equally-similar rows resolve in
 * whatever order the access method produces — which was already true of the
 * sort this replaces, since neither spelling names a tiebreaker.
 *
 * The returned `similarity` VALUE is still `similarity()`, not the distance: it
 * is what callers score on, and reporting `1 - x` under the same name would be
 * a silent unit change.
 *
 * Do not "tidy" this back to `ORDER BY similarity(...) DESC` — it compiles,
 * returns the same rows, and quietly costs 6.6× more.
 */
export async function searchCanonicalProductsByNameSimilarity(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<{ product: CanonicalProductRow; similarity: number }[]> {
  const score = sql<number>`similarity(${canonicalProducts.normalizedName}, ${normalizedName})`;
  return db
    .select({ product: canonicalProducts, similarity: score })
    .from(canonicalProducts)
    .where(sql`${canonicalProducts.normalizedName} % ${normalizedName}`)
    .orderBy(sql`${canonicalProducts.normalizedName} <-> ${normalizedName}`)
    .limit(limit);
}

/** Every live product of one family — the reverse lookup a family page reads. */
export async function listProductsForFamily(
  db: DatabaseOrTransaction,
  familyId: string,
): Promise<CanonicalProductRow[]> {
  return db
    .select()
    .from(canonicalProducts)
    .where(and(eq(canonicalProducts.familyId, familyId), ne(canonicalProducts.status, 'merged')))
    .orderBy(asc(canonicalProducts.name), asc(canonicalProducts.id));
}

/** Every live product of one brand — the reverse lookup a brand page reads. */
export async function listProductsForBrand(
  db: DatabaseOrTransaction,
  brandId: string,
  limit: number,
): Promise<CanonicalProductRow[]> {
  return db
    .select()
    .from(canonicalProducts)
    .where(and(eq(canonicalProducts.brandId, brandId), ne(canonicalProducts.status, 'merged')))
    .orderBy(asc(canonicalProducts.name), asc(canonicalProducts.id))
    .limit(limit);
}

/**
 * The ONE definition of what `canonical_product_families.product_count` counts
 * (#749).
 *
 * Every writer of that column reads it here — `canonical-product.service` on
 * create and on reassignment, `backfill/stages/projections`, and the merge
 * rollup — so the stored figure cannot depend on which writer ran last. It was
 * spelled `<> 'merged'` in three of those places and inline SQL in the fourth,
 * and #749 measured what that costs: narrowing only one of them makes the
 * number change according to whether a merge or an ordinary product write
 * touched the row most recently, which is worse than being consistently wrong
 * because it cannot be reproduced or reported.
 *
 * The population is `SHOPPER_VISIBLE_CATALOG_STATUSES`, because this count is
 * published — `listBrandFamilies` renders it on the brand page beside a
 * `productCount` #628/#747 already narrowed, and `searchCandidateRepository`
 * serves it in canonical search results. A family entry claiming more products
 * than the brand admits to having is the shape that gave it away.
 */
export async function countProductsForFamily(
  db: DatabaseOrTransaction,
  familyId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(canonicalProducts)
    .where(
      and(
        eq(canonicalProducts.familyId, familyId),
        inArray(canonicalProducts.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * The ONE definition of what `brands.product_count` counts (#749).
 *
 * New here, because the merge rollup was its ONLY writer and spelled the
 * derivation inline. That is also why it is the counter with no routine repair
 * path: a family's count is re-derived by the backfill projections stage, and a
 * brand's is re-derived only when a merge or split happens to touch it.
 *
 * Published through `seoRepository` as `catalogueEntryCount`, so the same
 * shopper-visible population applies.
 */
export async function countProductsForBrand(
  db: DatabaseOrTransaction,
  brandId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(canonicalProducts)
    .where(
      and(
        eq(canonicalProducts.brandId, brandId),
        inArray(canonicalProducts.status, [...SHOPPER_VISIBLE_CATALOG_STATUSES]),
      ),
    );
  return rows[0]?.count ?? 0;
}

export interface InsertCanonicalProductAliasInput {
  productId: string;
  alias: string;
  kind: CanonicalAliasKind;
  language?: string;
  sourceRecordId?: string;
  createdByOxyUserId?: string;
}

export async function insertCanonicalProductAlias(
  db: DatabaseOrTransaction,
  input: InsertCanonicalProductAliasInput,
): Promise<CanonicalProductAliasRow | undefined> {
  const rows = await db
    .insert(canonicalProductAliases)
    .values({
      productId: input.productId,
      alias: input.alias,
      kind: input.kind,
      language: input.language ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [canonicalProductAliases.productId, canonicalProductAliases.normalizedAlias],
    })
    .returning();
  return rows[0];
}

export async function listCanonicalProductAliases(
  db: DatabaseOrTransaction,
  productId: string,
): Promise<CanonicalProductAliasRow[]> {
  return db
    .select()
    .from(canonicalProductAliases)
    .where(eq(canonicalProductAliases.productId, productId))
    .orderBy(asc(canonicalProductAliases.createdAt), asc(canonicalProductAliases.id));
}

/**
 * Every alias of several products, in ONE round trip.
 *
 * The matcher compares a declared model against a product's normalized name AND
 * its aliases, over a bounded candidate set — so the per-product read above
 * would be one query per candidate on every evaluation.
 */
export async function listCanonicalProductAliasesForProducts(
  db: DatabaseOrTransaction,
  productIds: readonly string[],
): Promise<CanonicalProductAliasRow[]> {
  if (productIds.length === 0) return [];
  return db
    .select()
    .from(canonicalProductAliases)
    .where(inArray(canonicalProductAliases.productId, [...productIds]));
}

export async function findCanonicalProductIdsByNormalizedAlias(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ productId: canonicalProductAliases.productId })
    .from(canonicalProductAliases)
    .where(eq(canonicalProductAliases.normalizedAlias, normalizedAlias));
  return rows.map((row) => row.productId);
}

export interface InsertCanonicalProductSourceLinkInput {
  productId: string;
  sourceRecordId: string;
  method: SourceLinkMethod;
  matchRule: string;
  confidence?: number;
  status?: SourceLinkStatus;
  decidedByOxyUserId?: string;
}

export async function insertCanonicalProductSourceLink(
  db: DatabaseOrTransaction,
  input: InsertCanonicalProductSourceLinkInput,
): Promise<CanonicalProductSourceLinkRow | undefined> {
  const rows = await db
    .insert(canonicalProductSourceLinks)
    .values({
      productId: input.productId,
      sourceRecordId: input.sourceRecordId,
      method: input.method,
      matchRule: input.matchRule,
      confidence: input.confidence ?? null,
      status: input.status ?? 'active',
      decidedByOxyUserId: input.decidedByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [canonicalProductSourceLinks.productId, canonicalProductSourceLinks.sourceRecordId],
      where: sql`${canonicalProductSourceLinks.status} = 'active'`,
    })
    .returning();
  return rows[0];
}

export async function listCanonicalProductSourceLinks(
  db: DatabaseOrTransaction,
  productId: string,
  status?: SourceLinkStatus,
): Promise<CanonicalProductSourceLinkRow[]> {
  const condition =
    status === undefined
      ? eq(canonicalProductSourceLinks.productId, productId)
      : and(
          eq(canonicalProductSourceLinks.productId, productId),
          eq(canonicalProductSourceLinks.status, status),
        );
  return db
    .select()
    .from(canonicalProductSourceLinks)
    .where(condition)
    .orderBy(asc(canonicalProductSourceLinks.createdAt), asc(canonicalProductSourceLinks.id));
}

/** Distinct product ids actively linked to any of these observation rows. */
export async function findCanonicalProductIdsBySourceRecordIds(
  db: DatabaseOrTransaction,
  sourceRecordIds: readonly string[],
): Promise<string[]> {
  if (sourceRecordIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ productId: canonicalProductSourceLinks.productId })
    .from(canonicalProductSourceLinks)
    .where(
      and(
        inArray(canonicalProductSourceLinks.sourceRecordId, [...sourceRecordIds]),
        eq(canonicalProductSourceLinks.status, 'active'),
      ),
    );
  return rows.map((row) => row.productId);
}

export async function insertCanonicalProductRedirect(
  db: DatabaseOrTransaction,
  input: {
    fromId: string;
    toId: string;
    reason: CanonicalRedirectReason;
    actorOxyUserId?: string;
    note?: string;
  },
): Promise<CanonicalProductRedirectRow | undefined> {
  const rows = await db
    .insert(canonicalProductRedirects)
    .values({
      fromId: input.fromId,
      toId: input.toId,
      reason: input.reason,
      actorOxyUserId: input.actorOxyUserId ?? null,
      note: input.note ?? null,
    })
    .onConflictDoNothing({
      target: [canonicalProductRedirects.fromId, canonicalProductRedirects.toId],
    })
    .returning();
  return rows[0];
}

export async function listCanonicalProductRedirects(
  db: DatabaseOrTransaction,
  fromId: string,
): Promise<CanonicalProductRedirectRow[]> {
  return db
    .select()
    .from(canonicalProductRedirects)
    .where(eq(canonicalProductRedirects.fromId, fromId))
    .orderBy(asc(canonicalProductRedirects.createdAt), asc(canonicalProductRedirects.id));
}

export async function repointCanonicalProductAliases(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerAliases = await db
    .select({ normalizedAlias: canonicalProductAliases.normalizedAlias })
    .from(canonicalProductAliases)
    .where(eq(canonicalProductAliases.productId, winnerId));
  const taken = winnerAliases.map((row) => row.normalizedAlias);

  if (taken.length > 0) {
    await db
      .delete(canonicalProductAliases)
      .where(
        and(
          eq(canonicalProductAliases.productId, loserId),
          inArray(canonicalProductAliases.normalizedAlias, taken),
        ),
      );
  }
  await db
    .update(canonicalProductAliases)
    .set({ productId: winnerId })
    .where(eq(canonicalProductAliases.productId, loserId));
}

export async function repointCanonicalProductSourceLinks(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerActive = await db
    .select({ sourceRecordId: canonicalProductSourceLinks.sourceRecordId })
    .from(canonicalProductSourceLinks)
    .where(
      and(
        eq(canonicalProductSourceLinks.productId, winnerId),
        eq(canonicalProductSourceLinks.status, 'active'),
      ),
    );
  const covered = winnerActive.map((row) => row.sourceRecordId);

  if (covered.length > 0) {
    await db
      .update(canonicalProductSourceLinks)
      .set({ productId: winnerId, status: 'superseded' })
      .where(
        and(
          eq(canonicalProductSourceLinks.productId, loserId),
          eq(canonicalProductSourceLinks.status, 'active'),
          inArray(canonicalProductSourceLinks.sourceRecordId, covered),
        ),
      );
  }
  await db
    .update(canonicalProductSourceLinks)
    .set({ productId: winnerId })
    .where(eq(canonicalProductSourceLinks.productId, loserId));
}

/**
 * Move a canonical product's rating aggregate — the PROJECTION of its `product`
 * scoped review aggregate (#76).
 *
 * `services/reviews/review-aggregate.service` is the ONLY caller and the only
 * writer of these two columns; both figures are derived from review rows in the
 * same call that lands here. A projection with one writer cannot disagree with
 * its source, which is what keeps this from being a second representation of
 * what `review_aggregates` holds. #56 product rule 11 asked for these columns
 * and left them unwritten; this is what fills them.
 *
 * Absolute SET, never a delta: the caller derived both figures, so this is the
 * whole answer rather than an adjustment to one.
 */
export async function setCanonicalProductRating(
  db: DatabaseOrTransaction,
  productId: string,
  rating: number,
  ratingCount: number,
): Promise<void> {
  await db
    .update(canonicalProducts)
    .set({ rating, ratingCount, updatedAt: new Date() })
    .where(eq(canonicalProducts.id, productId));
}

/** The merge CAS — see `productFamilyRepository.markFamilyMerged`. */
export async function markCanonicalProductMerged(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<CanonicalProductRow | undefined> {
  const rows = await db
    .update(canonicalProducts)
    .set({ status: 'merged', mergedIntoId: winnerId })
    .where(and(eq(canonicalProducts.id, loserId), ne(canonicalProducts.status, 'merged')))
    .returning();
  return rows[0];
}

export async function findProductTombstonesPointingAt(
  db: DatabaseOrTransaction,
  fromId: string,
): Promise<CanonicalProductRow[]> {
  return db.select().from(canonicalProducts).where(eq(canonicalProducts.mergedIntoId, fromId));
}

export async function retargetProductTombstones(
  db: DatabaseOrTransaction,
  fromId: string,
  toId: string,
): Promise<void> {
  await db
    .update(canonicalProducts)
    .set({ mergedIntoId: toId })
    .where(eq(canonicalProducts.mergedIntoId, fromId));
}

export async function listCanonicalProductsPage(
  db: DatabaseOrTransaction,
  offset: number,
  limit: number,
): Promise<{ rows: CanonicalProductRow[]; total: number }> {
  const rows = await db
    .select()
    .from(canonicalProducts)
    .orderBy(asc(canonicalProducts.name), asc(canonicalProducts.id))
    .offset(offset)
    .limit(limit);
  const counted = await db.select({ count: sql<number>`count(*)::int` }).from(canonicalProducts);
  return { rows, total: counted[0]?.count ?? 0 };
}
