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

/**
 * The COMPOSITION, which neither half above establishes (#367 Workstream 18,
 * "reject duplicate normalized combinations").
 *
 * `normalizeAxisValue` is proven to fold and `typedVariantSignature` is proven
 * to refuse an unfolded value, and both were proven separately. What nobody
 * drove is the sentence the box actually asks for: **`Black` and `black ` are
 * one combination**. Two correct halves compose into that only if the caller
 * puts them in the right order, and the order is not checkable from either half.
 *
 * ## What this reaches, and what it deliberately does not
 *
 * ORDER-differing duplicates are covered end to end at three grains by
 * `__tests__/vertical-e2e/vertical-matrix-and-new-product.e2e.realdb.test.ts`.
 * NORMALIZATION-differing duplicates cannot be driven at those grains today, and
 * the reason is structural rather than an omission: every seeded variant axis is
 * `controlled_value`, so an answer is an ENUM VALUE ID and
 * `attribute_enum_values.value` is already `lower(btrim(...))` by CHECK — there
 * is no spelling for one enum answer to differ from another in case or space.
 * `draft.service.ts`'s `normalizedAxisValue` folds the `text` and `number`
 * branches for the free-text axes a product type MAY declare, and no seeded
 * vertical declares one. So this is the grain where the composition is
 * expressible at all.
 *
 * `authoring-validation.test.ts`'s duplicate-signature case does not cover it
 * either, and should not be counted for it: the `axisSignature` there is a
 * hand-supplied literal and the validator never computes one, so that case can
 * catch a DETECTOR regression and can never catch a normalization or an ordering
 * one.
 */
describe('a duplicate that differs only in normalization is one combination', () => {
  /** What a free-text axis answer becomes on the way to the digest. */
  const answered = (raw: string) => ({
    attributeDefinitionId: COLOR,
    normalizedValue: normalizeAxisValue(raw),
  });

  it('collapses onto ONE signature across case and surrounding and interior space', () => {
    const spellings = ['Black Titanium', 'black titanium', '  BLACK TITANIUM  ', 'Black   Titanium'];
    const digests = new Set(spellings.map((raw) => typedVariantSignature([answered(raw)])));
    expect({ spellings: spellings.length, digests: digests.size }).toEqual({
      spellings: spellings.length,
      digests: 1,
    });

    // The sensitivity control, in the same shape: the fold is not collapsing
    // everything. Without it a `normalizeAxisValue` that returned a constant
    // would satisfy the assertion above.
    expect(typedVariantSignature([answered('Blue Titanium')])).not.toBe(
      typedVariantSignature([answered('Black Titanium')]),
    );
  });

  it('is the ORDER of the two steps that makes it true, not either step alone', () => {
    // Fold-then-digest is one signature; digest-without-folding is not a
    // signature at all. Stated as a THROW rather than as a different digest,
    // because the second is what a caller who reversed the two steps would get
    // — and it is the failure mode `typedVariantSignature` asserts against
    // instead of papering over.
    expect(() =>
      typedVariantSignature([{ attributeDefinitionId: COLOR, normalizedValue: 'Black Titanium' }]),
    ).toThrow(/not normalized/u);
  });

  it('holds for a MULTI-axis combination, where the duplicate would actually collide', () => {
    // One axis proves the fold; a real duplicate is a whole combination. Two
    // axes, each spelled differently, still reach one digest — and the axes are
    // listed in opposite ORDERS too, so the case covers both properties at once
    // rather than assuming order-independence carries over.
    const first = [
      { attributeDefinitionId: COLOR, normalizedValue: normalizeAxisValue('Black Titanium') },
      { attributeDefinitionId: STORAGE, normalizedValue: normalizeAxisValue('256 GB') },
    ];
    const second = [
      { attributeDefinitionId: STORAGE, normalizedValue: normalizeAxisValue('  256   gb ') },
      { attributeDefinitionId: COLOR, normalizedValue: normalizeAxisValue('BLACK titanium') },
    ];
    expect(typedVariantSignature(second)).toBe(typedVariantSignature(first));
  });
});
