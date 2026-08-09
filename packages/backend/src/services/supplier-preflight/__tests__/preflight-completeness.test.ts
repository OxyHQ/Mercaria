/**
 * The completeness derivation, as a table (#122 acceptance 6, 8).
 *
 * Pure fixtures against the same function the service calls, so every case here
 * is the case production takes — the `eligibility.test.ts` (#121) arrangement.
 *
 * The fixtures deliberately sit on BOTH sides of every distinction the
 * derivation exists to make: a timeout AND a definite out-of-stock, an
 * unpriced route AND a priced one, an ambiguous identity AND a mismatched one.
 * A suite whose fixtures all sat on one side would pass against a derivation
 * that had collapsed the two — the fixture law `~/Oxy/AGENTS.md` records.
 */

import { describe, expect, it } from 'vitest';
import type { SupplierPreflightAnswer } from '@mercaria/shared-types';
import { unknownAnswer } from '../adapter.js';
import { deriveSupplierPreflightCompleteness } from '../preflight-completeness.js';

const EUR = 'EUR' as const;

/** A fully-answered, orderable, priced line — the only shape that completes. */
function healthy(overrides: Partial<SupplierPreflightAnswer> = {}): SupplierPreflightAnswer {
  return {
    ...unknownAnswer(),
    identity: 'confirmed',
    availability: 'orderable',
    maxOrderableQuantity: 10,
    minimumOrderQuantity: 1,
    packSize: 1,
    unitCost: { amount: 1_000, currency: EUR },
    shipping: {
      basis: 'basket',
      cost: { amount: 499, currency: EUR },
      serviceCode: 'std',
      guaranteed: true,
    },
    shippingOptions: [
      {
        serviceCode: 'std',
        carrier: null,
        serviceName: null,
        cost: { amount: 499, currency: EUR },
        basis: 'basket',
        deliveryDaysMin: 2,
        deliveryDaysMax: 5,
        guaranteed: true,
      },
    ],
    deliveryDaysMin: 2,
    deliveryDaysMax: 5,
    priceGuarantee: 'guaranteed',
    stockGuarantee: 'guaranteed',
    ...overrides,
  };
}

function derive(answer: SupplierPreflightAnswer, overrides: Partial<Parameters<typeof deriveSupplierPreflightCompleteness>[0]> = {}) {
  return deriveSupplierPreflightCompleteness({
    answer,
    requestedQuantity: 1,
    requestedCurrency: EUR,
    contractViolations: [],
    gateReasons: [],
    failureKind: null,
    requireDeliveryEstimate: false,
    requireTaxTreatment: false,
    ...overrides,
  });
}

