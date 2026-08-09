/**
 * Identifier validation and normalization (#56 identifier rules 1–4,
 * ADR 0002 D14).
 *
 * Pure functions: nothing here touches a database, mints a row or decides who
 * owns an identifier. What it decides is narrower and load-bearing — whether a
 * string IS the identifier it claims to be, and what its one normalized form
 * is. Everything downstream (the collision gate, the dispute routing, the
 * matcher) reads that normalized form, so a validator that accepted a
 * mistyped GTIN would not produce a wrong answer here; it would produce a wrong
 * OWNER two tables away.
 *
 * ## The three things it refuses
 *
 * - **A bad check digit.** Every GS1 and ISBN scheme carries one, and a
 *   transcription error is the single most common way a real catalogue asserts
 *   an identifier that belongs to a different product. Refusing is the point:
 *   the assertion is rejected, not stored as a fact about the wrong item.
 * - **A merchant SKU or a marketplace id.** There is no scheme for either, so
 *   there is no argument to pass — the refusal is structural, which is what
 *   makes "a merchant title or SKU cannot create an accidental global identity"
 *   (#56 acceptance 2) something other than a promise.
 * - **A brand-scoped value asserted without brand scope.** `mpn` and
 *   `brand_model` name nothing on their own (identifier rule 4). The caller
 *   must supply the brand the assertion is scoped to; {@link normalizeIdentifier}
 *   answers `requiresBrandScope` and the service refuses the write.
 */

import {
  IDENTIFIER_SCHEME_REGISTRY,
  type CanonicalIdentifierScheme,
  type IdentifierGrain,
  type IdentifierScheme,
} from '@mercaria/shared-types';

/** Why a value is not the identifier it claimed to be. */
export type IdentifierRejection =
  | 'empty'
  | 'non_numeric'
  | 'wrong_length'
  | 'bad_check_digit'
  | 'not_an_isbn_prefix';

/** A validated identifier, in the exact shape `product_identifiers` stores. */
export interface NormalizedIdentifier {
  readonly scheme: IdentifierScheme;
  /** The grain this scheme binds to, from the bound registry. */
  readonly grain: IdentifierGrain;
  /** The scheme's own normalization — digits for a GTIN, folded case for an MPN. */
  readonly normalizedValue: string;
  /** The cross-scheme normalization, when the scheme has one. */
  readonly canonicalScheme?: CanonicalIdentifierScheme;
  /** Zero-padded 14-digit GTIN, present with `canonicalScheme`. */
  readonly canonicalValue?: string;
  /** Whether this scheme means nothing without a brand or manufacturer. */
  readonly requiresBrandScope: boolean;
}

/**
 * The discriminant is a STRING, not an `ok: boolean`.
 *
 * This backend compiles with `strict: false`, and under `strictNullChecks: false`
 * TypeScript does not narrow a boolean-discriminated union by truthiness:
 * `if (!result.ok) return result.reason` fails to compile, while
 * `result.ok === false` succeeds. A union whose safe use depends on remembering
 * which of those two spellings the compiler happens to accept is a trap for the
 * next caller, so the discriminant is the same `kind` string every other union
 * in this domain uses (`AliasResolution`, `IdentifierResolution`).
 */
export type IdentifierNormalization =
  | { readonly kind: 'valid'; readonly identifier: NormalizedIdentifier }
  | { readonly kind: 'invalid'; readonly reason: IdentifierRejection };

/**
 * The GS1 mod-10 check digit over a payload (the value WITHOUT its check
 * digit).
 *
 * Weights alternate 3 and 1 from the RIGHT of the payload, which is what makes
 * the same routine correct for GTIN-8, 12, 13 and 14 without a per-length
 * table — the alternation is anchored at the check digit's position, not at the
 * string's start.
 */
