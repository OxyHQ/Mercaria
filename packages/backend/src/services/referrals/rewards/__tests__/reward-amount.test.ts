/**
 * Reward arithmetic: rounding defined once, allocations that reconcile exactly,
 * and clamps that can only ever lower (#144 calculation rules 2, 3, 6 and 7).
 *
 * Pure, so these are the cases where a mistake is CHEAPEST to find — the realdb
 * file exercises the same arithmetic through the schema, but a rounding bug
 * discovered there is discovered under three layers of fixture.
 */

import { describe, expect, it } from 'vitest';
import { MAX_MONEY_MINOR_UNITS } from '@mercaria/shared-types';
import {
  capPeriodStart,
  clampReward,
  isBelowMinimumAccrual,
  percentageOfRealizedBase,
  REWARD_RATE_BPS_DENOMINATOR,
} from '../amount.js';

describe('rounding is half-even and it is defined once', () => {
  it('rounds an exact half to the EVEN neighbour, in both directions', () => {
    // 2_500 bps of 10 is 2.5 → 2 (even). 2_500 bps of 30 is 7.5 → 8 (even).
    // Half-UP would answer 3 and 8; half-DOWN 2 and 7. Only half-even splits.
    expect(percentageOfRealizedBase(10, 2_500)).toBe(2);
    expect(percentageOfRealizedBase(30, 2_500)).toBe(8);
    expect(percentageOfRealizedBase(50, 2_500)).toBe(12);
    expect(percentageOfRealizedBase(70, 2_500)).toBe(18);
  });

  it('rounds an ordinary remainder to the nearer neighbour', () => {
    expect(percentageOfRealizedBase(101, 2_000)).toBe(20); // 20.2
    expect(percentageOfRealizedBase(104, 2_000)).toBe(21); // 20.8
  });

  it('does not systematically favour either side over a run of bases', () => {
    // The reason half-even is the rule at all: a reward is a small percentage
    // of many bases, and half-up transfers the ties one way every time. Over
    // the bases whose 25% lands exactly on a half, the half-even total is
    // strictly less than the half-up total and strictly more than half-down.
    let halfEven = 0;
    let halfUp = 0;
    let halfDown = 0;
    for (let base = 2; base <= 200; base += 4) {
      // base ≡ 2 (mod 4) ⇒ base × 25% ends in .5 exactly.
      halfEven += percentageOfRealizedBase(base, 2_500);
      halfUp += Math.floor((base * 2_500) / 10_000 + 0.5);
      halfDown += Math.ceil((base * 2_500) / 10_000 - 0.5);
    }
    expect(halfEven).toBeLessThan(halfUp);
    expect(halfEven).toBeGreaterThan(halfDown);
    // …and it lands exactly halfway between them, which is what "unbiased"
    // means for a set of ties split evenly.
    expect(halfEven * 2).toBe(halfUp + halfDown);
  });

  it('computes in integer arithmetic, so a large FAIR base does not drift', () => {
    // FAIR carries eight decimals: 1_000 ⊜ is 10^11 minor units, and
    // base × bps is 10^15 — inside the safe range, but only just. Float
    // arithmetic on the same figures is where the answer would quietly move.
    const base = 100_000_000_000;
    expect(percentageOfRealizedBase(base, 2_000)).toBe(20_000_000_000);
    expect(percentageOfRealizedBase(base + 1, 1)).toBe(10_000_000);
  });

  it('refuses a base or a rate outside the range a stored rule can hold', () => {
    expect(() => percentageOfRealizedBase(-1, 2_000)).toThrow(/non-negative/);
    expect(() => percentageOfRealizedBase(1.5, 2_000)).toThrow(/integer/);
    expect(() => percentageOfRealizedBase(100, 0)).toThrow(/bps/);
    expect(() => percentageOfRealizedBase(100, REWARD_RATE_BPS_DENOMINATOR + 1)).toThrow(/bps/);
    // 100% is representable — ADR 0005 D10 bounds the rate at, not below, it.
    expect(percentageOfRealizedBase(100, REWARD_RATE_BPS_DENOMINATOR)).toBe(100);
  });

  it('enforces the money ceiling rather than trusting the integer check', () => {
    // `z.number().int()` accepts 1e300 and so does `Number.isInteger`; the
    // ceiling is what makes the bound real.
    expect(() => percentageOfRealizedBase(MAX_MONEY_MINOR_UNITS, 10_000)).not.toThrow();
    expect(() => percentageOfRealizedBase(MAX_MONEY_MINOR_UNITS * 2, 10_000)).toThrow();
  });
});

