/**
 * `native_listing_variant_axes`, `native_variant_axis_assignments` and
 * `native_variant_signatures` (#367 step 4, ADR 0007 D6).
 *
 * ## Every write here is idempotent, and that is what makes the backfill safe
 *
 * `declareVariantAxis` and `writeVariantAxisAssignment` are `ON CONFLICT DO
 * NOTHING` plus a read, never `DO UPDATE`. The distinction is not stylistic:
 * `DO UPDATE` with identical values still moves `updated_at` and the row's
 * `xmin`, so a re-run of the migration would look like a write in every audit
 * and in every replication stream (measured on `moderation_outboxes`, and pinned
 * there by a test). A repeat has to be a genuine no-op because a repeat is
 * ordinary — a resumed backfill, a retried transaction, two connector deliveries
 * a millisecond apart.
 *
 * `upsertVariantSignature` is the one exception and it is `DO UPDATE`, because a
 * signature is DERIVED: when a variant's assignments change its digest must
 * change with them, in the same transaction, or
 * `mercaria_native_variant_signature_agrees` refuses the COMMIT. The
 * `where`-guarded conflict branch keeps an unchanged recomputation a no-op all
 * the same.
 *
 * The database is the authority on everything these functions look polite about:
 * the citation trigger, the scope triggers and the deferred count constraint all
 * hold against callers that never reach this file.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  nativeListingVariantAxes,
  nativeVariantAxisAssignments,
  nativeVariantSignatures,
} from '../schema/variantAxes.js';
import { attributeDefinitions } from '../schema/attributeRegistry.js';
import type { DatabaseOrTransaction } from '../postgres.js';

export type NativeVariantAxisRow = typeof nativeListingVariantAxes.$inferSelect;
export type NativeVariantAxisAssignmentRow = typeof nativeVariantAxisAssignments.$inferSelect;
export type NativeVariantSignatureRow = typeof nativeVariantSignatures.$inferSelect;

/** One declared axis, as the authoring path and the backfill both supply it. */
export interface NewNativeVariantAxis {
  listingId: string;
  attributeDefinitionId: string;
  attributeKey: string;
  attributeDefinitionVersion: number;
  productTypeDefinitionId?: string | null;
  legacyOptionName?: string | null;
  position?: number;
}

/**
 * Declare one axis, converging on the row already there.
 *
 * The conflict target is `(listing_id, attribute_key)` — the same key the unique
 * index carries — so a second declaration of `color` on one listing returns the
 * first rather than raising. It deliberately does NOT reconcile a declaration
 * that arrives citing a different VERSION of the same key: the axis is frozen by
 * trigger, so re-typing an axis is `retireVariantAxis` plus a fresh declaration,
 * which cascades the assignments normalized under the old meaning away.
 */
export async function declareVariantAxis(
  db: DatabaseOrTransaction,
  input: NewNativeVariantAxis,
): Promise<{ row: NativeVariantAxisRow; created: boolean }> {
  const [inserted] = await db
    .insert(nativeListingVariantAxes)
    .values({
      listingId: input.listingId,
      attributeDefinitionId: input.attributeDefinitionId,
      attributeKey: input.attributeKey,
      attributeDefinitionVersion: input.attributeDefinitionVersion,
      productTypeDefinitionId: input.productTypeDefinitionId ?? null,
      legacyOptionName: input.legacyOptionName ?? null,
      position: input.position ?? 0,
    })
    .onConflictDoNothing({
      target: [nativeListingVariantAxes.listingId, nativeListingVariantAxes.attributeKey],
    })
    .returning();
  if (inserted !== undefined) return { row: inserted, created: true };

  // The empty `RETURNING` set IS the "already declared" answer, and it is the
  // ONLY reliable one: `created_at === updated_at` is true of a row this
  // transaction inserted AND of one a previous pass inserted and never touched,
  // so a caller counting "declared" off the timestamps would report every
  // re-run as fresh work. The read that follows turns the answer into the row.
  const [existing] = await db
    .select()
    .from(nativeListingVariantAxes)
    .where(
      and(
        eq(nativeListingVariantAxes.listingId, input.listingId),
        eq(nativeListingVariantAxes.attributeKey, input.attributeKey),
      ),
    )
    .limit(1);
  if (existing === undefined) {
    throw new Error(
      `declareVariantAxis: the insert of "${input.attributeKey}" on listing ` +
        `${input.listingId} conflicted and the row is not readable. This means the conflict ` +
        'was on a DIFFERENT constraint than the one named.',
    );
  }
  return { row: existing, created: false };
}

/** Every axis one listing declares, in display order. */
export async function listVariantAxesForListing(
  db: DatabaseOrTransaction,
  listingId: string,
): Promise<NativeVariantAxisRow[]> {
  return db
    .select()
    .from(nativeListingVariantAxes)
    .where(eq(nativeListingVariantAxes.listingId, listingId))
    .orderBy(asc(nativeListingVariantAxes.position), asc(nativeListingVariantAxes.attributeKey));
}

