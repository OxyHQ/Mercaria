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

/**
 * A pair of REAL words that differ ONLY in a combining mark, in the script's own
 * orthography — the fixture a mark-eating fold collapses.
 *
 * Separate from {@link ScriptSample.variant}, which is overloaded: it is a
 * marks-only pair for Devanagari and Bengali, a CASING pair for Cyrillic, a
 * half-width pair for Katakana and a precomposed/decomposed pair for Latin. That
 * overload is why `MARK_BEARING` in `text-fold-script-behaviour.test.ts` was a
 * hand-written list of the two scripts whose `variant` happened to be the right
 * shape — and a hand-maintained map is exactly what let #854 sit unmeasured for
 * a week inside the gate built to catch its family.
 *
 * With the pair named explicitly, `MARK_BEARING` is DERIVED from the corpus, so
 * adding one here extends every fold's assertion rather than requiring somebody
 * to remember a second list.
 *
 * ## Composed marks and precomposed ones are different fixtures
 *
 * Devanagari `साइकिलें` carries its matras as separate `Mn`/`Mc` codepoints in
 * NFC, so `\p{M}` sees them without normalising. Cyrillic `мой` does NOT: `й` is
 * the single precomposed codepoint U+0439 and only decomposes to `и` + U+0306
 * under NFD. Both are mark-bearing pairs and a fold can eat either, but only the
 * first can be asserted on with a `\p{M}` test of the INPUT — which is why the
 * mechanism assertion and the distinctness assertion are separate, and why
 * Cyrillic contributes to one and not the other.
 */
export interface ScriptMarkPair {
  /** The member carrying the mark. */
  readonly marked: string;
  /** What {@link marked} means, in English. */
  readonly markedGloss: string;
  /**
   * The member without it — a DIFFERENT real word, not a misspelling. That is
   * the whole point: a fold that removes the mark does not merely lose
   * decoration, it returns the other word.
   */
  readonly unmarked: string;
  /** What {@link unmarked} means, in English. */
  readonly unmarkedGloss: string;
}

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
  /**
   * Two real words differing ONLY in a combining mark, or `undefined` where the
   * script has no such pair. See {@link ScriptMarkPair}.
   *
   * `text-fold-script-behaviour.test.ts` derives its mark-bearing script list
   * from the presence of this field, so adding one extends every fold's
   * assertion.
   */
  readonly markPair: ScriptMarkPair | undefined;
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
    // NONE, and the absence is the point rather than an omission: `café` and
    // `cafe` are a mark pair that folds are SUPPOSED to collapse. A markPair
    // asserts two words stay APART, so recording one here would assert the
    // opposite of what accent folding is for.
    markPair: undefined,
  },
  {
    script: 'Arabic',
    noun: 'دراجة',
    nounGloss: 'bicycle (ar)',
    variant: undefined,
    variantGloss: undefined,
    adjective: 'جديد',
    adjectiveGloss: 'new (ar)',
    // Arabic diacritics (harakat) are optional and virtually never written in
    // product copy, so a pair differing only in them would be a fixture nobody
    // types. The hazard Arabic carries is #832's, not #830's.
    markPair: undefined,
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
    markPair: {
      marked: 'বইগুলি',
      markedGloss: 'books (bn) — carries the ু vowel sign',
      unmarked: 'বই',
      unmarkedGloss: 'book (bn)',
    },
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
    /**
     * `мой` / `мои` — #854's own pair, and the fixture this corpus was missing.
     *
     * `й` is U+0439, a PRECOMPOSED codepoint that decomposes to `и` + U+0306
     * (combining breve) — inside the `U+0300–U+036F` block a Latin accent fold
     * strips. It is not `и` with decoration: it is its own letter of the Russian
     * alphabet, and `мой` (my, masc. sg.) and `мои` (my, pl.) are two words.
     *
     * Two consequences follow from it being PRECOMPOSED, and they are why this
     * entry bites one assertion and not the other. `\p{M}` does not match either
     * member as written, so the mechanism assertion — "a mark came out the other
     * side" — has nothing to look at and skips it. What catches a fold here is
     * DISTINCTNESS: the two words must not land on one string.
     *
     * Cyrillic was in this corpus from the start and its `variant` slot went to
     * the CASING pair, for #832's `[A-Z]` reasoning. That is why the mark-eating
     * gate could not see #854 — not because Cyrillic was missing, but because
     * the one variant slot was already spent.
     */
    markPair: {
      marked: 'мой',
      markedGloss: 'my (ru, masculine singular) — the й carries U+0306 under NFD',
      unmarked: 'мои',
      unmarkedGloss: 'my (ru, plural) — a DIFFERENT word, spelled with и',
    },
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
    markPair: {
      marked: 'साइकिलें',
      markedGloss: 'bicycles (hi) — carries the ें matra',
      unmarked: 'साइकिल',
      unmarkedGloss: 'bicycle (hi)',
    },
  },
  {
    script: 'Han',
    noun: '自行车',
    nounGloss: 'bicycle (zh-Hans)',
    variant: undefined,
    variantGloss: undefined,
    adjective: '全新',
    adjectiveGloss: 'brand new (zh-Hans)',
    /** Han carries no combining marks at all. */
    markPair: undefined,
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
    /**
     * Precomposed like Cyrillic's: `じ` is U+3058 and decomposes to `し` +
     * U+3099. The dakuten is NOT in the Latin block, so a fold stripping only
     * `U+0300–U+036F` leaves it alone — but one stripping every `\p{M}` eats it,
     * and #838 measured `strip_diacritics:1` doing exactly that and returning
     * `してんしゃ`, a different and meaningless word. That defect has its own
     * named case below; recording the pair here extends the same protection to
     * every OTHER fold, none of which had it.
     */
    markPair: {
      marked: 'じてんしゃ',
      markedGloss: 'bicycle (ja) — じ is し plus the dakuten U+3099 under NFD',
      unmarked: 'してんしゃ',
      unmarkedGloss: 'a different, meaningless word — what #838 measured coming back',
    },
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
    // The Hiragana entry already carries the dakuten pair; a katakana twin would
    // measure the same codepoint through the same folds.
    markPair: undefined,
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

/**
 * Every script carrying a {@link ScriptMarkPair} — the mark-eating gate's
 * subjects, DERIVED rather than listed.
 *
 * `text-fold-script-behaviour.test.ts` held this as a two-element literal, and
 * #854 is what that cost: `normalizeCatalogAlias` and `foldPhrase` sat in its
 * mark-PRESERVING register for a week claiming a property they do not have,
 * because the only scripts they were measured against were the two somebody had
 * written down. A fold cannot be wrong about a script nobody asked it about.
 */
export function markBearingScripts(): ScriptFamily[] {
  return SCRIPT_CORPUS.filter((entry) => entry.markPair !== undefined).map((entry) => entry.script);
}

/**
 * One script's mark pair.
 *
 * THROWS when the script has none, for {@link scriptVariant}'s reason: a caller
 * that received `undefined` would assert it away and read as a passing test.
 */
export function scriptMarkPair(script: ScriptFamily): ScriptMarkPair {
  const { markPair } = scriptSample(script);
  if (markPair === undefined) {
    throw new Error(`corpus sample for ${script} carries no mark pair`);
  }
  return markPair;
}
