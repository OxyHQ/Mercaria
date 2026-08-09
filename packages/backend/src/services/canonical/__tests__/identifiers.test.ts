/**
 * Identifier validation and normalization (#56 identifier rules 1–4).
 *
 * Every check-digit case here carries BOTH a valid fixture and a fixture whose
 * check digit is wrong by one — the distinction the validator exists to make.
 * A suite of only-valid GTINs cannot tell a real check-digit routine from
 * `return true`, which is exactly the shape of check the mutation-testing rule
 * in AGENTS.md warns about.
 */

import { describe, expect, it } from 'vitest';
import { IDENTIFIER_SCHEMES, IDENTIFIER_SCHEME_REGISTRY } from '@mercaria/shared-types';
import {
  gs1CheckDigit,
  isbn10CheckCharacter,
  isbn10ToIsbn13,
  normalizeBrandScopedValue,
  normalizeIdentifier,
} from '../identifiers.js';

/** Flip the last digit so the value is well-formed and the check digit is wrong. */
function breakCheckDigit(value: string): string {
  const last = Number(value.slice(-1));
  return `${value.slice(0, -1)}${(last + 1) % 10}`;
}

describe('GS1 check digits', () => {
  it('computes the published check digit for each GTIN length', () => {
    // Payloads WITHOUT their check digit, against the digit GS1 publishes for
    // each of these well-known example numbers. Literal expectations, not a
    // re-derivation: a test that recomputed the value with the same function it
    // is checking would pass against any arithmetic at all.
    expect(gs1CheckDigit('9638507')).toBe(4); // GTIN-8  96385074
    expect(gs1CheckDigit('03600029145')).toBe(2); // GTIN-12 036000291452
    expect(gs1CheckDigit('400638133393')).toBe(1); // GTIN-13 4006381333931
    expect(gs1CheckDigit('1061414100041')).toBe(5); // GTIN-14 10614141000415
  });

  it('is position-anchored at the check digit, so a leading zero does not shift the weights', () => {
    // A GTIN-13 and the GTIN-14 that zero-pads it must carry the SAME check
    // digit. If the 3/1 alternation were anchored at the string's start instead
    // of at the check digit, padding would flip every weight and these would
    // disagree — which is the bug that makes a UPC and its GTIN-14 form look
    // like two different trade items.
    const body13 = '400638133393';
    const check = gs1CheckDigit(body13);
    expect(gs1CheckDigit(`0${body13}`)).toBe(check);
  });
});

describe('normalizeIdentifier — the GTIN family', () => {
  const cases: { scheme: 'gtin8' | 'upc' | 'ean' | 'gtin14'; value: string }[] = [
    { scheme: 'gtin8', value: '96385074' },
    { scheme: 'upc', value: '036000291452' },
    { scheme: 'ean', value: '4006381333931' },
    { scheme: 'gtin14', value: '10614141000415' },
  ];

  for (const { scheme, value } of cases) {
    it(`accepts a valid ${scheme} and normalizes it to a padded GTIN-14`, () => {
      const result = normalizeIdentifier(scheme, value);
      expect(result.kind).toBe('valid');
      if (result.kind !== 'valid') return;
      expect(result.identifier.normalizedValue).toBe(value);
      expect(result.identifier.canonicalScheme).toBe('gtin');
      expect(result.identifier.canonicalValue).toBe(value.padStart(14, '0'));
      expect(result.identifier.grain).toBe('variant');
    });

    it(`refuses a ${scheme} whose check digit is wrong by one`, () => {
      const result = normalizeIdentifier(scheme, breakCheckDigit(value));
      expect(result).toEqual({ kind: 'invalid', reason: 'bad_check_digit' });
    });
  }

  it('strips spaces and hyphens a source put in the value', () => {
    const spaced = normalizeIdentifier('ean', ' 4006-381 333931 ');
    expect(spaced.kind).toBe('valid');
    if (spaced.kind !== 'valid') return;
    expect(spaced.identifier.normalizedValue).toBe('4006381333931');
  });

  it('refuses a value of the wrong length and one that is not numeric', () => {
    expect(normalizeIdentifier('ean', '400638133393')).toEqual({
      kind: 'invalid',
      reason: 'wrong_length',
    });
    expect(normalizeIdentifier('ean', '400638133393X')).toEqual({
      kind: 'invalid',
      reason: 'non_numeric',
    });
    expect(normalizeIdentifier('ean', '   ')).toEqual({ kind: 'invalid', reason: 'empty' });
  });

  it('collapses a UPC and the EAN that pads to it into ONE canonical value', () => {
    // This is what the one-active-owner unique is taken over, so if these two
    // did not collapse, a UPC and its EAN form could name two different
    // variants without the database noticing.
    const upc = normalizeIdentifier('upc', '036000291452');
    const ean = normalizeIdentifier('ean', '0036000291452');
    expect(upc.kind).toBe('valid');
    expect(ean.kind).toBe('valid');
    if (upc.kind !== 'valid' || ean.kind !== 'valid') return;
    expect(upc.identifier.canonicalValue).toBe(ean.identifier.canonicalValue);
  });
});