/**
 * One listing's declared axis, carrying the DISPLAY name a shopper reads.
 *
 * The label comes from `attribute_definitions.label` rather than from the axis
 * row, and that is the whole point of typing an axis: #94 freezes a
 * definition's MEANING once published and deliberately does NOT freeze its
 * label, because stored keys are what has to stay stable. So the display name
 * is resolved at read time and a copy-edit reaches every listing at once.
 *
 * `legacyOptionName` is PROVENANCE — the verbatim `listing_options.name` a
 * backfilled axis was resolved FROM — and is deliberately not the display name.
 * Rendering it would reproduce the exact defect ADR 0007 D6 exists to remove:
 * `Color`, `Colour`, `color ` and `Tono` as four separate axes for one shoe. It
 * is returned so a caller can SHOW what a claim said, never so a caller can
 * fall back to it.
 */
export interface NativeVariantAxisWithLabel {
  readonly id: string;
  readonly listingId: string;
  readonly attributeKey: string;
  readonly attributeDefinitionId: string;
  readonly attributeDefinitionVersion: number;
  /** `attribute_definitions.label` — the default-locale display name. */
  readonly label: string;
  /** The verbatim legacy option name this axis was resolved from, if any. */
  readonly legacyOptionName: string | null;
  readonly position: number;
}

/**
 * Every axis declared by a SET of listings, in display order.
 *
 * The batched sibling of {@link listVariantAxesForListing}, for
 * `catalog-hydration.service.ts`, which loads a whole page's children in
 * batches and must not acquire an N+1 to gain a typed read. Ordered by
 * `(listing_id, position, attribute_key)` so a caller can bucket in one pass
 * and the axis order is stable across pages — `native_listing_variant_axes_listing_position_idx`
 * serves the first two, and the key breaks the tie `position` allows (it
 * defaults to 0, so a backfilled listing can declare several axes all at zero).
 */
export async function listVariantAxesForListings(
  db: DatabaseOrTransaction,
  listingIds: readonly string[],
): Promise<NativeVariantAxisWithLabel[]> {
  if (listingIds.length === 0) return [];
  return db
    .select({
      id: nativeListingVariantAxes.id,
      listingId: nativeListingVariantAxes.listingId,
      attributeKey: nativeListingVariantAxes.attributeKey,
      attributeDefinitionId: nativeListingVariantAxes.attributeDefinitionId,
      attributeDefinitionVersion: nativeListingVariantAxes.attributeDefinitionVersion,
      label: attributeDefinitions.label,
      legacyOptionName: nativeListingVariantAxes.legacyOptionName,
      position: nativeListingVariantAxes.position,
    })
    .from(nativeListingVariantAxes)
    // INNER join: `attribute_definition_id` is NOT NULL with an `ON DELETE
    // restrict` edge, so a definition a live axis cites cannot be deleted and a
    // missing row is unrepresentable. A left join would add a `null` branch
    // whose only reachable meaning is "the database broke its own constraint",
    // and the honest handling of that is a loud absence rather than a listing
    // rendered with a blank option name.
    .innerJoin(
      attributeDefinitions,
      eq(attributeDefinitions.id, nativeListingVariantAxes.attributeDefinitionId),
    )
    .where(inArray(nativeListingVariantAxes.listingId, [...listingIds]))
    .orderBy(
      asc(nativeListingVariantAxes.listingId),
      asc(nativeListingVariantAxes.position),
      asc(nativeListingVariantAxes.attributeKey),
    );
}

/**
 * Retire one axis, cascading its assignments away.
 *
 * The caller MUST recompute every affected variant's signature in the same
 * transaction; the deferred count constraint refuses the commit otherwise, which
 * is the point of it being deferred rather than immediate.
 */
export async function retireVariantAxis(
  db: DatabaseOrTransaction,
  axisId: string,
): Promise<void> {
  await db.delete(nativeListingVariantAxes).where(eq(nativeListingVariantAxes.id, axisId));
}

/** One variant's value on one axis, as the caller supplies it. */
export interface NewNativeVariantAxisAssignment {
  variantId: string;
  axisId: string;
  attributeDefinitionId: string;
  attributeKey: string;
  displayValue: string;
  normalizedValue: string;
  enumValueId?: string | null;
  normalizedNumber?: number | null;
  normalizedUnit?: string | null;
  sourceClaimId?: string | null;
}

/**
 * Write one assignment, converging on the row already there.
 *
 * A repeat is a no-op for the reason stated at the top of the file. A CHANGED
 * value is deliberately not an update: the caller replaces a variant's whole
 * assignment set through {@link replaceVariantAxisAssignments}, because a partial
 * update leaves the signature describing a set that no longer exists and the
 * deferred constraint would refuse the commit with nothing naming which value
 * moved.
 */
