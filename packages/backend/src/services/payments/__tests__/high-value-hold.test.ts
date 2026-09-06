/**
 * WHEN a seller's share waits, and why the default direction is the OPPOSITE of
 * `three-d-secure.ts`'s.
 *
 * The policy is pure and takes its thresholds and window as arguments rather
 * than reading `config`, so both branches are reachable here whatever this
 * deployment happens to be configured with — the same rule the 3DS matrix
 * follows next door.
 *
 * The asymmetry between the two modules is the thing most likely to be "fixed"
 * by somebody making them consistent, so it is pinned as a case of its own with
 * the reason attached.
 */

import { describe, expect, it } from 'vitest';
import { ALL_CURRENCY_CODES, type CurrencyCode, type Money } from '@mercaria/shared-types';
import { highValueHoldFor, parseHighValueHoldThresholds } from '../high-value-hold.js';

const isKnown = (code: string): code is CurrencyCode =>
  (ALL_CURRENCY_CODES as readonly string[]).includes(code);

const eur = (amount: number): Money => ({ amount, currency: 'EUR' });

/** 72 hours, the shipped default. */
const WINDOW = 72 * 60 * 60 * 1_000;
const SETTLEABLE_SINCE = new Date('2026-09-01T00:00:00.000Z');
/** One hour into the window: held under any policy that holds at all. */
const INSIDE = new Date(SETTLEABLE_SINCE.getTime() + 60 * 60 * 1_000);

describe('which transfers wait', () => {
  it('holds at and above the threshold, and settles below it', () => {
    const thresholds = { EUR: 100_000 } as const;
    const at = (amount: number) =>
      highValueHoldFor({
        amount: eur(amount),
        settleableSince: SETTLEABLE_SINCE,
        now: INSIDE,
        thresholds,
        windowMs: WINDOW,
      });

    expect(at(99_999).outcome).toBe('settle');
    // INCLUSIVE, like the 3DS boundary and for the same reason: a threshold of
    // "a thousand euros" that let a thousand-euro transfer straight through is
    // off by one in the direction that loses money.
    expect(at(100_000).outcome).toBe('hold');
    expect(at(100_001).outcome).toBe('hold');
  });

  it('settles EVERY transfer in a currency with no threshold', () => {
    // The fail-OPEN direction, and the whole reason this file exists separately
    // from `three-d-secure.test.ts`. Were the default reversed to match that
    // module, a deployment that configured nothing would freeze every payout it
    // ever made — an outage that reads as caution. Absent the missing-entry
    // branch, these two would come back `hold` and the assertion would fail.
    expect(
      highValueHoldFor({
        amount: eur(10_000_000),
        settleableSince: SETTLEABLE_SINCE,
        now: INSIDE,
        thresholds: {},
        windowMs: WINDOW,
      }).outcome,
    ).toBe('settle');
    expect(
      highValueHoldFor({
        amount: { amount: 10_000_000, currency: 'USD' },
        settleableSince: SETTLEABLE_SINCE,
        now: INSIDE,
        thresholds: { EUR: 100_000 },
        windowMs: WINDOW,
      }).outcome,
    ).toBe('settle');
  });

  it('settles when the window is zero or negative, however large the amount', () => {
    // `STRIPE_HIGH_VALUE_HOLD_WINDOW_MS=0` is how a deployment turns the hold
    // off without editing the thresholds. Without the guard the releasable
    // instant would equal `settleableSince`, which the `>=` comparison would
    // then settle anyway — so this case is not redundant with the boundary
    // below, it is what stops a NEGATIVE window producing a hold in the past.
    for (const windowMs of [0, -1, -WINDOW]) {
      expect(
        highValueHoldFor({
          amount: eur(10_000_000),
          settleableSince: SETTLEABLE_SINCE,
          now: INSIDE,
          thresholds: { EUR: 100_000 },
          windowMs,
        }).outcome,
      ).toBe('settle');
    }
  });
});

describe('when the wait ends', () => {
  const held = (now: Date) =>
    highValueHoldFor({
      amount: eur(500_000),
      settleableSince: SETTLEABLE_SINCE,
      now,
      thresholds: { EUR: 100_000 },
      windowMs: WINDOW,
    });

  it('names the releasable instant, and it is the anchor plus the window', () => {
    const decision = held(INSIDE);
    expect(decision.outcome).toBe('hold');
    // Read off the decision rather than recomputed from the same expression the
    // implementation uses: an assertion written as `anchor + WINDOW` on both
    // sides would agree with any anchor the function chose, including the wrong
    // one.
    if (decision.outcome !== 'hold') throw new Error('unreachable');
    expect(decision.releasableAt.toISOString()).toBe('2026-09-04T00:00:00.000Z');
  });

  it('settles on the millisecond the window closes, not one sweep later', () => {
    const releasableAt = new Date(SETTLEABLE_SINCE.getTime() + WINDOW);
    expect(held(new Date(releasableAt.getTime() - 1)).outcome).toBe('hold');
    expect(held(releasableAt).outcome).toBe('settle');
    expect(held(new Date(releasableAt.getTime() + 1)).outcome).toBe('settle');
  });
});

describe('reading STRIPE_HIGH_VALUE_HOLD_THRESHOLDS', () => {
  it('accepts a per-currency map in minor units', () => {
    expect(parseHighValueHoldThresholds('EUR:100000, usd:250000', isKnown)).toEqual({
      thresholds: { EUR: 100_000, USD: 250_000 },
      rejected: [],
    });
  });

  it('rejects an entry rather than guessing, and names it', () => {
    // Every rejected entry leaves its currency with NO hold, which settles —
    // the same direction as the missing-entry default. A typo therefore costs
    // exposure and not an outage, which is why it is a rejection and not a
    // refusal to boot.
    const parsed = parseHighValueHoldThresholds(
      'EUR:100000,XYZ:1,USD:,USD:abc,EUR,GBP:0,GBP:-5,USD:1e6',
      isKnown,
    );
    expect(parsed.thresholds).toEqual({ EUR: 100_000 });
    expect(parsed.rejected).toEqual([
      'XYZ:1',
      'USD:',
      'USD:abc',
      'EUR',
      'GBP:0',
      'GBP:-5',
      'USD:1e6',
    ]);
  });

  it('reads an empty setting as no thresholds at all', () => {
    expect(parseHighValueHoldThresholds('', isKnown)).toEqual({ thresholds: {}, rejected: [] });
    expect(parseHighValueHoldThresholds('  ,  ,', isKnown)).toEqual({
      thresholds: {},
      rejected: [],
    });
  });
});
