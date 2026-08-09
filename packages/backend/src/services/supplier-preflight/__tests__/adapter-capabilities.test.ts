/**
 * The capability boundary (#122 acceptance 3, and the load-bearing honesty
 * rule).
 *
 * Every case here is "the adapter claimed X without declaring the capability
 * for X", and every one asserts the claim was REMOVED and REPORTED. The
 * reservation case is the one #122 names outright; the rest are the same rule
 * applied to the other success states a capability gates.
 *
 * The direction of each downgrade is asserted too, because it is a decision
 * rather than an implementation detail: `orderable` becomes `unknown` and NOT
 * `unavailable`. The supplier may well have the stock — what is missing is
 * Mercaria's right to claim it does — so the answer lands on the value that
 * blocks rather than on the one that refuses.
 */

import { describe, expect, it } from 'vitest';
import type { SupplierAdapterCapability, SupplierPreflightAnswer } from '@mercaria/shared-types';
import { applyDeclaredCapabilities, unknownAnswer } from '../adapter.js';

const EUR = 'EUR' as const;

const ALL: readonly SupplierAdapterCapability[] = [
  'live_product_lookup',
  'live_stock_lookup',
  'destination_shipping_quote',
  'order_draft_validation',
  'inventory_reservation',
  'quote_expiry',
  'price_guarantee',
  'address_validation',
  'delivery_estimate',
  'tax_duty_estimate',
  'cancellation_before_submission',
  'update_notifications',
];

function without(...removed: SupplierAdapterCapability[]): SupplierAdapterCapability[] {
  const drop = new Set(removed);
  return ALL.filter((capability) => !drop.has(capability));
}

/** An adapter answering with everything a fully-capable one could. */
function fullyClaiming(): SupplierPreflightAnswer {
  return {
    ...unknownAnswer(),
    identity: 'confirmed',
    availability: 'orderable',
    maxOrderableQuantity: 10,
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
    tax: { amount: 210, currency: EUR },
    duty: { amount: 0, currency: EUR },
    importResponsibility: 'supplier',
    providerExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    priceGuarantee: 'guaranteed',
    stockGuarantee: 'guaranteed',
    reservation: {
      supported: true,
      state: 'reserved',
      providerReservationId: 'hold-1',
      providerExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      singleUse: true,
    },
  };
}

describe('applyDeclaredCapabilities', () => {
  it('keeps every claim an adapter DID declare', () => {
    // The positive control. Without it, a boundary that removed everything
    // unconditionally would pass every case below.
    const { answer, downgrades } = applyDeclaredCapabilities(fullyClaiming(), ALL);
    expect(downgrades).toEqual([]);
    expect(answer.reservation.supported).toBe(true);
    expect(answer.availability).toBe('orderable');
    expect(answer.priceGuarantee).toBe('guaranteed');
    expect(answer.deliveryDaysMax).toBe(5);
    expect(answer.tax).not.toBeNull();
  });

  it('removes a reservation from an adapter that did not declare one', () => {
    // #122's own sentence, mechanically: the orchestration cannot name a local
    // record `reserved` when the supplier made no commitment.
    const { answer, downgrades } = applyDeclaredCapabilities(
      fullyClaiming(),
      without('inventory_reservation'),
    );
    expect(answer.reservation).toEqual({ supported: false, reason: 'capability_not_declared' });
    expect(downgrades.map((entry) => entry.commitment)).toContain('emulated_reservation');
    // The removed shape carries no id and no expiry, so there is nothing left
    // for a caller to write a reservation row from.
    expect(Object.keys(answer.reservation)).not.toContain('providerReservationId');
  });

  it('downgrades `orderable` to UNKNOWN, not to `unavailable`', () => {
    const { answer, downgrades } = applyDeclaredCapabilities(
      fullyClaiming(),
      without('live_stock_lookup'),
    );
    expect(answer.availability).toBe('unknown');
    expect(answer.maxOrderableQuantity).toBeNull();
    expect(downgrades.length).toBeGreaterThan(0);
  });

  it('downgrades an undeclared price guarantee to advisory', () => {
    const { answer, downgrades } = applyDeclaredCapabilities(
      fullyClaiming(),
      without('price_guarantee'),
    );
    expect(answer.priceGuarantee).toBe('advisory');
    expect(downgrades.map((entry) => entry.commitment)).toContain('inferred_price_guarantee');
  });

  it('removes a shipping quote from an adapter that cannot quote shipping', () => {
    const { answer } = applyDeclaredCapabilities(
      fullyClaiming(),
      without('destination_shipping_quote'),
    );
    expect(answer.shipping.basis).toBe('unknown');
    expect(answer.shippingOptions).toEqual([]);
  });

  it('removes an undeclared delivery window and tax estimate rather than zeroing them', () => {
    const { answer } = applyDeclaredCapabilities(
      fullyClaiming(),
      without('delivery_estimate', 'tax_duty_estimate'),
    );
    expect(answer.deliveryDaysMin).toBeNull();
    expect(answer.deliveryDaysMax).toBeNull();
    expect(answer.tax).toBeNull();
    expect(answer.duty).toBeNull();
    expect(answer.importResponsibility).toBeNull();
  });

  it('removes a supplier expiry from an adapter that cannot report one', () => {
    const { answer } = applyDeclaredCapabilities(fullyClaiming(), without('quote_expiry'));
    expect(answer.providerExpiresAt).toBeNull();
  });

  it('names EVERY removal, so a contract violation reaches an operator', () => {
    // A boundary that removed the claims silently would leave an adapter's
    // declaration decorative and the bug invisible. The count is what the
    // service turns into `provider_contract_violation`.
    const { downgrades } = applyDeclaredCapabilities(fullyClaiming(), []);
    expect(downgrades.length).toBeGreaterThanOrEqual(6);
    for (const entry of downgrades) {
      expect(entry.explanation.length).toBeGreaterThan(0);
    }
  });
});

describe('unknownAnswer', () => {
  it('is the shape a call that never completed produces', () => {
    const answer = unknownAnswer();
    expect(answer.availability).toBe('unknown');
    expect(answer.identity).toBe('unknown');
    expect(answer.unitCost).toBeNull();
    expect(answer.shipping.basis).toBe('unknown');
    expect(answer.reservation.supported).toBe(false);
    expect(answer.priceGuarantee).toBe('advisory');
    expect(answer.stockGuarantee).toBe('advisory');
  });
});
