/**
 * The pilot's two pure decisions, driven over their boundaries (#125).
 *
 * `deriveRetailPilotAdmission` and `evaluateStopThresholds` are pure precisely
 * so this file can exist: a safety bound is wrong exactly AT its boundary, and
 * a test that needed a database to reach one would exercise two or three cases
 * instead of every one.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveRetailPilotAdmission,
  type RetailPilotBounds,
  type RetailPilotRequest,
  type RetailPilotState,
} from '../admission.js';
import {
  evaluateStopThresholds,
  PRINTFUL_PILOT_RECOMMENDED_THRESHOLDS,
  type RetailPilotMeasurement,
  type RetailPilotThreshold,
} from '../thresholds.js';

const BOUNDS: RetailPilotBounds = {
  cohortId: 'cohort-1',
  version: 1,
  supplierId: 'supplier-1',
  supplierAccountId: 'account-1',
  marketCountry: 'ES',
  currency: 'EUR',
  audience: 'public',
  audiencePercentageBps: null,
  maxItemTotalMinor: 5_000,
  maxOrderTotalMinor: 15_000,
  minOrderTotalMinor: 1_500,
  maxLineQuantity: 5,
  permittedShippingServiceCodes: ['STANDARD'],
  fundingFloorMinor: 10_000,
  fundingCurrency: 'EUR',
  fundingObservationMaxAgeSeconds: 86_400,
};

const NOW = new Date('2026-08-10T12:00:00.000Z');

function state(overrides: Partial<RetailPilotState> = {}): RetailPilotState {
  return {
    bounds: BOUNDS,
    allowlistedSkus: new Set(['4012']),
    liveStops: [],
    funding: { balanceMinor: 100_000, currency: 'EUR', observedAt: NOW },
    ...overrides,
  };
}

function request(overrides: Partial<RetailPilotRequest> = {}): RetailPilotRequest {
  return {
    supplierId: 'supplier-1',
    supplierAccountId: 'account-1',
    supplierSku: '4012',
    destinationCountry: 'ES',
    currency: 'EUR',
    quantity: 1,
    lineTotalMinor: 3_000,
    orderTotalMinor: 3_000,
    shippingServiceCode: 'STANDARD',
    audience: 'public',
    at: NOW,
    ...overrides,
  };
}

describe('the pilot admits only what a published cohort names', () => {
  it('admits a line inside every bound, naming the cohort version', () => {
    const admission = deriveRetailPilotAdmission(state(), request());
    expect(admission).toEqual({ outcome: 'admitted', cohortVersion: 1 });
  });

  it('refuses everything when no cohort is published', () => {
    // A deployment that has published no bounds refuses every retail line, which
    // is why this domain needs no kill switch of its own — an empty pilot IS
    // the off position.
    const admission = deriveRetailPilotAdmission(state({ bounds: null }), request());
    expect(admission).toEqual({ outcome: 'refused', reason: 'no_active_cohort' });
  });

  it('refuses a market, currency, supplier or SKU the cohort does not name', () => {
    const cases: { patch: Partial<RetailPilotRequest>; reason: string }[] = [
      { patch: { destinationCountry: 'FR' }, reason: 'market_not_in_pilot' },
      { patch: { currency: 'USD' }, reason: 'currency_not_in_pilot' },
      { patch: { supplierId: 'supplier-2' }, reason: 'supplier_not_in_pilot' },
      // BOTH halves of the supply side are checked: the account is what a
      // purchase order is placed against and the supplier is what an agreement
      // is signed with.
      { patch: { supplierAccountId: 'account-2' }, reason: 'supplier_not_in_pilot' },
      { patch: { supplierSku: '9999' }, reason: 'sku_not_allowlisted' },
    ];
    for (const testCase of cases) {
      expect(deriveRetailPilotAdmission(state(), request(testCase.patch))).toEqual({
        outcome: 'refused',
        reason: testCase.reason,
      });
    }
  });

  it('is exact at every value boundary, in both directions', () => {
    // A bound is wrong exactly AT its boundary, so each is driven at the value
    // that must pass and the one that must not.
    expect(deriveRetailPilotAdmission(state(), request({ quantity: 5 })).outcome).toBe('admitted');
    expect(deriveRetailPilotAdmission(state(), request({ quantity: 6 }))).toEqual({
      outcome: 'refused',
      reason: 'quantity_above_cohort_limit',
    });

    expect(
      deriveRetailPilotAdmission(
        state(),
        request({ lineTotalMinor: 5_000, orderTotalMinor: 5_000 }),
      ).outcome,
    ).toBe('admitted');
    expect(
      deriveRetailPilotAdmission(state(), request({ lineTotalMinor: 5_001, orderTotalMinor: 5_001 })),
    ).toEqual({ outcome: 'refused', reason: 'item_value_above_cohort_limit' });

    expect(
      deriveRetailPilotAdmission(
        state(),
        request({ lineTotalMinor: 5_000, orderTotalMinor: 15_000 }),
      ).outcome,
    ).toBe('admitted');
    expect(
      deriveRetailPilotAdmission(
        state(),
        request({ lineTotalMinor: 5_000, orderTotalMinor: 15_001 }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'order_value_above_cohort_limit' });

    // The MINIMUM is an honesty bound rather than a margin device: below it a
    // parcel's carriage dwarfs the goods.
    expect(
      deriveRetailPilotAdmission(
        state(),
        request({ lineTotalMinor: 1_500, orderTotalMinor: 1_500 }),
      ).outcome,
    ).toBe('admitted');
    expect(
      deriveRetailPilotAdmission(
        state(),
        request({ lineTotalMinor: 1_499, orderTotalMinor: 1_499 }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'order_value_below_cohort_minimum' });
  });

  it('treats an ABSENT shipping service as not permitted', () => {
    // An unnamed service cannot be checked against a list, and admitting it
    // would make the bound optional for whoever forgot to pin one.
    expect(deriveRetailPilotAdmission(state(), request({ shippingServiceCode: null }))).toEqual({
      outcome: 'refused',
      reason: 'shipping_service_not_permitted',
    });
    expect(
      deriveRetailPilotAdmission(state(), request({ shippingServiceCode: 'EXPRESS' })),
    ).toEqual({ outcome: 'refused', reason: 'shipping_service_not_permitted' });
  });

  it('reads the audience ladder in the narrow direction', () => {
    const staffCohort = state({ bounds: { ...BOUNDS, audience: 'staff' } });
    expect(deriveRetailPilotAdmission(staffCohort, request({ audience: 'staff' })).outcome).toBe(
      'admitted',
    );
    // A `staff` cohort admits nobody else — which is what makes the ladder's
    // narrow rungs a real bound while no staff or invite list exists.
    expect(deriveRetailPilotAdmission(staffCohort, request({ audience: 'invited' }))).toEqual({
      outcome: 'refused',
      reason: 'audience_not_in_cohort',
    });
    expect(deriveRetailPilotAdmission(staffCohort, request({ audience: 'public' }))).toEqual({
      outcome: 'refused',
      reason: 'audience_not_in_cohort',
    });
  });

  it('lets a live stop cover only what its scope names', () => {
    const skuStop = state({
      liveStops: [{ metric: 'product_safety_incident', scope: 'sku', scopeRef: '4012' }],
    });
    expect(deriveRetailPilotAdmission(skuStop, request())).toEqual({
      outcome: 'refused',
      reason: 'stop_threshold_active',
    });
    // A stop on ONE SKU does not stop another — which is the whole reason the
    // scope is per threshold rather than pilot-wide.
    const other = state({
      allowlistedSkus: new Set(['4012', '4013']),
      liveStops: [{ metric: 'product_safety_incident', scope: 'sku', scopeRef: '4012' }],
    });
    expect(deriveRetailPilotAdmission(other, request({ supplierSku: '4013' })).outcome).toBe(
      'admitted',
    );
    // And a `pilot`-scoped one covers everything.
    const pilotWide = state({
      liveStops: [{ metric: 'non_eu_dispatch_origin', scope: 'pilot', scopeRef: '' }],
    });
    expect(deriveRetailPilotAdmission(pilotWide, request())).toEqual({
      outcome: 'refused',
      reason: 'stop_threshold_active',
    });
  });

  it('matches a supplier stop EXACTLY, never by prefix', () => {
    // A prefix test would make a stop on `supplier-1` also stop
    // `supplier-10`, which is somebody else.
    const stopped = state({
      liveStops: [{ metric: 'late_dispatch', scope: 'supplier', scopeRef: 'supplier-10' }],
    });
    expect(deriveRetailPilotAdmission(stopped, request()).outcome).toBe('admitted');
  });

  it('refuses on absent, stale, foreign-currency or insufficient funding', () => {
    // Absence refuses. Unlike an absent TRUST signal (which withholds nothing,
    // because restricting on absence turns an outage into a delisting), an
    // absent BALANCE is Mercaria not knowing whether it can pay.
    expect(deriveRetailPilotAdmission(state({ funding: null }), request())).toEqual({
      outcome: 'refused',
      reason: 'supplier_funding_unavailable',
    });

    const stale = state({
      funding: {
        balanceMinor: 100_000,
        currency: 'EUR',
        observedAt: new Date(NOW.getTime() - 86_401_000),
      },
    });
    expect(deriveRetailPilotAdmission(stale, request())).toEqual({
      outcome: 'refused',
      reason: 'supplier_funding_unavailable',
    });

    // A balance in another currency is not a smaller balance, it is an
    // UNCOMPARABLE one — and this domain does no FX.
    const foreign = state({
      funding: { balanceMinor: 100_000, currency: 'USD', observedAt: NOW },
    });
    expect(deriveRetailPilotAdmission(foreign, request())).toEqual({
      outcome: 'refused',
      reason: 'supplier_funding_unavailable',
    });
  });

  it('compares the floor against the balance MINUS this order’s draw', () => {
    // A balance exactly at the floor does not stay there once the order is
    // procured, and a check that ignored the draw would admit the order that
    // empties the wallet. Floor 10_000, order 3_000 ⇒ 13_000 passes, 12_999
    // does not.
    const exact = state({ funding: { balanceMinor: 13_000, currency: 'EUR', observedAt: NOW } });
    expect(deriveRetailPilotAdmission(exact, request()).outcome).toBe('admitted');

    const short = state({ funding: { balanceMinor: 12_999, currency: 'EUR', observedAt: NOW } });
    expect(deriveRetailPilotAdmission(short, request())).toEqual({
      outcome: 'refused',
      reason: 'supplier_funding_unavailable',
    });
  });
});

describe('stop thresholds report what was NOT measured', () => {
  const rate: RetailPilotThreshold = {
    metric: 'supplier_stock_rejection',
    unit: 'rate_bps',
    thresholdValue: 200,
    windowHours: 168,
    scope: 'supplier',
  };
  const once: RetailPilotThreshold = {
    metric: 'non_eu_dispatch_origin',
    unit: 'count',
    thresholdValue: 0,
    windowHours: 0,
    scope: 'pilot',
  };

  function measurement(overrides: Partial<RetailPilotMeasurement> = {}): RetailPilotMeasurement {
    return {
      metric: 'supplier_stock_rejection',
      unit: 'rate_bps',
      value: 100,
      scopeRef: 'supplier-1',
      sampleSize: 100,
      ...overrides,
    };
  }

  it('reports a threshold nobody measured as UNMEASURED, never as within bounds', () => {
    // THE failure this module is shaped around: a monitor that reported "no
    // breaches" because it read nothing.
    expect(evaluateStopThresholds([rate], [])).toEqual([
      { outcome: 'unmeasured', metric: 'supplier_stock_rejection', reason: 'no_measurement' },
    ]);
  });

  it('refuses to compare a measurement in the wrong unit', () => {
    // A rate in basis points against a threshold in minor units is not a
    // smaller number, it is a different question.
    expect(evaluateStopThresholds([rate], [measurement({ unit: 'minor_units' })])).toEqual([
      { outcome: 'unmeasured', metric: 'supplier_stock_rejection', reason: 'unit_mismatch' },
    ]);
  });

  it('will not read a rate off a sample too small to mean anything', () => {
    // A 2% threshold against three orders fires on the first failure, which is
    // a signal about three orders rather than about the pilot.
    expect(
      evaluateStopThresholds([rate], [measurement({ value: 5_000, sampleSize: 3 })]),
    ).toEqual([{ outcome: 'unmeasured', metric: 'supplier_stock_rejection', reason: 'empty_sample' }]);
    // A COUNT has no such floor: one incident is one incident.
    expect(
      evaluateStopThresholds([once], [
        { metric: 'non_eu_dispatch_origin', unit: 'count', value: 1, scopeRef: '', sampleSize: 1 },
      ]),
    ).toEqual([
      {
        outcome: 'breached',
        metric: 'non_eu_dispatch_origin',
        scope: 'pilot',
        scopeRef: '',
        observedValue: 1,
        thresholdValue: 0,
      },
    ]);
  });

  it('breaches strictly ABOVE the threshold and not at it', () => {
    expect(evaluateStopThresholds([rate], [measurement({ value: 200 })])).toEqual([
      { outcome: 'within', metric: 'supplier_stock_rejection' },
    ]);
    expect(evaluateStopThresholds([rate], [measurement({ value: 201 })])[0]?.outcome).toBe(
      'breached',
    );
  });

  it('drops the scope reference for a pilot-wide threshold', () => {
    // A pilot-scoped stop covers everything, so carrying a subject would make
    // the live-stop unique key admit a second one for a different subject.
    const outcomes = evaluateStopThresholds(
      [{ ...once, scope: 'pilot' }],
      [
        {
          metric: 'non_eu_dispatch_origin',
          unit: 'count',
          value: 1,
          scopeRef: 'supplier-1',
          sampleSize: 1,
        },
      ],
    );
    expect(outcomes[0]).toMatchObject({ outcome: 'breached', scopeRef: '' });
  });

  it('recommends only thresholds #119 §10 actually quantified', () => {
    // The gap is deliberate: the six #125 names that the decision document did
    // not put a number on are ABSENT rather than given one invented here, so
    // somebody has to decide and record them.
    const metrics = PRINTFUL_PILOT_RECOMMENDED_THRESHOLDS.map((entry) => entry.metric);
    expect(metrics).toContain('non_eu_dispatch_origin');
    expect(metrics).toContain('negative_realized_margin');
    expect(metrics).not.toContain('customer_support_volume');
    expect(metrics).not.toContain('payment_refund_or_dispute_rate');
    // And every recommended one is internally consistent: a rate is bounded by
    // 10,000 bps and a one-occurrence stop has a zero threshold.
    for (const entry of PRINTFUL_PILOT_RECOMMENDED_THRESHOLDS) {
      if (entry.unit === 'rate_bps') expect(entry.thresholdValue).toBeLessThanOrEqual(10_000);
      if (entry.windowHours === 0) expect(entry.thresholdValue).toBe(0);
    }
  });
});
