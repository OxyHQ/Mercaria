/**
 * Writing a native listing's typed axes and its variants' identities
 * (#367 step 4, ADR 0007 D6).
 *
 * ## One transaction per LISTING, and the reason is the collision gate
 *
 * A variant's signature is a digest over its whole assignment SET, and
 * `native_variant_signatures_listing_signature_key` compares those digests
 * across the listing. So the unit of consistency is the listing, not the
 * variant: writing one variant's axes while another's signature still reflects
 * an older axis list leaves two rows that may or may not collide depending on
 * which order two workers happened to run in.
 *
 * `mercaria_native_variant_signature_agrees` — deferred to COMMIT — is what
 * refuses a caller that writes assignments and forgets the digest. It is the
 * reason these functions take a transaction handle rather than opening their
 * own: a caller who split the two writes across transactions would get a refusal
 * naming the second one, with nothing saying the first was the mistake.
 *
 * ## Nothing here generates a matrix
 *
 * There is no function in this module that takes an axis list and returns a set
 * of combinations, and ADR 0007 D6's "matrices are sparse — nothing generates
 * the full Cartesian product as rows" is that absence. A caller supplies the
 * variants it has; a 4-colour × 5-size listing with three real SKUs writes three
 * signatures and six assignments. `variant-axis-isolation.test.ts` fails the
 * build if a generator appears.
 */

import { validationError } from '../../lib/errors/index.js';
import {
  declareVariantAxis,
  listVariantAxesForListing,
  replaceVariantAxisAssignments,
  upsertVariantSignature,
  type NativeVariantAxisRow,
  type NewNativeVariantAxis,
  type NewNativeVariantAxisAssignment,
} from '../../db/variantAxes/variantAxisRepository.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { normalizeAxisValue, typedVariantSignature } from './signature.js';

/** One variant's value on one DECLARED axis of its listing. */
export interface VariantAxisValueInput {
  /** The axis's attribute key. It must already be declared on the listing. */
  readonly attributeKey: string;
  /** The seller's own words. */
  readonly displayValue: string;
  /** The folded form. Normalized by the caller, asserted here. */
  readonly normalizedValue: string;
  readonly enumValueId?: string | null;
  readonly normalizedNumber?: number | null;
  readonly normalizedUnit?: string | null;
  readonly sourceClaimId?: string | null;
}

/** What writing one variant's axes settled. */
export interface VariantAxisWriteResult {
  readonly variantId: string;
  readonly signature: string;
  readonly axisCount: number;
  /** `false` when the recomputation produced exactly what was already stored. */
  readonly signatureChanged: boolean;
}

/** Declare a listing's axes, converging on the ones already declared. */
export async function declareListingVariantAxes(
  tx: DatabaseOrTransaction,
  axes: readonly NewNativeVariantAxis[],
): Promise<NativeVariantAxisRow[]> {
  const declared: NativeVariantAxisRow[] = [];
  for (const axis of axes) {
    declared.push((await declareVariantAxis(tx, axis)).row);
  }
  return declared;
}

/**
 * Replace one variant's axis values and recompute its identity.
 *
 * Every value must name an axis the listing has DECLARED. That is a refusal
 * rather than an implicit declaration, and it is the half ADR 0007 D6 puts on
 * the product: "the product's own declared axis list is authoritative for that
 * product". A value quietly declaring its own axis would make the authoritative
 * list a function of whatever a variant happened to carry, which is the free-text
 * behaviour this epic replaces.
 */
export async function writeVariantAxisValues(
  tx: DatabaseOrTransaction,
  input: {
    readonly listingId: string;
    readonly variantId: string;
    readonly values: readonly VariantAxisValueInput[];
  },
): Promise<VariantAxisWriteResult> {
  const axes = await listVariantAxesForListing(tx, input.listingId);
  const byKey = new Map(axes.map((axis) => [axis.attributeKey, axis]));

  const assignments: NewNativeVariantAxisAssignment[] = [];
  for (const value of input.values) {
    const axis = byKey.get(value.attributeKey);
    if (axis === undefined) {
      throw validationError(
        `Listing ${input.listingId} declares no axis "${value.attributeKey}". Declare the axis ` +
          'before assigning a value to it.',
      );
    }
    if (value.normalizedValue !== normalizeAxisValue(value.normalizedValue)) {
      throw validationError(
        `The value for "${value.attributeKey}" is not normalized. The stored value and the ` +
          'hashed value must be the same string, or the signature cannot be recomputed.',
      );
    }
    assignments.push({
      variantId: input.variantId,
      axisId: axis.id,
      attributeDefinitionId: axis.attributeDefinitionId,
      attributeKey: axis.attributeKey,
      displayValue: value.displayValue,
      normalizedValue: value.normalizedValue,
      enumValueId: value.enumValueId ?? null,
      normalizedNumber: value.normalizedNumber ?? null,
      normalizedUnit: value.normalizedUnit ?? null,
      sourceClaimId: value.sourceClaimId ?? null,
    });
  }

  // The digest is computed from the assignments about to be written, not read
  // back from them: a read-back would be a second description of the same set
  // and the two could disagree for exactly one transaction.
  const signature = typedVariantSignature(
    assignments.map((assignment) => ({
      attributeDefinitionId: assignment.attributeDefinitionId,
      normalizedValue: assignment.normalizedValue,
    })),
  );

  await replaceVariantAxisAssignments(tx, input.variantId, assignments);
  const { changed } = await upsertVariantSignature(tx, {
    variantId: input.variantId,
    listingId: input.listingId,
    signature,
    axisCount: assignments.length,
  });

  return {
    variantId: input.variantId,
    signature,
    axisCount: assignments.length,
    signatureChanged: changed,
  };
}

/**
 * The signature a set of values WOULD produce, without writing anything.
 *
 * The collision check a caller runs before touching a listing: two variants
 * whose axis values fold to one digest are indistinguishable, and
 * `native_variant_signatures_listing_signature_key` refuses the second. Finding
 * that out from a 23505 mid-transaction tells you a write failed; finding it out
 * here tells you WHICH two variants a merchant's legacy data cannot tell apart.
 */
export function previewVariantSignature(
  values: readonly { attributeDefinitionId: string; normalizedValue: string }[],
): string {
  return typedVariantSignature(values);
}
