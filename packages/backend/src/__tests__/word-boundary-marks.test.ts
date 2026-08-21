/**
 * Word-boundary predicates and combining marks (#836).
 *
 * #830 was a TOKENIZER eating marks, and #834/#838 fixed that everywhere by
 * moving the character class to `@mercaria/shared-types`' {@link wordTokens}.
 * #836 is the other shape the same class takes: a PREDICATE asking "is the
 * character on each side of this match a word character". `\p{L}` excludes
 * combining marks, so a mark answers "no" and opens a boundary that is not
 * there.
 *
 * ## The two sites are repaired differently, and that is the finding
 *
 * The issue reported both as one shape and asked whoever took it to check
 * whether the repair is symmetrical. Measured, it is not, and the discriminator
 * is which way a match points:
 *
 * | Site | A match means | A mark-opened boundary produces | Repair |
 * |---|---|---|---|
 * | `search-intent/dictionaries.ts` | SELECT: add a category filter or an attribute requirement | a filter the shopper did not ask for | add `\p{M}` |
 * | `attributes/marketing-claims.ts` | REFUSE: reject a promotional sentence as a spec value | one visible refusal an author can answer | leave it, and pin it |
 *
 * Adding `\p{M}` to the refusing site would move every changed case from refuse
 * to accept, which is an evasion: one invisible mark and a marketing sentence
 * enters an objective specification. Each module's own docblock carries its
 * measurement; this file is where both directions are asserted, so changing
 * either decision means deleting an assertion rather than editing a class.
 *
 * ## The population is DERIVED from the shared corpus
 *
 * A hand-written list of "words with marks in them" is the habit #833 already
 * found failing — 21 of 22 normalization test files held no non-Latin character
 * at all. The mid-word fragments below are computed from {@link SCRIPT_CORPUS},
 * so a locale added tomorrow brings its own cases with no edit here, and the
 * floor names how many the corpus can currently produce.
 */
import { describe, expect, it } from 'vitest';

import { isMarketingClaim, matchedMarketingPhrase } from '../services/attributes/marketing-claims.js';
import { containsFoldedPhrase, foldPhrase } from '../services/search-intent/dictionaries.js';
import { SCRIPT_CORPUS, scriptSample } from './script-corpus.js';

const MARK = /\p{M}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** One corpus word, and a fragment of it that begins immediately after a mark. */
interface MidWordFragment {
  readonly script: string;
  readonly word: string;
  readonly gloss: string;
  /** The word as the dictionaries space stores it. */
  readonly folded: string;
  /** A tail of {@link folded} whose preceding character is a combining mark. */
  readonly fragment: string;
  /**
   * Where {@link fragment} starts in {@link folded}.
   *
   * Recorded rather than re-derived with `indexOf`, because a one-character
   * fragment can also occur EARLIER in the same word at a position that is a
   * legitimate boundary — Bengali `নতুন` ends in `ন` and also begins with it.
   * `indexOf` finds the legitimate occurrence and would make the mid-word
   * property assert something true of the wrong index.
   */
  readonly at: number;
}

/**
 * Every corpus word that can produce a mid-word fragment, and the fragment.
 *
 * "Mid-word" is the whole point: the fragment is a strict, non-initial suffix of
 * a single word, so a predicate that matches it has matched inside a word — the
 * exact thing `containsPhrase`'s boundary check exists to refuse, and the thing
 * it already refuses in Latin.
 */
function midWordFragments(): MidWordFragment[] {
  const found: MidWordFragment[] = [];
  for (const sample of SCRIPT_CORPUS) {
    const words: readonly (readonly [string | undefined, string | undefined])[] = [
      [sample.noun, sample.nounGloss],
      [sample.variant, sample.variantGloss],
      [sample.adjective, sample.adjectiveGloss],
    ];
    for (const [word, gloss] of words) {
      if (word === undefined) continue;
      const folded = foldPhrase(word);
      const characters = [...folded];
      for (let index = 0; index < characters.length - 1; index += 1) {
        if (!MARK.test(characters[index])) continue;
        const rest = characters.slice(index + 1);
        if (MARK.test(rest[0]) || !LETTER_OR_DIGIT.test(rest[0])) continue;
        found.push({
          script: sample.script,
          word,
          gloss: gloss ?? '(no gloss)',
          folded,
          fragment: rest.join(''),
          at: characters.slice(0, index + 1).join('').length,
        });
        break;
      }
    }
  }
  return found;
}

