/**
 * The replenishment arithmetic, as numbers a merchant could check by hand.
 *
 * Each case is chosen to exercise a distinction the function exists to make: a
 * young variant measured over its own age beside an old one measured over the
 * window, an oversold level beside an empty one, a variant that never sold
 * beside one that sold and is now out, and a float product that must not round
 * up to an extra unit.
 */

import { describe, expect, it } from 'vitest';
import type { ReplenishmentPlanRow } from '@mercaria/shared-types';
import {
  addDaysIsoDate,
  averageDailyDemand,
  effectiveSettings,
  observedDays,
  projectStock,
  wholeDaysBetween,
} from '../forecast.js';
import { comparePlanRows, toReplenishmentCsv } from '../plan.service.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const SETTINGS = { leadTimeDays: 10, targetCoverDays: 20, safetyStockDays: 5 };

describe('averageDailyDemand', () => {
  it('is zero for a variant that never sold', () => {
    expect(averageDailyDemand({ unitsRecent: 0, unitsLong: 0, ageDays: 400 })).toBe(0);
  });

  it('blends the recent month at 60% and the quarter at 40%', () => {
    // 28 in 28 days = 1/day; 90 in 90 days = 1/day -> 1.
    expect(averageDailyDemand({ unitsRecent: 28, unitsLong: 90, ageDays: 400 })).toBeCloseTo(1, 10);
    // 56 recent (2/day) and 90 long (1/day) -> 0.6*2 + 0.4*1 = 1.6.
    expect(averageDailyDemand({ unitsRecent: 56, unitsLong: 90, ageDays: 400 })).toBeCloseTo(
      1.6,
      10,
    );
  });

  it('measures a young variant over its own age, so a new launch is not diluted by 90 days', () => {
    // 20 days old, 20 units: 1/day in both windows, not 20/90.
    expect(averageDailyDemand({ unitsRecent: 20, unitsLong: 20, ageDays: 20 })).toBeCloseTo(1, 10);
  });

  it('never measures over fewer than seven days, so one early sale is not a rate of one a day', () => {
    expect(observedDays(28, 1)).toBe(7);
    expect(observedDays(90, 0)).toBe(7);
    expect(observedDays(28, 400)).toBe(28);
    expect(averageDailyDemand({ unitsRecent: 1, unitsLong: 1, ageDays: 1 })).toBeCloseTo(1 / 7, 10);
  });

  it('refuses a negative count and a long window smaller than the recent one', () => {
    expect(averageDailyDemand({ unitsRecent: -5, unitsLong: -5, ageDays: 400 })).toBe(0);
    // The long window includes the recent one; a smaller value is clamped up.
    expect(averageDailyDemand({ unitsRecent: 28, unitsLong: 0, ageDays: 400 })).toBeCloseTo(
      0.6 + (0.4 * 28) / 90,
      10,
    );
  });
});

describe('projectStock', () => {
  it('suggests demand × (lead + cover + safety) − available, rounded up', () => {
    // 2/day × 35 days = 70; 30 on hand -> 40.
    const projection = projectStock({
      demandPerDay: 2,
      available: 30,
      settings: SETTINGS,
      now: NOW,
    });
    expect(projection.suggestedOrderQuantity).toBe(40);
    expect(projection.reorderPoint).toBe(30);
    expect(projection.daysOfCover).toBe(15);
    expect(projection.projectedStockoutDate).toBe('2026-06-25');
    expect(projection.status).toBe('reorder_now');
  });

  it('is healthy above the reorder point and never suggests a negative quantity', () => {
    const projection = projectStock({
      demandPerDay: 1,
      available: 500,
      settings: SETTINGS,
      now: NOW,
    });
    expect(projection.status).toBe('healthy');
    expect(projection.suggestedOrderQuantity).toBe(0);
    expect(projection.daysOfCover).toBe(500);
  });

  it('does not round float noise up to an extra unit', () => {
    // 0.1 × 30 is 3.0000000000000004 in floating point.
    const projection = projectStock({
      demandPerDay: 0.1,
      available: 0,
      settings: { leadTimeDays: 10, targetCoverDays: 15, safetyStockDays: 5 },
      now: NOW,
    });
    expect(projection.suggestedOrderQuantity).toBe(3);
  });

  it('rounds a fractional need up, so it never under-orders', () => {
    const projection = projectStock({
      demandPerDay: 0.25,
      available: 3,
      settings: SETTINGS,
      now: NOW,
    });
    // 0.25 × 35 = 8.75 − 3 = 5.75 -> 6.
    expect(projection.suggestedOrderQuantity).toBe(6);
  });

  it('a variant with no sales and no stock is no_recent_sales with nothing to buy', () => {
    const projection = projectStock({
      demandPerDay: 0,
      available: 0,
      settings: SETTINGS,
      now: NOW,
    });
    expect(projection).toEqual({
      daysOfCover: null,
      projectedStockoutDate: null,
      reorderPoint: 0,
      suggestedOrderQuantity: 0,
      status: 'no_recent_sales',
    });
  });

  it('a selling variant with nothing left is stocked out today', () => {
    const projection = projectStock({
      demandPerDay: 1,
      available: 0,
      settings: SETTINGS,
      now: NOW,
    });
    expect(projection.status).toBe('stocked_out');
    expect(projection.daysOfCover).toBe(0);
    expect(projection.projectedStockoutDate).toBe('2026-06-10');
    expect(projection.suggestedOrderQuantity).toBe(35);
  });

  it('an oversold level is stocked out and the suggestion makes up the deficit', () => {
    const selling = projectStock({ demandPerDay: 1, available: -4, settings: SETTINGS, now: NOW });
    expect(selling.status).toBe('stocked_out');
    expect(selling.daysOfCover).toBe(0);
    expect(selling.suggestedOrderQuantity).toBe(39);

    // Even with no recent demand the oversold units are owed.
    const idle = projectStock({ demandPerDay: 0, available: -4, settings: SETTINGS, now: NOW });
    expect(idle.status).toBe('stocked_out');
    expect(idle.projectedStockoutDate).toBe('2026-06-10');
    expect(idle.suggestedOrderQuantity).toBe(4);
  });

  it('projects the stock-out on the day the last whole day of cover ends', () => {
    // 10 units at 3/day lasts 3.33 days -> runs out during day 3.
    const projection = projectStock({
      demandPerDay: 3,
      available: 10,
      settings: SETTINGS,
      now: NOW,
    });
    expect(projection.projectedStockoutDate).toBe(addDaysIsoDate(NOW, 3));
  });

  it('with zero target cover, stock exactly at the reorder point needs nothing and is healthy', () => {
    const projection = projectStock({
      demandPerDay: 1,
      available: 15,
      settings: { leadTimeDays: 10, targetCoverDays: 0, safetyStockDays: 5 },
      now: NOW,
    });
    expect(projection.reorderPoint).toBe(15);
    expect(projection.suggestedOrderQuantity).toBe(0);
    expect(projection.status).toBe('healthy');
  });
});

