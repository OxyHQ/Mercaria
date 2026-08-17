/**
 * Choosing a display unit, and printing it without inventing digits
 * (#367 Workstream 4: "localize unit display and choose display units by
 * locale/market/user preference without mutating stored values", and "avoid
 * false precision after conversion").
 *
 * ## What each half of this file would report if its mechanism were absent
 *
 * If `resolveDisplayUnit` always answered the base unit, the exhaustive override
 * walk and every inch assertion below go red. If the precision rules collapsed
 * to `String(magnitude)`, the noise-digit case goes red naming the digits. If
 * the refusal collapsed to "fall back to the base unit", the unknown-unit case
 * goes red. Each is asserted with a companion that must PASS, so a module that
 * refused everything — the widest-blast-radius failure — cannot read as a
 * healthy run.
 */

import { describe, expect, it } from 'vitest';
import { UNIT_FAMILIES, type UnitFamily } from '@mercaria/shared-types';
import { BASE_UNITS, UNIT_DEFINITIONS, convertUnit, toBaseUnit } from '../units.js';
import {
  MAX_DISPLAY_DECIMALS,
  MEASUREMENT_SYSTEMS,
  displayDecimals,
  isMeasurementSystem,
  measurementSystemForMarket,
  renderMeasurement,
  resolveDisplayUnit,
  significantDigits,
  sourceNumberText,
  type MeasurementSystem,
} from '../display-units.js';

/** The base unit is metric for every family, so `metric` overrides nothing. */
const NON_METRIC: readonly MeasurementSystem[] = ['us', 'uk'];

describe('a market implies a measurement system, and an absent one implies nothing', () => {
  it('answers null for an absent or malformed market, and metric for a real one', () => {
    // The two are DIFFERENT answers, and the distinction is the whole reason
    // this function returns a nullable. A caller that read `null` as `metric`
    // would convert for a shopper who stated no preference at all.
    for (const absent of [undefined, null, '', '  ', 'ESP', 'e', '12', 'es-ES']) {
      expect(measurementSystemForMarket(absent), `${String(absent)} produced a system`).toBeNull();
    }
    expect(measurementSystemForMarket('ES')).toBe('metric');
    expect(measurementSystemForMarket('es')).toBe('metric');
    expect(measurementSystemForMarket(' de ')).toBe('metric');
  });

  it('names exactly the four markets CLDR overrides', () => {
    expect(measurementSystemForMarket('US')).toBe('us');
    expect(measurementSystemForMarket('LR')).toBe('us');
    expect(measurementSystemForMarket('MM')).toBe('us');
    expect(measurementSystemForMarket('GB')).toBe('uk');
    // …and the neighbours that are NOT overridden, or "four markets" would be
    // satisfied by a function answering `us` to everything.
    for (const metric of ['CA', 'AU', 'IE', 'NZ', 'DE', 'FR', 'JP']) {
      expect(measurementSystemForMarket(metric), `${metric} is not metric`).toBe('metric');
    }
  });

  it('guards the request parameter against anything but the three systems', () => {
    for (const system of MEASUREMENT_SYSTEMS) expect(isMeasurementSystem(system)).toBe(true);
    for (const other of ['imperial', 'METRIC', 'unspecified', '', 'si']) {
      expect(isMeasurementSystem(other), `${other} passed the guard`).toBe(false);
    }
    expect(MEASUREMENT_SYSTEMS).toHaveLength(3);
  });
});

