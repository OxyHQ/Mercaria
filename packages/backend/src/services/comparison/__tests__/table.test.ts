/**
 * The machine comparison table (#96 §"Product comparison").
 *
 * The cases that matter are the ones where two answers are both plausible and
 * only one is honest: a missing fact against a fact that does not apply, two
 * sources disagreeing against nothing recorded, and a difference against a
 * tradeoff.
 */

import { describe, expect, it } from 'vitest';
import { COMMERCE_ROW_KEYS, resolveComparisonDirection } from '../policy.js';
import { buildComparisonTable } from '../table.js';
import { commerce, declared, eur, fact, numberValue, subject, unknownMoney } from './fixtures.js';

describe('the four cell states are kept apart', () => {
  it('an absent value in a DECLARED attribute is unknown, not not-applicable', () => {
    const table = buildComparisonTable([
      subject('p1', { declared: new Map([['warranty_months', declared()]]) }),
      subject('p2', {
        declared: new Map([['warranty_months', declared()]]),
        facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(24) })]]),
      }),
    ]);
    const row = table.rows.find((entry) => entry.key === 'warranty_months');
    expect(row?.cells.p1).toEqual({ state: 'unknown', reason: 'not_recorded' });
    expect(row?.cells.p2.state).toBe('source_backed');
  });

  it('an attribute the category does not declare is NOT APPLICABLE, never unknown', () => {
    // The distinction the issue asks for and the one most easily collapsed:
    // telling a shopper a desk chair's battery life is "unrecorded" invites
    // them to go looking for it.
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['battery_life_hours', declared()]]),
        facts: new Map([
          ['battery_life_hours', fact({ key: 'battery_life_hours', value: numberValue(12) })],
        ]),
      }),
      subject('p2', { declared: new Map() }),
    ]);
    const row = table.rows.find((entry) => entry.key === 'battery_life_hours');
    expect(row?.cells.p2).toEqual({
      state: 'not_applicable',
      reason: 'attribute_out_of_category',
    });
  });

  it('a declared but non-comparable attribute is not-applicable for its own reason', () => {
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['marketing_blurb', declared({ comparable: false })]]),
        facts: new Map([['marketing_blurb', fact({ key: 'marketing_blurb' })]]),
      }),
      subject('p2', { declared: new Map([['marketing_blurb', declared({ comparable: false })]]) }),
    ]);
    const row = table.rows.find((entry) => entry.key === 'marketing_blurb');
    expect(row?.cells.p1).toEqual({
      state: 'not_applicable',
      reason: 'attribute_not_comparable',
    });
  });

  it('two disagreeing sources produce a CONFLICTING cell carrying both', () => {
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['ram_capacity', declared()]]),
        facts: new Map([
          [
            'ram_capacity',
            fact({
              key: 'ram_capacity',
              state: 'conflicting',
              candidates: [numberValue(8, 'GB'), numberValue(16, 'GB')],
            }),
          ],
        ]),
      }),
      subject('p2', { declared: new Map([['ram_capacity', declared()]]) }),
    ]);
    const row = table.rows.find((entry) => entry.key === 'ram_capacity');
    expect(row?.cells.p1.state).toBe('conflicting');
    if (row?.cells.p1.state === 'conflicting') {
      expect(row.cells.p1.candidates.map((value) => value.rendered)).toEqual(['8 GB', '16 GB']);
    }
    // A conflicting cell states NO fact, so the row does not "differ" on it.
    expect(row?.differs).toBe(false);
  });

  it('a fact stored under a different unit is refused rather than converted', () => {
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['screen_size', declared({ unit: 'mm' })]]),
        facts: new Map([
          ['screen_size', fact({ key: 'screen_size', unit: 'mm', value: numberValue(170, 'mm') })],
        ]),
      }),
      subject('p2', {
        declared: new Map([['screen_size', declared({ unit: 'mm' })]]),
        facts: new Map([
          ['screen_size', fact({ key: 'screen_size', unit: 'in', value: numberValue(6.7, 'in') })],
        ]),
      }),
    ]);
    const row = table.rows.find((entry) => entry.key === 'screen_size');
    expect(row?.cells.p2).toEqual({ state: 'unknown', reason: 'unit_not_comparable' });
  });
});

