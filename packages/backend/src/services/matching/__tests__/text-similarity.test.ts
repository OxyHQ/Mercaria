/**
 * Title tokenization — the matcher's view of a title's words.
 *
 * The claim under test is #830's second route. `normalized_name` is the space
 * merge CANDIDATES are generated in, but `titleTokens` is the space they are
 * SCORED in, and it carried its own copy of the `[^\p{L}\p{N}]` split. That
 * class drops combining marks, so `साइकिल` (bicycle) and `साइकिलें` (bicycles)
 * both tokenized to `['स','इक','ल']` — two distinct products scoring as
 * identical text. Fixing the stored name alone would have left that live.
 */

import { describe, expect, it } from 'vitest';
import { titleTokens } from '../text-similarity.js';

describe('titleTokens', () => {
  it('folds, lowercases, splits on punctuation and dedupes', () => {
    expect(titleTokens('Nestlé  NESTLE nestle')).toEqual(['nestle']);
    expect(titleTokens('Ray-Ban Aviator')).toEqual(['ray', 'ban', 'aviator']);
  });

  it('keeps an alphanumeric run whole', () => {
    // A model number is the most discriminating token a title has.
    expect(titleTokens('iPhone A2848 256GB')).toEqual(['iphone', 'a2848', '256gb']);
  });

  it('drops stopwords', () => {
    expect(titleTokens('bicicleta de montaña')).toEqual(['bicicleta', 'montana']);
  });

  it('keeps an Indic word whole (#830)', () => {
    expect(titleTokens('साइकिल')).toEqual(['साइकिल']);
    expect(titleTokens('সাইকেল')).toEqual(['সাইকেল']);
  });

  it('scores two different Hindi words as DIFFERENT text (#830)', () => {
    const singular = titleTokens('साइकिल');
    const plural = titleTokens('साइकिलें');
    expect(singular).not.toEqual(plural);
    // Not merely different — two different corruptions would also pass that.
    expect(singular).toEqual(['साइकिल']);
    expect(plural).toEqual(['साइकिलें']);
  });

  it('keeps a Japanese word whole rather than splitting on a voiced mark (#830)', () => {
    // `ジ` decomposes to `シ` + U+3099; the orphaned mark used to become a
    // space, so `janku` was scored as `shi anku`.
    expect(titleTokens('ジャンク')).toEqual(['ジャンク']);
  });

  it('does not substitute one Cyrillic letter for another (#830)', () => {
    expect(titleTokens('красный')).toEqual(['красный']);
    // `й` and `и` are distinct letters, so these two titles are distinct text.
    expect(titleTokens('мой')).not.toEqual(titleTokens('мои'));
  });

  it('tokenizes composed and decomposed spellings identically (#830)', () => {
    const composed = 'ジャンク PC';
    const decomposed = composed.normalize('NFD');
    // The premise: the two inputs really do differ, or the assertion is vacuous.
    expect(decomposed).not.toBe(composed);
    expect(titleTokens(decomposed)).toEqual(titleTokens(composed));
  });

  it('still separates a Latin singular from its plural — the control', () => {
    // Or "no collision" above would be satisfied by a tokenizer that had simply
    // stopped normalizing anything.
    expect(titleTokens('bicicleta')).not.toEqual(titleTokens('bicicletas'));
  });
});