describe('deriveSupplierPreflightCompleteness', () => {
  it('completes a fully-answered orderable line', () => {
    const verdict = derive(healthy());
    expect(verdict.status).toBe('complete');
    expect(verdict.blockReasons).toEqual([]);
    expect(verdict.exceptionKind).toBeNull();
    expect(verdict.mayCheckout).toBe(true);
  });

  it('treats a TIMEOUT as unknown availability and refuses checkout', () => {
    // #122 concurrency 7 and acceptance 6, the load-bearing case: a call that
    // did not answer must not read as stock.
    const verdict = derive(unknownAnswer(), { failureKind: 'timeout' });
    expect(verdict.status).toBe('partial');
    expect(verdict.blockReasons).toContain('availability_unknown');
    expect(verdict.blockReasons).toContain('provider_timeout');
    expect(verdict.mayCheckout).toBe(false);
  });

  it('distinguishes a definite out-of-stock from an unknown one', () => {
    // The other side of the same distinction: `unavailable` is a real answer
    // and routes to the customer, `unknown` routes to a retry and an operator.
    const definite = derive(healthy({ availability: 'unavailable', maxOrderableQuantity: 0 }));
    expect(definite.blockReasons).toContain('not_orderable');
    expect(definite.blockReasons).not.toContain('availability_unknown');
    expect(definite.exceptionKind).toBeNull();
  });

  it('refuses an unpriced shipping route without reading it as free', () => {
    const verdict = derive(
      healthy({ shipping: { basis: 'unknown', restrictions: [] }, shippingOptions: [] }),
    );
    expect(verdict.status).toBe('partial');
    expect(verdict.blockReasons).toContain('shipping_cost_unknown');
    expect(verdict.mayCheckout).toBe(false);
  });

  it('files an AMBIGUOUS identity as an exception, and a MISMATCH as a block', () => {
    // Two different facts: ambiguity is a provider contradiction an operator
    // must resolve; a mismatch is a clear answer that the offer's mapping is
    // wrong, which is a catalogue correction rather than an exception.
    const ambiguous = derive(healthy({ identity: 'ambiguous' }));
    expect(ambiguous.status).toBe('invalid');
    expect(ambiguous.exceptionKind).toBe('ambiguous_sku_identity');

    const mismatched = derive(healthy({ identity: 'mismatched' }));
    expect(mismatched.status).toBe('partial');
    expect(mismatched.exceptionKind).toBeNull();
    expect(mismatched.blockReasons).toContain('identity_mismatched');
  });

  it('refuses an amount denominated in a currency nobody asked for', () => {
    const verdict = derive(healthy({ unitCost: { amount: 1_000, currency: 'USD' } }));
    expect(verdict.status).toBe('invalid');
    expect(verdict.exceptionKind).toBe('currency_mismatch');
  });

  it('files "orderable, quantity zero" as a self-contradiction', () => {
    const verdict = derive(healthy({ availability: 'orderable', maxOrderableQuantity: 0 }));
    expect(verdict.status).toBe('invalid');
    expect(verdict.exceptionKind).toBe('ambiguous_availability');
  });

  it('files disagreeing shipping bases as a self-contradiction', () => {
    const answer = healthy();
    const verdict = derive({
      ...answer,
      shippingOptions: [{ ...answer.shippingOptions[0], basis: 'per_item' }],
    });
    expect(verdict.status).toBe('invalid');
    expect(verdict.exceptionKind).toBe('conflicting_shipping_basis');
  });

  it('files a capability claim the adapter did not declare as a contract violation', () => {
    const verdict = derive(healthy(), {
      contractViolations: [
        {
          capability: 'inventory_reservation',
          commitment: 'emulated_reservation',
          explanation: 'x',
        },
      ],
    });
    expect(verdict.status).toBe('invalid');
    expect(verdict.exceptionKind).toBe('provider_contract_violation');
  });

  it('blocks a quantity above the supplier ceiling, below the minimum, or off the pack size', () => {
    expect(derive(healthy(), { requestedQuantity: 11 }).blockReasons).toContain(
      'quantity_above_maximum',
    );
    expect(
      derive(healthy({ minimumOrderQuantity: 5 }), { requestedQuantity: 2 }).blockReasons,
    ).toContain('quantity_below_minimum');
    expect(derive(healthy({ packSize: 4 }), { requestedQuantity: 6 }).blockReasons).toContain(
      'pack_size_violated',
    );
  });

  it('blocks a delivery window and a tax treatment only when the POLICY requires them', () => {
    // #122's closing rule names exactly three blocking facts; these two are
    // policy-gated because a made-to-order supplier publishing neither would
    // otherwise be unable to sell anything at all.
    const noWindow = healthy({ deliveryDaysMin: null, deliveryDaysMax: null });
    expect(derive(noWindow).status).toBe('complete');
    expect(derive(noWindow, { requireDeliveryEstimate: true }).blockReasons).toContain(
      'delivery_estimate_unknown',
    );
    expect(derive(healthy(), { requireTaxTreatment: true }).blockReasons).toContain(
      'tax_treatment_unknown',
    );
  });

  it('never completes while a destination restriction stands', () => {
    const verdict = derive(healthy({ destinationRestrictions: ['postal_code_excluded'] }));
    expect(verdict.status).toBe('partial');
    expect(verdict.blockReasons).toContain('destination_restricted');
  });

  it('carries a non-empty reason list on every non-complete verdict', () => {
    // The column CHECK requires it, both directions. Asserted here too because
    // a derivation that returned `invalid` with no reason would be refused at
    // the INSERT — a 500 on a checkout path rather than a blocked quote.
    for (const answer of [
      unknownAnswer(),
      healthy({ identity: 'ambiguous' }),
      healthy({ availability: 'orderable', maxOrderableQuantity: 0 }),
    ]) {
      const verdict = derive(answer);
      if (verdict.status === 'complete') continue;
      expect(verdict.blockReasons.length).toBeGreaterThan(0);
    }
  });
});
