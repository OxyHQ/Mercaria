/**
 * One shared corpus of REAL words, one entry per script family the product
 * ships a locale bundle for (#833).
 *
 * ## Why a shared corpus rather than a string in each test
 *
 * The census behind #833 found 21 of 22 normalization test files carrying no
 * non-Latin character at all, while `hi.json`, `bn.json`, `ja.json`, `ru.json`,
 * `ar.json` and `zh-Hans.json` ship in `@mercaria/ui`. Three defects came out of
 * that blind spot in one week. The remedy is not "remember to add a Hindi
 * string" — that is the habit that already failed — it is a corpus every fold's
 * test drives, so a fold added tomorrow is measured against the same words.
 *
 * ## Why these words and not decorative ones
 *
 * Each entry is chosen to carry the hazard its script actually has, because a
 * fixture that only proves "a non-Latin character was present" is the same
 * failure one level down:
 *
 * - **Devanagari and Bengali** carry vowel signs (matras). Those are `Mn`/`Mc`,
 *   NOT `L`, so the obvious `[^\p{L}\p{N}]` deletes them — the #830 defect. Each
 *   has a singular/plural PAIR that differs only in matras, so a fold that eats
 *   them collapses two different words onto one string and the test says so.
 * - **Arabic** is caseless and right-to-left, so `[A-Z]`-anchored patterns (the
 *   #832 defect) never fire on it.
 * - **Cyrillic** is CASED and non-ASCII: the one script where `[A-Z]` looks like
 *   it should work and does not.
 * - **Hiragana** carries dakuten as a combining mark (`か` + `゛` = `が`) and
 *   small kana. It is the script every fixture writer in this repository skipped
 *   — measured: before #833 exactly one file contained any.
 * - **Katakana** additionally has half-width forms (`ｼﾞﾃﾝｼｬ`) that NFKC folds.
 * - **Han** is ideographic and word-boundary-free, so a whitespace tokenizer
 *   yields one token for a whole phrase.
 * - **Latin** carries a precomposed/decomposed pair, the hazard that is not
 *   about a "foreign" script at all.
 *
 * Glosses are on every entry so a reader who does not read the script can still
 * review the expectation.
 */

/** A script family, spelled as its Unicode `Script=` property value. */
export type ScriptFamily =
  | 'Latin'
  | 'Arabic'
  | 'Bengali'
  | 'Cyrillic'
  | 'Devanagari'
  | 'Han'
  | 'Hiragana'
  | 'Katakana';

/** One script's sample, with the gloss a reviewer needs. */
export interface ScriptSample {
  readonly script: ScriptFamily;
  /** A noun a seller would actually list. */
  readonly noun: string;
  /** What {@link noun} means, in English. */
  readonly nounGloss: string;
  /**
   * A SECOND form of {@link noun} that differs from it only in characters a
   * mark-eating fold destroys, or `undefined` where the script has no such
   * pair. Where it exists, `noun` and `variant` must stay DISTINCT under a
   * correct fold — that is the #830 property, stated per script.
   */
  readonly variant: string | undefined;
  /** What {@link variant} means, in English. */
  readonly variantGloss: string | undefined;
  /** A short adjective, for phrase-level and tokenizer cases. */
  readonly adjective: string;
  /** What {@link adjective} means, in English. */
  readonly adjectiveGloss: string;
}

/**
 * The corpus.
 *
 * Ordered as `ScriptFamily` is declared. Nothing derives the REQUIRED set from
 * this file — `script-coverage-census.test.ts` derives that from the shipped
 * locale bundles and then asserts this corpus covers it, so a locale added
 * tomorrow fails the gate here rather than passing unnoticed.
 */
