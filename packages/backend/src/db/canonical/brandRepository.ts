/**
 * Reads and writes for `brands`, `brand_aliases` and `brand_source_links`.
 *
 * `db` first everywhere (the payment-domain convention): every mutating helper
 * here has at least one caller that must be atomic with other writes — an
 * observation and its link, a merge and its repoints — and a `Database`-only
 * signature would silently push that caller outside its transaction.
 *
 * Nothing here decides identity. Normalization, confidence rules, review
 * routing and the merge protocol live in `services/canonical/`; this module
 * states the SQL shapes, including the two convergence writes (alias and link
 * inserts are `ON CONFLICT DO NOTHING`, so repeats are genuine no-ops) and the
 * one CAS ({@link markBrandMerged} — a re-issued merge sees `status='merged'`
 * and affects nothing, ADR 0002 D22).
 */

import { and, arrayContains, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { CanonicalAliasKind, SourceLinkMethod, SourceLinkStatus } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { brandAliases, brands, brandSourceLinks } from '../schema/organizations.js';

/** A brand row as the services read it back. */
export type BrandRow = typeof brands.$inferSelect;

/** An alias row as the services read it back. */
export type BrandAliasRow = typeof brandAliases.$inferSelect;

/** A source-link row as the services read it back. */
export type BrandSourceLinkRow = typeof brandSourceLinks.$inferSelect;

/** What the write service supplies to mint a brand. */
/**
 * #915: `nameFoldVersion` is REQUIRED here, though the column has a DEFAULT.
 *
 * The database default is load-bearing — the serving image writes none of these
 * columns and they are NOT NULL — but a default also makes `$inferInsert` mark
 * the field OPTIONAL, which is how a new writer folds a name and silently takes
 * version 1 while folding under 2. The requirement is re-imposed at the input
 * type instead. Reasoning in full: `canonicalProductRepository.ts`.
 */
export type InsertBrandInput = typeof brands.$inferInsert &
  Required<Pick<typeof brands.$inferInsert, 'nameFoldVersion'>>;

/** The columns a brand update may touch. Identity columns are absent on purpose. */
export type BrandPatch = Partial<
  Pick<
    BrandRow,
    | 'name'
    | 'normalizedName'
    // #915: patchable so a re-fold moves the value and its version together.
    | 'nameFoldVersion'
    | 'description'
    | 'websiteUrl'
    | 'observedDomains'
    | 'logoFileId'
    | 'logoSourceRecordId'
    | 'status'
    | 'lastSeenAt'
    | 'lastReviewedAt'
    | 'firstSeenAt'
    | 'pinnedFields'
  >
>;

export async function insertBrand(
  db: DatabaseOrTransaction,
  values: InsertBrandInput,
): Promise<BrandRow> {
  const rows = await db.insert(brands).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertBrand returned no row.');
  return row;
}

export async function updateBrand(
  db: DatabaseOrTransaction,
  id: string,
  patch: BrandPatch,
): Promise<BrandRow | undefined> {
  const rows = await db.update(brands).set(patch).where(eq(brands.id, id)).returning();
  return rows[0];
}

export async function findBrandById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<BrandRow | undefined> {
  const rows = await db.select().from(brands).where(eq(brands.id, id)).limit(1);
  return rows[0];
}

export async function findBrandBySlug(
  db: DatabaseOrTransaction,
  slug: string,
): Promise<BrandRow | undefined> {
  const rows = await db.select().from(brands).where(eq(brands.slug, slug)).limit(1);
  return rows[0];
}

export async function findBrandsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<BrandRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(brands).where(inArray(brands.id, [...ids]));
}

/** Exact-normalization candidates — equality on the service-maintained column. */
export async function findBrandsByNormalizedName(
  db: DatabaseOrTransaction,
  normalizedName: string,
): Promise<BrandRow[]> {
  return db.select().from(brands).where(eq(brands.normalizedName, normalizedName));
}

/** A trigram candidate with pg_trgm's own similarity score. */
export interface BrandNameCandidate {
  brand: BrandRow;
  similarity: number;
}

/**
 * Typo-tolerant candidates via the trigram GIN on `normalized_name` (D21).
 *
 * `%` (the similarity operator) is what USES the index; `similarity()` in the
 * projection is what makes the score explainable to the caller. The operator
 * reads `pg_trgm.similarity_threshold`, left at its default — tightening
 * happens in the service on the returned score, where the rule is visible and
 * testable, not in a session variable nobody can see.
 */
