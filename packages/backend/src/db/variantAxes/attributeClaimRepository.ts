/**
 * `native_listing_attribute_claims` and `native_variant_attribute_claims`
 * (#367 step 4, ADR 0007 D7).
 *
 * A claim is what a party SAID. This file writes it, settles it, and counts what
 * is still waiting; it never deletes one and it never rewrites the assertion.
 * Both of those are held by triggers rather than by this file's discipline —
 * `mercaria_native_*_claim_frozen` refuses any UPDATE that moves the raw text,
 * the subject, the provenance or the assertion instant, and
 * `mercaria_native_claim_no_delete` refuses a DELETE while the subject exists.
 *
 * ## The insert is `DO NOTHING`, and the identity key includes the VALUE
 *
 * A repeat has to be a genuine no-op — no tuple version, no timestamp, no lock —
 * because a repeat is ordinary: a resumed backfill, a retried connector
 * delivery, an operator re-import. `DO UPDATE` with identical values still moves
 * `updated_at` and `xmin` (measured on `moderation_outboxes`, pinned there by a
 * test), so it is not available.
 *
 * What must NOT converge is a party changing their mind. `Black` becoming
 * `Jet Black` is a NEW assertion and ADR 0007 D7 retains both, so the value is in
 * the identity key and the second one gets its own row. Anything that converges
 * is the SAME sentence arriving twice.
 */

import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type {
  NativeAttributeClaimKind,
  NativeAttributeClaimProvenance,
  NativeClaimResolution,
  VariantAxisAttributeRefusal,
  VariantAxisValueRefusal,
} from '@mercaria/shared-types';
import {
  NATIVE_CLAIM_QUEUED_RESOLUTIONS,
  VARIANT_AXIS_ATTRIBUTE_REFUSALS,
  VARIANT_AXIS_VALUE_REFUSALS,
} from '@mercaria/shared-types';
import {
  nativeListingAttributeClaims,
  nativeVariantAttributeClaims,
} from '../schema/variantAxes.js';
import { productVariants } from '../schema/catalog.js';
import type { DatabaseOrTransaction } from '../postgres.js';

export type NativeListingAttributeClaimRow = typeof nativeListingAttributeClaims.$inferSelect;
export type NativeVariantAttributeClaimRow = typeof nativeVariantAttributeClaims.$inferSelect;

/** The provenance half every claim carries, at both grains. */
export interface ClaimProvenanceInput {
  provenance: NativeAttributeClaimProvenance;
  sourceConnectionId?: string | null;
  assertedByOxyUserId?: string | null;
  assertedAt: Date;
}

/**
 * The settled half, when the writer already knows it.
 *
 * Every field is optional and the DEFAULT is `unresolved` on both halves —
 * because a connector or a merchant asserting a value has said nothing about
 * which registry entry it is, and recording their assertion must not wait on the
 * registry being able to answer.
 */
export interface ClaimResolutionInput {
  attributeResolution?: NativeClaimResolution;
  attributeRefusal?: VariantAxisAttributeRefusal | null;
  valueResolution?: NativeClaimResolution;
  valueRefusal?: VariantAxisValueRefusal | null;
  attributeDefinitionId?: string | null;
  attributeDefinitionVersion?: number | null;
  enumValueId?: string | null;
  normalizedValue?: string | null;
  resolvedByOxyUserId?: string | null;
  resolvedAt?: Date | null;
}

function resolutionValues(input: ClaimResolutionInput) {
  return {
    attributeResolution: input.attributeResolution ?? 'unresolved',
    attributeRefusal: input.attributeRefusal ?? null,
    valueResolution: input.valueResolution ?? 'unresolved',
    valueRefusal: input.valueRefusal ?? null,
    attributeDefinitionId: input.attributeDefinitionId ?? null,
    attributeDefinitionVersion: input.attributeDefinitionVersion ?? null,
    enumValueId: input.enumValueId ?? null,
    normalizedValue: input.normalizedValue ?? null,
    resolvedByOxyUserId: input.resolvedByOxyUserId ?? null,
    resolvedAt: input.resolvedAt ?? null,
  };
}

/** One claim about a native LISTING. */
export interface NewNativeListingAttributeClaim extends ClaimProvenanceInput, ClaimResolutionInput {
  listingId: string;
  kind: NativeAttributeClaimKind;
  rawName: string;
  rawValue?: string | null;
}

/**
 * Record one listing-grain claim, converging on the row already there.
 *
 * Returns `null` when the claim was already present — the empty `RETURNING` set
 * IS the answer, and the caller counts `alreadyPresent` off it rather than
 * re-deriving what it wrote.
 */
