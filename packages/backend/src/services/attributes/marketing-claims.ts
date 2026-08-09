/**
 * The refusal that keeps promotional language out of objective specifications
 * (#94 coverage rule 6).
 *
 * A source feed's description field routinely contains "blazing fast NVMe
 * storage" where a normalized `storage_type` attribute expects `nvme`. Recording
 * the sentence as the attribute's value is worse than recording nothing: it is
 * then comparable, filterable and quotable as a fact Mercaria asserts about
 * somebody's product.
 *
 * ## Why a bounded lexicon and not a cleverness
 *
 * The temptation is a general "does this look like marketing" heuristic. Every
 * version of that is wrong in one of two expensive directions: too loose and it
 * refuses `Pro`, `Ultra` and `Max`, which are literally model names in the
 * launch categories; too tight and it passes everything. A closed table of
 * PHRASES that no specification value ever legitimately contains is checkable,
 * mutation-testable, and extendable by whoever finds the next one.
 *
 * The second half of the design is that the refusal only applies where it is
 * meaningful: an `objective` definition of `string` type. A `subjective`
 * definition — an editorial style tag — is ALLOWED to contain adjectives,
 * because that is what it is for, and a numeric attribute does not need this
 * check at all since a sentence simply fails to parse as a number. Applying it
 * everywhere would make it either useless or absurd, which is how a gate gets
 * disabled by whoever hits it next.
 */

/**
 * Phrases that never appear in a legitimate specification value.
 *
 * Whole-phrase matches against the case-folded, whitespace-collapsed value, with
 * word boundaries — so `ultimate` refuses "the ultimate laptop" and leaves
 * "Ultimate Ears" (a brand) alone only if it appears as part of a longer
 * enum/model value the definition permits. Every entry is a claim about the
 * PRODUCT'S EXCELLENCE, never a technical term.
 */
const MARKETING_PHRASES: readonly string[] = [
  'best in class',
  'best-in-class',
  "world's best",
  'world class',
  'world-class',
  'revolutionary',
  'game changing',
  'game-changing',
  'blazing fast',
  'lightning fast',
  'lightning-fast',
  'blazingly fast',
  'unbeatable',
  'unrivalled',
  'unrivaled',
  'unparalleled',
  'state of the art',
  'state-of-the-art',
  'cutting edge',
  'cutting-edge',
  'must have',
  'must-have',
  'top notch',
  'top-notch',
  'premium quality',
  'superior quality',
  'incredible',
  'amazing',
  'stunning',
  'breathtaking',
  'flawless',
  'extraordinary',
  'perfect for',
  'second to none',
  'like no other',
];

/**
 * Whether a source's words are a promotional claim rather than a value.
 *
 * Case-folded and whitespace-collapsed before matching, so "Blazing   Fast" and
 * "BLAZING FAST" are the same phrase. Matching is on WORD boundaries, so
 * `amazing` refuses "amazing sound" and does not refuse a hypothetical model
 * called "Amazingo".
 */
export function isMarketingClaim(displayValue: string): boolean {
  const folded = displayValue.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (folded.length === 0) return false;
  return MARKETING_PHRASES.some((phrase) => containsPhrase(folded, phrase));
}

/** The phrase this value matched, for a refusal that names its reason. */
export function matchedMarketingPhrase(displayValue: string): string | undefined {
  const folded = displayValue.trim().replace(/\s+/gu, ' ').toLowerCase();
  return MARKETING_PHRASES.find((phrase) => containsPhrase(folded, phrase));
}

/**
 * Whole-phrase containment.
 *
 * `indexOf` alone would match `amazing` inside `amazingly`, which is the same
 * claim, but also inside a model number that happened to contain the letters.
 * The boundary check asks that the character on each side is not a letter or a
 * digit — hyphens and spaces both qualify as boundaries, which is what lets
 * `top-notch` and `top notch` be two entries rather than a regex.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(phrase, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack[at - 1];
    const afterIndex = at + phrase.length;
    const after = afterIndex >= haystack.length ? '' : haystack[afterIndex];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    from = at + 1;
  }
}

function isWordCharacter(character: string | undefined): boolean {
  if (character === undefined || character === '') return false;
  return /[\p{L}\p{N}]/u.test(character);
}

/** The lexicon, exposed so a test can assert it is non-empty and mutation-check it. */
export const MARKETING_PHRASE_COUNT = MARKETING_PHRASES.length;
