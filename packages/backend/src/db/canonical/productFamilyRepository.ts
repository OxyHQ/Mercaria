/**
 * Reads and writes for `canonical_product_families` and its alias, source-link
 * and redirect children (#56).
 *
 * `db` first everywhere, the payment-domain convention #53's repositories
 * already follow: every mutating helper here has a caller that must be atomic
 * with other writes — an observation and its link, a merge and its repoints —
 * and a `Database`-only signature would silently push that caller outside its
 * transaction.
 *
 * Nothing here decides identity. Normalization, confidence rules and the merge
 * protocol live in `services/canonical/`; this module states the SQL shapes,
 * including the convergence writes (`ON CONFLICT DO NOTHING`, so a repeat is a
 * genuine no-op) and the one CAS, {@link markFamilyMerged}.
 */

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  CanonicalAliasKind,
  CanonicalRedirectReason,
  SourceLinkMethod,
  SourceLinkStatus,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  canonicalProductFamilies,
  canonicalProductFamilyAliases,
  canonicalProductFamilyRedirects,
  canonicalProductFamilySourceLinks,
} from '../schema/canonicalCatalog.js';

export type ProductFamilyRow = typeof canonicalProductFamilies.$inferSelect;
export type ProductFamilyAliasRow = typeof canonicalProductFamilyAliases.$inferSelect;
export type ProductFamilySourceLinkRow = typeof canonicalProductFamilySourceLinks.$inferSelect;
export type ProductFamilyRedirectRow = typeof canonicalProductFamilyRedirects.$inferSelect;
export type InsertProductFamilyInput = typeof canonicalProductFamilies.$inferInsert;

/** The columns an update may touch. Identity columns are absent on purpose. */
export type ProductFamilyPatch = Partial<
  Pick<
    ProductFamilyRow,
    | 'name'
    | 'normalizedName'
    | 'description'
    | 'brandId'
    | 'categoryId'
    | 'productCount'
    | 'status'
    | 'firstSeenAt'
    | 'lastSeenAt'
    | 'lastReviewedAt'
    | 'pinnedFields'
  >
>;

export async function insertProductFamily(
  db: DatabaseOrTransaction,
  values: InsertProductFamilyInput,
): Promise<ProductFamilyRow> {
  const rows = await db.insert(canonicalProductFamilies).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertProductFamily returned no row.');
  return row;
}

export async function updateProductFamily(
  db: DatabaseOrTransaction,
  id: string,
  patch: ProductFamilyPatch,
): Promise<ProductFamilyRow | undefined> {
  const rows = await db
    .update(canonicalProductFamilies)
    .set(patch)
    .where(eq(canonicalProductFamilies.id, id))
    .returning();
  return rows[0];
}

export async function findProductFamilyById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ProductFamilyRow | undefined> {
  const rows = await db
    .select()
    .from(canonicalProductFamilies)
    .where(eq(canonicalProductFamilies.id, id))
    .limit(1);
  return rows[0];
}

export async function findProductFamilyBySlug(
  db: DatabaseOrTransaction,
  slug: string,
): Promise<ProductFamilyRow | undefined> {
  const rows = await db
    .select()
    .from(canonicalProductFamilies)
    .where(eq(canonicalProductFamilies.slug, slug))
    .limit(1);
  return rows[0];
}

export async function findProductFamiliesByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<ProductFamilyRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(canonicalProductFamilies)
    .where(inArray(canonicalProductFamilies.id, [...ids]));
}

/** Exact-normalization candidates — equality on the service-maintained column. */
export async function findProductFamiliesByNormalizedName(
  db: DatabaseOrTransaction,
  normalizedName: string,
  brandId?: string,
): Promise<ProductFamilyRow[]> {
  const condition =
    brandId === undefined
      ? eq(canonicalProductFamilies.normalizedName, normalizedName)
      : and(
          eq(canonicalProductFamilies.normalizedName, normalizedName),
          eq(canonicalProductFamilies.brandId, brandId),
        );
  return db.select().from(canonicalProductFamilies).where(condition);
}

export interface InsertProductFamilyAliasInput {
  familyId: string;
  alias: string;
  kind: CanonicalAliasKind;
  language?: string;
  sourceRecordId?: string;
  createdByOxyUserId?: string;
}

/**
 * Add an alias, converging on `(family_id, normalized_alias)`.
 *
 * @returns The inserted row, or `undefined` when this family already carried
 *   the alias by normalization — the existing row is left physically untouched.
 */
