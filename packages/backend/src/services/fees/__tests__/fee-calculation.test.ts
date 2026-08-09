/**
 * The pure fee arithmetic (#88), table-tested against worked examples — the
 * same shape as `ledger-postings.test.ts`, because the commission is the part
 * that has to be right the first time.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateFee,
  formatMinor,
  selectFeeSchedule,
  type EffectiveFeeSchedule,
} from '../fee-calculation.js';

/** A schedule with sane defaults; tests override what they exercise. */
function schedule(overrides: Partial<EffectiveFeeSchedule> = {}): EffectiveFeeSchedule {
  return {
    scheduleKey: 'standard',
    version: 1,
    name: 'Standard marketplace fee',
    effectiveStart: new Date('2026-01-01T00:00:00Z'),
    effectiveEnd: null,
    eligibleSellerType: null,
    eligibleCurrency: null,
    percentageBps: 1_000, // 10%
    fixedFeeAmount: null,
    fixedFeeCurrency: null,
    minFeeMinor: null,
    maxFeeMinor: null,
    taxTreatment: 'unknown',
    refundPolicy: 'proportional',
    termsVersion: 'v1',
    ...overrides,
  };
}

describe('calculateFee — the percentage component', () => {
  it('charges exactly the percentage of the discounted item subtotal', () => {
    const result = calculateFee({
      schedule: schedule(),
      currency: 'EUR',
      lines: [{ lineTotalMinor: 4_000, discountMinor: 0 }],
    });
    expect(result.basisMinor).toBe(4_000);
    expect(result.feeMinor).toBe(400);
    expect(result.roundingAdjustmentMinor).toBe(0);
    expect(result.lineAllocationsMinor).toEqual([400]);
  });

  it('excludes the discount from the basis — a discount reduces the fee', () => {
    const result = calculateFee({
      schedule: schedule(),
      currency: 'EUR',
      lines: [{ lineTotalMinor: 4_000, discountMinor: 1_000 }],
    });
    expect(result.basisMinor).toBe(3_000);
    expect(result.feeMinor).toBe(300);
  });

  it('clamps an over-allocated line discount to a zero base, never negative', () => {
    const result = calculateFee({
      schedule: schedule(),
      currency: 'EUR',
      lines: [
        { lineTotalMinor: 1_000, discountMinor: 1_500 },
        { lineTotalMinor: 2_000, discountMinor: 0 },
      ],
    });
    // The first line contributes 0, not −500 — an over-discounted line must not
    // shrink a sibling's fee.
    expect(result.basisMinor).toBe(2_000);
    expect(result.feeMinor).toBe(200);
    expect(result.lineAllocationsMinor).toEqual([0, 200]);
  });

  it('rounds HALF-UP exactly once, at the order level, and records the unit', () => {
    // 10% of 105 = 10.5 → 11, adjustment 1.
    const up = calculateFee({
      schedule: schedule(),
      currency: 'EUR',
      lines: [{ lineTotalMinor: 105, discountMinor: 0 }],
    });
    expect(up.feeMinor).toBe(11);
    expect(up.roundingAdjustmentMinor).toBe(1);

    // 10% of 104 = 10.4 → 10, adjustment 0.
    const down = calculateFee({
      schedule: schedule(),
      currency: 'EUR',
      lines: [{ lineTotalMinor: 104, discountMinor: 0 }],
    });
    expect(down.feeMinor).toBe(10);
    expect(down.roundingAdjustmentMinor).toBe(0);
  });

  it('is deterministic: the same commercial facts produce a byte-identical result', () => {
    // The whole of guest/authenticated equivalence lives in the SIGNATURE — no
    // parameter carries a buyer, a session or a claim — so equivalence reduces
    // to determinism, asserted here rather than assumed.
    const input = {
      schedule: schedule({ fixedFeeAmount: 30, fixedFeeCurrency: 'EUR' as const, eligibleCurrency: 'EUR' as const }),
      currency: 'EUR' as const,
      lines: [
        { lineTotalMinor: 3_333, discountMinor: 111 },
        { lineTotalMinor: 777, discountMinor: 0 },
      ],
    };
    expect(calculateFee(input)).toEqual(calculateFee(input));
  });
});