export async function searchBrandsByNameSimilarity(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<BrandNameCandidate[]> {
  const score = sql<number>`similarity(${brands.normalizedName}, ${normalizedName})`;
  const rows = await db
    .select({ brand: brands, similarity: score })
    .from(brands)
    .where(sql`${brands.normalizedName} % ${normalizedName}`)
    .orderBy(desc(score))
    .limit(limit);
  return rows;
}

/** Brands carrying this observed domain — `@>` over the GIN index. */
export async function findBrandsByObservedDomain(
  db: DatabaseOrTransaction,
  domain: string,
): Promise<BrandRow[]> {
  return db.select().from(brands).where(arrayContains(brands.observedDomains, [domain]));
}

export interface InsertBrandAliasInput {
  brandId: string;
  alias: string;
  kind: CanonicalAliasKind;
  language?: string;
  sourceRecordId?: string;
  createdByOxyUserId?: string;
}

/**
 * Add an alias, converging on `(brand_id, normalized_alias)`.
 *
 * @returns The inserted row, or `undefined` when this brand already had the
 *   alias (by normalization) — the existing row is left physically untouched.
 */
export async function insertBrandAlias(
  db: DatabaseOrTransaction,
  input: InsertBrandAliasInput,
): Promise<BrandAliasRow | undefined> {
  const rows = await db
    .insert(brandAliases)
    .values({
      brandId: input.brandId,
      alias: input.alias,
      kind: input.kind,
      language: input.language ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
    })
    .onConflictDoNothing({ target: [brandAliases.brandId, brandAliases.normalizedAlias] })
    .returning();
  return rows[0];
}

export async function listBrandAliases(
  db: DatabaseOrTransaction,
  brandId: string,
): Promise<BrandAliasRow[]> {
  return db
    .select()
    .from(brandAliases)
    .where(eq(brandAliases.brandId, brandId))
    .orderBy(asc(brandAliases.createdAt), asc(brandAliases.id));
}

/**
 * Every alias of several brands, in ONE round trip.
 *
 * A brand alias IS the evidence #58 rule 3 asks for when it lets an evidenced
 * rebrand resolve a brand mismatch (an alias row carries its `source_record_id`),
 * so the matcher reads the whole alias set of every candidate's brand on every
 * evaluation.
 */
export async function listBrandAliasesForBrands(
  db: DatabaseOrTransaction,
  brandIds: readonly string[],
): Promise<BrandAliasRow[]> {
  if (brandIds.length === 0) return [];
  return db.select().from(brandAliases).where(inArray(brandAliases.brandId, [...brandIds]));
}

/** Distinct brand ids any alias with this normalization points at. */
export async function findBrandIdsByNormalizedAlias(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ brandId: brandAliases.brandId })
    .from(brandAliases)
    .where(eq(brandAliases.normalizedAlias, normalizedAlias));
  return rows.map((row) => row.brandId);
}

export interface InsertBrandSourceLinkInput {
  brandId: string;
  sourceRecordId: string;
  method: SourceLinkMethod;
  matchRule: string;
  confidence?: number;
  status?: SourceLinkStatus;
  decidedByOxyUserId?: string;
}

/**
 * Link an observation to a brand, converging on the ACTIVE partial unique.
 *
 * @returns The inserted row, or `undefined` when an active link for this
 *   (brand, record) already exists — which is the re-applied-observation case,
 *   and a genuine no-op.
 */
export async function insertBrandSourceLink(
  db: DatabaseOrTransaction,
  input: InsertBrandSourceLinkInput,
): Promise<BrandSourceLinkRow | undefined> {
  const rows = await db
    .insert(brandSourceLinks)
    .values({
      brandId: input.brandId,
      sourceRecordId: input.sourceRecordId,
      method: input.method,
      matchRule: input.matchRule,
      confidence: input.confidence ?? null,
      status: input.status ?? 'active',
      decidedByOxyUserId: input.decidedByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [brandSourceLinks.brandId, brandSourceLinks.sourceRecordId],
      where: sql`${brandSourceLinks.status} = 'active'`,
    })
    .returning();
  return rows[0];
}

export async function listBrandSourceLinks(
  db: DatabaseOrTransaction,
  brandId: string,
  status?: SourceLinkStatus,
): Promise<BrandSourceLinkRow[]> {
  const condition = status
    ? and(eq(brandSourceLinks.brandId, brandId), eq(brandSourceLinks.status, status))
    : eq(brandSourceLinks.brandId, brandId);
  return db
    .select()
    .from(brandSourceLinks)
    .where(condition)
    .orderBy(asc(brandSourceLinks.createdAt), asc(brandSourceLinks.id));
}

