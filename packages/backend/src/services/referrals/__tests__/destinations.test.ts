/**
 * The destination allow-list: every representable destination maps to an
 * internal relative path, and everything URL-shaped is refused at validation —
 * which is what "structurally not an open redirect" means in practice.
 */

import { describe, expect, it } from 'vitest';
import { referralDestinationPath, validateReferralDestination } from '../destinations.js';

describe('validateReferralDestination', () => {
  it('accepts the four allow-listed shapes', () => {
    expect(validateReferralDestination({ destinationType: 'home' })).toEqual({
      destinationType: 'home',
    });
    expect(
      validateReferralDestination({ destinationType: 'listing', destinationRef: 'abc123' }),
    ).toEqual({ destinationType: 'listing', destinationRef: 'abc123' });
    expect(
      validateReferralDestination({ destinationType: 'collection', destinationRef: 'c-1' }),
    ).toEqual({ destinationType: 'collection', destinationRef: 'c-1' });
    expect(
      validateReferralDestination({ destinationType: 'store', destinationRef: 's-1' }),
    ).toEqual({ destinationType: 'store', destinationRef: 's-1' });
  });

  it('refuses an incomplete pairing in both directions', () => {
    expect(() =>
      validateReferralDestination({ destinationType: 'home', destinationRef: 'x' }),
    ).toThrow(/no reference/i);
    expect(() => validateReferralDestination({ destinationType: 'listing' })).toThrow(
      /plain id/i,
    );
  });

  it('refuses everything URL- or path-shaped as a reference', () => {
    for (const hostile of [
      'https://evil.example',
      '//evil.example',
      '../admin',
      'a/b',
      'a?x=1',
      'a#frag',
      'a%2Fb',
      'javascript:alert(1)',
      ' ',
      '',
    ]) {
      expect(() =>
        validateReferralDestination({ destinationType: 'listing', destinationRef: hostile }),
      ).toThrow(/plain id/i);
    }
  });
});

describe('referralDestinationPath', () => {
  it('maps each type to its internal relative route', () => {
    expect(referralDestinationPath({ destinationType: 'home' })).toBe('/');
    expect(
      referralDestinationPath({ destinationType: 'listing', destinationRef: 'l1' }),
    ).toBe('/listings/l1');
    expect(
      referralDestinationPath({ destinationType: 'collection', destinationRef: 'c1' }),
    ).toBe('/collections/c1');
    expect(referralDestinationPath({ destinationType: 'store', destinationRef: 's1' })).toBe(
      '/stores/s1',
    );
  });

  it('re-validates STORED data at read time — a hostile ref is refused, not rendered', () => {
    expect(() =>
      referralDestinationPath({ destinationType: 'listing', destinationRef: '../x' }),
    ).toThrow(/plain id/i);
  });
});