describe('calculateFee — fixed component and clamps', () => {
  it('adds the fixed component after the percentage', () => {
    const result = calculateFee({
      schedule: schedule({
        eligibleCurrency: 'EUR',
        fixedFeeAmount: 30,
        fixedFeeCurrency: 'EUR',
      }),
      currency: 'EUR',
      lines: [{ lineTotalMinor: 4_000, discountMinor: 0 }],
    });
    expect(result.feeMinor).toBe(430);
  });

  it('raises to the minimum and records the clamp', () => {
    const result = calculateFee({
      schedule: schedule({ eligibleCurrency: 'EUR', minFeeMinor: 100 }),
      currency: 'EUR',
      lines: [{ lineTotalMinor: 500, discountMinor: 0 }], // 10% = 50 < 100
    });
    expect(result.feeMinor).toBe(100);
    expect(result.clampApplied).toBe('min');
  });

  it('caps at the maximum and records the clamp', () => {
    const result = calculateFee({
      schedule: schedule({ eligibleCurrency: 'EUR', maxFeeMinor: 250 }),
      currency: 'EUR',
      lines: [{ lineTotalMinor: 4_000, discountMinor: 0 }], // 10% = 400 > 250
    });
    expect(result.feeMinor).toBe(250);
    expect(result.clampApplied).toBe('max');
  });

  it('never exceeds its own basis, whatever the minimum says', () => {
    const result = calculateFee({
      schedule: schedule({ eligibleCurrency: 'EUR', minFeeMinor: 500 }),
      currency: 'EUR',
      lines: [{ lineTotalMinor: 300, discountMinor: 0 }],
    });
    // min 500 > basis 300 → the whole basis and no more. Trust rule 6's "no
    // negative fee" has a mirror: no negative NET either.
    expect(result.feeMinor).toBe(300);
    expect(result.explanation).toContain('never exceeds');
  });

  it('refuses a fixed component in another currency rather than converting', () => {
    expect(() =>
      calculateFee({
        schedule: schedule({
          eligibleCurrency: 'EUR',
          fixedFeeAmount: 30,
          fixedFeeCurrency: 'EUR',
        }),
        currency: 'USD',
        lines: [{ lineTotalMinor: 4_000, discountMinor: 0 }],
      }),
    ).toThrow(/never mixes currencies/);
  });

  it('refuses a clamp whose pinned currency is not the order currency', () => {
    expect(() =>
      calculateFee({
        schedule: schedule({ eligibleCurrency: 'EUR', minFeeMinor: 100 }),
        currency: 'USD',
        lines: [{ lineTotalMinor: 4_000, discountMinor: 0 }],
      }),
    ).toThrow(/never mixes currencies/);
  });
});

describe('calculateFee — currencies at their own precisions', () => {
  it('works in zero-decimal JPY minor units', () => {
    const result = calculateFee({
      schedule: schedule({ percentageBps: 850 }), // 8.5%
      currency: 'JPY',
      lines: [{ lineTotalMinor: 10_000, discountMinor: 0 }], // ¥10,000
    });
    expect(result.feeMinor).toBe(850);
  });

  it('works at FAIR precision without losing minor units to float arithmetic', () => {
    // 7.77% of 3 ⊜ (300,000,000 minor). 300_000_000 × 777 overflows nothing in
    // bigint and must come back exact: 23,310,000.
    const result = calculateFee({
      schedule: schedule({ percentageBps: 777 }),
      currency: 'FAIR',
      lines: [{ lineTotalMinor: 300_000_000, discountMinor: 0 }],
    });
    expect(result.feeMinor).toBe(23_310_000);
  });

  it('formats minor units at the currency precision', () => {
    expect(formatMinor(12_345, 'EUR')).toBe('123.45 EUR');
    expect(formatMinor(850, 'JPY')).toBe('850 JPY');
    expect(formatMinor(23_310_000, 'FAIR')).toBe('0.23310000 FAIR');
  });
});

