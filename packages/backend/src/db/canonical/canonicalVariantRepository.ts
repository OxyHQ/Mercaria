/**
 * Reads and writes for `canonical_variants`, its option assignments, aliases,
 * source links and bundle components (#56).
 *
 * The variant is the grain everything commercial attaches to (ADR 0002 D13), so
 * two shapes here carry more weight than the rest:
 *
 * - {@link replaceVariantAttributes} rewrites a variant's option set INSIDE the
 *   caller's transaction, beside the signature recomputation. Splitting them
 *   would let a variant exist for one statement whose stored signature does not
 *   describe its assignments — and that signature is in a unique index.
 * - {@link markCanonicalVariantMerged} is a one-statement CAS, so a concurrent
 *   duplicate merge loses and walks away having written nothing.
 */

import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  AttributeNormalizationState,
  CanonicalAliasKind,
  SourceLinkMethod,
  SourceLinkStatus,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  bundleComponents,
  canonicalVariantAliases,
  canonicalVariantAttributes,
  canonicalVariantSourceLinks,
  canonicalVariants,
} from '../schema/canonicalCatalog.js';

export type CanonicalVariantRow = typeof canonicalVariants.$inferSelect;
export type CanonicalVariantAttributeRow = typeof canonicalVariantAttributes.$inferSelect;
export type CanonicalVariantAliasRow = typeof canonicalVariantAliases.$inferSelect;
export type CanonicalVariantSourceLinkRow = typeof canonicalVariantSourceLinks.$inferSelect;
export type BundleComponentRow = typeof bundleComponents.$inferSelect;
export type InsertCanonicalVariantInput = typeof canonicalVariants.$inferInsert;

export type CanonicalVariantPatch = Partial<
  Pick<
    CanonicalVariantRow,
    | 'name'
    | 'signature'
    | 'isDefault'
    | 'releasedAt'
    | 'discontinuedAt'
    | 'status'
    | 'firstSeenAt'
    | 'lastSeenAt'
    | 'lastReviewedAt'
    | 'pinnedFields'
  >
>;

export async function insertCanonicalVariant(
  db: DatabaseOrTransaction,
  values: InsertCanonicalVariantInput,
): Promise<CanonicalVariantRow> {
  const rows = await db.insert(canonicalVariants).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertCanonicalVariant returned no row.');
  return row;
}

export async function updateCanonicalVariant(
  db: DatabaseOrTransaction,
  id: string,
  patch: CanonicalVariantPatch,
): Promise<CanonicalVariantRow | undefined> {
  const rows = await db
    .update(canonicalVariants)
    .set(patch)
    .where(eq(canonicalVariants.id, id))
    .returning();
  return rows[0];
}

export async function findCanonicalVariantById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CanonicalVariantRow | undefined> {
  const rows = await db.select().from(canonicalVariants).where(eq(canonicalVariants.id, id)).limit(1);
  return rows[0];
}

export async function findCanonicalVariantsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<CanonicalVariantRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(canonicalVariants).where(inArray(canonicalVariants.id, [...ids]));
}

/** The variant of one product carrying this exact option set. */
export async function findVariantBySignature(
  db: DatabaseOrTransaction,
  productId: string,
  signature: string,
): Promise<CanonicalVariantRow | undefined> {
  const rows = await db
    .select()
    .from(canonicalVariants)
    .where(and(eq(canonicalVariants.productId, productId), eq(canonicalVariants.signature, signature)))
    .limit(1);
  return rows[0];
}

/** Every variant of one product — the reverse lookup a product page reads. */
export async function listVariantsForProduct(
  db: DatabaseOrTransaction,
  productId: string,
): Promise<CanonicalVariantRow[]> {
  return db
    .select()
    .from(canonicalVariants)
    .where(eq(canonicalVariants.productId, productId))
    .orderBy(asc(canonicalVariants.createdAt), asc(canonicalVariants.id));
}

/**
 * Every variant of several products, in ONE round trip.
 *
 * The matcher (#58) scores a subject against every variant of every candidate
 * product, so the per-product read above would be N queries per evaluation
 * against a bounded candidate set — the shape that turns a bounded retrieval
 * back into an unbounded one.
 */
