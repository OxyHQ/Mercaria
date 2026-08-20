/**
 * The catalog-alias comparison space (#732).
 *
 * Two properties, and the second is the one that would rot silently.
 *
 * 1. **The normalization is what a lookup compares.** `apply.ts` writes it,
 *    `catalogAliasCandidates` asks for it, and `interpretDeterministically`
 *    folds a stored row again before matching. Three places in one space, so a
 *    change here is a schema change on two Postgres indexes.
 * 2. **It agrees with `foldPhrase`, and is deliberately not an import of it.**
 *    `foldPhrase` defines the space the shipped DICTIONARIES are written in;
 *    this one defines a space `category_aliases_lookup_idx` and
 *    `product_type_aliases_lookup_idx` are built over. Coupling them by an
 *    import would make an edit to the dictionaries' folding a silent migration;
 *    coupling them by a TEST makes it a build failure with a paragraph beside
 *    it. Two normalizations that must agree and are not asserted to agree is
 *    the state this file exists to prevent.
 *
 * The fixtures are on both sides of every distinction each rule makes: an
 * accented pair whose folding is the whole point, a case pair, a whitespace
 * pair, and a token that folds to nothing at all.
 */

import { describe, expect, it } from 'vitest';
import { foldPhrase } from '../../search-intent/dictionaries.js';
import {
  MAX_CATALOG_ALIAS_WORDS,
  catalogAliasCandidates,
  normalizeCatalogAlias,
} from '../alias-normalization.js';

/** Written out rather than generated: a reader has to be able to check them. */
const SPELLINGS = [
  'móvil',
  'MÓVILES',
  'movil',
  '  Cell   Phone  ',
  'Smartphone',
  'Ordenador de sobremesa',
  'Ray-Ban',
  'Apple Inc.',
  'ÅNGSTRÖM',
  'الهاتف',
  '',
  '   ',
  '́',
];

describe('normalizeCatalogAlias', () => {
  it('folds accents, case and whitespace', () => {
    expect(normalizeCatalogAlias('MÓVILES')).toBe('moviles');
    expect(normalizeCatalogAlias('  Cell   Phone  ')).toBe('cell phone');
    // The distinction that matters: the accented and unaccented spellings are
    // ONE key, which is what makes a shopper typing either find the row.
    expect(normalizeCatalogAlias('móvil')).toBe(normalizeCatalogAlias('movil'));
  });

  it('leaves punctuation and non-Latin scripts alone', () => {
    // It is a FOLD, not a slug: `ray-ban` and `apple inc.` are how somebody
    // wrote them, and stripping punctuation would silently merge two aliases.
    expect(normalizeCatalogAlias('Ray-Ban')).toBe('ray-ban');
    expect(normalizeCatalogAlias('Apple Inc.')).toBe('apple inc.');
    expect(normalizeCatalogAlias('الهاتف')).toBe('الهاتف');
  });

  it('is idempotent', () => {
    for (const spelling of SPELLINGS) {
      expect(normalizeCatalogAlias(normalizeCatalogAlias(spelling))).toBe(
        normalizeCatalogAlias(spelling),
      );
    }
  });

  it('agrees with the dictionaries own folding, on every fixture', () => {
    // The pin the module header promises. If these ever diverge, a dictionary
    // phrase and a stored alias stop living in one space and the divergence is
    // invisible until an operator's row resolves for nobody.
    for (const spelling of SPELLINGS) {
      expect(normalizeCatalogAlias(spelling), `disagreed on ${JSON.stringify(spelling)}`).toBe(
        foldPhrase(spelling),
      );
    }
  });
});

describe('catalogAliasCandidates', () => {
  it('yields every contiguous run up to the bound, in both spellings', () => {
    const candidates = catalogAliasCandidates('un móvil barato');
    // The folded spelling — what every writer in this repository stores.
    expect(candidates).toContain('movil');
    expect(candidates).toContain('un movil');
    expect(candidates).toContain('movil barato');
    expect(candidates).toContain('un movil barato');
    // And the BARE `lower()` spelling, which is what a row somebody inserted by
    // hand most likely carries. Without it that row is an index entry and no
    // behaviour — the state #732 exists to end.
    expect(candidates).toContain('móvil');
    expect(candidates).toContain('un móvil');
  });

  it('stops at the word bound rather than truncating the set', () => {
    const words = ['a', 'b', 'c', 'd', 'e', 'f'];
    const candidates = catalogAliasCandidates(words.join(' '));
    expect(candidates).toContain(words.slice(0, MAX_CATALOG_ALIAS_WORDS).join(' '));
    expect(candidates).not.toContain(words.slice(0, MAX_CATALOG_ALIAS_WORDS + 1).join(' '));
    // Every run of every permitted size is present — a set that dropped the
    // tail would under-match, and an under-match looks exactly like an alias
    // nobody recorded.
    expect(candidates).toContain('f');
    expect(candidates).toContain('c d e f');
  });

  it('answers nothing for a query with no words', () => {
    expect(catalogAliasCandidates('   ')).toEqual([]);
    expect(catalogAliasCandidates('')).toEqual([]);
  });

  it('never yields an empty key, whatever folds away', () => {
    // A blank `normalized_alias` is refused by
    // `category_aliases_normalized_present_check`, so a blank CANDIDATE could
    // never match a row — but it would be an element in an `= ANY` that reads
    // as coverage. The combining mark folds to nothing and the bare spelling
    // keeps it, which is exactly the pair this asserts.
    const candidates = catalogAliasCandidates('́ movil');
    expect(candidates.every((candidate) => candidate.length > 0)).toBe(true);
    expect(candidates).toContain('movil');
  });

  it('deduplicates, so an ASCII query does not ask twice for one key', () => {
    const candidates = catalogAliasCandidates('mobile phone');
    expect(new Set(candidates).size).toBe(candidates.length);
    // Both spellings of an unaccented phrase are the same string, and asking
    // Postgres for it twice is the visible symptom of a set built by
    // concatenation rather than by a set.
    expect(candidates.filter((candidate) => candidate === 'mobile phone')).toHaveLength(1);
  });
});
