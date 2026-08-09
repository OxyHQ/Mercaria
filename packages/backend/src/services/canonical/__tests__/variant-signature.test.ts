/**
 * The deterministic variant signature (#56 variant rule 6).
 *
 * The fixtures deliberately differ in the ONE way the signature must ignore
 * (option order) and in the ways it must not (a different value, a missing axis,
 * an extra axis). A suite whose fixtures were all in the same order could not
 * tell an order-independent digest from one that simply concatenates.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultVariantSignature,
  normalizeAttributeKey,
  normalizeOptionValue,
  variantSignature,
} from '../variant-signature.js';

describe('variantSignature', () => {
  it('is identical for the same options in different display orders', () => {
    const colourFirst = variantSignature([
      { key: 'color', normalizedValue: 'black titanium' },
      { key: 'storage', normalizedValue: '256000000000B' },
    ]);
    const storageFirst = variantSignature([
      { key: 'storage', normalizedValue: '256000000000B' },
      { key: 'color', normalizedValue: 'black titanium' },
    ]);
    expect(colourFirst).toBe(storageFirst);
  });

  it('folds the attribute key so a source that shouted an axis still matches', () => {
    const folded = variantSignature([{ key: 'Storage', normalizedValue: '256000000000B' }]);
    const plain = variantSignature([{ key: ' storage ', normalizedValue: '256000000000B' }]);
    expect(folded).toBe(plain);
  });

  it('differs when a VALUE differs', () => {
    const black = variantSignature([{ key: 'color', normalizedValue: 'black titanium' }]);
    const white = variantSignature([{ key: 'color', normalizedValue: 'white titanium' }]);
    expect(black).not.toBe(white);
  });

  it('differs when an axis is MISSING or EXTRA', () => {
    const both = variantSignature([
      { key: 'color', normalizedValue: 'black' },
      { key: 'storage', normalizedValue: '256000000000B' },
    ]);
    const onlyColour = variantSignature([{ key: 'color', normalizedValue: 'black' }]);
    const threeAxes = variantSignature([
      { key: 'color', normalizedValue: 'black' },
      { key: 'storage', normalizedValue: '256000000000B' },
      { key: 'region', normalizedValue: 'eu' },
    ]);
    expect(both).not.toBe(onlyColour);
    expect(both).not.toBe(threeAxes);
  });

  it('cannot be confused by a value containing the key of another axis', () => {
    // A naive `key + value` concatenation without a separator makes
    // {a: "bc"} and {ab: "c"} hash the same. The unit separator is what stops
    // that, and this is the fixture pair that would catch its removal.
    const first = variantSignature([{ key: 'ab', normalizedValue: 'c' }]);
    const second = variantSignature([{ key: 'a', normalizedValue: 'bc' }]);
    expect(first).not.toBe(second);
  });

  it('is a sha-256 hex digest, which the column CHECK also demands', () => {
    const signature = variantSignature([{ key: 'color', normalizedValue: 'black' }]);
    expect(signature).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses two values for one axis', () => {
    // Hashing it would make the result depend on which the caller listed first,
    // which is precisely the order dependence this function removes.
    expect(() =>
      variantSignature([
        { key: 'storage', normalizedValue: '256000000000B' },
        { key: 'Storage', normalizedValue: '512000000000B' },
      ]),
    ).toThrow(/assigned twice/u);
  });

  it('refuses an empty attribute key', () => {
    expect(() => variantSignature([{ key: '  ', normalizedValue: 'x' }])).toThrow(/empty/u);
  });

  it('gives the default variant a stable signature of the empty option set', () => {
    expect(defaultVariantSignature()).toBe(variantSignature([]));
    expect(defaultVariantSignature()).toMatch(/^[0-9a-f]{64}$/u);
    // And it is NOT the signature of a variant that carries an axis, which is
    // what keeps `UNIQUE(product_id, signature)` from making the default collide
    // with a real configuration.
    expect(defaultVariantSignature()).not.toBe(
      variantSignature([{ key: 'color', normalizedValue: '' }]),
    );
  });
});

describe('the normalizers the signature reads through', () => {
  it('folds case and collapses whitespace, and nothing more', () => {
    expect(normalizeAttributeKey('  Storage ')).toBe('storage');
    expect(normalizeOptionValue('  Black   Titanium ')).toBe('black titanium');
    // "Black" and "Blackout" must stay different: no stemming, no prefix
    // matching, no cleverness that could merge two real colours.
    expect(normalizeOptionValue('Black')).not.toBe(normalizeOptionValue('Blackout'));
  });
});
