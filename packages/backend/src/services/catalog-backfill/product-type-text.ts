/**
 * Folding `listings.product_type` free text into the product-type key space —
 * or refusing to, by name (#367 workstream 13, ADR 0007 D1/D5).
 *
 * Deliberately the same shape as #367 step 4's `legacyOptionNameToKey`, applied
 * to a different key space, and NOT a call into it: an attribute key is
 * `^[a-z][a-z0-9_]*$` while a product-type key admits dotted namespaces
 * (`PRODUCT_TYPE_KEY_PATTERN`), so reusing step 4's function would refuse every
 * namespaced key and report the refusal as `no_registered_key` — a wrong answer
 * that looks exactly like a right one.
 *
 * ## What this can and cannot produce
 *
 * The folds are mechanical spelling conventions over the merchant's OWN text.
 * They can never produce a key the merchant did not already type: `Knitwear`
 * becomes `knitwear`, and `knitwear` is a key only if somebody published a
 * product type under it. So the honest and overwhelmingly common outcome on a
 * legacy catalogue is `product_type_no_registered_key`, and that backlog IS the
 * result — ADR 0007's own consequences section: "the migration's output includes
 * a backlog rather than a clean number".
 *
 * Matching against a product type's localized NAME is the tempting fix and is
 * forbidden: ADR 0007 D1 makes a key identity and a label presentation, so a
 * name match is the basis #55's `verification_method` has no member for. It is
 * also how `Shoes` becomes `footwear` for a listing selling shoe TREES.
 */

import { PRODUCT_TYPE_KEY_PATTERN } from '@mercaria/shared-types';

/**
 * The complete list of transformations {@link legacyProductTypeTextToKey}
 * performs, asserted against the function by a test.
 *
 * Exhaustive on purpose: a reader deciding whether this module guesses needs the
 * list to be checkable, and a sixth transformation has to be argued for here
 * before it can be written.
 */
export const LEGACY_PRODUCT_TYPE_FOLDS: readonly string[] = [
  'trim leading and trailing whitespace',
  'lowercase',
  'collapse internal whitespace runs to a single underscore',
  'convert hyphens to underscores',
  'collapse repeated underscores to one',
];

/**
 * Transformations this module may never perform, stated as VALUES and asserted
 * DISJOINT from {@link LEGACY_PRODUCT_TYPE_FOLDS} by a test.
 *
 * The negative list beside the positive one is what fails the build when
 * somebody adds a plausible-looking step later — step 4's
 * `LEGACY_OPTION_FORBIDDEN_FOLDS`, and the `FEED_FORBIDDEN_TRANSFORM_KINDS`
 * device before it. Every one of them turns "I do not know what this is" into a
 * confident wrong answer, and every one of them looks like diligence in a diff.
 *
 * `depluralisation` is the one worth reading twice. `Shoes` → `shoe` is the
 * single most obviously useful fold on this dataset and the single most
 * dangerous: English plurals are irregular, other languages are worse, and a
 * catalogue full of `Pants`, `Glasses` and `Scissors` has no singular to fold
 * to at all.
 */
export const LEGACY_PRODUCT_TYPE_FORBIDDEN_FOLDS: readonly string[] = [
  'edit_distance',
  'fuzzy_match',
  'trigram_similarity',
  'phonetic_match',
  'stemming',
  'depluralisation',
  'translation',
  'synonym_expansion',
  'localized_name_match',
  'prefix_match',
];

/**
 * Fold legacy product-type text into the key space, or answer `null`.
 *
 * `null` for text that folds to nothing, or to something no product-type key
 * could ever be. `Ropa de niño` folds to `ropa_de_niño`, which the key pattern
 * refuses — so it is unmapped rather than mangled into ASCII, because stripping
 * the accent would be a transliteration and
 * {@link LEGACY_PRODUCT_TYPE_FORBIDDEN_FOLDS} refuses one.
 */
export function legacyProductTypeTextToKey(rawText: string): string | null {
  const folded = rawText
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_')
    .replace(/_+/gu, '_');
  if (folded.length === 0) return null;
  return PRODUCT_TYPE_KEY_PATTERN.test(folded) ? folded : null;
}