/** Distinct brand ids actively linked to any of these observation rows. */
export async function findBrandIdsBySourceRecordIds(
  db: DatabaseOrTransaction,
  sourceRecordIds: readonly string[],
): Promise<string[]> {
  if (sourceRecordIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ brandId: brandSourceLinks.brandId })
    .from(brandSourceLinks)
    .where(
      and(
        inArray(brandSourceLinks.sourceRecordId, [...sourceRecordIds]),
        eq(brandSourceLinks.status, 'active'),
      ),
    );
  return rows.map((row) => row.brandId);
}

/**
 * Repoint the loser's aliases to the winner during a merge.
 *
 * Where the winner already carries the same normalized alias, the loser's row
 * is DELETED rather than repointed — the unique would refuse the repoint, and
 * the alias fact ("this name resolves here") is already true of the winner.
 * Alias rows are pure child annotations (the CASCADE class), so this is the one
 * place a canonical-graph delete is legitimate.
 */
export async function repointBrandAliases(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerAliases = await db
    .select({ normalizedAlias: brandAliases.normalizedAlias })
    .from(brandAliases)
    .where(eq(brandAliases.brandId, winnerId));
  const taken = winnerAliases.map((row) => row.normalizedAlias);

  if (taken.length > 0) {
    await db
      .delete(brandAliases)
      .where(
        and(eq(brandAliases.brandId, loserId), inArray(brandAliases.normalizedAlias, taken)),
      );
  }
  await db.update(brandAliases).set({ brandId: winnerId }).where(eq(brandAliases.brandId, loserId));
}

/**
 * Repoint the loser's source links to the winner during a merge — retaining
 * EVERY mapping (#53 identity rule 7): a loser link whose record the winner
 * already actively links is repointed as `superseded` (the winner's own link is
 * the active one); everything else moves over unchanged.
 */
export async function repointBrandSourceLinks(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerActive = await db
    .select({ sourceRecordId: brandSourceLinks.sourceRecordId })
    .from(brandSourceLinks)
    .where(and(eq(brandSourceLinks.brandId, winnerId), eq(brandSourceLinks.status, 'active')));
  const covered = winnerActive.map((row) => row.sourceRecordId);

  if (covered.length > 0) {
    await db
      .update(brandSourceLinks)
      .set({ brandId: winnerId, status: 'superseded' })
      .where(
        and(
          eq(brandSourceLinks.brandId, loserId),
          eq(brandSourceLinks.status, 'active'),
          inArray(brandSourceLinks.sourceRecordId, covered),
        ),
      );
  }
  await db
    .update(brandSourceLinks)
    .set({ brandId: winnerId })
    .where(eq(brandSourceLinks.brandId, loserId));
}

/**
 * Stamp the loser's tombstone — the merge CAS. ONE statement, guard and
 * mutation together, so of two concurrent merges exactly one wins and the
 * other's re-read sees `merged` and no-ops.
 */
export async function markBrandMerged(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<BrandRow | undefined> {
  const rows = await db
    .update(brands)
    .set({ status: 'merged', mergedIntoId: winnerId })
    .where(and(eq(brands.id, loserId), ne(brands.status, 'merged')))
    .returning();
  return rows[0];
}

/**
 * Flatten the chain (ADR 0002 D16): every tombstone that pointed at the loser
 * now points at the final winner, so resolution stays one hop forever.
 */
export async function retargetBrandTombstones(
  db: DatabaseOrTransaction,
  fromId: string,
  toId: string,
): Promise<void> {
  await db.update(brands).set({ mergedIntoId: toId }).where(eq(brands.mergedIntoId, fromId));
}

/** One page of brands plus the total, for the paginated list seam. */
export async function listBrandsPage(
  db: DatabaseOrTransaction,
  offset: number,
  limit: number,
): Promise<{ rows: BrandRow[]; total: number }> {
  const rows = await db
    .select()
    .from(brands)
    .orderBy(asc(brands.name), asc(brands.id))
    .offset(offset)
    .limit(limit);
  const counted = await db.select({ count: sql<number>`count(*)::int` }).from(brands);
  return { rows, total: counted[0]?.count ?? 0 };
}

/**
 * Store a brand's derived product count.
 *
 * The counterpart of `refreshFamilyProductCount`, added by #749 so the counter
 * has a repair path at all. Until then `brands.product_count` was written ONLY
 * by the merge rollup, which meant a brand nobody merged carried whatever the
 * last merge that happened to touch it had stored — and correcting the
 * derivation would never have reached those rows.
 *
 * The VALUE comes from `countProductsForBrand`, the one definition of what this
 * column counts; this function only writes what it is handed.
 */
export async function refreshBrandProductCount(
  db: DatabaseOrTransaction,
  brandId: string,
  productCount: number,
): Promise<void> {
  await db.update(brands).set({ productCount }).where(eq(brands.id, brandId));
}