describe('dictionaries: a combining mark is part of the word it sits on (#836)', () => {
  it('refuses a fragment that begins immediately after a mark, in every script that has one', () => {
    const refused: string[] = [];
    const matched: string[] = [];
    for (const item of midWordFragments()) {
      const where = `${item.script}: ${item.fragment} inside ${item.word} (${item.gloss})`;
      if (containsFoldedPhrase(item.folded, item.fragment)) matched.push(where);
      else refused.push(where);
    }
    // Named rather than counted, so a regression says which script came back.
    expect(matched).toEqual([]);
    expect(refused.length).toBe(midWordFragments().length);
  });

  it('still matches each of those words as a whole — the positive control', () => {
    // Without this the assertion above is satisfied by a predicate that matches
    // nothing at all, which is the cheapest possible green.
    for (const item of midWordFragments()) {
      expect(
        containsFoldedPhrase(item.folded, item.folded),
        `${item.script}: ${item.word} must still match itself`,
      ).toBe(true);
    }
  });

  it('the corpus can actually produce these cases — the vacuity floor', () => {
    // A floor on the FIXTURES, not on the defect: its cheapest green is a corpus
    // that still carries mark-bearing words, never "leave the bug in". Counts
    // measured on the corpus as it stands; both are `>=` so a locale added later
    // widens the population without conflicting here.
    const fragments = midWordFragments();
    const scripts = new Set(fragments.map((item) => item.script));
    expect(fragments.length).toBeGreaterThanOrEqual(6);
    expect(scripts.size).toBeGreaterThanOrEqual(4);
    // Every fragment must genuinely sit MID-WORD behind a mark, or the case
    // above proves nothing: a fragment that is the whole word, or one whose
    // preceding character is an ordinary letter, would be refused (or matched)
    // for reasons that have nothing to do with #836.
    for (const item of fragments) {
      expect(item.folded.slice(item.at)).toBe(item.fragment);
      expect(item.at).toBeGreaterThan(0);
      expect(
        MARK.test(item.folded.slice(item.at - 1, item.at)),
        `${item.script}: ${item.fragment} must be preceded by a combining mark`,
      ).toBe(true);
    }
  });

  it('Latin produces no such case, because the fold removes its marks first', () => {
    // The reason the Latin control was already correct before #836, stated as a
    // measurement rather than an assumption: `foldPhrase` strips U+0300–U+036F,
    // so no Latin combining mark survives to reach the boundary test at all.
    const latin = scriptSample('Latin');
    for (const word of [latin.noun, latin.variant, latin.adjective]) {
      if (word === undefined) continue;
      expect(MARK.test(foldPhrase(word)), `${word} must fold to a mark-free string`).toBe(false);
    }
    expect(midWordFragments().some((item) => item.script === 'Latin')).toBe(false);
  });

  it('leaves the Latin behaviour the docblock promises exactly as it was', () => {
    const latin = scriptSample('Latin');
    // `nuevo` inside `renuevo` is not a claim about condition.
    expect(containsFoldedPhrase(foldPhrase(`re${latin.adjective}`), foldPhrase(latin.adjective))).toBe(
      false,
    );
    // The same word standing alone is.
    expect(
      containsFoldedPhrase(foldPhrase(`${latin.noun} ${latin.adjective}`), foldPhrase(latin.adjective)),
    ).toBe(true);
    // `16gb` matches inside `16gb/512gb` — the reason the boundary is letters
    // and digits rather than whitespace.
    expect(containsFoldedPhrase(foldPhrase('16gb/512gb'), foldPhrase('16gb'))).toBe(true);
  });

  it('still matches a mark-bearing word standing as its own word', () => {
    // The direction the repair must NOT break: adding `\p{M}` closes boundaries,
    // so a phrase separated by a space has to keep matching or every Hindi and
    // Bengali category alias stops resolving.
    const devanagari = scriptSample('Devanagari');
    const bengali = scriptSample('Bengali');
    expect(
      containsFoldedPhrase(
        foldPhrase(`${devanagari.adjective} ${devanagari.noun}`),
        foldPhrase(devanagari.noun),
      ),
      `${devanagari.noun} (${devanagari.nounGloss}) must match as its own word`,
    ).toBe(true);
    expect(
      containsFoldedPhrase(foldPhrase(`${bengali.adjective} ${bengali.noun}`), foldPhrase(bengali.noun)),
      `${bengali.noun} (${bengali.nounGloss}) must match as its own word`,
    ).toBe(true);
  });

  it('treats a trailing matra the way Latin treats a trailing letter', () => {
    // `साइकिलें` against the alias `साइकिल` is the one true positive the repair
    // removes, and removing it is the point: Latin already refuses `bicycles`
    // against `bicycle`, and two scripts answering one question differently is
    // what #836 is.
    const devanagari = scriptSample('Devanagari');
    const latin = scriptSample('Latin');
    expect(
      containsFoldedPhrase(foldPhrase(devanagari.variant ?? ''), foldPhrase(devanagari.noun)),
    ).toBe(false);
    expect(containsFoldedPhrase(foldPhrase(`${latin.adjective}s`), foldPhrase(latin.adjective))).toBe(
      false,
    );
  });
});