describe('the display unit table', () => {
  it('answers the base unit for every family under metric', () => {
    // Exhaustive over the tuple rather than over three examples, so a family
    // added later is covered without anybody remembering this file.
    expect(UNIT_FAMILIES.length).toBeGreaterThanOrEqual(16);
    for (const family of UNIT_FAMILIES) {
      expect(resolveDisplayUnit(family, 'metric'), `metric ${family}`).toBe(BASE_UNITS[family]);
    }
  });

  it('every override names a REAL unit of the SAME family', () => {
    // The failure this catches is the one that would be invisible: an override
    // naming a unit of another dimension turns every rendering of that family
    // into a refusal (or, worse, a plausible number in the wrong dimension).
    const overridden: string[] = [];
    for (const system of NON_METRIC) {
      for (const family of UNIT_FAMILIES) {
        const unit = resolveDisplayUnit(family, system);
        expect(UNIT_DEFINITIONS[unit], `${system}/${family} names an unknown unit`).toBeDefined();
        expect(UNIT_DEFINITIONS[unit]?.family, `${system}/${family} crosses dimension`).toBe(family);
        if (unit !== BASE_UNITS[family]) overridden.push(`${system}/${family}=${unit}`);
      }
    }
    // The population, printed on success and floored: an empty override table
    // would satisfy every assertion above.
    expect(overridden.sort()).toEqual([
      'uk/length=in',
      'uk/mass=lb',
      'us/length=in',
      'us/mass=lb',
      'us/volume=fl_oz',
    ]);
  });

  it('leaves UK volume in millilitres, because `fl_oz` is the US ounce', () => {
    // The outcome AND its reason, so the assertion cannot pass for a different
    // reason later. `fl_oz` here is 29.5735295625 ml — the US fluid ounce. The
    // imperial one is 28.4130625 ml, so mapping UK volume onto this unit prints
    // a number four per cent wrong on every bottle.
    expect(resolveDisplayUnit('volume', 'uk')).toBe('ml');
    expect(toBaseUnit(1, 'fl_oz')).toBeCloseTo(29.5735295625, 9);
    expect(toBaseUnit(1, 'fl_oz')).not.toBeCloseTo(28.4130625, 3);
  });

  it('leaves the dimensionless and digital families alone under every system', () => {
    // A gigabyte is a gigabyte in Ohio. Stated as an assertion because the
    // tempting "make the table symmetrical" edit is what would break it.
    for (const system of MEASUREMENT_SYSTEMS) {
      for (const family of ['digital_storage', 'frequency', 'percentage', 'ratio', 'rating'] as const) {
        expect(resolveDisplayUnit(family, system), `${system}/${family}`).toBe(BASE_UNITS[family]);
      }
    }
  });
});

describe('precision after conversion', () => {
  it('reads the significant digits a source claimed, and not its decimal places', () => {
    expect(significantDigits('6.1')).toBe(2);
    expect(significantDigits('0.256')).toBe(3);
    expect(significantDigits('155')).toBe(3);
    expect(significantDigits('0')).toBe(1);
    expect(significantDigits('-12.50')).toBe(4);
  });

  it('reads a leading number off a source string, and refuses a sentence', () => {
    expect(sourceNumberText('6.1 in')).toBe('6.1');
    expect(sourceNumberText(' 256GB ')).toBe('256');
    expect(sourceNumberText('-3.5 cm')).toBe('-3.5');
    // Anchored: a number in the middle of prose is not a claimed precision.
    expect(sourceNumberText('about 6 cm')).toBeNull();
    expect(sourceNumberText('Black Titanium')).toBeNull();
  });

  it('lets a DECLARED precision win over both the source and the ceiling', () => {
    expect(displayDecimals(154.94000000000001, '6.1', 1)).toBe(1);
    expect(displayDecimals(154.94000000000001, '6.1', 3)).toBe(3);
    // Clamped rather than trusted, because the column admits 0–12 and this
    // module prints at most six.
    expect(displayDecimals(1, '1', 99)).toBe(MAX_DISPLAY_DECIMALS);
    expect(displayDecimals(1, '1', -4)).toBe(0);
  });

  it('never exceeds the source significant digits when nothing declared one', () => {
    // 6.1 in knows two digits. The converted 154.94 mm may be printed as 155;
    // printing 154.94 would claim a hundredth of a millimetre nobody measured.
    expect(displayDecimals(154.94, '6.1', null)).toBe(0);
    // 155 mm knows three. Converted to 6.102362… in, three digits is two
    // decimals — and this is the direction a decimal-places rule gets WRONG,
    // because 155 has none and 6 in would throw away real information.
    expect(displayDecimals(6.102362204724409, '155', null)).toBe(2);
  });

  it('caps at a total-digit ceiling when nothing states a precision at all', () => {
    expect(displayDecimals(27.940000000000005, null, null)).toBe(MAX_DISPLAY_DECIMALS - 2);
    expect(displayDecimals(0.5, null, null)).toBe(MAX_DISPLAY_DECIMALS - 1);
  });
});