export async function listVariantsForProducts(
  db: DatabaseOrTransaction,
  productIds: readonly string[],
): Promise<CanonicalVariantRow[]> {
  if (productIds.length === 0) return [];
  return db
    .select()
    .from(canonicalVariants)
    .where(inArray(canonicalVariants.productId, [...productIds]))
    .orderBy(asc(canonicalVariants.createdAt), asc(canonicalVariants.id));
}

/**
 * Which of these variants ARE bundles — i.e. own at least one component row.
 *
 * A bundle is a bundle because it has components (ADR 0002 D15), not because its
 * name says so, and the matcher refuses to merge a bundle into one of its own
 * components. Answering that from the component table rather than from prose is
 * what makes rule 7 structural on the canonical side.
 */
export async function findBundleVariantIds(
  db: DatabaseOrTransaction,
  variantIds: readonly string[],
): Promise<string[]> {
  if (variantIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ bundleVariantId: bundleComponents.bundleVariantId })
    .from(bundleComponents)
    .where(inArray(bundleComponents.bundleVariantId, [...variantIds]));
  return rows.map((row) => row.bundleVariantId);
}

export async function countVariantsForProduct(
  db: DatabaseOrTransaction,
  productId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(canonicalVariants)
    .where(and(eq(canonicalVariants.productId, productId), ne(canonicalVariants.status, 'merged')));
  return rows[0]?.count ?? 0;
}

/** One option assignment as the write services supply it. */
export interface VariantAttributeInput {
  attributeKey: string;
  displayValue: string;
  normalizedValue: string;
  attributeDefinitionId?: string;
  /** The registry version the key was read under. Travels with the definition id. */
  definitionVersion?: number;
  normalizedNumber?: number;
  normalizedUnit?: string;
  normalizationState?: AttributeNormalizationState;
  position?: number;
}

/**
 * Replace a variant's option assignments wholesale.
 *
 * Delete-then-insert rather than a diff: the option set IS the variant's
 * identity, so "which rows changed" is not a question with a useful answer —
 * a changed set is a different variant, and the caller recomputes the signature
 * from the same input in the same transaction.
 */
export async function replaceVariantAttributes(
  db: DatabaseOrTransaction,
  variantId: string,
  attributes: readonly VariantAttributeInput[],
): Promise<CanonicalVariantAttributeRow[]> {
  await db
    .delete(canonicalVariantAttributes)
    .where(eq(canonicalVariantAttributes.variantId, variantId));
  if (attributes.length === 0) return [];

  return db
    .insert(canonicalVariantAttributes)
    .values(
      attributes.map((attribute, index) => ({
        variantId,
        attributeDefinitionId: attribute.attributeDefinitionId ?? null,
        definitionVersion: attribute.definitionVersion ?? null,
        attributeKey: attribute.attributeKey,
        displayValue: attribute.displayValue,
        normalizedValue: attribute.normalizedValue,
        normalizedNumber: attribute.normalizedNumber ?? null,
        normalizedUnit: attribute.normalizedUnit ?? null,
        normalizationState: attribute.normalizationState ?? 'normalized',
        position: attribute.position ?? index,
      })),
    )
    .returning();
}

export async function listVariantAttributes(
  db: DatabaseOrTransaction,
  variantId: string,
): Promise<CanonicalVariantAttributeRow[]> {
  return db
    .select()
    .from(canonicalVariantAttributes)
    .where(eq(canonicalVariantAttributes.variantId, variantId))
    .orderBy(asc(canonicalVariantAttributes.position), asc(canonicalVariantAttributes.attributeKey));
}

export async function listVariantAttributesForVariants(
  db: DatabaseOrTransaction,
  variantIds: readonly string[],
): Promise<CanonicalVariantAttributeRow[]> {
  if (variantIds.length === 0) return [];
  return db
    .select()
    .from(canonicalVariantAttributes)
    .where(inArray(canonicalVariantAttributes.variantId, [...variantIds]))
    .orderBy(asc(canonicalVariantAttributes.position), asc(canonicalVariantAttributes.attributeKey));
}

