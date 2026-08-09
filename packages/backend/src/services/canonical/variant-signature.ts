/**
 * The deterministic canonical-variant signature (#56 variant rule 6).
 *
 * A variant is defined by WHICH options it carries, not by the order a source
 * happened to list them in. Two feeds describing the same phone as
 * "Colour: Black, Storage: 256 GB" and "Storage: 256GB, Colour: Black" describe
 * ONE variant, and a system that cannot say so mints a duplicate for every
 * source it ingests.
 *
 * The signature is the mechanical form of that statement: sort by attribute key,
 * serialize each assignment in its NORMALIZED value, hash. `position` — the
 * display order — is deliberately not an input, which is exactly what "does not
 * rely on option display order" means.
 *
 * ## Why it is worth hashing rather than storing the sorted string
 *
 * `canonical_variants.signature` sits inside `UNIQUE(product_id, signature)`, so
 * it must be bounded: an option set of unbounded length in a unique index is a
 * btree entry a long enough value silently overflows. A fixed 64-character
 * digest is also what lets the column carry a shape CHECK, so a hand-written row
 * with a made-up signature fails the write rather than occupying the key space.
 *
 * ## The version prefix
 *
 * `SIGNATURE_VERSION` is inside the hashed payload. If the serialization ever
 * has to change, bumping it changes every signature at once — which is a
 * recompute-and-migrate, visibly, rather than a silent drift where rows written
 * before and after a refactor stop colliding with each other.
 */

import { createHash } from 'node:crypto';

/** Bumping this changes every signature; see the note above. */
const SIGNATURE_VERSION = 'v1';

/** ASCII unit separator — cannot occur in a normalized key or value. */
const FIELD_SEPARATOR = '\u001f';

/** ASCII record separator — cannot occur in a normalized key or value. */
const RECORD_SEPARATOR = '\u001e';

/** One option assignment, as the signature reads it. */
export interface VariantOptionAssignment {
  /** The attribute key — an axis of the variant's product. */
  readonly key: string;
  /** The normalized value; a quantity's base-unit magnitude, or folded text. */
  readonly normalizedValue: string;
}

/**
 * Fold a dimension key into the space the signature and the database CHECK both
 * live in (`attribute_key = lower(btrim(attribute_key))`).
 */
export function normalizeAttributeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Fold a free-text option value.
 *
 * Whitespace collapsed and case folded, and nothing else — "Black Titanium" and
 * "black  titanium" are the same option; "Black" and "Blackout" are not, and no
 * amount of cleverness here should be able to make them one.
 */
export function normalizeOptionValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * The order-independent digest of a variant's option assignments.
 *
 * @throws When two assignments share a key. A variant with two storages is not
 *   a variant, and hashing it would make the signature depend on which of the
 *   two the caller happened to put first — precisely the order dependence this
 *   function exists to remove. The database refuses the same thing at
 *   `canonical_variant_attrs_key_unique`; this is the earlier, clearer failure.
 */
export function variantSignature(assignments: readonly VariantOptionAssignment[]): string {
  const seen = new Set<string>();
  const serialized: string[] = [];

  for (const assignment of assignments) {
    const key = normalizeAttributeKey(assignment.key);
    if (key.length === 0) {
      throw new Error('variantSignature: an option assignment has an empty attribute key.');
    }
    if (seen.has(key)) {
      throw new Error(
        `variantSignature: attribute key '${key}' is assigned twice; a variant has one value per axis.`,
      );
    }
    seen.add(key);
    serialized.push(`${key}${FIELD_SEPARATOR}${assignment.normalizedValue}`);
  }

  // Sort AFTER serialization on the composed string: sorting on the key alone
  // would leave ties (impossible here, since keys are unique) unresolved, and
  // sorting the composed form is one rule with no second case to get wrong.
  serialized.sort();

  const payload = [SIGNATURE_VERSION, ...serialized].join(RECORD_SEPARATOR);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** The signature of the DEFAULT variant — the empty assignment set (ADR 0002 D13). */
export function defaultVariantSignature(): string {
  return variantSignature([]);
}
