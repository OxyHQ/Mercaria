/**
 * The normalization vocabulary — pure functions, pinned value by value.
 *
 * The one behavioural claim that matters most here is DELIBERATE COLLAPSE:
 * "Apple" and "Apple Inc." normalizing to the same string is the intended
 * candidate-generation behaviour, and the reason it is safe is that nothing
 * merges on it — that half of acceptance criterion 1 is pinned against the
 * real database in `canonical-graph.realdb.test.ts`; this file pins the
 * collapse itself so a "fix" that stops the collapse is caught as loudly as
 * one that starts merging.
 */

import { describe, expect, it } from 'vitest';
import { foldAccents, wordTokens } from '@mercaria/shared-types';
import {
  normalizeAliasLookup,
  normalizeDomain,
  normalizeEntityName,
  slugFromName,
} from '../normalization.js';

describe('normalizeEntityName', () => {
  it('lowercases, trims and collapses punctuation to single spaces', () => {
    expect(normalizeEntityName('  Ray-Ban  ')).toBe('ray ban');
    expect(normalizeEntityName('Procter & Gamble')).toBe('procter gamble');
    expect(normalizeEntityName("L'Oréal")).toBe('l oreal');
  });

  it('folds accents', () => {
    expect(normalizeEntityName('Nestlé')).toBe('nestle');
    expect(normalizeEntityName('Müller')).toBe('muller');
    expect(normalizeEntityName('Ñandú')).toBe('nandu');
  });

  it('strips trailing legal suffixes, including punctuated and stacked ones', () => {
    expect(normalizeEntityName('Apple Inc.')).toBe('apple');
    expect(normalizeEntityName('Apple, Inc.')).toBe('apple');
    expect(normalizeEntityName('Samsung Electronics Co., Ltd.')).toBe('samsung electronics');
    expect(normalizeEntityName('Nike Inc Ltd')).toBe('nike');
    expect(normalizeEntityName('Zara S.A.')).toBe('zara');
  });

  it('collapses "Apple" and "Apple Inc." — the intended candidate grouping', () => {
    expect(normalizeEntityName('Apple')).toBe(normalizeEntityName('Apple Inc.'));
  });

  it('strips legal forms only from the END of the name', () => {
    // "co" mid-name is part of the name, not a legal form.
    expect(normalizeEntityName('Co-op Market')).toBe('co op market');
    expect(normalizeEntityName('Inc Magazine')).toBe('inc magazine');
  });

  it('never strips a name down to nothing', () => {
    // A brand that IS a legal-form word keeps it.
    expect(normalizeEntityName('Limited')).toBe('limited');
    expect(normalizeEntityName('Co Ltd')).toBe('co ltd');
  });

  it('returns the empty string only for content-free input', () => {
    expect(normalizeEntityName('!!!')).toBe('');
    expect(normalizeEntityName('   ')).toBe('');
    expect(normalizeEntityName('---')).toBe('');
  });
});

describe('normalizeAliasLookup', () => {
  it('matches the generated normalized_alias column: lower(btrim(...)) and nothing more', () => {
    expect(normalizeAliasLookup('  Ray-Ban  ')).toBe('ray-ban');
    // Deliberately NOT the deep normalization — punctuation survives, exactly
    // as it does in the database's generated column.
    expect(normalizeAliasLookup('Apple Inc.')).toBe('apple inc.');
  });
});

describe('normalizeDomain', () => {
  it('strips scheme, path, query, port and a leading www', () => {
    expect(normalizeDomain('https://www.Apple.com/es/shop?x=1')).toBe('apple.com');
    expect(normalizeDomain('http://apple.com:8080/x')).toBe('apple.com');
    expect(normalizeDomain('WWW.EXAMPLE.CO.UK')).toBe('example.co.uk');
    expect(normalizeDomain('shop.example.com')).toBe('shop.example.com');
  });

  it('refuses what carries no registrable host', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('-bad-.com')).toBeNull();
  });
});

describe('slugFromName', () => {
  it('derives a URL-safe slug, keeping legal suffixes', () => {
    // "Apple Inc." the organization must NOT collide with "apple" the brand by
    // default — the suffix stays in the slug.
    expect(slugFromName('Apple Inc.')).toBe('apple-inc');
    expect(slugFromName('Ñandú S.A.')).toBe('nandu-s-a');
  });

  it('returns null when nothing sluggable remains', () => {
    expect(slugFromName('!!!')).toBeNull();
  });
});

describe('foldAccents', () => {
  it('removes Latin combining marks and nothing else', () => {
    expect(foldAccents('Nestlé Müller Ñ')).toBe('Nestle Muller N');
  });

  it('leaves a mark alone when its base is not a Latin letter (#830)', () => {
    // `й` decomposes to `и` + U+0306 and `ジ` to `シ` + U+3099. An
    // unconditional strip of the combining block returned a DIFFERENT LETTER
    // for the first and, once the token class ate the orphan, a split word for
    // the second.
    expect(foldAccents('красный')).toBe('красный');
    expect(foldAccents('ジャンク')).toBe('ジャンク');
    expect(foldAccents('साइकिल')).toBe('साइकिल');
  });

  it('returns NFC, so one word has one spelling (#830)', () => {
    // The trap in fixing the strip: stop deleting marks without recomposing and
    // the composed and decomposed spellings of a word become different byte
    // sequences that never compare equal — an invisible non-match replacing a
    // visible corruption.
    const composed = 'ジャンク';
    const decomposed = composed.normalize('NFD');
    // The premise: these two really are different strings going in. Without
    // this the equality below could hold because nothing differed.
    expect(decomposed).not.toBe(composed);
    expect(foldAccents(decomposed)).toBe(foldAccents(composed));
    expect(foldAccents(decomposed)).toBe(foldAccents(decomposed).normalize('NFC'));
  });
});