describe('effectiveSettings', () => {
  it('lays a partial override over the store and says it did', () => {
    expect(
      effectiveSettings(SETTINGS, {
        leadTimeDays: 30,
        targetCoverDays: null,
        safetyStockDays: null,
      }),
    ).toEqual({ leadTimeDays: 30, targetCoverDays: 20, safetyStockDays: 5, overridden: true });
    expect(effectiveSettings(SETTINGS, undefined)).toEqual({ ...SETTINGS, overridden: false });
  });

  it('a zero override is a value, not an absence', () => {
    expect(
      effectiveSettings(SETTINGS, { leadTimeDays: 0, targetCoverDays: null, safetyStockDays: 0 }),
    ).toEqual({ leadTimeDays: 0, targetCoverDays: 20, safetyStockDays: 0, overridden: true });
  });
});

describe('wholeDaysBetween', () => {
  it('floors and never goes negative', () => {
    expect(wholeDaysBetween(new Date('2026-06-01T13:00:00Z'), NOW)).toBe(8);
    expect(wholeDaysBetween(new Date('2026-07-01T00:00:00Z'), NOW)).toBe(0);
  });
});

function row(overrides: Partial<ReplenishmentPlanRow>): ReplenishmentPlanRow {
  return {
    variantId: 'v',
    listingId: 'l',
    productTitle: 'Product',
    variantTitle: 'Default',
    sku: null,
    locationId: null,
    unitsSoldRecent: 0,
    unitsSoldLong: 0,
    averageDailyDemand: 0,
    available: 0,
    committed: 0,
    onHand: 0,
    daysOfCover: null,
    projectedStockoutDate: null,
    leadTimeDays: 14,
    targetCoverDays: 28,
    safetyStockDays: 7,
    overridden: false,
    reorderPoint: 0,
    suggestedOrderQuantity: 0,
    status: 'no_recent_sales',
    ...overrides,
  };
}

describe('the prioritised order', () => {
  it('puts the soonest stock-out first, then the biggest suggestion, and no-forecast rows last', () => {
    const rows = [
      row({ variantId: 'none', projectedStockoutDate: null }),
      row({ variantId: 'later', projectedStockoutDate: '2026-07-01' }),
      row({
        variantId: 'soon-small',
        projectedStockoutDate: '2026-06-12',
        suggestedOrderQuantity: 2,
      }),
      row({
        variantId: 'soon-big',
        projectedStockoutDate: '2026-06-12',
        suggestedOrderQuantity: 9,
      }),
    ];
    expect([...rows].sort(comparePlanRows).map((r) => r.variantId)).toEqual([
      'soon-big',
      'soon-small',
      'later',
      'none',
    ]);
  });
});

describe('the CSV', () => {
  it('guards a formula-looking title and keeps numbers bare', () => {
    const csv = toReplenishmentCsv({
      storeId: 's',
      generatedAt: NOW.toISOString(),
      locationId: null,
      locations: [],
      settings: SETTINGS,
      windowDays: { recent: 28, long: 90 },
      rows: [row({ productTitle: '=HYPERLINK("x")', available: -2, suggestedOrderQuantity: 7 })],
      totalRows: 1,
      truncated: false,
      summary: { stockedOut: 0, reorderNow: 0, healthy: 0, noRecentSales: 1, suggestedUnits: 7 },
    });
    const [header, line] = csv.trim().split('\n');
    expect(header).toContain('"units_sold_28d"');
    expect(line?.startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
    expect(line).toContain(',7,');
    expect(line).toContain(',-2,');
    expect(line).toContain('"All locations"');
  });
});