describe('normalizeIdentifier — ISBN', () => {
  it('accepts a valid ISBN-10 with an X check character and converts it to ISBN-13', () => {
    expect(isbn10CheckCharacter('043942089')).toBe('X');
    expect(isbn10ToIsbn13('043942089X')).toBe('9780439420891');

    const result = normalizeIdentifier('isbn10', '0-439-42089-X');
    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.identifier.normalizedValue).toBe('043942089X');
    expect(result.identifier.canonicalValue).toBe('09780439420891');
  });

  it('refuses an ISBN-10 whose check character is wrong', () => {
    expect(normalizeIdentifier('isbn10', '0439420891')).toEqual({
      kind: 'invalid',
      reason: 'bad_check_digit',
    });
    expect(isbn10ToIsbn13('0439420891')).toBeNull();
  });

  it('refuses a 13-digit number outside the 978/979 range as an ISBN-13', () => {
    // A valid EAN-13 that is not a book. Recording it as an ISBN would file a
    // grocery item in a bibliographic index, so the prefix is checked BEFORE the
    // check digit is trusted to mean anything.
    const groceryEan = '4006381333931';
    expect(normalizeIdentifier('ean', groceryEan).kind).toBe('valid');
    expect(normalizeIdentifier('isbn13', groceryEan)).toEqual({
      kind: 'invalid',
      reason: 'not_an_isbn_prefix',
    });
  });

  it('accepts an ISBN-13 in range and lands it in the same GTIN space as its ISBN-10', () => {
    const fromTen = normalizeIdentifier('isbn10', '043942089X');
    const fromThirteen = normalizeIdentifier('isbn13', '9780439420891');
    expect(fromTen.kind).toBe('valid');
    expect(fromThirteen.kind).toBe('valid');
    if (fromTen.kind !== 'valid' || fromThirteen.kind !== 'valid') return;
    expect(fromTen.identifier.canonicalValue).toBe(fromThirteen.identifier.canonicalValue);
  });
});

describe('normalizeIdentifier — brand-scoped schemes', () => {
  it('folds case and whitespace on an MPN without stripping meaningful punctuation', () => {
    // A hyphen or a dot genuinely distinguishes manufacturer part numbers, so
    // over-normalizing here would merge two different parts into one product —
    // a wrong merge nobody notices, against a missed match review fixes.
    expect(normalizeBrandScopedValue('  mq-9t3  zd/a ')).toBe('MQ-9T3 ZD/A');
    const result = normalizeIdentifier('mpn', 'mq9t3zd/a');
    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.identifier.normalizedValue).toBe('MQ9T3ZD/A');
    expect(result.identifier.canonicalScheme).toBeUndefined();
    expect(result.identifier.requiresBrandScope).toBe(true);
    expect(result.identifier.grain).toBe('variant');
  });

  it('binds brand_model to the PRODUCT grain and demands brand scope', () => {
    const result = normalizeIdentifier('brand_model', 'iPhone 16 Pro');
    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.identifier.grain).toBe('product');
    expect(result.identifier.requiresBrandScope).toBe(true);
  });
});

describe('the identifier scheme registry', () => {
  it('defines every scheme the tuple names, and nothing else', () => {
    expect(Object.keys(IDENTIFIER_SCHEME_REGISTRY).sort()).toEqual([...IDENTIFIER_SCHEMES].sort());
    // Vacuity floor: a registry that lost its entries would still satisfy the
    // equality above if the tuple emptied with it.
    expect(IDENTIFIER_SCHEMES.length).toBeGreaterThanOrEqual(8);
  });

  it('has no scheme for a merchant SKU or a marketplace id (#56 acceptance 2)', () => {
    // The absence IS the guarantee: with no scheme, `assignIdentifier` has no
    // argument that could carry one, so a seller's private code cannot become a
    // global identity by any path through this module.
    const names = Object.keys(IDENTIFIER_SCHEME_REGISTRY).join(' ');
    expect(names).not.toMatch(/sku/iu);
    expect(names).not.toMatch(/asin/iu);
    expect(names).not.toMatch(/source/iu);
  });

  it('gives a canonical scheme to exactly the globally unique schemes', () => {
    for (const scheme of IDENTIFIER_SCHEMES) {
      const definition = IDENTIFIER_SCHEME_REGISTRY[scheme];
      expect(definition.canonicalScheme !== undefined).toBe(definition.globallyUnique);
      // And the converse pairing: a scheme that needs brand scope is exactly one
      // that is not globally unique. That equivalence is what lets the service
      // read one flag and refuse the right things.
      expect(definition.requiresBrandScope).toBe(!definition.globallyUnique);
    }
  });
});