describe('calculateFee — line allocations reconcile exactly', () => {
  it('splits an odd fee by largest remainder and sums to the order fee exactly', () => {
    const result = calculateFee({
      schedule: schedule(),
      currency: 'EUR',
      lines: [
        { lineTotalMinor: 333, discountMinor: 0 },
        { lineTotalMinor: 333, discountMinor: 0 },
        { lineTotalMinor: 335, discountMinor: 0 },
      ],
    });
    // 10% of 1001 = 100.1 → 100.
    expect(result.feeMinor).toBe(100);
    const sum = result.lineAllocationsMinor.reduce((total, part) => total + part, 0);
    expect(sum).toBe(result.feeMinor);
    // The largest fractional part (the 335 line) takes the leftover unit;
    // the two tied lines keep input order. Deterministic, so a replay allocates
    // identically.
    expect(result.lineAllocationsMinor).toEqual([33, 33, 34]);
  });

  it('reconciles across many random splits — no unit ever lost or invented', () => {
    for (let round = 0; round < 200; round += 1) {
      const lineCount = 1 + Math.floor(Math.random() * 6);
      const lines = Array.from({ length: lineCount }, () => {
        const lineTotalMinor = Math.floor(Math.random() * 100_000);
        return { lineTotalMinor, discountMinor: Math.floor(Math.random() * lineTotalMinor * 1.2) };
      });
      const bps = Math.floor(Math.random() * 10_001);
      const result = calculateFee({
        schedule: schedule({ percentageBps: bps }),
        currency: 'EUR',
        lines,
      });
      const sum = result.lineAllocationsMinor.reduce((total, part) => total + part, 0);
      expect(sum).toBe(result.feeMinor);
      expect(result.feeMinor).toBeGreaterThanOrEqual(0);
      expect(result.feeMinor).toBeLessThanOrEqual(result.basisMinor);
    }
  });
});

describe('selectFeeSchedule — the schedule effective at pricing time', () => {
  const facts = { sellerType: 'store', currency: 'EUR' } as const;

  it('selects only inside the effective window', () => {
    const s = schedule({ effectiveStart: new Date('2026-06-01T00:00:00Z'), effectiveEnd: new Date('2026-07-01T00:00:00Z') });
    expect(selectFeeSchedule({ schedules: [s], facts, at: new Date('2026-05-31T23:59:59Z') })).toBeUndefined();
    expect(selectFeeSchedule({ schedules: [s], facts, at: new Date('2026-06-15T00:00:00Z') })).toBe(s);
    // The end is EXCLUSIVE — `[start, end)`.
    expect(selectFeeSchedule({ schedules: [s], facts, at: new Date('2026-07-01T00:00:00Z') })).toBeUndefined();
  });

  it('matches scope facts and nothing else', () => {
    const storeOnly = schedule({ eligibleSellerType: 'store' });
    const usdOnly = schedule({ eligibleCurrency: 'USD' });
    const at = new Date('2026-06-01T00:00:00Z');
    expect(selectFeeSchedule({ schedules: [storeOnly], facts: { sellerType: 'user', currency: 'EUR' }, at })).toBeUndefined();
    expect(selectFeeSchedule({ schedules: [storeOnly], facts, at })).toBe(storeOnly);
    expect(selectFeeSchedule({ schedules: [usdOnly], facts, at })).toBeUndefined();
  });

  it('refuses TWO matching schedules loudly — ambiguity fails before payment', () => {
    const a = schedule({ scheduleKey: 'a' });
    const b = schedule({ scheduleKey: 'b' });
    expect(() =>
      selectFeeSchedule({ schedules: [a, b], facts, at: new Date('2026-06-01T00:00:00Z') }),
    ).toThrow(/ambiguous/i);
  });

  it('a version effective later never selects for an earlier pricing time', () => {
    // Acceptance 3, at the selection layer: a new version cannot reach back.
    const v1 = schedule({ version: 1, effectiveStart: new Date('2026-01-01T00:00:00Z'), effectiveEnd: new Date('2026-06-01T00:00:00Z') });
    const v2 = schedule({ version: 2, effectiveStart: new Date('2026-06-01T00:00:00Z') });
    const before = selectFeeSchedule({ schedules: [v1, v2], facts, at: new Date('2026-03-01T00:00:00Z') });
    const after = selectFeeSchedule({ schedules: [v1, v2], facts, at: new Date('2026-07-01T00:00:00Z') });
    expect(before?.version).toBe(1);
    expect(after?.version).toBe(2);
  });
});
