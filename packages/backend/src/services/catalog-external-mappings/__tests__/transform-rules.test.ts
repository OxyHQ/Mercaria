/**
 * The shipped transform rules (#367 Workstream 11).
 *
 * Every case here is a REFUSAL or an exact value, because the failure mode of a
 * normalization rule is not an exception — it is a plausible wrong number. A
 * rule that silently did nothing is how a magnitude in grams gets stored as
 * kilograms, and a rule that guessed a decimal convention is how `1,234` becomes
 * a thousand times what the source meant.
 */

import { describe, expect, it } from 'vitest';
import {
  applyExternalTransform,
  isTransformRuleRegistered,
  latestTransformRuleVersion,
} from '../transform-rules.js';

describe('an unregistered rule refuses and is never silently `identity`', () => {
  it('refuses a version that does not ship', () => {
    expect(isTransformRuleRegistered('identity', 2)).toBe(false);
    expect(applyExternalTransform('identity', 2, 'anything')).toEqual({
      outcome: 'refused',
      reason: 'rule_not_registered',
    });
  });

  it('the version a fresh mapping cites is one that ships', () => {
    const version = latestTransformRuleVersion('unit_magnitude_to_base');
    expect(isTransformRuleRegistered('unit_magnitude_to_base', version)).toBe(true);
  });
});

describe('the text rules', () => {
  it('`identity` changes nothing, including the case a lookup would fold', () => {
    expect(applyExternalTransform('identity', 1, '  Cor  ')).toEqual({
      outcome: 'normalized',
      value: '  Cor  ',
    });
  });

  it('`case_fold` and `collapse_whitespace` do exactly what they say', () => {
    expect(applyExternalTransform('case_fold', 1, '  Cor  ')).toEqual({
      outcome: 'normalized',
      value: 'cor',
    });
    expect(applyExternalTransform('collapse_whitespace', 1, ' a   b \t c ')).toEqual({
      outcome: 'normalized',
      value: 'a b c',
    });
  });

  it('`strip_diacritics` folds accents without destroying the letters', () => {
    expect(applyExternalTransform('strip_diacritics', 1, 'Algodón')).toEqual({
      outcome: 'normalized',
      value: 'algodon',
    });
  });

  it('`path_leaf` takes the last segment of every separator a feed uses', () => {
    for (const path of [
      'Apparel > Shoes > Sneakers',
      'Apparel/Shoes/Sneakers',
      'Apparel » Shoes » Sneakers',
      'Apparel|Shoes|Sneakers',
    ]) {
      expect(applyExternalTransform('path_leaf', 1, path)).toEqual({
        outcome: 'normalized',
        value: 'Sneakers',
      });
    }
  });

  it('a rule that empties its input REFUSES rather than storing an empty token', () => {
    // An empty normalized key would collide with every other empty one on the
    // lookup unique, so "the rule produced nothing" has to be a refusal.
    expect(applyExternalTransform('collapse_whitespace', 1, '   ')).toEqual({
      outcome: 'refused',
      reason: 'empty_result',
    });
    expect(applyExternalTransform('path_leaf', 1, ' > > ')).toEqual({
      outcome: 'refused',
      reason: 'empty_result',
    });
  });
});

describe('the numeric rules refuse rather than guessing', () => {
  it('resolves when BOTH separators are present, whichever convention', () => {
    expect(applyExternalTransform('decimal_separator_normalize', 1, '1.234,56')).toEqual({
      outcome: 'normalized',
      value: '1234.56',
    });
    expect(applyExternalTransform('decimal_separator_normalize', 1, '1,234.56')).toEqual({
      outcome: 'normalized',
      value: '1234.56',
    });
  });

  it('REFUSES the genuinely ambiguous three-digit tail', () => {
    // `1,234` is a thousand in one convention and 1.234 in the other, and
    // nothing in the token says which. Guessing here is off by three orders of
    // magnitude and looks entirely plausible downstream.
    expect(applyExternalTransform('decimal_separator_normalize', 1, '1,234')).toEqual({
      outcome: 'refused',
      reason: 'ambiguous_number',
    });
    expect(applyExternalTransform('decimal_separator_normalize', 1, '1.234')).toEqual({
      outcome: 'refused',
      reason: 'ambiguous_number',
    });
  });

  it('resolves an unambiguous tail', () => {
    expect(applyExternalTransform('decimal_separator_normalize', 1, '1,5')).toEqual({
      outcome: 'normalized',
      value: '1.5',
    });
    expect(applyExternalTransform('decimal_separator_normalize', 1, '12.25')).toEqual({
      outcome: 'normalized',
      value: '12.25',
    });
    expect(applyExternalTransform('decimal_separator_normalize', 1, '42')).toEqual({
      outcome: 'normalized',
      value: '42',
    });
  });

  it('refuses something that is not a number at all', () => {
    expect(applyExternalTransform('decimal_separator_normalize', 1, 'about 3')).toEqual({
      outcome: 'refused',
      reason: 'unparsed',
    });
  });
});

describe('`unit_magnitude_to_base` takes its unit from the SOURCE and nowhere else', () => {
  it('converts a magnitude into the family base unit', () => {
    // `length`'s base is `mm`, so 15.5 cm is 155.
    expect(applyExternalTransform('unit_magnitude_to_base', 1, '15.5 cm')).toEqual({
      outcome: 'normalized',
      value: '155',
    });
  });

  it('refuses a bare number — a unit is never inferred from a magnitude', () => {
    // #94 normalization rule 1. There is no parameter on this rule through which
    // an assumed unit could arrive, so the refusal is the only reachable answer.
    expect(applyExternalTransform('unit_magnitude_to_base', 1, '16')).toEqual({
      outcome: 'refused',
      reason: 'unparsed',
    });
  });

  it('refuses a unit token the canonical table does not know', () => {
    expect(applyExternalTransform('unit_magnitude_to_base', 1, '5 furlongs')).toEqual({
      outcome: 'refused',
      reason: 'unknown_unit',
    });
  });
});
