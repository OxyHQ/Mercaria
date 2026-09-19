/**
 * The deterministic selector and the retail pricing function (#1016 Workstreams 5
 * and 6, ADR 0011 D7/D9).
 *
 * Both are pure, and both are the kind of policy that goes wrong silently: a
 * selector that is merely usually deterministic produces an incident nobody can
 * reproduce, and a pricing function that rounds the wrong way sells below an
 * approved margin with a green build.
 */

import { describe, expect, it } from 'vitest';
import type { DigitalProcurementEligibility } from '@mercaria/shared-types';
import {
  RELIABILITY_WITHOUT_HISTORY,
  selectProcurementCandidate,
  selectionRefused,
  type RankedCandidate,
} from '../selection.js';
import { priceDigitalRetailOffer, type DigitalRetailPricingPolicyFacts } from '../pricing.js';

const ELIGIBLE: DigitalProcurementEligibility = { eligible: true, reasons: [] };
const INELIGIBLE: DigitalProcurementEligibility = {
  eligible: false,
  reasons: ['offer_out_of_stock'],
};

function candidate(overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    offerId: 'offer-b',
    supplierId: 'sup-1',
    supplierAccountId: 'acct-1',
    provenance: 'authorized_distributor',
    costAmount: 1_000,
    costCurrency: 'EUR',
    capability: 'activation_key',
    expectedFulfilmentSeconds: 10,
    reliability: 0.9,
    eligibility: ELIGIBLE,
    ...overrides,
  };
}

describe('the selector never returns an ineligible candidate', () => {
  it('refuses when every candidate is ineligible, and hands back all of them', () => {
    const result = selectProcurementCandidate([candidate({ eligibility: INELIGIBLE })]);
    expect(selectionRefused(result)).toBe(true);
    if (selectionRefused(result)) expect(result.refusals).toHaveLength(1);
  });

  it('refuses when the only eligible candidate is excluded by a previous attempt', () => {
    // The fallback loop's own guard: a supplier that just failed must not be
    // re-selected, or a "fallback" is a retry against the same failure.
    const only = candidate({ offerId: 'offer-a' });
    const result = selectProcurementCandidate([only], ['offer-a']);
    expect(selectionRefused(result)).toBe(true);
  });
});

describe('the ranking, in the order ADR 0011 D9 states', () => {
  it('prefers stronger provenance over a cheaper cost', () => {
    const direct = candidate({ offerId: 'offer-a', provenance: 'publisher_direct', costAmount: 2_000 });
    const marketplace = candidate({
      offerId: 'offer-b',
      provenance: 'approved_marketplace_supply',
      costAmount: 100,
    });
    const result = selectProcurementCandidate([marketplace, direct]);
    expect(selectionRefused(result)).toBe(false);
    if (!selectionRefused(result)) expect(result.candidate.offerId).toBe('offer-a');
  });

  it('prefers a measured reliable supplier over an unmeasured one', () => {
    const measured = candidate({ offerId: 'offer-a', reliability: 0.99 });
    const unmeasured = candidate({ offerId: 'offer-b', reliability: null });
    const result = selectProcurementCandidate([unmeasured, measured]);
    if (!selectionRefused(result)) expect(result.candidate.offerId).toBe('offer-a');
  });

  it('does NOT treat an unmeasured supplier as perfect', () => {
    // The trap: `reliability ?? 1` makes a brand-new account win every routing
    // decision on its first day, which is the opposite of what a record is for.
    const unmeasured = candidate({ offerId: 'offer-a', reliability: null });
    const worse = candidate({ offerId: 'offer-b', reliability: RELIABILITY_WITHOUT_HISTORY - 0.1 });
    const better = candidate({ offerId: 'offer-c', reliability: RELIABILITY_WITHOUT_HISTORY + 0.1 });
    const result = selectProcurementCandidate([unmeasured, worse, better]);
    if (!selectionRefused(result)) expect(result.candidate.offerId).toBe('offer-c');
  });

  it('prefers the faster supplier when provenance and reliability tie', () => {
    const slow = candidate({ offerId: 'offer-a', expectedFulfilmentSeconds: 600 });
    const fast = candidate({ offerId: 'offer-b', expectedFulfilmentSeconds: 5 });
    const result = selectProcurementCandidate([slow, fast]);
    if (!selectionRefused(result)) expect(result.candidate.offerId).toBe('offer-b');
  });

  it('treats an unknown latency as the worst, not as instantaneous', () => {
    const unknown = candidate({ offerId: 'offer-a', expectedFulfilmentSeconds: null });
    const slow = candidate({ offerId: 'offer-b', expectedFulfilmentSeconds: 3_600 });
    const result = selectProcurementCandidate([unknown, slow]);
    if (!selectionRefused(result)) expect(result.candidate.offerId).toBe('offer-b');
  });

  it('only then prefers the cheaper cost', () => {
    const dear = candidate({ offerId: 'offer-a', costAmount: 2_000 });
    const cheap = candidate({ offerId: 'offer-b', costAmount: 900 });
    const result = selectProcurementCandidate([dear, cheap]);
    if (!selectionRefused(result)) expect(result.candidate.offerId).toBe('offer-b');
  });

  it('is TOTAL: two identical candidates resolve by id, and the order of the input does not matter', () => {
    // Without this, the same order replayed can route elsewhere — and an incident
    // nobody can reproduce is one nobody can fix.
    const a = candidate({ offerId: 'offer-a' });
    const b = candidate({ offerId: 'offer-b' });
    const forward = selectProcurementCandidate([a, b]);
    const backward = selectProcurementCandidate([b, a]);
    if (!selectionRefused(forward) && !selectionRefused(backward)) {
      expect(forward.candidate.offerId).toBe('offer-a');
      expect(backward.candidate.offerId).toBe('offer-a');
    }
  });
});