export async function insertProductFamilyAlias(
  db: DatabaseOrTransaction,
  input: InsertProductFamilyAliasInput,
): Promise<ProductFamilyAliasRow | undefined> {
  const rows = await db
    .insert(canonicalProductFamilyAliases)
    .values({
      familyId: input.familyId,
      alias: input.alias,
      kind: input.kind,
      language: input.language ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [canonicalProductFamilyAliases.familyId, canonicalProductFamilyAliases.normalizedAlias],
    })
    .returning();
  return rows[0];
}

export async function listProductFamilyAliases(
  db: DatabaseOrTransaction,
  familyId: string,
): Promise<ProductFamilyAliasRow[]> {
  return db
    .select()
    .from(canonicalProductFamilyAliases)
    .where(eq(canonicalProductFamilyAliases.familyId, familyId))
    .orderBy(asc(canonicalProductFamilyAliases.createdAt), asc(canonicalProductFamilyAliases.id));
}

/** Distinct family ids any alias with this normalization points at. */
export async function findProductFamilyIdsByNormalizedAlias(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ familyId: canonicalProductFamilyAliases.familyId })
    .from(canonicalProductFamilyAliases)
    .where(eq(canonicalProductFamilyAliases.normalizedAlias, normalizedAlias));
  return rows.map((row) => row.familyId);
}

export interface InsertProductFamilySourceLinkInput {
  familyId: string;
  sourceRecordId: string;
  method: SourceLinkMethod;
  matchRule: string;
  confidence?: number;
  status?: SourceLinkStatus;
  decidedByOxyUserId?: string;
}

/**
 * Link an observation to a family, converging on the ACTIVE partial unique.
 *
 * @returns The inserted row, or `undefined` when an active link for this
 *   (family, record) already exists — the re-applied observation, a no-op.
 */
export async function insertProductFamilySourceLink(
  db: DatabaseOrTransaction,
  input: InsertProductFamilySourceLinkInput,
): Promise<ProductFamilySourceLinkRow | undefined> {
  const rows = await db
    .insert(canonicalProductFamilySourceLinks)
    .values({
      familyId: input.familyId,
      sourceRecordId: input.sourceRecordId,
      method: input.method,
      matchRule: input.matchRule,
      confidence: input.confidence ?? null,
      status: input.status ?? 'active',
      decidedByOxyUserId: input.decidedByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [
        canonicalProductFamilySourceLinks.familyId,
        canonicalProductFamilySourceLinks.sourceRecordId,
      ],
      where: sql`${canonicalProductFamilySourceLinks.status} = 'active'`,
    })
    .returning();
  return rows[0];
}

export async function listProductFamilySourceLinks(
  db: DatabaseOrTransaction,
  familyId: string,
  status?: SourceLinkStatus,
): Promise<ProductFamilySourceLinkRow[]> {
  const condition =
    status === undefined
      ? eq(canonicalProductFamilySourceLinks.familyId, familyId)
      : and(
          eq(canonicalProductFamilySourceLinks.familyId, familyId),
          eq(canonicalProductFamilySourceLinks.status, status),
        );
  return db
    .select()
    .from(canonicalProductFamilySourceLinks)
    .where(condition)
    .orderBy(
      asc(canonicalProductFamilySourceLinks.createdAt),
      asc(canonicalProductFamilySourceLinks.id),
    );
}

/**
 * Record one redirect hop. Converges on `(from_id, to_id)`, so a re-run writes
 * nothing and the audit trail cannot grow a row per retry.
 */
export async function insertProductFamilyRedirect(
  db: DatabaseOrTransaction,
  input: {
    fromId: string;
    toId: string;
    reason: CanonicalRedirectReason;
    actorOxyUserId?: string;
    note?: string;
  },
): Promise<ProductFamilyRedirectRow | undefined> {
  const rows = await db
    .insert(canonicalProductFamilyRedirects)
    .values({
      fromId: input.fromId,
      toId: input.toId,
      reason: input.reason,
      actorOxyUserId: input.actorOxyUserId ?? null,
      note: input.note ?? null,
    })
    .onConflictDoNothing({
      target: [canonicalProductFamilyRedirects.fromId, canonicalProductFamilyRedirects.toId],
    })
    .returning();
  return rows[0];
}

/** Every redirect hop recorded FROM this family, oldest first. */
export async function listProductFamilyRedirects(
  db: DatabaseOrTransaction,
  fromId: string,
): Promise<ProductFamilyRedirectRow[]> {
  return db
    .select()
    .from(canonicalProductFamilyRedirects)
    .where(eq(canonicalProductFamilyRedirects.fromId, fromId))
    .orderBy(asc(canonicalProductFamilyRedirects.createdAt), asc(canonicalProductFamilyRedirects.id));
}

