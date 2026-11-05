/**
 * The published commission is the one ADR 0018 decided: 5% + $0.30 per order on
 * store card sales in USD, processing included, and nothing on any sale that is
 * not a USD card sale — FairCoin above all.
 *
 * Run through the SAME pure selection and arithmetic checkout runs, so what
 * this pins is what an order is charged, not what the catalogue literally says.
 */

import { describe, expect, it } from 'vitest';
import type { CurrencyCode, OrderSellerType } from '@mercaria/shared-types';
import { FEE_SCHEDULE_CATALOG, type FeeScheduleDefinition } from '../catalog.js';
import { calculateFee, selectFeeSchedule, type EffectiveFeeSchedule } from '../fee-calculation.js';

function effective(definition: FeeScheduleDefinition): EffectiveFeeSchedule {
  return {
    scheduleKey: definition.scheduleKey,
    version: definition.version,
    name: definition.name,
    effectiveStart: definition.effectiveStart,
    effectiveEnd: null,
    eligibleSellerType: definition.eligibleSellerType ?? null,
    eligibleCurrency: definition.eligibleCurrency ?? null,
    percentageBps: definition.percentageBps,
    fixedFeeAmount: definition.fixedFee?.amount ?? null,
    fixedFeeCurrency: definition.fixedFee?.currency ?? null,
    minFeeMinor: null,
    maxFeeMinor: null,
    taxTreatment: definition.taxTreatment ?? 'unknown',
    refundPolicy: 'proportional',
    termsVersion: definition.termsVersion,
  };
}

const schedules = FEE_SCHEDULE_CATALOG.map(effective);
// The instant the newest catalogue version takes effect: derived from the
// catalogue rather than a literal, so the real clock never overtakes it.
const at = new Date(
  Math.max(...FEE_SCHEDULE_CATALOG.map((entry) => entry.effectiveStart.getTime())),
);

function select(sellerType: OrderSellerType, currency: CurrencyCode) {
  return selectFeeSchedule({ schedules, facts: { sellerType, currency }, at });
}

function feeOn(subtotalMinor: number): number {
  const schedule = select('store', 'USD');
  if (!schedule) throw new Error('no USD store schedule in the catalogue');
  return calculateFee({
    schedule,
    currency: 'USD',
    lines: [{ lineTotalMinor: subtotalMinor, discountMinor: 0 }],
  }).feeMinor;
}

describe('the published marketplace commission (ADR 0018)', () => {
  it('holds no EUR schedule: the unpublished EUR rate is retired, not kept', () => {
    expect(FEE_SCHEDULE_CATALOG.some((entry) => entry.eligibleCurrency === 'EUR')).toBe(false);
    expect(select('store', 'EUR')).toBeUndefined();
  });

  it('charges 5% + $0.30 per order on a store’s USD card sale', () => {
    expect(feeOn(10_000)).toBe(530); // $100.00 → $5.30
    expect(feeOn(2_000)).toBe(130); // $20.00 → $1.30
    expect(feeOn(999)).toBe(80); // $9.99 → 49.95¢ rounds half-up to 50¢, + 30¢
  });

  it('never charges more than the item subtotal', () => {
    expect(feeOn(25)).toBe(25);
  });

  it('charges nothing on a FairCoin sale', () => {
    expect(select('store', 'FAIR')).toBeUndefined();
    expect(select('user', 'FAIR')).toBeUndefined();
  });

  it('reaches no individual seller until a P2P acceptance surface exists', () => {
    // A schedule reaching `user` sellers would take their checkout offline
    // (`merchant-activation/checkout-gate.ts`), so the catalogue must not.
    expect(select('user', 'USD')).toBeUndefined();
  });

  it('every version is unique by key and version', () => {
    const ids = FEE_SCHEDULE_CATALOG.map((entry) => `${entry.scheduleKey}@${entry.version}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