describe('rendering a stored measurement', () => {
  const stored = (over: Record<string, unknown> = {}) =>
    Object.freeze({ baseMagnitude: 154.94, baseUnit: 'mm', ...over });

  it('shows a metric shopper millimetres and a US shopper inches', () => {
    const metric = renderMeasurement(stored({ sourceDisplayValue: '6.1 in' }), 'metric');
    const us = renderMeasurement(stored({ sourceDisplayValue: '6.1 in' }), 'us');
    expect(metric).toMatchObject({ outcome: 'rendered', unit: 'mm', text: '155 mm' });
    expect(us).toMatchObject({ outcome: 'rendered', unit: 'in', text: '6.1 in' });
  });

  it('keeps the source significant digits through the OTHER direction too', () => {
    const us = renderMeasurement(stored({ baseMagnitude: 155, sourceDisplayValue: '155 mm' }), 'us');
    // Three digits in, three digits out — `6.1` would drop one the source had.
    expect(us).toMatchObject({ outcome: 'rendered', unit: 'in', text: '6.10 in', decimals: 2 });
  });

  it('honours a declared precision in the DISPLAY unit', () => {
    const rendered = renderMeasurement(
      stored({ sourceDisplayValue: '6.1 in', declaredDecimals: 1 }),
      'metric',
    );
    expect(rendered).toMatchObject({ outcome: 'rendered', text: '154.9 mm', decimals: 1 });
  });

  it('never prints a double noise digit', () => {
    // `1.1 in` lands on 27.940000000000005 through the exact rational factors —
    // the value the codebase already measured. With nothing declaring a
    // precision this is where `String(magnitude)` would reach a product page.
    const noisy = toBaseUnit(1.1, 'in') as number;
    expect(String(noisy)).toContain('000000');
    const rendered = renderMeasurement({ baseMagnitude: noisy, baseUnit: 'mm' }, 'metric');
    expect(rendered).toMatchObject({ outcome: 'rendered', text: '27.94 mm' });
    if (rendered.outcome === 'rendered') {
      expect(rendered.text).not.toContain('000000');
      expect(rendered.decimals).toBeLessThanOrEqual(MAX_DISPLAY_DECIMALS);
    }
  });

  it('REFUSES a stored unit it does not know, rather than defaulting to a base unit', () => {
    // The #94 rule pointed at display. Printing the number beside a base unit
    // would assert a dimension the row never claimed — `14` becoming `14 mm` on
    // one feed and `14 in` on another with nothing saying so.
    const refused = renderMeasurement({ baseMagnitude: 14, baseUnit: 'parsec' }, 'metric');
    expect(refused).toEqual({ outcome: 'refused', reason: 'unknown_unit' });
    // The companion that must PASS, so "refuses everything" is not a green run.
    expect(renderMeasurement({ baseMagnitude: 14, baseUnit: 'mm' }, 'metric').outcome).toBe(
      'rendered',
    );
  });

  it('renders both bounds of a range in one unit at one precision', () => {
    const rendered = renderMeasurement(
      { baseMagnitude: 604_800, baseMagnitudeMax: 2_592_000, baseUnit: 's', declaredDecimals: 0 },
      'metric',
    );
    expect(rendered).toMatchObject({
      outcome: 'rendered',
      unit: 's',
      magnitude: 604_800,
      magnitudeMax: 2_592_000,
    });
    if (rendered.outcome === 'rendered') expect(rendered.text).toContain('–');
  });

  it('agrees with `units.ts`, which is the only thing that converts here', () => {
    // The rendered magnitude is the conversion, rounded — never a second
    // arithmetic. A drift here means a factor was reimplemented.
    for (const [family, magnitude] of [
      ['length', 154.94],
      ['mass', 1000],
      ['volume', 1500],
    ] as const) {
      for (const system of MEASUREMENT_SYSTEMS) {
        const unit = resolveDisplayUnit(family as UnitFamily, system);
        const rendered = renderMeasurement(
          { baseMagnitude: magnitude, baseUnit: BASE_UNITS[family as UnitFamily] },
          system,
        );
        expect(rendered.outcome).toBe('rendered');
        if (rendered.outcome !== 'rendered') continue;
        const direct = convertUnit(magnitude, BASE_UNITS[family as UnitFamily], unit) as number;
        expect(Math.abs(rendered.magnitude - direct)).toBeLessThanOrEqual(
          0.5 * 10 ** -rendered.decimals,
        );
      }
    }
  });

  it('mutates nothing it is given', () => {
    // `Object.freeze` on the input, so an assignment throws in strict mode
    // rather than being invisible. "Without mutating stored values" begins with
    // not mutating the value handed in.
    const input = Object.freeze({ baseMagnitude: 154.94, baseUnit: 'mm', declaredDecimals: 1 });
    renderMeasurement(input, 'us');
    expect(input).toEqual({ baseMagnitude: 154.94, baseUnit: 'mm', declaredDecimals: 1 });
  });
});
