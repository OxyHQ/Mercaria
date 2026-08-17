/**
 * The product wizard's validation-finding router, executed (#469).
 *
 * ## Why a path parser, specifically
 *
 * This is the same class of code as the bug that motivated #469.
 * `parseComparisonSubjects` in the storefront trimmed a whole `?p=` entry
 * instead of each half, so a shared link kept a trailing space inside a handle
 * and would have 404'd — and `tsc`, ESLint, `expo export` and all five walls of
 * `validate:storefront-catalog` were green on it. A parser's defects are
 * BEHAVIOURAL: the code is well-typed, the shape is right, and the wrong branch
 * is taken.
 *
 * What is downstream of this one is a merchant's ability to fix their own
 * product. `parseFindingPath` decides which control a server complaint points
 * at and `stepForTarget` decides which wizard screen the error summary jumps
 * to. Route a finding to the wrong step and the merchant lands on a screen with
 * nothing wrong on it; route it to `unknown` and it lands on Review, attached to
 * no control — which the module's own docblock argues is still better than
 * dropping it, because "a finding nobody can see is a publish that fails for a
 * reason nobody is told". Both of those are silent, and neither is a shape a
 * scanning gate can check.
 *
 * ## The `unknown` branch is a REQUIREMENT, not a fallback
 *
 * A path is a string crossing a network. The cases below assert that an
 * unparseable one still produces a finding — pinned deliberately, because the
 * tempting simplification is to drop what cannot be placed.
 */

import { describe, expect, it } from 'vitest';
import type { AuthoringValidationFinding } from '@mercaria/shared-types';
import {
  WIZARD_STEPS,
  findingsForProductField,
  findingsForVariant,
  hasBlockingFinding,
  locateFindings,
  parseFindingPath,
  stepForTarget,
} from '../findings';

function finding(
  path: string,
  overrides: Partial<AuthoringValidationFinding> = {},
): AuthoringValidationFinding {
  return { code: 'required_field_missing', severity: 'error', path, ...overrides };
}

describe('parseFindingPath places a server complaint on a control', () => {
  it('reads both classification paths as the classification step', () => {
    expect(parseFindingPath('classification.categoryId')).toEqual({ kind: 'classification' });
    expect(parseFindingPath('classification.productType')).toEqual({ kind: 'classification' });
  });

  it('distinguishes the two listing fields rather than collapsing them', () => {
    expect(parseFindingPath('listing.title')).toEqual({ kind: 'listing', field: 'title' });
    expect(parseFindingPath('listing.description')).toEqual({
      kind: 'listing',
      field: 'description',
    });
  });

  it('reads a bare variants complaint as being about the set', () => {
    expect(parseFindingPath('variants')).toEqual({ kind: 'variants' });
  });

  it('reads a variant row, and its position, from the index', () => {
    expect(parseFindingPath('variants[0]')).toEqual({ kind: 'variant', position: 0, part: 'row' });
    expect(parseFindingPath('variants[12]')).toEqual({ kind: 'variant', position: 12, part: 'row' });
  });

  it('separates a variant price from its stock and from the row', () => {
    expect(parseFindingPath('variants[3].price')).toEqual({
      kind: 'variant',
      position: 3,
      part: 'price',
    });
    expect(parseFindingPath('variants[3].inventory')).toEqual({
      kind: 'variant',
      position: 3,
      part: 'inventory',
    });
  });

  it('reads an attribute on a variant as a variant FIELD, keeping both keys', () => {
    expect(parseFindingPath('variants[2].fields.shoe_size')).toEqual({
      kind: 'variant_field',
      position: 2,
      attributeKey: 'shoe_size',
    });
  });

  it('falls back to the ROW for a variant sub-path it does not know', () => {
    // Deliberate: the row exists and can be shown, so a complaint about some
    // future part of it still lands somewhere a merchant can act on.
    expect(parseFindingPath('variants[4].somethingNew')).toEqual({
      kind: 'variant',
      position: 4,
      part: 'row',
    });
  });

  it('reads a product-scope field, with no ordinal when it is not repeated', () => {
    expect(parseFindingPath('fields.material')).toEqual({
      kind: 'product_field',
      attributeKey: 'material',
      ordinal: null,
    });
  });

  it('reads the ordinal of a repeated product field', () => {
    expect(parseFindingPath('fields.material[2]')).toEqual({
      kind: 'product_field',
      attributeKey: 'material',
      ordinal: 2,
    });
    // Zero is an ordinal, not an absent one — the branch a falsy check breaks.
    expect(parseFindingPath('fields.material[0]')).toEqual({
      kind: 'product_field',
      attributeKey: 'material',
      ordinal: 0,
    });
  });

  it('accepts an attribute key with digits and underscores, not only letters', () => {
    expect(parseFindingPath('fields.screen_size_in')).toEqual({
      kind: 'product_field',
      attributeKey: 'screen_size_in',
      ordinal: null,
    });
  });

  it('reads anything under draft. as being about the draft', () => {
    expect(parseFindingPath('draft.status')).toEqual({ kind: 'draft' });
    expect(parseFindingPath('draft.schemaVersion')).toEqual({ kind: 'draft' });
  });

  it('answers unknown rather than guessing, and never throws', () => {
    for (const path of ['', 'nonsense', 'fields.', 'fields.Bad-Key', 'variants[]', 'listing.slug']) {
      expect(parseFindingPath(path).kind).toBe('unknown');
    }
  });
});

