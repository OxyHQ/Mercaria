/**
 * The typed variant signature (#367 step 4, ADR 0007 D6).
 *
 * The property under test is the one the epic's acceptance scenario names:
 * "Two variants whose axes were entered in different orders must collide, by
 * construction." Everything else here exists so that property cannot be true by
 * accident — a function returning a constant would satisfy it perfectly.
 */

import { describe, expect, it } from 'vitest';
import { TYPED_VARIANT_SIGNATURE_PATTERN } from '@mercaria/shared-types';
import {
  defaultTypedVariantSignature,
  normalizeAxisValue,
  typedVariantSignature,
} from '../signature.js';

const COLOR = 'def_color_v1';
const STORAGE = 'def_storage_v1';
const SIZE = 'def_size_v1';

describe('order independence', () => {
  it('two orderings of one assignment set produce ONE digest', () => {
    const a = typedVariantSignature([
      { attributeDefinitionId: COLOR, normalizedValue: 'black titanium' },
      { attributeDefinitionId: STORAGE, normalizedValue: '256 gb' },
    ]);
    const b = typedVariantSignature([
      { attributeDefinitionId: STORAGE, normalizedValue: '256 gb' },
      { attributeDefinitionId: COLOR, normalizedValue: 'black titanium' },
    ]);
    expect(a).toBe(b);
  });

  it('and every permutation of three axes agrees', () => {
    const assignments = [
      { attributeDefinitionId: COLOR, normalizedValue: 'black' },
      { attributeDefinitionId: STORAGE, normalizedValue: '256 gb' },
      { attributeDefinitionId: SIZE, normalizedValue: 'm' },
    ];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const digests = new Set(
      permutations.map((order) =>
        typedVariantSignature(order.map((index) => assignments[index] as (typeof assignments)[0])),
      ),
    );
    expect(digests.size).toBe(1);
  });
});

describe('the digest actually depends on the input — the anti-constant control', () => {
  it('a different VALUE changes the digest', () => {
    expect(
      typedVariantSignature([{ attributeDefinitionId: COLOR, normalizedValue: 'black' }]),
    ).not.toBe(typedVariantSignature([{ attributeDefinitionId: COLOR, normalizedValue: 'blue' }]));
  });

  it('a different DEFINITION VERSION changes the digest', () => {
    // ADR 0007 D6 hashes the definition ID, and each row is one VERSION. The
    // consequence is stated rather than discovered: re-declaring a listing's
    // axis under a new version of `color` changes every one of its signatures,
    // which is why the axis row is frozen and a version bump is a new axis.
    expect(
      typedVariantSignature([{ attributeDefinitionId: 'def_color_v1', normalizedValue: 'black' }]),
    ).not.toBe(
      typedVariantSignature([{ attributeDefinitionId: 'def_color_v2', normalizedValue: 'black' }]),
    );
  });

  it('an ADDED axis changes the digest', () => {
    expect(
      typedVariantSignature([{ attributeDefinitionId: COLOR, normalizedValue: 'black' }]),
    ).not.toBe(
      typedVariantSignature([
        { attributeDefinitionId: COLOR, normalizedValue: 'black' },
        { attributeDefinitionId: SIZE, normalizedValue: 'm' },
      ]),
    );
  });

  it('the field and record separators cannot be forged from ordinary text', () => {
    // Without distinct separators, `{color: "a"} + {size: "b"}` and
    // `{colorsize: "ab"}` could serialize identically. The separators are ASCII
    // control characters precisely because a normalized value cannot contain one
    // — `normalizeAxisValue` only ever produces printable text.
    expect(
      typedVariantSignature([
        { attributeDefinitionId: 'a', normalizedValue: 'b' },
        { attributeDefinitionId: 'c', normalizedValue: 'd' },
      ]),
    ).not.toBe(typedVariantSignature([{ attributeDefinitionId: 'ac', normalizedValue: 'bd' }]));
  });
});

describe('the shape the column CHECK enforces', () => {
  it('is a sha-256 hex digest, for the empty set and for a populated one', () => {
    expect(defaultTypedVariantSignature()).toMatch(TYPED_VARIANT_SIGNATURE_PATTERN);
    expect(
      typedVariantSignature([{ attributeDefinitionId: COLOR, normalizedValue: 'black' }]),
    ).toMatch(TYPED_VARIANT_SIGNATURE_PATTERN);
  });

  it('the zero-axis signature is a real digest, not a special case', () => {
    // "Zero, one and many axes are all supported" (ADR 0007 D6). The empty set
    // gets an identity so `UNIQUE(listing_id, signature)` refuses a SECOND
    // axis-less variant on one listing — two variants that vary along nothing
    // are one variant.
    expect(defaultTypedVariantSignature()).toBe(typedVariantSignature([]));
    expect(defaultTypedVariantSignature()).not.toBe(
      typedVariantSignature([{ attributeDefinitionId: COLOR, normalizedValue: 'black' }]),
    );
  });
});

describe('what it refuses', () => {
  it('refuses one attribute assigned twice', () => {
    expect(() =>
      typedVariantSignature([
        { attributeDefinitionId: COLOR, normalizedValue: 'black' },
        { attributeDefinitionId: COLOR, normalizedValue: 'blue' },
      ]),
    ).toThrow(/assigned twice/);
  });

  it('refuses an unnormalized value rather than folding it silently', () => {
    // Folding here would let a caller store the RAW value in the column and the
    // FOLDED one in the digest, producing a row whose signature nothing can
    // recompute — invisible until two variants stop colliding.
    expect(() =>
      typedVariantSignature([{ attributeDefinitionId: COLOR, normalizedValue: 'Black' }]),
    ).toThrow(/not normalized/);
  });

  it('refuses an empty value and an empty definition id', () => {
    expect(() =>
      typedVariantSignature([{ attributeDefinitionId: COLOR, normalizedValue: '' }]),
    ).toThrow(/is empty/);
    expect(() =>
      typedVariantSignature([{ attributeDefinitionId: '  ', normalizedValue: 'black' }]),
    ).toThrow(/empty attribute definition id/);
  });
});

describe('normalizeAxisValue folds exactly what #56 folds, and nothing else', () => {
  it('collapses whitespace and case', () => {
    expect(normalizeAxisValue('  Black   Titanium ')).toBe('black titanium');
  });

  it('does NOT make two different words one', () => {
    expect(normalizeAxisValue('Black')).not.toBe(normalizeAxisValue('Blackout'));
  });
});