describe('wordTokens', () => {
  it('keeps combining marks inside a word (#830)', () => {
    // `\p{L}` EXCLUDES marks, so `[^\p{L}\p{N}]` turned Indic vowel signs —
    // `Mn`/`Mc` — into spaces. This is the line the whole issue turns on.
    expect(wordTokens('साइकिल')).toEqual(['साइकिल']);
    expect(wordTokens('সাইকেল')).toEqual(['সাইকেল']);
  });

  it('still splits on punctuation and whitespace', () => {
    expect(wordTokens('ray-ban  sunglasses')).toEqual(['ray', 'ban', 'sunglasses']);
    expect(wordTokens('procter & gamble')).toEqual(['procter', 'gamble']);
  });

  it('drops a token carrying no letter or digit', () => {
    // Marks are kept by the CLASS, so a stray combining mark would otherwise
    // become a token of its own and break `normalizeEntityName`'s documented
    // "empty only for content-free input" contract.
    expect(wordTokens('!!!')).toEqual([]);
    expect(wordTokens('   ')).toEqual([]);
    expect(wordTokens('\u0301')).toEqual([]);
  });
});

describe('script integrity (#830)', () => {
  // Four of Mercaria's twelve catalogue languages did not survive the canonical
  // name fold. The failure mattered because `normalized_name` is the space #53
  // generates MERGE CANDIDATES in: two distinct Hindi listings collapsing to one
  // string is a false merge, which looks exactly like a correct match and is
  // found by a customer.
  const SCRIPTS: ReadonlyArray<readonly [string, string, string]> = [
    ['Hindi', 'साइकिल', 'स इक ल'],
    ['Hindi plural', 'साइकिलें', 'स इक ल'],
    ['Bengali', 'সাইকেল', 'স ইক ল'],
    ['Japanese', 'ジャンク', 'シ ャンク'],
    ['Japanese 2', 'パソコン', 'ハ ソコン'],
    ['Russian', 'красный', 'красныи'],
    ['Russian yo', 'ёлка', 'елка'],
  ];

  it('returns each word unchanged apart from case', () => {
    for (const [language, input] of SCRIPTS) {
      expect(normalizeEntityName(input), `${language} moved`).toBe(input);
    }
  });

  it('no longer returns the corrupt string measured on the issue', () => {
    // Named explicitly rather than implied by the assertion above: these exact
    // strings are what the pre-fix function produced, so this fails loudly and
    // recognisably if any part of the fold is reverted.
    for (const [language, input, before] of SCRIPTS) {
      expect(normalizeEntityName(input), `${language} regressed`).not.toBe(before);
    }
  });

  it('two different Hindi words no longer collide', () => {
    const singular = normalizeEntityName('साइकिल');
    const plural = normalizeEntityName('साइकिलें');
    expect(singular).not.toBe(plural);
    // Not merely different: two DIFFERENT corruptions would also pass that.
    expect(singular).toBe('साइकिल');
    expect(plural).toBe('साइकिलें');
  });

  it('keeps the Latin fold working — the control', () => {
    // The control is what makes the four failures specific rather than an
    // artefact of the harness, and it is the thing a careless fix breaks: the
    // point was never to stop folding, only to stop folding other scripts'
    // letters.
    expect(normalizeEntityName('Nestlé')).toBe('nestle');
    expect(normalizeEntityName('Müller')).toBe('muller');
    expect(normalizeEntityName('Ñandú')).toBe('nandu');
    expect(normalizeEntityName('état')).toBe('etat');
    // Latin inflection must still NOT collide, or "no collision" above would be
    // satisfied by a fold that had simply stopped folding anything.
    expect(normalizeEntityName('bicicleta')).not.toBe(normalizeEntityName('bicicletas'));
  });

  it('scripts with no decomposable marks are untouched', () => {
    expect(normalizeEntityName('دراجة')).toBe('دراجة');
    expect(normalizeEntityName('自転車')).toBe('自転車');
  });

  it('normalizes composed and decomposed spellings to ONE string', () => {
    // The subtlety that makes preserving marks insufficient on its own: NFD
    // output would store a spelling that never matches the composed one a
    // shopper types.
    for (const [language, input] of SCRIPTS) {
      const decomposed = input.normalize('NFD');
      expect(normalizeEntityName(decomposed), `${language} composed vs decomposed`).toBe(
        normalizeEntityName(input),
      );
    }
    // The premise, asserted rather than assumed: at least one of those inputs
    // really does decompose, or the loop compares identical strings and proves
    // nothing.
    expect(SCRIPTS.some(([, input]) => input.normalize('NFD') !== input)).toBe(true);
  });

  it('still strips legal suffixes and still refuses content-free input', () => {
    // The rest of the contract, unchanged by #830.
    expect(normalizeEntityName('Apple Inc.')).toBe('apple');
    expect(normalizeEntityName('Limited')).toBe('limited');
    expect(normalizeEntityName('!!!')).toBe('');
  });
});