describe('a larger number is not always better', () => {
  it('an unclassified attribute is `not_comparable` and produces a DIFFERENCE, not a tradeoff', () => {
    // The default, and the case the whole `policy.ts` argument is about: a
    // heavier laptop is not an improvement, and nothing declared a direction
    // for `weight_grams`.
    expect(resolveComparisonDirection('weight_grams')).toBe('not_comparable');

    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['weight_grams', declared()]]),
        facts: new Map([['weight_grams', fact({ key: 'weight_grams', value: numberValue(1200, 'g') })]]),
      }),
      subject('p2', {
        declared: new Map([['weight_grams', declared()]]),
        facts: new Map([['weight_grams', fact({ key: 'weight_grams', value: numberValue(1600, 'g') })]]),
      }),
    ]);

    expect(table.tradeoffs.some((entry) => entry.rowKey === 'weight_grams')).toBe(false);
    const difference = table.differences.find((entry) => entry.rowKey === 'weight_grams');
    expect(difference?.values).toEqual({ p1: '1200 g', p2: '1600 g' });
  });

  it('a DECLARED direction produces a tradeoff naming the better subject', () => {
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['warranty_months', declared()]]),
        facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(12) })]]),
      }),
      subject('p2', {
        declared: new Map([['warranty_months', declared()]]),
        facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(36) })]]),
      }),
    ]);
    const tradeoff = table.tradeoffs.find((entry) => entry.rowKey === 'warranty_months');
    expect(tradeoff?.betterSubjectRef).toBe('p2');
    expect(tradeoff?.direction).toBe('higher_is_better');
    // …and it is NOT also reported as a plain difference, which would render it twice.
    expect(table.differences.some((entry) => entry.rowKey === 'warranty_months')).toBe(false);
  });

  it('a lower-is-better direction inverts the tradeoff', () => {
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['charging_time', declared()]]),
        facts: new Map([['charging_time', fact({ key: 'charging_time', value: numberValue(90, 'min') })]]),
      }),
      subject('p2', {
        declared: new Map([['charging_time', declared()]]),
        facts: new Map([['charging_time', fact({ key: 'charging_time', value: numberValue(45, 'min') })]]),
      }),
    ]);
    expect(
      table.tradeoffs.find((entry) => entry.rowKey === 'charging_time')?.betterSubjectRef,
    ).toBe('p2');
  });

  it('a RANGE that differs is a difference and never a tradeoff', () => {
    // "6.1 to 6.7 in" is not one point on a scale, so picking an end to order
    // by would be an inference the cell never declared.
    const range = {
      type: 'range' as const,
      lower: 6.1,
      upper: 6.7,
      unit: 'in',
      rendered: '6.1–6.7 in',
    };
    const other = { ...range, lower: 5.4, upper: 6.1, rendered: '5.4–6.1 in' };
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['warranty_months', declared()]]),
        facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: range })]]),
      }),
      subject('p2', {
        declared: new Map([['warranty_months', declared()]]),
        facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: other })]]),
      }),
    ]);
    expect(table.tradeoffs.some((entry) => entry.rowKey === 'warranty_months')).toBe(false);
    expect(table.differences.some((entry) => entry.rowKey === 'warranty_months')).toBe(true);
  });
});

describe('the commerce rows', () => {
  it('every commerce row is present and in policy order', () => {
    const table = buildComparisonTable([subject('p1'), subject('p2')]);
    expect(table.rows.slice(0, COMMERCE_ROW_KEYS.length).map((row) => row.key)).toEqual(
      COMMERCE_ROW_KEYS,
    );
  });

  it('a withheld offers half makes every commerce cell unknown, never zero', () => {
    const table = buildComparisonTable([
      subject('p1', { commerce: commerce({ served: false }) }),
      subject('p2'),
    ]);
    for (const key of COMMERCE_ROW_KEYS) {
      const row = table.rows.find((entry) => entry.key === key);
      expect(row?.cells.p1).toEqual({ state: 'unknown', reason: 'definition_not_published' });
    }
  });

  it('an unknown lowest total is an unknown cell rather than a zero', () => {
    const table = buildComparisonTable([
      subject('p1', { commerce: commerce({ lowestKnownTotal: unknownMoney('component_missing') }) }),
      subject('p2'),
    ]);
    const row = table.rows.find((entry) => entry.key === 'known_total');
    expect(row?.cells.p1).toEqual({ state: 'unknown', reason: 'not_recorded' });
  });

  it('the cheaper subject wins the price tradeoff', () => {
    const table = buildComparisonTable([
      subject('p1', { commerce: commerce({ lowestItemPrice: eur(29900) }) }),
      subject('p2', { commerce: commerce({ lowestItemPrice: eur(24900) }) }),
    ]);
    const tradeoff = table.tradeoffs.find((entry) => entry.rowKey === 'offer_price');
    expect(tradeoff?.betterSubjectRef).toBe('p2');
    expect(tradeoff?.betterValue.rendered).toBe('249.00 EUR');
  });
});

describe('determinism', () => {
  it('the same subjects in a different order produce the same rows and tradeoffs', () => {
    const first = subject('p1', {
      declared: new Map([['warranty_months', declared()]]),
      facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(12) })]]),
      commerce: commerce({ lowestItemPrice: eur(20000) }),
    });
    const second = subject('p2', {
      declared: new Map([['warranty_months', declared()]]),
      facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(24) })]]),
      commerce: commerce({ lowestItemPrice: eur(30000) }),
    });

    const forwards = buildComparisonTable([first, second]);
    const backwards = buildComparisonTable([second, first]);

    expect(forwards.rows.map((row) => row.key)).toEqual(backwards.rows.map((row) => row.key));
    expect(forwards.tradeoffs.map((entry) => `${entry.rowKey}:${entry.betterSubjectRef}`)).toEqual(
      backwards.tradeoffs.map((entry) => `${entry.rowKey}:${entry.betterSubjectRef}`),
    );
  });

  it('two subjects at the same magnitude produce no tradeoff at all', () => {
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([['warranty_months', declared()]]),
        facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(24) })]]),
      }),
      subject('p2', {
        declared: new Map([['warranty_months', declared()]]),
        facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(24) })]]),
      }),
    ]);
    expect(table.tradeoffs.some((entry) => entry.rowKey === 'warranty_months')).toBe(false);
  });
});
