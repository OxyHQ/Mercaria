/**
 * WHEN Mercaria asks the issuer to authenticate — the matrix, and the two
 * failure directions that are not symmetrical.
 *
 * The policy is pure and takes its thresholds as an argument rather than
 * reading `config`, so both branches are reachable here whatever this
 * deployment happens to be configured with. That is `resolveRefusalAccountRef`'s
 * rule: a function reading configuration directly can only ever be tested
 * against whichever branch the machine running the suite is in.
 */

import { describe, expect, it } from 'vitest';
import { ALL_CURRENCY_CODES, type CurrencyCode, type Money } from '@mercaria/shared-types';
import { parseThreeDSecureThresholds, threeDSecureRequestFor } from '../three-d-secure.js';

const isKnown = (code: string): code is CurrencyCode =>
  (ALL_CURRENCY_CODES as readonly string[]).includes(code);

const eur = (amount: number): Money => ({ amount, currency: 'EUR' });

describe('which payments are authenticated', () => {
  it('asks at and above the threshold, and leaves Stripe to decide below it', () => {
    const thresholds = { EUR: 50_000 } as const;
    expect(threeDSecureRequestFor(eur(49_999), thresholds)).toBe('automatic');
    // The boundary is INCLUSIVE. A threshold of "500 euros" that exempted a
    // 500-euro order would be off by one in the direction that loses money.
    expect(threeDSecureRequestFor(eur(50_000), thresholds)).toBe('any');
    expect(threeDSecureRequestFor(eur(50_001), thresholds)).toBe('any');
  });

  it('asks on EVERY payment in a currency with no threshold', () => {
    // The fail-closed direction, and the whole reason the map is partial. A
    // currency nobody configured costs extra friction; the alternative default
    // costs unlimited unauthenticated exposure, and only one of those is
    // recoverable.
    expect(threeDSecureRequestFor(eur(1), {})).toBe('any');
    expect(threeDSecureRequestFor({ amount: 1, currency: 'USD' }, { EUR: 50_000 })).toBe('any');
  });

  it('never asks for a challenge, only for authentication', () => {
    // `any` authenticates wherever the card supports it, and a large share of
    // 3DS authentications are frictionless. `challenge` would force a visible
    // step the liability shift does not require, on every high-value order.
    for (const verdict of [
      threeDSecureRequestFor(eur(999_999), {}),
      threeDSecureRequestFor(eur(999_999), { EUR: 1 }),
    ]) {
      expect(verdict).not.toBe('challenge');
    }
  });

  it('treats a zero threshold as "always", not as "never"', () => {
    // `0` is falsy, and a `??`/`||` reading of it would silently mean "no
    // threshold" — which happens to land on the same answer here, but for the
    // wrong reason and only by luck.
    expect(threeDSecureRequestFor(eur(0), { EUR: 0 })).toBe('any');
    expect(threeDSecureRequestFor(eur(1), { EUR: 0 })).toBe('any');
  });
});

describe('parsing STRIPE_3DS_THRESHOLDS', () => {
  it('reads a per-currency map', () => {
    const { thresholds, rejected } = parseThreeDSecureThresholds('EUR:50000,USD:60000', isKnown);
    expect(thresholds).toEqual({ EUR: 50_000, USD: 60_000 });
    expect(rejected).toEqual([]);
  });

  it('tolerates whitespace, lower case and a trailing comma', () => {
    const { thresholds, rejected } = parseThreeDSecureThresholds(' eur : 500 , ', isKnown);
    expect(thresholds).toEqual({ EUR: 500 });
    expect(rejected).toEqual([]);
  });

  it('REJECTS rather than defaults, and reports what it dropped', () => {
    // Every one of these leaves its currency with no threshold, which asks on
    // every payment. A parser that defaulted a malformed entry to a NUMBER
    // would exempt real orders on the strength of a typo.
    const { thresholds, rejected } = parseThreeDSecureThresholds(
      'XYZ:100,EUR:notanumber,USD:-5,GBP:1.5,JPY',
      isKnown,
    );
    expect(thresholds).toEqual({});
    expect(rejected).toEqual(['XYZ:100', 'EUR:notanumber', 'USD:-5', 'GBP:1.5', 'JPY']);
  });

  it('drops an amount past the safe-integer range', () => {
    const { thresholds, rejected } = parseThreeDSecureThresholds('EUR:99999999999999999999', isKnown);
    expect(thresholds).toEqual({});
    expect(rejected).toHaveLength(1);
  });

  it('reads nothing from an empty setting, which is the shipped default', () => {
    // And the shipped default therefore authenticates everything. Stated here
    // because it is a deployment-wide behaviour nobody would infer from an
    // empty string.
    expect(parseThreeDSecureThresholds('', isKnown)).toEqual({ thresholds: {}, rejected: [] });
    expect(threeDSecureRequestFor(eur(1), {})).toBe('any');
  });
});