/* -------------------------------------------------------------------------- */

function policy(
  overrides: Partial<DigitalRetailPricingPolicyFacts> = {},
): DigitalRetailPricingPolicyFacts {
  return {
    currency: 'EUR',
    marginFloorBps: 1_000,
    marginCeilingBps: 3_000,
    paymentCostBps: 0,
    paymentCostFixedMinor: 0,
    roundingMode: 'minor_unit',
    priceCeilingMinor: null,
    ...overrides,
  };
}

describe('retail pricing', () => {
  it('refuses without a policy rather than inventing a margin', () => {
    expect(priceDigitalRetailOffer({ amount: 1_000, currency: 'EUR' }, null)).toEqual({
      priced: false,
      refusal: 'no_policy',
    });
  });

  it('refuses to price a cost in a currency the policy is not in', () => {
    expect(priceDigitalRetailOffer({ amount: 1_000, currency: 'USD' }, policy())).toEqual({
      priced: false,
      refusal: 'currency_mismatch',
    });
  });

  it('computes margin as basis points of the RETAIL price, not of cost', () => {
    // 10% of retail on a cost of 900 is 1000, not 990. The distinction is what
    // makes a ceiling bound anything at all.
    const result = priceDigitalRetailOffer({ amount: 900, currency: 'EUR' }, policy());
    expect(result.priced).toBe(true);
    if (result.priced) {
      expect(result.retailAmount).toBe(1_000);
      expect(result.marginAmount).toBe(100);
      expect(result.marginBps).toBe(1_000);
    }
  });

  it('clamps a requested margin into the policy’s band rather than honouring it', () => {
    // Asked for 90%, approved for at most 30%: the price must be the one the
    // ceiling produces, and comparing against a request AT the ceiling is what
    // proves the clamp rather than merely that the number went down.
    const overreach = priceDigitalRetailOffer({ amount: 900, currency: 'EUR' }, policy(), 9_000);
    const atCeiling = priceDigitalRetailOffer({ amount: 900, currency: 'EUR' }, policy(), 3_000);
    expect(overreach.priced && atCeiling.priced).toBe(true);
    if (overreach.priced && atCeiling.priced) {
      expect(overreach.retailAmount).toBe(atCeiling.retailAmount);
    }
  });

  it('bounds the REQUESTED margin, and rounding may realize a basis point above it', () => {
    // Documented rather than hidden: rounding up adds at most one increment, and
    // clamping the realized figure back down would mean rounding DOWN — the one
    // direction that can cross the floor.
    const result = priceDigitalRetailOffer({ amount: 900, currency: 'EUR' }, policy(), 3_000);
    if (result.priced) {
      expect(result.retailAmount).toBe(1_286);
      expect(result.marginBps).toBe(3_001);
    }
  });

  it('defaults to the FLOOR, which is the launch posture', () => {
    const result = priceDigitalRetailOffer({ amount: 900, currency: 'EUR' }, policy());
    if (result.priced) expect(result.marginBps).toBe(1_000);
  });

  it('includes the payment cost when the policy passes it through', () => {
    const withPassthrough = priceDigitalRetailOffer(
      { amount: 900, currency: 'EUR' },
      policy({ paymentCostBps: 200, paymentCostFixedMinor: 25 }),
    );
    const without = priceDigitalRetailOffer({ amount: 900, currency: 'EUR' }, policy());
    expect(withPassthrough.priced && without.priced).toBe(true);
    if (withPassthrough.priced && without.priced) {
      expect(withPassthrough.retailAmount).toBeGreaterThan(without.retailAmount);
    }
  });

  it('rounds UP, never down through the floor', () => {
    const result = priceDigitalRetailOffer(
      { amount: 901, currency: 'EUR' },
      policy({ roundingMode: 'end_99' }),
    );
    expect(result.priced).toBe(true);
    if (result.priced) {
      expect(result.retailAmount % 100).toBe(99);
      expect(result.marginBps).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('refuses when a competitive ceiling would push the price below the floor', () => {
    // The honest outcome: this is a product Mercaria cannot sell at this cost,
    // and no price is better than one nobody approved.
    const result = priceDigitalRetailOffer(
      { amount: 900, currency: 'EUR' },
      policy({ priceCeilingMinor: 950 }),
    );
    expect(result).toEqual({ priced: false, refusal: 'margin_below_floor' });
  });

  it('honours a competitive ceiling that still clears the floor', () => {
    const result = priceDigitalRetailOffer(
      { amount: 900, currency: 'EUR' },
      policy({ marginCeilingBps: 5_000, priceCeilingMinor: 1_200 }),
      5_000,
    );
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.retailAmount).toBe(1_200);
  });

  it('refuses a non-positive cost', () => {
    expect(priceDigitalRetailOffer({ amount: 0, currency: 'EUR' }, policy())).toEqual({
      priced: false,
      refusal: 'cost_not_positive',
    });
  });

  it('always returns whole minor units', () => {
    for (const amount of [1, 7, 333, 12_345]) {
      const result = priceDigitalRetailOffer({ amount, currency: 'EUR' }, policy());
      if (result.priced) expect(Number.isInteger(result.retailAmount)).toBe(true);
    }
  });
});
