/**
 * The cohort floor on geographic revenue — #1015 W6 requirement 9.
 *
 * The floor is driven AT, BELOW and ACROSS its edge, because a suppression rule
 * tested only well below its threshold passes with the comparison the wrong way
 * round. The control is the last test in the first block: a country at the floor is
 * NAMED, which is what proves the suppression is a threshold rather than a blanket.
 */

import { describe, expect, it } from 'vitest';
import {
  DIGITAL_GEOGRAPHIC_MIN_COHORT,
  DIGITAL_GEOGRAPHIC_MIN_POOLED_COUNTRIES,
  summariseGeographicRevenue,
} from '../geography.js';
import { repeat, sale } from './fact-builders.js';
import { assertEachOf } from '../../../../__tests__/assert-each-of.js';

const FLOOR = DIGITAL_GEOGRAPHIC_MIN_COHORT;

describe('#1015 W6 r9 — a country is named only at or above the cohort floor', () => {
  it('a country BELOW the floor is not named at all', () => {
    const summary = summariseGeographicRevenue([
      ...repeat(FLOOR - 1, () => sale({ supplyCountry: 'LU' })),
    ]);
    expect(summary.countries).toEqual([]);
    expect(summary.withheld.countryCount).toBe(1);
    expect(summary.withheld.saleCount).toBe(FLOOR - 1);
  });

  it('a country AT the floor is named — the control', () => {
    // Without this, a `summariseGeographicRevenue` that named nothing ever would
    // pass every other assertion in this file.
    const summary = summariseGeographicRevenue([
      ...repeat(FLOOR, () => sale({ supplyCountry: 'LU', grossAmount: 100 })),
    ]);
    expect(summary.countries).toHaveLength(1);
    expect(summary.countries[0]).toMatchObject({ country: 'LU', saleCount: FLOOR });
    expect(summary.countries[0].amounts).toEqual([
      { currency: 'EUR', grossAmount: 100 * FLOOR, creatorEarningsAmount: 2_250 * FLOOR },
    ]);
  });

  it('the floor counts SALES, not revenue — one large sale is still a cohort of one', () => {
    const summary = summariseGeographicRevenue([
      sale({ supplyCountry: 'LU', grossAmount: 50_000_00 }),
    ]);
    expect(summary.countries).toEqual([]);
    expect(summary.withheld.saleCount).toBe(1);
  });

  it('it suppresses, it does not round — a below-floor country has no row to read', () => {
    const summary = summariseGeographicRevenue([
      ...repeat(FLOOR + 2, () => sale({ supplyCountry: 'ES' })),
      ...repeat(3, () => sale({ supplyCountry: 'LU' })),
    ]);
    expect(summary.countries.map((country) => country.country)).toEqual(['ES']);
    // No "LU: under 10" row. Rounding a 3 to "under 10" still says somebody was
    // there, which on a one-product shop plus a month is a person.
    expect(JSON.stringify(summary.countries)).not.toContain('LU');
  });
});

describe('#1015 W6 r9 — the withheld pool is itself a cohort before it discloses money', () => {
  it('one withheld country can never reach the pool floor — the implication, stated', () => {
    // The largest a one-country pool can be: every country in the pool is below
    // the per-country floor by construction, so the most a single withheld country
    // contributes is FLOOR - 1 sales, which fails the pool's own sale floor first.
    // This is why `DIGITAL_GEOGRAPHIC_MIN_POOLED_COUNTRIES` cannot fire on its own
    // today, and the assertion is what would notice if the two floors diverged.
    const summary = summariseGeographicRevenue([
      ...repeat(FLOOR + 5, () => sale({ supplyCountry: 'ES' })),
      ...repeat(FLOOR - 1, () => sale({ supplyCountry: 'LU' })),
    ]);
    expect(summary.withheld.countryCount).toBe(1);
    expect(summary.withheld.saleCount).toBe(FLOOR - 1);
    expect(summary.withheld.saleCount).toBeLessThan(FLOOR);
    expect(summary.withheld.disclosed).toBe(false);
    // EMPTY, not zeroed: a list of zeros would read as "no money".
    expect(summary.withheld.amounts).toEqual([]);
  });

  it('two withheld countries with enough sales between them DO disclose', () => {
    const summary = summariseGeographicRevenue([
      ...repeat(6, () => sale({ supplyCountry: 'LU', grossAmount: 100 })),
      ...repeat(6, () => sale({ supplyCountry: 'MT', grossAmount: 100 })),
    ]);
    expect(summary.withheld).toMatchObject({
      countryCount: 2,
      saleCount: 12,
      disclosed: true,
    });
    expect(summary.withheld.amounts).toEqual([
      { currency: 'EUR', grossAmount: 1_200, creatorEarningsAmount: 2_250 * 12 },
    ]);
    // And neither country is named anywhere.
    assertEachOf(['LU', 'MT'], 2, (country) => {
      expect(summary.countries.map((entry) => entry.country)).not.toContain(country);
    });
  });

  it('two withheld countries with too FEW sales between them do not', () => {
    const summary = summariseGeographicRevenue([
      sale({ supplyCountry: 'LU' }),
      sale({ supplyCountry: 'MT' }),
    ]);
    expect(summary.withheld.disclosed).toBe(false);
    expect(summary.withheld.amounts).toEqual([]);
  });

  it('both conditions are required, and the second is a real number', () => {
    expect(DIGITAL_GEOGRAPHIC_MIN_POOLED_COUNTRIES).toBe(2);
    expect(DIGITAL_GEOGRAPHIC_MIN_COHORT).toBe(10);
  });
});