/** Repoint the loser's aliases; see `brandRepository.repointBrandAliases`. */
export async function repointProductFamilyAliases(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerAliases = await db
    .select({ normalizedAlias: canonicalProductFamilyAliases.normalizedAlias })
    .from(canonicalProductFamilyAliases)
    .where(eq(canonicalProductFamilyAliases.familyId, winnerId));
  const taken = winnerAliases.map((row) => row.normalizedAlias);

  if (taken.length > 0) {
    await db
      .delete(canonicalProductFamilyAliases)
      .where(
        and(
          eq(canonicalProductFamilyAliases.familyId, loserId),
          inArray(canonicalProductFamilyAliases.normalizedAlias, taken),
        ),
      );
  }
  await db
    .update(canonicalProductFamilyAliases)
    .set({ familyId: winnerId })
    .where(eq(canonicalProductFamilyAliases.familyId, loserId));
}

/** Repoint the loser's source links, RETAINING every mapping (#56 merge rule). */
export async function repointProductFamilySourceLinks(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerActive = await db
    .select({ sourceRecordId: canonicalProductFamilySourceLinks.sourceRecordId })
    .from(canonicalProductFamilySourceLinks)
    .where(
      and(
        eq(canonicalProductFamilySourceLinks.familyId, winnerId),
        eq(canonicalProductFamilySourceLinks.status, 'active'),
      ),
    );
  const covered = winnerActive.map((row) => row.sourceRecordId);

  if (covered.length > 0) {
    await db
      .update(canonicalProductFamilySourceLinks)
      .set({ familyId: winnerId, status: 'superseded' })
      .where(
        and(
          eq(canonicalProductFamilySourceLinks.familyId, loserId),
          eq(canonicalProductFamilySourceLinks.status, 'active'),
          inArray(canonicalProductFamilySourceLinks.sourceRecordId, covered),
        ),
      );
  }
  await db
    .update(canonicalProductFamilySourceLinks)
    .set({ familyId: winnerId })
    .where(eq(canonicalProductFamilySourceLinks.familyId, loserId));
}

/**
 * Stamp the loser's tombstone — the merge CAS. ONE statement, guard and mutation
 * together, so of two concurrent merges exactly one wins and the other's re-read
 * sees `merged` and no-ops.
 */
export async function markFamilyMerged(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<ProductFamilyRow | undefined> {
  const rows = await db
    .update(canonicalProductFamilies)
    .set({ status: 'merged', mergedIntoId: winnerId })
    .where(
      and(eq(canonicalProductFamilies.id, loserId), ne(canonicalProductFamilies.status, 'merged')),
    )
    .returning();
  return rows[0];
}

/** Every tombstone currently pointing at `fromId` — the flatten set. */
export async function findFamilyTombstonesPointingAt(
  db: DatabaseOrTransaction,
  fromId: string,
): Promise<ProductFamilyRow[]> {
  return db
    .select()
    .from(canonicalProductFamilies)
    .where(eq(canonicalProductFamilies.mergedIntoId, fromId));
}

/** Flatten the chain (ADR 0002 D16), so resolution stays one hop forever. */
export async function retargetFamilyTombstones(
  db: DatabaseOrTransaction,
  fromId: string,
  toId: string,
): Promise<void> {
  await db
    .update(canonicalProductFamilies)
    .set({ mergedIntoId: toId })
    .where(eq(canonicalProductFamilies.mergedIntoId, fromId));
}

/** One page of families plus the total, for the paginated read seam. */
export async function listProductFamiliesPage(
  db: DatabaseOrTransaction,
  offset: number,
  limit: number,
): Promise<{ rows: ProductFamilyRow[]; total: number }> {
  const rows = await db
    .select()
    .from(canonicalProductFamilies)
    .orderBy(asc(canonicalProductFamilies.name), asc(canonicalProductFamilies.id))
    .offset(offset)
    .limit(limit);
  const counted = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(canonicalProductFamilies);
  return { rows, total: counted[0]?.count ?? 0 };
}

/** Recount a family's live products — the rollup, recomputed rather than nudged. */
export async function refreshFamilyProductCount(
  db: DatabaseOrTransaction,
  familyId: string,
  productCount: number,
): Promise<void> {
  await db
    .update(canonicalProductFamilies)
    .set({ productCount })
    .where(eq(canonicalProductFamilies.id, familyId));
}

/** Trigram candidates with pg_trgm's own score, ordered strongest first. */
export async function searchProductFamiliesByNameSimilarity(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<{ family: ProductFamilyRow; similarity: number }[]> {
  const score = sql<number>`similarity(${canonicalProductFamilies.normalizedName}, ${normalizedName})`;
  return db
    .select({ family: canonicalProductFamilies, similarity: score })
    .from(canonicalProductFamilies)
    .where(sql`${canonicalProductFamilies.normalizedName} % ${normalizedName}`)
    .orderBy(desc(score))
    .limit(limit);
}
