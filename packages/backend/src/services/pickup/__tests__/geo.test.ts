/**
 * Cells, coordinates, distances and coarsening (#93).
 *
 * Every fixture here is chosen to exercise the DISTINCTION the function under
 * test exists to make, rather than a value that would pass under either
 * behaviour — the fixture law. Three of them are worth naming:
 *
 *  - the null island `(0, 0)`, which a range check ADMITS and which is the
 *    single commonest bad coordinate there is;
 *  - a NEGATIVE latitude for the cell index, because `Math.floor` and
 *    `Math.trunc` agree on every positive value and disagree on every negative
 *    one, so a positive-only fixture cannot tell them apart;
 *  - a distance exactly ON a band boundary, because `<` and `<=` agree
 *    everywhere else.
 */

import { describe, expect, it } from 'vitest';
import { P2P_LOCAL_CELL_PRECISION_DEGREES } from '@mercaria/shared-types';
import {
  assertUsableCoordinate,
  clampNearbyRadius,
  coarsenMetres,
  DEFAULT_NEARBY_RADIUS_METRES,
  distanceBandFor,
  haversineMetres,
  localAreaCentre,
  MAX_NEARBY_RADIUS_METRES,
  MIN_NEARBY_RADIUS_METRES,
  toLocalArea,
} from '../geo.js';

describe('assertUsableCoordinate', () => {
  it('accepts a real position', () => {
    expect(assertUsableCoordinate(41.3874, 2.1686)).toEqual({ latitude: 41.3874, longitude: 2.1686 });
  });

  it('REFUSES the null island, which a range check admits', () => {
    // The whole reason this function exists beside the range CHECK: `(0, 0)` is
    // inside every bound and is what a failed import writes.
    expect(() => assertUsableCoordinate(0, 0)).toThrow(/Atlantic/);
  });

  it('accepts a real position ON the prime meridian and ON the equator', () => {
    // The refusal above must be the PAIR and not either half: Greenwich and
    // Quito are real places and refusing them would be refusing a merchant.
    expect(() => assertUsableCoordinate(51.4779, 0)).not.toThrow();
    expect(() => assertUsableCoordinate(0, -78.4678)).not.toThrow();
  });

  it('refuses an out-of-range or non-finite value', () => {
    expect(() => assertUsableCoordinate(91, 0)).toThrow();
    expect(() => assertUsableCoordinate(0, 181)).toThrow();
    expect(() => assertUsableCoordinate(Number.NaN, 1)).toThrow();
  });
});

describe('toLocalArea', () => {
  it('floors rather than truncating, which only a NEGATIVE fixture can show', () => {
    // `Math.trunc(-0.05 / 0.1)` is `-0` and `Math.floor` is `-1`. Every
    // positive fixture agrees under both, so this is the one that discriminates.
    expect(toLocalArea({ latitude: -0.05, longitude: -0.05 })).toEqual({
      latIndex: -1,
      lonIndex: -1,
      precisionDegrees: P2P_LOCAL_CELL_PRECISION_DEGREES,
    });
  });

  it('puts two positions in one neighbourhood into ONE cell', () => {
    const a = toLocalArea({ latitude: 41.402, longitude: 2.153 });
    const b = toLocalArea({ latitude: 41.418, longitude: 2.161 });
    expect(a).toEqual(b);
  });

  it('recovers only the cell CENTRE, never the original', () => {
    const centre = localAreaCentre(toLocalArea({ latitude: 41.3874, longitude: 2.1686 }));
    expect(centre.latitude).toBeCloseTo(41.35, 6);
    expect(centre.longitude).toBeCloseTo(2.15, 6);
  });
});

describe('haversineMetres', () => {
  it('measures a known city distance to within a kilometre', () => {
    // Barcelona → Madrid, about 505 km.
    const metres = haversineMetres(
      { latitude: 41.3874, longitude: 2.1686 },
      { latitude: 40.4168, longitude: -3.7038 },
    );
    expect(metres).toBeGreaterThan(500_000);
    expect(metres).toBeLessThan(510_000);
  });

  it('is zero for one point against itself', () => {
    expect(haversineMetres({ latitude: 1, longitude: 2 }, { latitude: 1, longitude: 2 })).toBe(0);
  });
});

describe('distanceBandFor', () => {
  it('is exclusive at the boundary, which only an exact fixture can show', () => {
    expect(distanceBandFor(999)).toBe('under_1km');
    expect(distanceBandFor(1_000)).toBe('under_5km');
    expect(distanceBandFor(49_999)).toBe('under_50km');
    expect(distanceBandFor(50_000)).toBe('beyond_50km');
  });
});

describe('coarsenMetres', () => {
  it('rounds OUTWARD, never to nearest', () => {
    // 1,201 m must not read as 1,200: the figure is what somebody has to walk,
    // and understating it is the direction that misleads.
    expect(coarsenMetres(1_201)).toBe(1_300);
    expect(coarsenMetres(1_200)).toBe(1_200);
  });

  it('switches step at 10 km, so a city centre is not all "1 km"', () => {
    expect(coarsenMetres(9_950)).toBe(10_000);
    expect(coarsenMetres(10_001)).toBe(11_000);
  });
});

describe('clampNearbyRadius', () => {
  it('defaults, floors and ceilings', () => {
    expect(clampNearbyRadius(undefined)).toBe(DEFAULT_NEARBY_RADIUS_METRES);
    expect(clampNearbyRadius(1)).toBe(MIN_NEARBY_RADIUS_METRES);
    expect(clampNearbyRadius(10_000_000)).toBe(MAX_NEARBY_RADIUS_METRES);
    expect(clampNearbyRadius(Number.NaN)).toBe(DEFAULT_NEARBY_RADIUS_METRES);
  });
});
