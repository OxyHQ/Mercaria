/**
 * The ONE definition of "what is part of a word" and "what is an accent" this
 * repository has (#830, fixed for the canonical graph in #834, extended to
 * every remaining site in #838).
 *
 * ## Why it lives in `@mercaria/shared-types`
 *
 * #834 put both functions in `packages/backend/src/services/canonical/normalization.ts`
 * and four backend call sites consumed them, which was the whole point: three
 * copies of one character class meant #830 was three bugs wearing one line.
 *
 * #838 then found the same class in a fold that is NOT in the backend —
 * {@link normalizeSourceConditionLabel} in `condition.ts`, one package down.
 * `@mercaria/shared-types` cannot import `@mercaria/backend` (the dependency
 * runs the other way), so the choice was a fifth private copy or moving the
 * authority to the package both sides can reach. A fifth copy is exactly how
 * #830 came back, so the authority moved. Nothing re-exports it: every consumer
 * imports it from here.
 *
 * These functions are pure, take no locale, touch no database and return
 * strings. Normalization exists for CANDIDATE GENERATION and LOOKUP KEYS;
 * nothing here decides that two things are the same thing.
 */

/** Any Unicode Mark — `Mn`, `Mc` or `Me`. See {@link wordTokens}. */
const UNICODE_MARK = /\p{M}/u;

/**
 * The Combining Diacritical Marks block — where LATIN accents decompose to.
 *
 * Deliberately not "every combining mark": U+3099 (the katakana voiced sound
 * mark) and the Indic vowel signs are marks too, and they carry a letter's worth
 * of meaning rather than decoration.
 */
const LATIN_COMBINING_DIACRITIC = /[\u0300-\u036f]/u;

/** A base character an accent may legitimately be folded off. */
const LATIN_LETTER = /\p{Script=Latin}/u;

/** A token has to carry at least one letter or digit to be a token. */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Fold accents off LATIN letters only, and return NFC. "Nestlé" → "Nestle".
 *
 * ## Why the fold is conditional (#830)
 *
 * The obvious spelling — NFD-decompose and drop every `U+0300–U+036F` — folds
 * more than accents, because that block is also where OTHER scripts' letters
 * keep their distinguishing marks. Measured: Cyrillic `й` decomposes to `и` +
 * U+0306, so the unconditional strip returned `красныи` for `красный`. That is
 * not an accent coming off, it is **a different letter**: `й` is its own letter
 * of the Russian alphabet, and folding it collides `мой` with `мои`.
 *
 * So a mark is dropped only when it is a Latin combining diacritic sitting on a
 * Latin base. Everything else survives.
 *
 * ## `ё` → `е` is REFUSED, deliberately
 *
 * Unlike `й`, this one is a plausible *desirable* fold: Russians routinely type
 * `е` for `ё`. It is refused anyway, because it is **a language's orthographic
 * convention and this function has no locale** — applying a Russian rule
 * globally from a function that cannot know which language it is looking at is
 * the exact class of decision that produced #830. If it is ever wanted it
 * belongs in a locale-aware layer that knows the text is Russian.
 *
 * The same reasoning refuses the Japanese dakuten, which #838 measured coming
 * off in `strip_diacritics`: `じ` is `し` plus U+3099, and removing it does not
 * take an accent off a letter, it yields a different, meaningless word.
 *
 * The asymmetry settles every case like it: **under-folding costs recall, which
 * routes a candidate to a human; over-folding costs precision, which is a false
 * merge a customer finds.** When in doubt, do not fold.
 *
 * ## Why the return value is NFC
 *
 * Decomposing without recomposing would leave callers storing NFD strings,
 * whose bytes differ from the composed spelling of the same word — so the two
 * spellings of one Japanese or Hindi name would stop comparing equal. That
 * trades a visible corruption for an invisible non-match, which is worse.
 * `normalization.test.ts` pins composed and decomposed inputs to one output.
 */
export function foldAccents(value: string): string {
  let folded = '';
  let base = '';
  for (const character of value.normalize('NFD')) {
    if (UNICODE_MARK.test(character)) {
      if (LATIN_COMBINING_DIACRITIC.test(character) && LATIN_LETTER.test(base)) continue;
      folded += character;
      continue;
    }
    base = character;
    folded += character;
  }
  return folded.normalize('NFC');
}

/**
 * Split text into word tokens — the ONE definition of "what is part of a word"
 * this repository has, and the fix for #830.
 *
 * ## Marks are part of a word
 *
 * The class is `[^\p{L}\p{N}\p{M}]`, and `\p{M}` is the whole point: `\p{L}`
 * **excludes combining marks**, so the obvious `[^\p{L}\p{N}]` turns Devanagari
 * and Bengali vowel signs — which are `Mn`/`Mc`, not letters — into SPACES.
 * Measured before the fix, `साइकिल` (bicycle) and `साइकिलें` (bicycles) both
 * came back as `"स इक ल"`, so two distinct Hindi listings collided on one
 * string. That is a false merge: it looks exactly like a correct match and is
 * discovered by a customer.
 *
 * ## Why this is exported rather than repeated
 *
 * #830 was three call sites each carrying their own copy of that class — the
 * canonical name fold, the catalogue-proposal search form and the matcher's
 * title tokenizer — so it was three bugs wearing one line. #838 found three
 * more, in three domains #830 never touched. A character class that decides
 * identity is one fact and it has one home; another copy is how this comes back.
 *
 * A token must carry at least one letter or digit, which keeps
 * `normalizeEntityName`'s "empty for input with no letters or digits" contract
 * true now that a lone mark is no longer discarded by the split.
 *
 * ## ZWNJ and ZWJ are `Cf`, not `M` (#837)
 *
 * U+200C and U+200D are FORMAT characters, so `\p{M}` does not cover them and
 * this splitter treats them as separators. That is deliberate and is the
 * conservative direction: a joiner splits a token in two rather than merging two
 * tokens into one, so the failure is recall (a human sees a candidate) and never
 * a false merge. Preserving them belongs to whoever needs Devanagari
 * conjunct-accurate tokenisation and can state which scripts it is for.
 */
export function wordTokens(value: string): string[] {
  return value
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((token) => HAS_LETTER_OR_DIGIT.test(token));
}