describe('marketing-claims: a mark reads as a boundary, deliberately (#836)', () => {
  // The phrase is one known-present entry of the lexicon, not an alternation:
  // an alternation passes as long as ANY member survives, which is a control
  // that cannot fail for the reason it is there.
  const PHRASE = 'revolutionary';

  it('the lexicon still carries the phrase these cases are built on', () => {
    expect(matchedMarketingPhrase(PHRASE)).toBe(PHRASE);
  });

  it('refuses the phrase, and does not refuse it inside a longer word', () => {
    expect(isMarketingClaim(`${PHRASE} design`)).toBe(true);
    expect(isMarketingClaim(`x${PHRASE}x`)).toBe(false);
    expect(isMarketingClaim(`${PHRASE}1`)).toBe(false);
    expect(isMarketingClaim('nvme storage')).toBe(false);
  });

  it('keeps refusing the phrase when a combining mark is glued to it', () => {
    // Each of these ACCEPTS if `\p{M}` is added to `isWordCharacter`, which is
    // why the repair was refused here: the cheapest way to make this test green
    // after such a change is to delete it.
    const glued: readonly (readonly [string, string])[] = [
      ['U+0301 combining acute', `${PHRASE}́`],
      ['U+093E devanagari matra', `${PHRASE}ा`],
      ['U+09C7 bengali vowel sign', `${PHRASE}ে`],
      ['U+3099 katakana-hiragana voiced mark', `${PHRASE}゙`],
      ['U+0650 arabic kasra', `${PHRASE}ِ`],
      ['U+0301 leading', `́${PHRASE}`],
    ];
    for (const [label, value] of glued) {
      expect(isMarketingClaim(value), `${label} must still be refused`).toBe(true);
    }
    expect(glued.length).toBeGreaterThanOrEqual(6);
  });

  it('loses no detection on a script whose marks are structural', () => {
    // The trade the decision rests on: there is no matching under-detection,
    // because every lexicon phrase is Latin and every non-Latin sample here is
    // made of `\p{L}` characters, which close the boundary correctly.
    for (const sample of SCRIPT_CORPUS) {
      if (sample.script === 'Latin') continue;
      expect(
        isMarketingClaim(`${sample.noun}${PHRASE}`),
        `${sample.script} glued before ${PHRASE} must not read as a claim`,
      ).toBe(false);
      expect(
        isMarketingClaim(`${PHRASE}${sample.noun}`),
        `${sample.script} glued after ${PHRASE} must not read as a claim`,
      ).toBe(false);
    }
    expect(SCRIPT_CORPUS.length).toBeGreaterThanOrEqual(7);
  });
});