/** Variants whose named axis carries this normalized value — reverse lookup. */
export async function findVariantIdsByAttributeValue(
  db: DatabaseOrTransaction,
  attributeKey: string,
  normalizedValue: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ variantId: canonicalVariantAttributes.variantId })
    .from(canonicalVariantAttributes)
    .where(
      and(
        eq(canonicalVariantAttributes.attributeKey, attributeKey),
        eq(canonicalVariantAttributes.normalizedValue, normalizedValue),
      ),
    );
  return rows.map((row) => row.variantId);
}

export interface InsertCanonicalVariantAliasInput {
  variantId: string;
  alias: string;
  kind: CanonicalAliasKind;
  language?: string;
  sourceRecordId?: string;
  createdByOxyUserId?: string;
}

export async function insertCanonicalVariantAlias(
  db: DatabaseOrTransaction,
  input: InsertCanonicalVariantAliasInput,
): Promise<CanonicalVariantAliasRow | undefined> {
  const rows = await db
    .insert(canonicalVariantAliases)
    .values({
      variantId: input.variantId,
      alias: input.alias,
      kind: input.kind,
      language: input.language ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [canonicalVariantAliases.variantId, canonicalVariantAliases.normalizedAlias],
    })
    .returning();
  return rows[0];
}

export async function listCanonicalVariantAliases(
  db: DatabaseOrTransaction,
  variantId: string,
): Promise<CanonicalVariantAliasRow[]> {
  return db
    .select()
    .from(canonicalVariantAliases)
    .where(eq(canonicalVariantAliases.variantId, variantId))
    .orderBy(asc(canonicalVariantAliases.createdAt), asc(canonicalVariantAliases.id));
}

export async function findCanonicalVariantIdsByNormalizedAlias(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ variantId: canonicalVariantAliases.variantId })
    .from(canonicalVariantAliases)
    .where(eq(canonicalVariantAliases.normalizedAlias, normalizedAlias));
  return rows.map((row) => row.variantId);
}

export interface InsertCanonicalVariantSourceLinkInput {
  variantId: string;
  sourceRecordId: string;
  method: SourceLinkMethod;
  matchRule: string;
  confidence?: number;
  status?: SourceLinkStatus;
  decidedByOxyUserId?: string;
}

export async function insertCanonicalVariantSourceLink(
  db: DatabaseOrTransaction,
  input: InsertCanonicalVariantSourceLinkInput,
): Promise<CanonicalVariantSourceLinkRow | undefined> {
  const rows = await db
    .insert(canonicalVariantSourceLinks)
    .values({
      variantId: input.variantId,
      sourceRecordId: input.sourceRecordId,
      method: input.method,
      matchRule: input.matchRule,
      confidence: input.confidence ?? null,
      status: input.status ?? 'active',
      decidedByOxyUserId: input.decidedByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [canonicalVariantSourceLinks.variantId, canonicalVariantSourceLinks.sourceRecordId],
      where: sql`${canonicalVariantSourceLinks.status} = 'active'`,
    })
    .returning();
  return rows[0];
}

export async function listCanonicalVariantSourceLinks(
  db: DatabaseOrTransaction,
  variantId: string,
  status?: SourceLinkStatus,
): Promise<CanonicalVariantSourceLinkRow[]> {
  const condition =
    status === undefined
      ? eq(canonicalVariantSourceLinks.variantId, variantId)
      : and(
          eq(canonicalVariantSourceLinks.variantId, variantId),
          eq(canonicalVariantSourceLinks.status, status),
        );
  return db
    .select()
    .from(canonicalVariantSourceLinks)
    .where(condition)
    .orderBy(asc(canonicalVariantSourceLinks.createdAt), asc(canonicalVariantSourceLinks.id));
}