export async function recordListingAttributeClaim(
  db: DatabaseOrTransaction,
  input: NewNativeListingAttributeClaim,
): Promise<NativeListingAttributeClaimRow | null> {
  const [row] = await db
    .insert(nativeListingAttributeClaims)
    .values({
      listingId: input.listingId,
      kind: input.kind,
      rawName: input.rawName,
      rawValue: input.rawValue ?? null,
      provenance: input.provenance,
      sourceConnectionId: input.sourceConnectionId ?? null,
      assertedByOxyUserId: input.assertedByOxyUserId ?? null,
      assertedAt: input.assertedAt,
      ...resolutionValues(input),
    })
    .onConflictDoNothing({
      target: [
        nativeListingAttributeClaims.listingId,
        nativeListingAttributeClaims.provenance,
        nativeListingAttributeClaims.kind,
        nativeListingAttributeClaims.rawNameNormalized,
        nativeListingAttributeClaims.rawValueKey,
      ],
    })
    .returning();
  return row ?? null;
}

/** One claim about a native VARIANT. Always a value — see the schema. */
export interface NewNativeVariantAttributeClaim extends ClaimProvenanceInput, ClaimResolutionInput {
  variantId: string;
  rawName: string;
  rawValue: string;
}

/** Record one variant-grain claim, converging on the row already there. */
export async function recordVariantAttributeClaim(
  db: DatabaseOrTransaction,
  input: NewNativeVariantAttributeClaim,
): Promise<NativeVariantAttributeClaimRow | null> {
  const [row] = await db
    .insert(nativeVariantAttributeClaims)
    .values({
      variantId: input.variantId,
      rawName: input.rawName,
      rawValue: input.rawValue,
      provenance: input.provenance,
      sourceConnectionId: input.sourceConnectionId ?? null,
      assertedByOxyUserId: input.assertedByOxyUserId ?? null,
      assertedAt: input.assertedAt,
      ...resolutionValues(input),
    })
    .onConflictDoNothing({
      target: [
        nativeVariantAttributeClaims.variantId,
        nativeVariantAttributeClaims.provenance,
        nativeVariantAttributeClaims.rawNameNormalized,
        nativeVariantAttributeClaims.rawValueKey,
      ],
    })
    .returning();
  return row ?? null;
}

/**
 * Read back the claim an insert converged on.
 *
 * The generated key columns are what the lookup is on, so the caller passes the
 * SAME raw text it tried to insert and the database does the folding — a
 * caller-side `lower(btrim(...))` would be a second implementation of the
 * generation expression, and the two would disagree the day one of them changed.
 */
