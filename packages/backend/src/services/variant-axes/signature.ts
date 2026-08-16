/**
 * The deterministic, order-independent TYPED variant signature
 * (#367 step 4, ADR 0007 D6).
 *
 * A variant is defined by WHICH axis values it carries, not by the order a
 * merchant, a connector or a legacy option list happened to put them in. Two
 * variants entered as "Colour: Black, Storage: 256 GB" and "Storage: 256GB,
 * Colour: Black" are ONE variant, and `native_variant_signatures_listing_signature_key`
 * is what makes that a database fact rather than a hope.
 *
 * ## Why this is a second signature function and not a reuse of #56's
 *
 * `services/canonical/variant-signature.ts` hashes `(attribute_key,
 * normalized_value)` pairs for a CANONICAL variant. ADR 0007 D6 specifies
 * `(attribute_definition_id, normalized_value)` for a native one, and the
 * difference is the whole point of the epic: a key is a stable machine name
 * shared by every VERSION of an attribute, while the definition id names one
 * exact version — so a native signature says which MEANING the value was
 * recorded under and a canonical one deliberately does not.
 *
 * The two therefore produce different digests for the same variant, always, and
 * {@link TYPED_VARIANT_SIGNATURE_VERSION} is `t1` rather than `v1` so nothing
 * reads them as comparable. Merging the two functions would mean one of the two
 * domains silently changing which fact its identity rests on.
 *
 * ## What follows from hashing the version, stated rather than discovered
 *
 * Publishing a new version of `color` and re-declaring a listing's axis under it
 * changes every one of that listing's signatures. That is correct — it is #94's
 * posture (a meaning change schedules a re-normalization rather than
 * reinterpreting facts) applied to identity — and it is why
 * `writeVariantAxisValues` recomputes every affected variant's signature in the
 * same transaction that moves the axis, and why the axis row itself is FROZEN
 * (`mercaria_native_variant_axis_frozen`): a version bump is a new axis, and the
 * old one cascades its assignments away rather than leaving them normalized
 * under a meaning nobody can name.
 */

import { createHash } from 'node:crypto';
import type { TypedVariantAxisAssignment } from '@mercaria/shared-types';
import { TYPED_VARIANT_SIGNATURE_VERSION } from '@mercaria/shared-types';
import { normalizeOptionValue } from '../canonical/variant-signature.js';

/** ASCII unit separator — cannot occur in a definition id or a normalized value. */
const FIELD_SEPARATOR = '\u001f';

/** ASCII record separator — the same. */
const RECORD_SEPARATOR = '\u001e';

/**
 * Fold an axis value into the space the signature and the database CHECK both
 * live in (`normalized_value = lower(btrim(normalized_value))`).
 *
 * Re-exported from #56's own folder rather than reimplemented: whitespace
 * collapsed and case folded, and nothing else. "Black Titanium" and
 * "black  titanium" are the same option; "Black" and "Blackout" are not, and no
 * amount of cleverness here should be able to make them one.
 */
export function normalizeAxisValue(value: string): string {
  return normalizeOptionValue(value);
}

/**
 * The order-independent digest of a variant's typed axis assignments.
 *
 * @throws When two assignments name the same attribute definition. A variant
 *   with two storages is not a variant, and hashing it would make the signature
 *   depend on which of the two the caller happened to put first — precisely the
 *   order dependence this function exists to remove. The database refuses the
 *   same thing at `native_variant_axis_assignments_variant_axis_key`; this is
 *   the earlier, clearer failure.
 * @throws When an assignment carries an empty definition id or an unnormalized
 *   value. Both would produce a digest no later read could reproduce, and a
 *   signature that cannot be recomputed is not an identity.
 */
export function typedVariantSignature(
  assignments: readonly TypedVariantAxisAssignment[],
): string {
  const seen = new Set<string>();
  const serialized: string[] = [];

  for (const assignment of assignments) {
    const definitionId = assignment.attributeDefinitionId.trim();
    if (definitionId.length === 0) {
      throw new Error(
        'typedVariantSignature: an assignment has an empty attribute definition id.',
      );
    }
    if (seen.has(definitionId)) {
      throw new Error(
        `typedVariantSignature: attribute definition '${definitionId}' is assigned twice; ` +
          'a variant has one value per axis.',
      );
    }
    // The value is asserted rather than folded here, deliberately. Folding
    // silently would make a caller that stored the RAW value in the column and
    // the FOLDED one in the digest produce a row whose signature nothing can
    // recompute — the failure is invisible until two variants stop colliding.
    if (assignment.normalizedValue !== normalizeAxisValue(assignment.normalizedValue)) {
      throw new Error(
        `typedVariantSignature: the value for definition '${definitionId}' is not normalized. ` +
          'Call `normalizeAxisValue` before storing it and before hashing it.',
      );
    }
    if (assignment.normalizedValue.length === 0) {
      throw new Error(
        `typedVariantSignature: the value for definition '${definitionId}' is empty.`,
      );
    }
    seen.add(definitionId);
    serialized.push(`${definitionId}${FIELD_SEPARATOR}${assignment.normalizedValue}`);
  }

  // Sort AFTER serialization on the composed string: sorting on the definition
  // id alone would leave ties (impossible here, since ids are unique) unresolved,
  // and sorting the composed form is one rule with no second case to get wrong.
  serialized.sort();

  const payload = [TYPED_VARIANT_SIGNATURE_VERSION, ...serialized].join(RECORD_SEPARATOR);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * The signature of a variant with NO axes — the empty assignment set.
 *
 * Not a special case and not a NULL. ADR 0007 D6 asks for zero, one and many
 * axes, and the zero-axis variant is the commonest row in this catalogue (a
 * listing with one default variant). It gets a real digest, so
 * `native_variant_signatures_listing_signature_key` refuses a SECOND axis-less
 * variant on one listing — which is right: two variants that vary along nothing
 * are one variant.
 */
export function defaultTypedVariantSignature(): string {
  return typedVariantSignature([]);
}
