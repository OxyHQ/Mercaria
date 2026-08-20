/**
 * What a draft variant's `barcode` IS, decided once (#367 workstream 7,
 * "validate identifiers and collisions using existing canonical rules").
 *
 * PURE, and deliberately tiny. The rules themselves are not here: every
 * arithmetic decision is made by {@link normalizeIdentifier} in
 * `services/canonical/identifiers.ts`, which is the module #56 wrote for
 * exactly this and which the canonical write path already uses. What this adds
 * is the ONE thing that module cannot do from an authoring draft — pick a
 * SCHEME.
 *
 * ## Why a scheme has to be picked at all
 *
 * `normalizeIdentifier(scheme, value)` takes the scheme as an argument, because
 * every caller it was written for has one: `product_identifiers` stores a
 * scheme column, a feed declares one, an operator types one.
 * `catalog_authoring_draft_variants.barcode` is a single free-text column with
 * no scheme beside it, so something has to say which registry entry the string
 * is being measured against.
 *
 * ## The scheme is picked from DIGIT LENGTH, and only for four lengths
 *
 * `GTIN_SCHEME_BY_LENGTH` covers the four GS1 trade-item lengths and nothing
 * else. Two absences are decisions:
 *
 * - **ISBN-10 (ten digits) is NOT inferred.** There is no ten-digit GS1 scheme,
 *   so a ten-digit barcode is either an ISBN-10 or a code system Mercaria does
 *   not model — and treating it as the first would refuse the second by
 *   arithmetic it never agreed to. An ISBN reaches this path as its 13-digit
 *   form, which IS an EAN-13 and validates as one.
 * - **`isbn13` is not inferred for a 978/979 prefix.** An ISBN-13 IS an EAN-13:
 *   the same mod-10 check digit over the same thirteen digits. Choosing `ean`
 *   for all thirteen-digit values therefore reaches the identical verdict, and
 *   choosing `isbn13` would additionally raise `not_an_isbn_prefix` for every
 *   grocery item — a refusal of a perfectly valid barcode.
 *
 * Anything that is not a digit string of one of the four lengths answers
 * `unrecognized` and is REPORTED AS NOTHING. The column is free text with only
 * a non-empty CHECK behind it and merchants keep other code systems in it; a
 * validator that called those invalid would refuse real data to satisfy a rule
 * nobody wrote. That boundary is stated here rather than left to be inferred
 * from which branch happens to fire.
 *
 * ## The discriminant is a STRING
 *
 * This backend compiles with `strict: false`, so TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — the finding
 * `services/offer-freshness/` records and `identifiers.ts` states at length.
 * `kind` is the same spelling every union in the canonical domain uses.
 */

import { IDENTIFIER_SCHEME_REGISTRY, type IdentifierScheme } from '@mercaria/shared-types';
import { normalizeIdentifier } from '../canonical/identifiers.js';

/**
 * The GS1 scheme each trade-item digit length names.
 *
 * A `Record` over the four lengths rather than a chain of comparisons, and the
 * lengths are read back OUT of `IDENTIFIER_SCHEME_REGISTRY` by
 * `authoring-identifier.test.ts` — so a registry whose `digitLength` moved, or
 * a fifth GS1 scheme added there, fails the build instead of being silently
 * unreachable from authoring.
 */
export const GTIN_SCHEME_BY_LENGTH: Readonly<Record<number, IdentifierScheme>> = Object.freeze({
  8: 'gtin8',
  12: 'upc',
  13: 'ean',
  14: 'gtin14',
});

/** What a barcode string turned out to be. */
export type BarcodeClassification =
  /** Not a digit string of a GS1 trade-item length. Nothing is claimed about it. */
  | { readonly kind: 'unrecognized' }
  /** The right length for a GS1 scheme, and the check digit does not hold. */
  | { readonly kind: 'invalid'; readonly scheme: IdentifierScheme }
  /** A real GTIN. Both forms `product_identifiers` indexes travel with it. */
  | {
      readonly kind: 'valid';
      readonly scheme: IdentifierScheme;
      /** The scheme's own normalization — the compact digits. */
      readonly normalizedValue: string;
      /** The zero-padded GTIN-14 the collision gate compares on. */
      readonly canonicalValue: string;
    };

/**
 * Classify one raw barcode.
 *
 * Separators are stripped before the length is measured, because a scanner and
 * a spreadsheet both emit `0-12345-67890-5`. That is `digitsOnly`'s own rule
 * one module over, and it is applied here for the LENGTH decision only —
 * `normalizeIdentifier` applies it again for the arithmetic, which is what
 * keeps the two from disagreeing about what the digits are.
 */
export function classifyBarcode(rawValue: string | null): BarcodeClassification {
  if (rawValue === null) return { kind: 'unrecognized' };
  const compact = rawValue.trim().replace(/[\s-]/gu, '');
  if (!/^[0-9]+$/u.test(compact)) return { kind: 'unrecognized' };

  const scheme = GTIN_SCHEME_BY_LENGTH[compact.length];
  if (scheme === undefined) return { kind: 'unrecognized' };

  const normalization = normalizeIdentifier(scheme, compact);
  if (normalization.kind === 'invalid') {
    // Only `bad_check_digit` is reachable: the length was measured against this
    // scheme's own `digitLength` before the call, the string is all digits, and
    // the ISBN-prefix rule belongs to a scheme this function never picks. The
    // reason is deliberately NOT carried into the finding — there is one code
    // and one remedy, and a second code for an unreachable reason is the
    // "reads as coverage" shape `canonical_reference_not_permitted` already
    // cost this domain once.
    return { kind: 'invalid', scheme };
  }

  const { normalizedValue, canonicalValue } = normalization.identifier;
  if (canonicalValue === undefined) {
    // Unreachable for the four schemes above — every one declares
    // `canonicalScheme: 'gtin'`, and `normalizeIdentifier` sets the pair
    // together. Answering `unrecognized` rather than asserting a padded form
    // this function computed itself: a second normalization here is exactly the
    // duplicate the module exists to avoid, and it would be the value the
    // collision read compares on.
    return { kind: 'unrecognized' };
  }
  return { kind: 'valid', scheme, normalizedValue, canonicalValue };
}

/**
 * The registry entry a classification cites, for a caller that needs the
 * uniqueness declaration rather than the value.
 *
 * Exported so `validation.ts` can say WHY a duplicate barcode is an error and a
 * duplicate SKU is not, by reading `globallyUnique` off the registry instead of
 * restating it.
 */
export function identifierIsGloballyUnique(scheme: IdentifierScheme): boolean {
  return IDENTIFIER_SCHEME_REGISTRY[scheme].globallyUnique;
}