export function gs1CheckDigit(payload: string): number {
  let sum = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const digit = payload.charCodeAt(payload.length - 1 - index) - 48;
    sum += index % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * The ISBN-10 check character — `0`–`9` or `X`, which is why this returns a
 * string where {@link gs1CheckDigit} returns a number.
 */
export function isbn10CheckCharacter(payload: string): string {
  let sum = 0;
  for (let index = 0; index < payload.length; index += 1) {
    sum += (10 - index) * (payload.charCodeAt(index) - 48);
  }
  const remainder = (11 - (sum % 11)) % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

/** Strip the separators a source may put in a numeric identifier. */
function digitsOnly(value: string): string {
  return value.replace(/[\s-]/gu, '');
}

/**
 * ISBN-10 → ISBN-13: prefix `978`, then recompute the GS1 check digit.
 *
 * @returns The 13-digit ISBN, or `null` when the input is not a valid ISBN-10.
 *   Conversion is refused rather than approximated, because an ISBN-13 derived
 *   from a mistyped ISBN-10 is a real, different book.
 */
export function isbn10ToIsbn13(value: string): string | null {
  const compact = digitsOnly(value).toUpperCase();
  if (!/^[0-9]{9}[0-9X]$/u.test(compact)) return null;
  const payload = compact.slice(0, 9);
  if (isbn10CheckCharacter(payload) !== compact.slice(9)) return null;
  const body = `978${payload}`;
  return `${body}${gs1CheckDigit(body)}`;
}

/**
 * Conservative normalization for a brand-scoped, human-authored identifier.
 *
 * Case folding and whitespace collapsing only. Deliberately NOT stripping
 * hyphens, dots or slashes: manufacturers ship genuinely different parts whose
 * numbers differ by exactly those characters, so "helpful" stripping merges
 * two products into one. Under-normalizing costs a missed match, which review
 * fixes; over-normalizing costs a wrong merge, which nobody notices.
 */
export function normalizeBrandScopedValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toUpperCase();
}

/**
 * Validate and normalize one identifier assertion.
 *
 * The grain, digit length, canonical scheme and brand-scope requirement all come
 * from `IDENTIFIER_SCHEME_REGISTRY` in shared-types — the explicit registry
 * #56 identifier rule 6 asks for — rather than from a rule retyped here, so
 * adding a category-specific scheme is a registry entry and a migration, never a
 * new branch in this function.
 */
export function normalizeIdentifier(
  scheme: IdentifierScheme,
  rawValue: string,
): IdentifierNormalization {
  const definition = IDENTIFIER_SCHEME_REGISTRY[scheme];
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return { kind: 'invalid', reason: 'empty' };

  if (definition.canonicalScheme === undefined) {
    return {
      kind: 'valid',
      identifier: {
        scheme,
        grain: definition.grain,
        normalizedValue: normalizeBrandScopedValue(trimmed),
        requiresBrandScope: definition.requiresBrandScope,
      },
    };
  }

  // ISBN-10 is the one scheme whose payload is not all digits (`X` is a valid
  // check character), so it converts first and then follows the GTIN path.
  if (scheme === 'isbn10') {
    const compact = digitsOnly(trimmed).toUpperCase();
    if (!/^[0-9X]+$/u.test(compact)) return { kind: 'invalid', reason: 'non_numeric' };
    if (compact.length !== 10) return { kind: 'invalid', reason: 'wrong_length' };
    const isbn13 = isbn10ToIsbn13(compact);
    if (isbn13 === null) return { kind: 'invalid', reason: 'bad_check_digit' };
    return {
      kind: 'valid',
      identifier: {
        scheme,
        grain: definition.grain,
        normalizedValue: compact,
        canonicalScheme: 'gtin',
        canonicalValue: isbn13.padStart(14, '0'),
        requiresBrandScope: definition.requiresBrandScope,
      },
    };
  }

  const compact = digitsOnly(trimmed);
  if (!/^[0-9]+$/u.test(compact)) return { kind: 'invalid', reason: 'non_numeric' };
  if (definition.digitLength !== undefined && compact.length !== definition.digitLength) {
    return { kind: 'invalid', reason: 'wrong_length' };
  }
  // An ISBN-13 IS an EAN-13, but only in the 978/979 range. A 13-digit number
  // outside it is a valid EAN and not a book, and recording it as an ISBN would
  // put a grocery item in a bibliographic index.
  if (scheme === 'isbn13' && !/^97[89]/u.test(compact)) {
    return { kind: 'invalid', reason: 'not_an_isbn_prefix' };
  }
  const payload = compact.slice(0, -1);
  if (gs1CheckDigit(payload) !== compact.charCodeAt(compact.length - 1) - 48) {
    return { kind: 'invalid', reason: 'bad_check_digit' };
  }

  return {
    kind: 'valid',
    identifier: {
      scheme,
      grain: definition.grain,
      normalizedValue: compact,
      canonicalScheme: 'gtin',
      // Padding to 14 is what puts every GS1 length in ONE comparison space, so
      // a UPC and the EAN that pads to the same number cannot name two variants.
      canonicalValue: compact.padStart(14, '0'),
      requiresBrandScope: definition.requiresBrandScope,
    },
  };
}
