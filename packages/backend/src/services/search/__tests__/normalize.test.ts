/**
 * Query normalization (#70 "Query normalization" 1–7).
 *
 * Every case here is one of the issue's numbered requirements, and each fixture
 * is chosen to be one the UN-normalized and normalized forms disagree about —
 * an already-lowercase ASCII query cannot tell a folding normalizer from an
 * identity function.
 */

import { describe, expect, it } from 'vitest';
import {
  escapeLikePattern,
  isDiscriminatingToken,
  normalizeSearchQuery,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MAX_TOKENS,
} from '../normalize.js';

describe('normalizeSearchQuery', () => {
  it('folds unicode, case and punctuation (#70 normalization 1 and 2)', () => {
    // Mixed case AND accents AND punctuation in one fixture, because a query
    // that is already lowercase, unaccented and unpunctuated passes an identity
    // function just as happily as a normalizer.
    expect(normalizeSearchQuery('Nestlé — CAFÉ, Instant!').normalized).toBe('nestle cafe instant');
  });

  it('folds COMPATIBILITY forms, which the write path deliberately does not', () => {
    // NFKC, not NFC: a full-width keyboard produces these and a merchant's
    // catalogue never contains them, so the fold has to happen on the QUERY.
    expect(normalizeSearchQuery('ｉＰｈｏｎｅ　１６').normalized).toBe('iphone 16');
  });

  it('keeps a model token whole and marks it discriminating (#70 normalization 3)', () => {
    const query = normalizeSearchQuery('Sony WH-1000XM5 headphones');
    expect(query.tokens).toContain('wh');
    expect(query.tokens).toContain('1000xm5');
    expect(query.discriminatingTokens).toContain('1000xm5');
    // `wh` is two characters with no digit — it carries no discriminating power
    // and an overlap on it would return an arbitrary page of the catalogue.
    expect(query.discriminatingTokens).not.toContain('wh');
  });

  it('reads an identifier-like string as every scheme it validly is (#70 normalization 4)', () => {
    // A real EAN-13 with a correct check digit. It is ALSO a valid ISBN-13,
    // which is why the contract is a list rather than one answer.
    const query = normalizeSearchQuery('9780132350884');
    const schemes = query.identifiers.map((identifier) => identifier.scheme).sort();
    expect(schemes).toContain('ean');
    expect(schemes).toContain('isbn13');
    expect(query.identifierOnly).toBe(true);
    // Every GTIN-family reading collapses onto the same 14-digit canonical form,
    // which is what makes ONE indexed lookup answer all of them.
    const canonical = new Set(
      query.identifiers.flatMap((identifier) =>
        identifier.canonicalValue === undefined ? [] : [identifier.canonicalValue],
      ),
    );
    expect([...canonical]).toEqual(['09780132350884']);
  });

  it('reads a hyphenated barcode, because that is how people paste one', () => {
    const query = normalizeSearchQuery('978-0-13-235088-4');
    expect(query.identifiers.length).toBeGreaterThan(0);
    expect(query.identifierOnly).toBe(true);
  });

  it('refuses a mistyped barcode rather than guessing (#70 normalization 4)', () => {
    // The same number with a wrong final check digit. A search is not an
    // identifier assertion, so this is simply a query that will not resolve
    // deterministically and falls through to the lexical stages.
    const query = normalizeSearchQuery('9780132350885');
    expect(query.identifiers).toEqual([]);
    expect(query.identifierOnly).toBe(false);
  });

  it('is not identifier-only when the barcode has words beside it', () => {
    const query = normalizeSearchQuery('ean 9780132350884');
    expect(query.identifiers.length).toBeGreaterThan(0);
    expect(query.identifierOnly).toBe(false);
  });

  it('never classifies ordinary prose as an identifier', () => {
    // The guard that makes `identifierOnly` usable at all: `mpn` and
    // `brand_model` accept essentially any string, so including them would make
    // every single-word query "identifier only" and switch fuzzy retrieval off
    // for the whole catalogue.
    expect(normalizeSearchQuery('headphones').identifiers).toEqual([]);
    expect(normalizeSearchQuery('sony').identifierOnly).toBe(false);
  });

  it('bounds the query and the token count', () => {
    const long = `${'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 100)}`;
    expect(normalizeSearchQuery(long).bounded.length).toBe(SEARCH_QUERY_MAX_LENGTH);

    const many = Array.from({ length: SEARCH_QUERY_MAX_TOKENS + 10 }, (_, index) => `w${index}`).join(
      ' ',
    );
    expect(normalizeSearchQuery(many).tokens.length).toBe(SEARCH_QUERY_MAX_TOKENS);
  });

  it('answers an empty normalization for input with no letters or digits', () => {
    const query = normalizeSearchQuery('  --- !!! ');
    expect(query.normalized).toBe('');
    expect(query.tokens).toEqual([]);
    expect(query.prefixEligible).toBe(false);
  });

  it('marks a short query as prefix-INELIGIBLE', () => {
    // Below three characters there is no trigram, so a `LIKE 'ab%'` is a
    // sequential scan of the product table on the hottest read path.
    expect(normalizeSearchQuery('ab').prefixEligible).toBe(false);
    expect(normalizeSearchQuery('abc').prefixEligible).toBe(true);
  });
});

describe('isDiscriminatingToken', () => {
  it('accepts anything with a digit and long words, and refuses short filler', () => {
    expect(isDiscriminatingToken('a2560')).toBe(true);
    expect(isDiscriminatingToken('16')).toBe(true);
    expect(isDiscriminatingToken('titanium')).toBe(true);
    expect(isDiscriminatingToken('pro')).toBe(false);
    expect(isDiscriminatingToken('max')).toBe(false);
  });

  it('refuses a listed filler word even when it is long', () => {
    expect(isDiscriminatingToken('para')).toBe(false);
  });
});

describe('escapeLikePattern', () => {
  it('makes a wildcard the shopper typed a literal', () => {
    // `100%` must find products whose name starts with "100%", not every
    // product whose name starts with "100".
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('escapes the escape character FIRST', () => {
    // Order is load-bearing: escaping `%` before `\` would leave the backslash
    // added by the first pass to be escaped by the second, doubling it.
    expect(escapeLikePattern('a\\%b')).toBe('a\\\\\\%b');
  });
});
