/**
 * A facet range is SHOWN in the shopper's system and FILTERED in the base unit
 * (#367 line 598, #942).
 *
 * Line 598 asks that units and ranges be formatted according to locale/market
 * preference. The facet rail took a locale and had no parameter a measurement
 * system could arrive on, so `FacetRange.unit` was the definition's base unit
 * and a shopper in a non-metric market read base-unit bounds.
 *
 * ## Why the fix is ADDITIVE, which is what most of this file pins
 *
 * `FacetRange.min`/`.max` are not only what a rail prints — they are the
 * vocabulary a SELECTION is sent back in. `facet-schemas.ts` says it of the
 * selection's own bounds: *"A magnitude in an attribute's BASE unit — never the
 * source's own unit."* Converting the range in place would make a shopper who
 * drags a slider to `6.1` filter on 6.1 MILLIMETRES, with every request still
 * well-formed and nothing failing. So the base span is untouched and
 * {@link FacetRangeDisplay} rides beside it.
 *
 * ## The branch that is wrong silently
 *
 * `measurementSystemForMarket` answers `null` for an absent or malformed market
 * rather than `metric`, and `metric` for a well-formed one CLDR does not
 * override. **Those are two different outcomes and only the first means
 * "nothing was stated".** A caller that treated them alike would convert for a
 * shopper who never asked — which is the one thing `display-units.ts` says it
 * exists to refuse, and the branch no fixture in this repository reaches.
 */

import { describe, expect, it } from 'vitest';
import { rangeDisplay } from '../facet.service.js';
import { measurementSystemForMarket } from '../../canonical/display-units.js';

describe('an absent preference converts nothing', () => {
  it('returns null when the request stated no system', () => {
    // Branch 1, and the reason this file exists. Serving `metric` here would
    // convert for a shopper who never asked.
    expect(rangeDisplay(100, 200, 'mm', null)).toBeNull();
  });

  it('returns null when the attribute has no unit', () => {
    expect(rangeDisplay(100, 200, null, 'us')).toBeNull();
  });

  it('returns null when the stored unit is one units.ts does not know', () => {
    // `renderMeasurement` REFUSES rather than falling back to the base unit —
    // printing the number beside an unrecognised unit would assert a dimension
    // the row never claimed. A refusal must stay a refusal here.
    expect(rangeDisplay(100, 200, 'smoots', 'us')).toBeNull();
  });
});

describe('a stated preference converts the DISPLAY only', () => {
  it('renders millimetres in inches for a US shopper', () => {
    const display = rangeDisplay(100, 200, 'mm', 'us');
    expect(display, 'no display for a convertible unit and a stated system').not.toBeNull();
    expect(display?.unit).toBe('in');
    // 100 mm ≈ 3.94 in, 200 mm ≈ 7.87 in. Asserted as a BAND rather than an
    // exact figure: the rounding is `display-units.ts`'s to decide and pinning
    // its output here would make this file a second opinion about precision.
    expect(display?.min).toBeGreaterThan(3.9);
    expect(display?.min).toBeLessThan(4);
    expect(display?.max).toBeGreaterThan(7.8);
    expect(display?.max).toBeLessThan(7.9);
  });

  it('leaves a metric shopper on the base unit', () => {
    const display = rangeDisplay(100, 200, 'mm', 'metric');
    expect(display?.unit).toBe('mm');
    expect(display?.min).toBe(100);
    expect(display?.max).toBe(200);
  });

  it('keeps the ends in order and both finite', () => {
    const display = rangeDisplay(100, 200, 'mm', 'us');
    expect(Number.isFinite(display?.min ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(display?.max ?? Number.NaN)).toBe(true);
    expect(display?.max ?? 0).toBeGreaterThan(display?.min ?? 0);
  });
});

describe('the market fallback, and the two outcomes it keeps apart', () => {
  it('places the four markets CLDR overrides', () => {
    expect(measurementSystemForMarket('US')).toBe('us');
    expect(measurementSystemForMarket('GB')).toBe('uk');
    expect(measurementSystemForMarket('LR')).toBe('us');
    expect(measurementSystemForMarket('MM')).toBe('us');
  });

  it('answers metric for a WELL-FORMED market it does not override', () => {
    // Not `null`. CLDR's `001` default is metric, and a well-formed region is a
    // statement — this is the half of the contract a "returns null for an
    // unknown market" reading gets wrong.
    expect(measurementSystemForMarket('ES')).toBe('metric');
    expect(measurementSystemForMarket('JP')).toBe('metric');
  });

  it('answers null for an ABSENT or malformed market, which is a different thing', () => {
    expect(measurementSystemForMarket(undefined)).toBeNull();
    expect(measurementSystemForMarket(null)).toBeNull();
    expect(measurementSystemForMarket('')).toBeNull();
    expect(measurementSystemForMarket('USA')).toBeNull();
    expect(measurementSystemForMarket('1')).toBeNull();
  });

  it('and the two outcomes reach different displays', () => {
    // The pair driven end to end: the distinction above is only worth anything
    // if it changes what a shopper is served.
    expect(rangeDisplay(100, 200, 'mm', measurementSystemForMarket('ES'))).not.toBeNull();
    expect(rangeDisplay(100, 200, 'mm', measurementSystemForMarket(undefined))).toBeNull();
  });
});

describe('the base span is never converted — the round trip', () => {
  it('display is a SEPARATE projection, so the filter vocabulary is untouched', () => {
    // The property the additive shape exists for. A selection is sent back in
    // the base unit; if converting the display had moved these, a slider drag
    // would filter on a different measurement.
    const base = { min: 100, max: 200 } as const;
    const display = rangeDisplay(base.min, base.max, 'mm', 'us');
    expect(base.min).toBe(100);
    expect(base.max).toBe(200);
    expect(display?.min).not.toBe(base.min);
    expect(display?.max).not.toBe(base.max);
  });

  it('MUTATION SELF-TEST: a converted span really is different, so the case above can fail', () => {
    // Without this, `not.toBe` above would pass on a system that converted
    // nothing — which is exactly what `metric` does. `us` is chosen because it
    // is the one that moves the numbers.
    const metric = rangeDisplay(100, 200, 'mm', 'metric');
    expect(metric?.min, 'metric does not move a millimetre').toBe(100);
    const us = rangeDisplay(100, 200, 'mm', 'us');
    expect(us?.min, 'us must move a millimetre, or the round-trip case is vacuous').not.toBe(100);
  });
});
