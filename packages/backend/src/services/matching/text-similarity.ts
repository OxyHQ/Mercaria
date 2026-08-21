/**
 * Title normalization and the ONE similarity this domain computes (#58 stage 5).
 *
 * Deliberately boring, and deliberately the least authoritative thing in the
 * pipeline. A title similarity RETRIEVES candidates and contributes one feature;
 * it can never carry a decision on its own, because a candidate whose only
 * support is a similarity carries `no_deterministic_support`, which is a
 * blocker. So the requirement on this module is not "be clever" — it is "be
 * reproducible, be explainable, and be the same number tomorrow".
 *
 * ## Why a token-set Jaccard rather than an edit distance or a learned score
 *
 * Three reasons, in order of how much they cost when ignored.
 *
 * 1. **Order independence.** "Apple iPhone 15 Pro 256GB" and
 *    "iPhone 15 Pro 256 GB Apple" are the same product written by two feeds. An
 *    edit distance says they are far apart, which is a miss on the most common
 *    real input there is.
 * 2. **Reproducibility.** The number has to be recomputable from the stored
 *    normalized fields years later, when a review asks why. A learned score is a
 *    model version nobody kept.
 * 3. **An operator can check it by eye.** `|A ∩ B| / |A ∪ B|` over a token list
 *    is a claim a person can verify from the two titles in front of them, which
 *    is what "explainable confidence" has to mean to be worth writing down.
 *
 * The known weakness is stated rather than patched: Jaccard punishes a long
 * title against a short one even when the short one is contained in it. That is
 * why {@link containmentSimilarity} exists and why the feature takes the MAX of
 * the two — a canonical name is usually shorter than a seller's title, and
 * penalising a source for being verbose would make retrieval worst exactly where
 * the catalogue is richest.
 */

import { foldAccents, wordTokens } from '../canonical/normalization.js';

/**
 * Tokens that carry no discriminating information in a product title.
 *
 * Kept SHORT on purpose. Every word removed here is a word that can no longer
 * tell two products apart, and an over-long stop list is how "Nike Pro" and
 * "Nike" become the same string. These are articles, conjunctions and
 * prepositions in the two languages this catalogue is written in, and nothing
 * else — no colours, no materials, no marketing words, because all three of
 * those are genuinely variant-defining somewhere in a marketplace.
 */
const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'al',
  'and',
  'con',
  'de',
  'del',
  'el',
  'en',
  'for',
  'in',
  'la',
  'las',
  'lo',
  'los',
  'of',
  'para',
  'por',
  'the',
  'to',
  'un',
  'una',
  'with',
  'y',
]);

/**
 * The normalized token stream of a title.
 *
 * Accent-folded, lowercased, split on non-alphanumerics, stopwords dropped, and
 * DEDUPED — a title that repeats "iPhone" three times is not thereby three times
 * more about iPhones, and leaving the repeats in lets keyword-stuffed listings
 * score higher than honest ones.
 *
 * Alphanumeric runs are kept whole (`a2848`, `256gb`), because a model number is
 * the single most discriminating token a title has and splitting it into `a` and
 * `2848` destroys exactly that.
 *
 * Tokenization is {@link wordTokens}, shared with the canonical name fold. It
 * used to be a local `[^\p{L}\p{N}]` split, which drops combining marks — so
 * `titleTokens('साइकिल')` and `titleTokens('साइकिलें')` both returned
 * `['स','इक','ल']` and two distinct Hindi products scored as IDENTICAL text.
 * That is #830's false merge reaching the matcher by a second route, which is
 * why fixing the stored name alone would not have closed it.
 */
export function titleTokens(title: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of wordTokens(foldAccents(title).toLowerCase())) {
    if (TITLE_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    tokens.push(raw);
  }
  return tokens;
}

/**
 * The normalized title as ONE string — what a decision stores so a reviewer can
 * see the pipeline's view of the text rather than re-deriving it.
 */
export function normalizeTitle(title: string): string {
  return titleTokens(title).join(' ');
}

/** `|A ∩ B| / |A ∪ B|`, and `0` for two empty sets rather than a division by zero. */
export function jaccardSimilarity(
  left: readonly string[],
  right: readonly string[],
): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of left) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = left.length + right.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * How much of the SHORTER token set the longer one contains.
 *
 * The asymmetric half of the similarity. A canonical product is named
 * "iPhone 15 Pro" and a seller's title is "Apple iPhone 15 Pro 256GB Titanio
 * Natural libre" — every canonical token is present, and Jaccard reports 0.43
 * because of the six extra words. Containment reports 1.0, which is the fact the
 * retrieval needs.
 *
 * It is NOT used alone, for the obvious reason: "iPhone" is fully contained in
 * "iPhone 15 Pro Max Case", so containment on its own merges an accessory with a
 * phone. The relation classifier refuses that pair before scoring, and the
 * feature is the max of the two similarities so a genuinely short canonical name
 * is not punished.
 */
export function containmentSimilarity(
  left: readonly string[],
  right: readonly string[],
): number {
  if (left.length === 0 || right.length === 0) return 0;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  const longerSet = new Set(longer);
  let contained = 0;
  for (const token of shorter) {
    if (longerSet.has(token)) contained += 1;
  }
  return contained / shorter.length;
}

/**
 * The title-similarity FEATURE: the better of the two views, bounded to 0–1.
 *
 * Taking the max rather than a blend is deliberate. A blend has a weight, a
 * weight is a second thing to tune, and neither number is more correct than the
 * other in general — they answer different questions ("are these the same text"
 * and "is one of these inside the other") and a candidate that answers either
 * one well is worth retrieving.
 */
export function titleSimilarity(left: readonly string[], right: readonly string[]): number {
  return Math.max(jaccardSimilarity(left, right), containmentSimilarity(left, right));
}

/**
 * The tokens most likely to be a model designation: alphanumeric mixtures and
 * bare numbers of two digits or more.
 *
 * Used for retrieval selectivity only — a query built from `iphone`, `15` and
 * `pro` scans far less of a catalogue than one built from every token. It is
 * NOT a model EXTRACTION: `modelAgreement` compares what a source explicitly
 * DECLARED as a model against the canonical product's own `model_code`, because
 * a model guessed out of prose is exactly the kind of invention #58 rule 5
 * forbids.
 */
export function discriminatingTokens(tokens: readonly string[]): string[] {
  return tokens.filter(
    (token) =>
      (/[0-9]/u.test(token) && /[\p{L}]/u.test(token)) || /^[0-9]{2,}$/u.test(token),
  );
}