export async function writeVariantAxisAssignment(
  db: DatabaseOrTransaction,
  input: NewNativeVariantAxisAssignment,
): Promise<NativeVariantAxisAssignmentRow | null> {
  const [row] = await db
    .insert(nativeVariantAxisAssignments)
    .values({
      variantId: input.variantId,
      axisId: input.axisId,
      attributeDefinitionId: input.attributeDefinitionId,
      attributeKey: input.attributeKey,
      displayValue: input.displayValue,
      normalizedValue: input.normalizedValue,
      enumValueId: input.enumValueId ?? null,
      normalizedNumber: input.normalizedNumber ?? null,
      normalizedUnit: input.normalizedUnit ?? null,
      sourceClaimId: input.sourceClaimId ?? null,
    })
    .onConflictDoNothing({
      target: [nativeVariantAxisAssignments.variantId, nativeVariantAxisAssignments.axisId],
    })
    .returning();
  return row ?? null;
}

/**
 * Replace one variant's WHOLE assignment set.
 *
 * Whole rather than incremental, because a variant's identity is the SET: a
 * signature is computed over all of it, so writing half of it and recomputing is
 * a digest of something that never existed. The delete and the inserts are one
 * statement each and the caller upserts the signature in the same transaction;
 * the deferred count constraint is what refuses a caller that forgets.
 */
export async function replaceVariantAxisAssignments(
  db: DatabaseOrTransaction,
  variantId: string,
  assignments: readonly NewNativeVariantAxisAssignment[],
): Promise<NativeVariantAxisAssignmentRow[]> {
  await db
    .delete(nativeVariantAxisAssignments)
    .where(eq(nativeVariantAxisAssignments.variantId, variantId));
  if (assignments.length === 0) return [];
  return db
    .insert(nativeVariantAxisAssignments)
    .values(
      assignments.map((assignment) => ({
        variantId: assignment.variantId,
        axisId: assignment.axisId,
        attributeDefinitionId: assignment.attributeDefinitionId,
        attributeKey: assignment.attributeKey,
        displayValue: assignment.displayValue,
        normalizedValue: assignment.normalizedValue,
        enumValueId: assignment.enumValueId ?? null,
        normalizedNumber: assignment.normalizedNumber ?? null,
        normalizedUnit: assignment.normalizedUnit ?? null,
        sourceClaimId: assignment.sourceClaimId ?? null,
      })),
    )
    .returning();
}

/** Every assignment of one variant, in axis order. */
export async function listVariantAxisAssignments(
  db: DatabaseOrTransaction,
  variantIds: readonly string[],
): Promise<NativeVariantAxisAssignmentRow[]> {
  if (variantIds.length === 0) return [];
  return db
    .select()
    .from(nativeVariantAxisAssignments)
    .where(inArray(nativeVariantAxisAssignments.variantId, [...variantIds]))
    .orderBy(asc(nativeVariantAxisAssignments.attributeKey));
}

/**
 * Record one variant's identity.
 *
 * The ONE `DO UPDATE` in this file, and the `where` on the conflict branch is
 * what keeps an unchanged recomputation from moving `updated_at`: a backfill
 * re-run over an untouched listing writes nothing at all, which is what makes
 * "already present" a countable outcome rather than an assumption.
 */
export async function upsertVariantSignature(
  db: DatabaseOrTransaction,
  input: { variantId: string; listingId: string; signature: string; axisCount: number },
): Promise<{ row: NativeVariantSignatureRow | null; changed: boolean }> {
  const [row] = await db
    .insert(nativeVariantSignatures)
    .values({
      variantId: input.variantId,
      listingId: input.listingId,
      signature: input.signature,
      axisCount: input.axisCount,
    })
    .onConflictDoUpdate({
      target: [nativeVariantSignatures.variantId],
      set: { signature: input.signature, axisCount: input.axisCount },
      setWhere: sql`${nativeVariantSignatures.signature} <> ${input.signature}
                    or ${nativeVariantSignatures.axisCount} <> ${input.axisCount}`,
    })
    .returning();
  return { row: row ?? null, changed: row !== undefined };
}

/** One variant's identity, or none. */
export async function findVariantSignature(
  db: DatabaseOrTransaction,
  variantId: string,
): Promise<NativeVariantSignatureRow | null> {
  const [row] = await db
    .select()
    .from(nativeVariantSignatures)
    .where(eq(nativeVariantSignatures.variantId, variantId))
    .limit(1);
  return row ?? null;
}

/** Every signature of one listing — the collision set the unique index guards. */
export async function listVariantSignaturesForListing(
  db: DatabaseOrTransaction,
  listingId: string,
): Promise<NativeVariantSignatureRow[]> {
  return db
    .select()
    .from(nativeVariantSignatures)
    .where(eq(nativeVariantSignatures.listingId, listingId));
}