describe('stepForTarget sends the merchant to a screen that can fix it', () => {
  it('puts money and stock complaints on the pricing screen', () => {
    expect(stepForTarget(parseFindingPath('variants[0].price'))).toBe('pricing');
    expect(stepForTarget(parseFindingPath('variants[0].inventory'))).toBe('pricing');
  });

  it('puts a complaint about the ROW where the combinations are built', () => {
    expect(stepForTarget(parseFindingPath('variants[0]'))).toBe('variants');
    expect(stepForTarget(parseFindingPath('variants'))).toBe('variants');
    expect(stepForTarget(parseFindingPath('variants[0].fields.color'))).toBe('variants');
  });

  it('routes the remaining kinds to their own screens', () => {
    expect(stepForTarget(parseFindingPath('classification.categoryId'))).toBe('classification');
    expect(stepForTarget(parseFindingPath('fields.material'))).toBe('details');
    expect(stepForTarget(parseFindingPath('listing.title'))).toBe('listing');
  });

  it('sends what it could not place to Review rather than nowhere', () => {
    expect(stepForTarget(parseFindingPath('nonsense'))).toBe('review');
    expect(stepForTarget(parseFindingPath('draft.status'))).toBe('review');
  });

  it('only ever names a step the wizard actually presents', () => {
    // A step id that is not in WIZARD_STEPS is a summary link to nothing.
    for (const path of [
      'classification.categoryId',
      'fields.material',
      'listing.title',
      'variants',
      'variants[0]',
      'variants[0].price',
      'variants[0].fields.color',
      'draft.status',
      'nonsense',
    ]) {
      expect(WIZARD_STEPS).toContain(stepForTarget(parseFindingPath(path)));
    }
  });
});

describe('locating and filtering a server response', () => {
  const located = locateFindings([
    finding('fields.material'),
    finding('fields.material[1]'),
    finding('fields.colour_family', { severity: 'warning' }),
    finding('variants[0].price'),
    finding('variants[0].fields.color'),
    finding('variants[1]'),
    finding('utter nonsense', { severity: 'warning' }),
  ]);

  it('keeps every finding, including the one it could not place', () => {
    expect(located).toHaveLength(7);
    expect(located.filter((f) => f.target.kind === 'unknown')).toHaveLength(1);
  });

  it('carries the original path through, so the unplaceable one is still showable', () => {
    expect(located.map((f) => f.path)).toContain('utter nonsense');
  });

  it('matches a product field on the PATH, ordinals included', () => {
    // `attributeKey` is optional on the DTO; matching on it would drop the
    // findings of any producer that omits it.
    expect(findingsForProductField(located, 'material')).toHaveLength(2);
    expect(findingsForProductField(located, 'colour_family')).toHaveLength(1);
    expect(findingsForProductField(located, 'never_used')).toHaveLength(0);
  });

  it('collects both a variant row and its fields under one position', () => {
    expect(findingsForVariant(located, 0)).toHaveLength(2);
    expect(findingsForVariant(located, 1)).toHaveLength(1);
    expect(findingsForVariant(located, 9)).toHaveLength(0);
  });

  it('does not let a product-field finding leak into a variant position', () => {
    expect(findingsForVariant(located, 0).every((f) => f.target.kind !== 'product_field')).toBe(true);
  });

  it('blocks publication on an error and not on a warning alone', () => {
    expect(hasBlockingFinding(located)).toBe(true);
    expect(hasBlockingFinding(locateFindings([finding('fields.a', { severity: 'warning' })]))).toBe(
      false,
    );
    expect(hasBlockingFinding([])).toBe(false);
  });
});