describe('#1015 W6 r9 — the summary publishes no grand total of its own', () => {
  it('there is no field to subtract the named countries from', () => {
    const summary = summariseGeographicRevenue([sale({ supplyCountry: 'ES' })]);
    assertEachOf(['total', 'totalAmount', 'grossAmount', 'allCountries'], 4, (field) => {
      expect(Object.keys(summary)).not.toContain(field);
    });
    expect(Object.keys(summary).sort()).toEqual(
      ['cohortFloor', 'countries', 'withheld', 'withoutPlaceOfSupply'].sort(),
    );
  });
});

describe('ADR 0010 D10 — a line with no place of supply is visible, not pooled', () => {
  it('it is counted on its own, so a privacy control cannot hide a tax bug', () => {
    const summary = summariseGeographicRevenue([
      ...repeat(3, () => sale({ supplyCountry: null })),
      sale({ supplyCountry: 'LU' }),
    ]);
    expect(summary.withoutPlaceOfSupply.saleCount).toBe(3);
    // NOT in the withheld pool: the pool is a privacy suppression, and this is a
    // checkout that never established where the supply happened.
    expect(summary.withheld.countryCount).toBe(1);
    expect(summary.withheld.saleCount).toBe(1);
  });
});

describe('#1015 W6 — money is per currency and never converted', () => {
  it('two currencies in one country are two rows, never one sum', () => {
    const summary = summariseGeographicRevenue([
      ...repeat(FLOOR, () => sale({ supplyCountry: 'ES', currency: 'EUR', grossAmount: 100 })),
      ...repeat(FLOOR, () => sale({ supplyCountry: 'ES', currency: 'USD', grossAmount: 100 })),
    ]);
    expect(summary.countries).toHaveLength(1);
    expect(summary.countries[0].amounts.map((amount) => amount.currency)).toEqual(['EUR', 'USD']);
    expect(summary.countries[0].amounts.every((amount) => amount.grossAmount === 100 * FLOOR)).toBe(
      true,
    );
  });

  it('free and refunded lines are not revenue', () => {
    const summary = summariseGeographicRevenue([
      ...repeat(FLOOR, () => sale({ supplyCountry: 'ES', priceClass: 'free' })),
      ...repeat(FLOOR, () => sale({ supplyCountry: 'ES', refunded: true })),
    ]);
    // Twenty lines in ES, none of which is revenue — so ES is not a revenue cohort
    // and inflating one is the direction a floor must never be wrong in.
    expect(summary.countries).toEqual([]);
    expect(summary.withheld.saleCount).toBe(0);
  });

  it('named countries are ordered by sales, then alphabetically — a total order', () => {
    const summary = summariseGeographicRevenue([
      ...repeat(FLOOR + 1, () => sale({ supplyCountry: 'PT' })),
      ...repeat(FLOOR, () => sale({ supplyCountry: 'FR' })),
      ...repeat(FLOOR, () => sale({ supplyCountry: 'DE' })),
    ]);
    expect(summary.countries.map((country) => country.country)).toEqual(['PT', 'DE', 'FR']);
  });
});