export async function findVariantAttributeClaim(
  db: DatabaseOrTransaction,
  input: {
    variantId: string;
    provenance: NativeAttributeClaimProvenance;
    rawName: string;
    rawValue: string;
  },
): Promise<NativeVariantAttributeClaimRow | null> {
  const [row] = await db
    .select()
    .from(nativeVariantAttributeClaims)
    .where(
      and(
        eq(nativeVariantAttributeClaims.variantId, input.variantId),
        eq(nativeVariantAttributeClaims.provenance, input.provenance),
        eq(nativeVariantAttributeClaims.rawNameNormalized, sql`lower(btrim(${input.rawName}))`),
        eq(nativeVariantAttributeClaims.rawValueKey, sql`lower(btrim(${input.rawValue}))`),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every claim about one listing, newest assertion first. */
export async function listListingAttributeClaims(
  db: DatabaseOrTransaction,
  listingId: string,
): Promise<NativeListingAttributeClaimRow[]> {
  return db
    .select()
    .from(nativeListingAttributeClaims)
    .where(eq(nativeListingAttributeClaims.listingId, listingId))
    .orderBy(desc(nativeListingAttributeClaims.assertedAt), asc(nativeListingAttributeClaims.id));
}

/** Every claim about a set of variants. */
export async function listVariantAttributeClaims(
  db: DatabaseOrTransaction,
  variantIds: readonly string[],
): Promise<NativeVariantAttributeClaimRow[]> {
  if (variantIds.length === 0) return [];
  return db
    .select()
    .from(nativeVariantAttributeClaims)
    .where(inArray(nativeVariantAttributeClaims.variantId, [...variantIds]))
    .orderBy(desc(nativeVariantAttributeClaims.assertedAt), asc(nativeVariantAttributeClaims.id));
}

/**
 * Settle one variant claim's two halves.
 *
 * The raw assertion is not a parameter, so a settlement that rewrote what
 * somebody said is not expressible here — and the freeze trigger refuses it for
 * every caller that does not come through this file.
 */
export async function settleVariantAttributeClaim(
  db: DatabaseOrTransaction,
  claimId: string,
  resolution: ClaimResolutionInput,
): Promise<NativeVariantAttributeClaimRow | null> {
  const [row] = await db
    .update(nativeVariantAttributeClaims)
    .set(resolutionValues(resolution))
    .where(eq(nativeVariantAttributeClaims.id, claimId))
    .returning();
  return row ?? null;
}

/** The same at the listing grain. */
export async function settleListingAttributeClaim(
  db: DatabaseOrTransaction,
  claimId: string,
  resolution: ClaimResolutionInput,
): Promise<NativeListingAttributeClaimRow | null> {
  const [row] = await db
    .update(nativeListingAttributeClaims)
    .set(resolutionValues(resolution))
    .where(eq(nativeListingAttributeClaims.id, claimId))
    .returning();
  return row ?? null;
}

/**
 * The backlog, by cause — ADR 0007's own closing consequence as a number.
 *
 * "Ambiguous legacy values are not resolved. They stay text, in a queue,
 * visible… the migration's output includes a backlog rather than a clean
 * number." A count grouped by refusal is what makes that visible; a boolean
 * "there is a backlog" would be exactly the silence the ADR is warning against.
 *
 * Every bucket of both vocabularies is present in the result whether or not any
 * row is in it, so a reader can tell a cause with nothing in it from a cause the
 * query forgot to ask about — the census discipline `CONVENTIONS.md` asks for,
 * applied to a report.
 */
export async function countQueuedClaims(
  db: DatabaseOrTransaction,
  scope?: { listingIds?: readonly string[] },
): Promise<{
  queued: number;
  neverAttempted: number;
  byAttributeRefusal: Record<VariantAxisAttributeRefusal, number>;
  byValueRefusal: Record<VariantAxisValueRefusal, number>;
}> {
  const byAttributeRefusal = Object.fromEntries(
    VARIANT_AXIS_ATTRIBUTE_REFUSALS.map((refusal) => [refusal, 0]),
  ) as Record<VariantAxisAttributeRefusal, number>;
  const byValueRefusal = Object.fromEntries(
    VARIANT_AXIS_VALUE_REFUSALS.map((refusal) => [refusal, 0]),
  ) as Record<VariantAxisValueRefusal, number>;

  const queuedPredicate = or(
    inArray(nativeVariantAttributeClaims.attributeResolution, [...NATIVE_CLAIM_QUEUED_RESOLUTIONS]),
    inArray(nativeVariantAttributeClaims.valueResolution, [...NATIVE_CLAIM_QUEUED_RESOLUTIONS]),
  );
  const scoped =
    scope?.listingIds === undefined || scope.listingIds.length === 0
      ? queuedPredicate
      : and(
          queuedPredicate,
          inArray(
            nativeVariantAttributeClaims.variantId,
            db
              .select({ id: productVariants.id })
              .from(productVariants)
              .where(inArray(productVariants.listingId, [...scope.listingIds])),
          ),
        );

  const rows = await db
    .select({
      attributeResolution: nativeVariantAttributeClaims.attributeResolution,
      attributeRefusal: nativeVariantAttributeClaims.attributeRefusal,
      valueRefusal: nativeVariantAttributeClaims.valueRefusal,
      total: count(),
    })
    .from(nativeVariantAttributeClaims)
    .where(scoped)
    .groupBy(
      nativeVariantAttributeClaims.attributeResolution,
      nativeVariantAttributeClaims.attributeRefusal,
      nativeVariantAttributeClaims.valueRefusal,
    );

  let queued = 0;
  let neverAttempted = 0;
  for (const row of rows) {
    queued += row.total;
    if (row.attributeRefusal !== null) {
      byAttributeRefusal[row.attributeRefusal] += row.total;
    }
    if (row.valueRefusal !== null) {
      byValueRefusal[row.valueRefusal] += row.total;
    }
    // Neither half has been looked at. A distinct fact from every refusal, and
    // the one an operator can fix by running the resolver rather than by
    // deciding anything.
    if (row.attributeResolution === 'unresolved' && row.attributeRefusal === null) {
      neverAttempted += row.total;
    }
  }

  return { queued, neverAttempted, byAttributeRefusal, byValueRefusal };
}