export async function findCanonicalVariantIdsBySourceRecordIds(
  db: DatabaseOrTransaction,
  sourceRecordIds: readonly string[],
): Promise<string[]> {
  if (sourceRecordIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ variantId: canonicalVariantSourceLinks.variantId })
    .from(canonicalVariantSourceLinks)
    .where(
      and(
        inArray(canonicalVariantSourceLinks.sourceRecordId, [...sourceRecordIds]),
        eq(canonicalVariantSourceLinks.status, 'active'),
      ),
    );
  return rows.map((row) => row.variantId);
}

export async function repointCanonicalVariantAliases(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerAliases = await db
    .select({ normalizedAlias: canonicalVariantAliases.normalizedAlias })
    .from(canonicalVariantAliases)
    .where(eq(canonicalVariantAliases.variantId, winnerId));
  const taken = winnerAliases.map((row) => row.normalizedAlias);

  if (taken.length > 0) {
    await db
      .delete(canonicalVariantAliases)
      .where(
        and(
          eq(canonicalVariantAliases.variantId, loserId),
          inArray(canonicalVariantAliases.normalizedAlias, taken),
        ),
      );
  }
  await db
    .update(canonicalVariantAliases)
    .set({ variantId: winnerId })
    .where(eq(canonicalVariantAliases.variantId, loserId));
}

export async function repointCanonicalVariantSourceLinks(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerActive = await db
    .select({ sourceRecordId: canonicalVariantSourceLinks.sourceRecordId })
    .from(canonicalVariantSourceLinks)
    .where(
      and(
        eq(canonicalVariantSourceLinks.variantId, winnerId),
        eq(canonicalVariantSourceLinks.status, 'active'),
      ),
    );
  const covered = winnerActive.map((row) => row.sourceRecordId);

  if (covered.length > 0) {
    await db
      .update(canonicalVariantSourceLinks)
      .set({ variantId: winnerId, status: 'superseded' })
      .where(
        and(
          eq(canonicalVariantSourceLinks.variantId, loserId),
          eq(canonicalVariantSourceLinks.status, 'active'),
          inArray(canonicalVariantSourceLinks.sourceRecordId, covered),
        ),
      );
  }
  await db
    .update(canonicalVariantSourceLinks)
    .set({ variantId: winnerId })
    .where(eq(canonicalVariantSourceLinks.variantId, loserId));
}

/** The merge CAS. A re-issued merge sees `merged` and affects nothing. */
export async function markCanonicalVariantMerged(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<CanonicalVariantRow | undefined> {
  const rows = await db
    .update(canonicalVariants)
    .set({ status: 'merged', mergedIntoId: winnerId, isDefault: false })
    .where(and(eq(canonicalVariants.id, loserId), ne(canonicalVariants.status, 'merged')))
    .returning();
  return rows[0];
}

export async function retargetVariantTombstones(
  db: DatabaseOrTransaction,
  fromId: string,
  toId: string,
): Promise<void> {
  await db
    .update(canonicalVariants)
    .set({ mergedIntoId: toId })
    .where(eq(canonicalVariants.mergedIntoId, fromId));
}

/** Replace a bundle's component list; the bundle variant owns the set. */
export async function replaceBundleComponents(
  db: DatabaseOrTransaction,
  bundleVariantId: string,
  components: readonly { componentVariantId: string; quantity: number; position?: number }[],
): Promise<BundleComponentRow[]> {
  await db.delete(bundleComponents).where(eq(bundleComponents.bundleVariantId, bundleVariantId));
  if (components.length === 0) return [];
  return db
    .insert(bundleComponents)
    .values(
      components.map((component, index) => ({
        bundleVariantId,
        componentVariantId: component.componentVariantId,
        quantity: component.quantity,
        position: component.position ?? index,
      })),
    )
    .returning();
}

export async function listBundleComponents(
  db: DatabaseOrTransaction,
  bundleVariantId: string,
): Promise<BundleComponentRow[]> {
  return db
    .select()
    .from(bundleComponents)
    .where(eq(bundleComponents.bundleVariantId, bundleVariantId))
    .orderBy(asc(bundleComponents.position), asc(bundleComponents.id));
}
