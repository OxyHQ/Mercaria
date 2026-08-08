/**
 * Unit tests for the money primitives: `applyPriceRules` — the connector price
 * transform applied to an imported native price (markup, then a rounding
 * strategy) — and `assertSafeMoneyAmount`, the shared guard every construction
 * boundary calls. Pure integer money math; no DB / no network. Covers markup
 * (positive/negative/clamped), each rounding mode (`none`/`nearest`/`charm`) for
 * a cent-precision currency (USD) and for FAIR, the markup+rounding composition
 * order, and the amount-representability limit.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_MONEY_MINOR_UNITS,
  assertSafeMoneyAmount,
  CURRENCY_PRECISION,
  type Money,
} from '@mercaria/shared-types';
import { applyPriceRules, type PriceRules } from '../money.js';

const usd = (amount: number): Money => ({ amount, currency: 'USD' });
const fair = (amount: number): Money => ({ amount, currency: 'FAIR' });

describe('applyPriceRules — no rules / no-op', () => {
  it('returns the price unchanged when rules are undefined', () => {
    expect(applyPriceRules(usd(1999))).toEqual(usd(1999));
  });

  it('returns the price unchanged for an empty rules object', () => {
    expect(applyPriceRules(usd(1999), {})).toEqual(usd(1999));
  });

  it('markupPercent 0 is a no-op', () => {
    expect(applyPriceRules(usd(1999), { markupPercent: 0 })).toEqual(usd(1999));
  });
});

describe('applyPriceRules — markup (half-even minor rounding)', () => {
  it('adds a positive percentage markup', () => {
    // 1999 * 1.10 = 2198.9 → half-even → 2199 ($21.99).
    expect(applyPriceRules(usd(1999), { markupPercent: 10 })).toEqual(usd(2199));
  });

  it('applies a fractional markup percent', () => {
    // 2000 * 1.125 = 2250 exactly.
    expect(applyPriceRules(usd(2000), { markupPercent: 12.5 })).toEqual(usd(2250));
  });

  it('treats a negative markup as a discount', () => {
    // 2000 * 0.90 = 1800.
    expect(applyPriceRules(usd(2000), { markupPercent: -10 })).toEqual(usd(1800));
  });

  it('clamps a below-cost markup to zero (never negative)', () => {
    // 1000 * (1 - 1.5) = -500 → clamped to 0.
    expect(applyPriceRules(usd(1000), { markupPercent: -150 })).toEqual(usd(0));
  });
});

describe('applyPriceRules — rounding strategies (USD, 2dp)', () => {
  it("'none' leaves the marked-up amount as is", () => {
    const rules: PriceRules = { markupPercent: 10, rounding: 'none' };
    expect(applyPriceRules(usd(1999), rules)).toEqual(usd(2199));
  });

  it("'nearest' rounds to the nearest whole major unit", () => {
    expect(applyPriceRules(usd(1999), { rounding: 'nearest' })).toEqual(usd(2000));
    expect(applyPriceRules(usd(1949), { rounding: 'nearest' })).toEqual(usd(1900));
  });

  it("'nearest' breaks an exact half to even", () => {
    // 19.50 → half-even → 20 → 2000; 18.50 → half-even → 18 → 1800.
    expect(applyPriceRules(usd(1950), { rounding: 'nearest' })).toEqual(usd(2000));
    expect(applyPriceRules(usd(1850), { rounding: 'nearest' })).toEqual(usd(1800));
  });

  it("'charm' prices one minor unit below the nearest whole major (x.99)", () => {
    expect(applyPriceRules(usd(1999), { rounding: 'charm' })).toEqual(usd(1999)); // 20.00 - 0.01
    expect(applyPriceRules(usd(1949), { rounding: 'charm' })).toEqual(usd(1899)); // 19.00 - 0.01
    expect(applyPriceRules(usd(1950), { rounding: 'charm' })).toEqual(usd(1999)); // 20.00 - 0.01
  });

  it('composes markup THEN rounding', () => {
    // 2000 * 1.15 = 2300 → nearest whole → 2300; charm → 2299.
    expect(applyPriceRules(usd(2000), { markupPercent: 15, rounding: 'nearest' })).toEqual(usd(2300));
    expect(applyPriceRules(usd(2000), { markupPercent: 15, rounding: 'charm' })).toEqual(usd(2299));
  });
});

describe('applyPriceRules — precision-aware for FAIR (8dp)', () => {
  it("'nearest' rounds to a whole ⊜ (1e8 minor units)", () => {
    // 1.5 ⊜ → half-even → 2 ⊜.
    expect(applyPriceRules(fair(150_000_000), { rounding: 'nearest' })).toEqual(fair(200_000_000));
  });

  it("'charm' is one minor unit below a whole ⊜ (x.99999999)", () => {
    expect(applyPriceRules(fair(200_000_000), { rounding: 'charm' })).toEqual(fair(199_999_999));
  });
});

describe('assertSafeMoneyAmount — the representability limit', () => {
  it('accepts ordinary integer amounts, zero and negatives', () => {
    expect(() => assertSafeMoneyAmount(0, 'test')).not.toThrow();
    expect(() => assertSafeMoneyAmount(1999, 'test')).not.toThrow();
    expect(() => assertSafeMoneyAmount(-1999, 'test')).not.toThrow();
  });

  it('accepts exactly the maximum, on either sign', () => {
    expect(() => assertSafeMoneyAmount(MAX_MONEY_MINOR_UNITS, 'test')).not.toThrow();
    expect(() => assertSafeMoneyAmount(-MAX_MONEY_MINOR_UNITS, 'test')).not.toThrow();
  });

  it('REJECTS one minor unit past the maximum, on either sign', () => {
    expect(() => assertSafeMoneyAmount(MAX_MONEY_MINOR_UNITS + 1, 'test')).toThrow(RangeError);
    expect(() => assertSafeMoneyAmount(-MAX_MONEY_MINOR_UNITS - 1, 'test')).toThrow(RangeError);
  });

  it('REJECTS a fractional amount — minor units are whole', () => {
    expect(() => assertSafeMoneyAmount(19.99, 'test')).toThrow(/integer count of minor units/);
  });

  it('REJECTS non-finite amounts', () => {
    expect(() => assertSafeMoneyAmount(Number.NaN, 'test')).toThrow(/finite/);
    expect(() => assertSafeMoneyAmount(Number.POSITIVE_INFINITY, 'test')).toThrow(/finite/);
  });

  it('names the CONTEXT in the message, so a breach points at what produced it', () => {
    expect(() => assertSafeMoneyAmount(1.5, 'pricing.grandTotal')).toThrow(/pricing\.grandTotal/);
  });

  it('is the boundary FAIR\'s eight decimals actually approach', () => {
    // FAIR is the only supported currency whose minor unit is small enough for a
    // plausible amount to reach the limit: the ceiling is ~90.07 million ⊜, but
    // ~90.07 TRILLION units of a 2-decimal fiat. That asymmetry is why the limit
    // is enforced rather than assumed unreachable.
    const fairCeiling = MAX_MONEY_MINOR_UNITS / 10 ** CURRENCY_PRECISION.FAIR;
    const usdCeiling = MAX_MONEY_MINOR_UNITS / 10 ** CURRENCY_PRECISION.USD;
    expect(Math.round(fairCeiling)).toBe(90_071_993);
    expect(usdCeiling).toBeGreaterThan(90_000_000_000_000);
  });
});