export const SCRIPT_CORPUS: readonly ScriptSample[] = [
  {
    script: 'Latin',
    noun: 'bicicleta',
    nounGloss: 'bicycle (es)',
    // `é` precomposed (U+00E9) vs decomposed (`e` + U+0301). NFC/NFD folds
    // must agree on these two; a naive byte comparison does not.
    variant: 'café',
    variantGloss: 'cafe, precomposed U+00E9',
    adjective: 'nuevo',
    adjectiveGloss: 'new (es)',
  },
  {
    script: 'Arabic',
    noun: 'دراجة',
    nounGloss: 'bicycle (ar)',
    variant: undefined,
    variantGloss: undefined,
    adjective: 'جديد',
    adjectiveGloss: 'new (ar)',
  },
  {
    script: 'Bengali',
    // বই / বইগুলি — "book" and "books". The plural adds গু (with the ু vowel
    // sign) and লি; the vowel signs are Mn/Mc.
    noun: 'বই',
    nounGloss: 'book (bn)',
    variant: 'বইগুলি',
    variantGloss: 'books (bn) — differs by vowel signs',
    adjective: 'নতুন',
    adjectiveGloss: 'new (bn)',
  },
  {
    script: 'Cyrillic',
    noun: 'велосипед',
    nounGloss: 'bicycle (ru)',
    // Cased, non-ASCII: the pair that shows `[A-Z]` is ASCII-only.
    variant: 'Велосипед',
    variantGloss: 'Bicycle (ru), capitalised',
    adjective: 'новый',
    adjectiveGloss: 'new (ru)',
  },
  {
    script: 'Devanagari',
    // साइकिल / साइकिलें — "bicycle" and "bicycles". The plural adds ें, which is
    // two combining marks. This is the #830 pair verbatim.
    noun: 'साइकिल',
    nounGloss: 'bicycle (hi)',
    variant: 'साइकिलें',
    variantGloss: 'bicycles (hi) — differs by combining marks',
    adjective: 'नया',
    adjectiveGloss: 'new (hi)',
  },
  {
    script: 'Han',
    noun: '自行车',
    nounGloss: 'bicycle (zh-Hans)',
    variant: undefined,
    variantGloss: undefined,
    adjective: '全新',
    adjectiveGloss: 'brand new (zh-Hans)',
  },
  {
    script: 'Hiragana',
    // じてんしゃ — "bicycle", written in hiragana. `じ` is `し` + dakuten in its
    // decomposed form, which is exactly the mark class #830 was about.
    noun: 'じてんしゃ',
    nounGloss: 'bicycle (ja, hiragana)',
    variant: 'してんしゃ',
    variantGloss: 'the same word without dakuten on the first kana — a different word',
    adjective: 'あたらしい',
    adjectiveGloss: 'new (ja)',
  },
  {
    script: 'Katakana',
    noun: 'ジテンシャ',
    nounGloss: 'bicycle (ja, katakana)',
    // Half-width katakana. NFKC folds this onto the full-width form above.
    variant: 'ｼﾞﾃﾝｼｬ',
    variantGloss: 'the same word in HALF-WIDTH katakana',
    adjective: 'ニュー',
    adjectiveGloss: 'new (ja, from English "new")',
  },
];

/** Look one sample up. Throws rather than returning `undefined`, so a caller
 * cannot silently test nothing. */
export function scriptSample(script: ScriptFamily): ScriptSample {
  const found = SCRIPT_CORPUS.find((entry) => entry.script === script);
  if (found === undefined) {
    throw new Error(`no corpus sample for script ${script}`);
  }
  return found;
}

/** Every script the corpus carries. */
export function corpusScripts(): ScriptFamily[] {
  return SCRIPT_CORPUS.map((entry) => entry.script);
}

/**
 * The marks-only variant of a script's noun.
 *
 * THROWS when the script has none, rather than returning `undefined` for a
 * caller to assert away. A `as string` at each call site would compile and would
 * make "this script has no pair to compare" read as a passing test; this makes
 * it a failure that names the script.
 */
export function scriptVariant(script: ScriptFamily): string {
  const { variant } = scriptSample(script);
  if (variant === undefined) {
    throw new Error(`corpus sample for ${script} carries no variant to compare against`);
  }
  return variant;
}