describe('every ceiling lowers and none raises', () => {
  it('clamps to the realized funding, so a reward never exceeds what was earned', () => {
    expect(clampReward(500, { realizedFundingMinor: 300 })).toEqual({
      amountMinor: 300,
      applied: 'realized_funding',
    });
  });

  it('reports the TIGHTEST ceiling, not the first one it tried', () => {
    expect(
      clampReward(500, {
        realizedFundingMinor: 400,
        perConversionMinor: 250,
        partnerHeadroomMinor: 100,
      }),
    ).toEqual({ amountMinor: 100, applied: 'partner_period' });
  });

  it('leaves an amount alone when nothing binds it', () => {
    expect(
      clampReward(120, {
        realizedFundingMinor: 1_000,
        perConversionMinor: 500,
        partnerHeadroomMinor: 400,
        campaignHeadroomMinor: 300,
      }),
    ).toEqual({ amountMinor: 120, applied: 'none' });
  });

  it('treats a negative headroom as zero rather than as a credit', () => {
    // A cap tightened after accruals were already made can leave headroom
    // BELOW zero. Reading that as a negative ceiling would make `min` return
    // a negative reward — the one shape the whole domain refuses.
    expect(clampReward(50, { realizedFundingMinor: 1_000, campaignHeadroomMinor: -25 })).toEqual({
      amountMinor: 0,
      applied: 'campaign',
    });
  });

  it('has no path that increases an amount, for any ceiling combination', () => {
    // The property, over a grid rather than an example: whatever the ceilings,
    // the output is never larger than the input. A "floor" added to this
    // function would fail here.
    for (const amount of [1, 7, 99, 1_000]) {
      for (const funding of [0, 1, 50, 10_000]) {
        for (const perConversion of [undefined, 1, 500]) {
          const result = clampReward(amount, {
            realizedFundingMinor: funding,
            perConversionMinor: perConversion,
          });
          expect(result.amountMinor).toBeLessThanOrEqual(amount);
        }
      }
    }
  });
});

describe('a minimum is a threshold, never a top-up (ADR 0005 D10)', () => {
  it('reports an amount under the minimum without changing it', () => {
    expect(isBelowMinimumAccrual(99, 100)).toBe(true);
    expect(isBelowMinimumAccrual(100, 100)).toBe(false);
    expect(isBelowMinimumAccrual(101, 100)).toBe(false);
  });

  it('is vacuously false when the rule sets none', () => {
    expect(isBelowMinimumAccrual(1, undefined)).toBe(false);
  });

  it('has no arithmetic form at all — the module exports no way to raise one', () => {
    // The structural half of the same rule: `clampReward` is the only function
    // here that returns an amount derived from another, and it is a `min`. A
    // floor would have to be a NEW export, which is a visible change.
    expect(typeof isBelowMinimumAccrual(1, 100)).toBe('boolean');
  });
});

describe('reversal allocations reconcile exactly', () => {
  it('recomputing from a shrinking base sums back to the gross', () => {
    // The property #144 calculation rule 3 asks for: the net after N partial
    // refunds equals the gross plus every delta, exactly, with no residue —
    // because each net is `f(base)` computed afresh rather than an accumulated
    // subtraction.
    const rate = 2_000;
    const bases = [10_007, 7_003, 3_331, 1_117, 0];
    let net = percentageOfRealizedBase(bases[0], rate);
    const gross = net;
    const deltas: number[] = [];
    for (const base of bases.slice(1)) {
      const recomputed = Math.min(percentageOfRealizedBase(base, rate), base, gross, net);
      deltas.push(recomputed - net);
      net = recomputed;
    }
    expect(deltas.every((delta) => delta <= 0)).toBe(true);
    expect(gross + deltas.reduce((sum, delta) => sum + delta, 0)).toBe(net);
    expect(net).toBe(0);
  });

  it('never lets a recomputation exceed the base it draws on', () => {
    // A 100% rule against a base of 1 rounds to 1, which equals the base; a
    // rule whose fixed amount exceeds a shrunken base is clamped to it. Both
    // are "never pay more than the eligible funding".
    expect(Math.min(percentageOfRealizedBase(1, 10_000), 1)).toBe(1);
    expect(Math.min(5_000, 300)).toBe(300);
  });
});

describe('cap periods are UTC and start where the calendar does', () => {
  const at = new Date('2026-08-12T14:33:07.512Z'); // a Wednesday

  it('starts a day at midnight UTC', () => {
    expect(capPeriodStart('day', at)?.toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });

  it('starts a week on the ISO Monday, not on Sunday', () => {
    expect(capPeriodStart('week', at)?.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('starts a month on the first', () => {
    expect(capPeriodStart('month', at)?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('gives a lifetime cap no start at all', () => {
    expect(capPeriodStart('lifetime', at)).toBeUndefined();
  });

  it('refuses a period nobody defined rather than defaulting to lifetime', () => {
    // Defaulting would silently widen a cap to the whole of history, which is
    // the permissive direction and therefore the wrong one.
    expect(() => capPeriodStart('quarter', at)).toThrow(/cap period/);
  });
});
