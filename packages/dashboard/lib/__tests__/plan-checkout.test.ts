import { describe, expect, it } from 'vitest';
import type { MerchantPlanStatusView } from '@mercaria/shared-types';
import { planCheckoutExpectation, planCheckoutOutcome, sheetInterval } from '../plan-checkout';

function status(subscription: string | null): MerchantPlanStatusView {
  return {
    storeId: 'store-1',
    subscription: subscription
      ? ({ status: subscription } as unknown as MerchantPlanStatusView['subscription'])
      : null,
    effectivePlanKey: null,
    effectivePlanVersion: null,
    entitlements: [],
    billingAvailable: true,
    portalAvailable: false,
  };
}

describe('a plan bought in the Peable sheet', () => {
  it('succeeds only once Mercaria says the store pays', () => {
    expect(planCheckoutOutcome('complete', status('active'))).toBe('succeeded');
    expect(planCheckoutOutcome('complete', status('trialing'))).toBe('succeeded');
  });

  it('keeps waiting while the session is closed but the plan is not yet the store’s', () => {
    expect(planCheckoutOutcome('complete', status(null))).toBeNull();
    expect(planCheckoutOutcome('complete', status('past_due'))).toBeNull();
    expect(planCheckoutOutcome('complete', undefined)).toBeNull();
    // Nothing is decided before Peable closes the order, whatever the status reads.
    expect(planCheckoutOutcome(null, status('active'))).toBeNull();
  });

  it('fails when the session expired unpaid', () => {
    expect(planCheckoutOutcome('expired', status(null))).toBe('failed');
  });

  it('expects exactly the price Mercaria resolved', () => {
    expect(
      planCheckoutExpectation({
        clientSecret: 'cs_x_secret_y',
        amount: { amount: 1299, currency: 'USD' },
        interval: 'monthly',
        livemode: true,
        expiresAt: null,
      }),
    ).toEqual({ amount: '1299', currency: 'USD', livemode: true });
    expect(sheetInterval('annual')).toBe('year');
    expect(sheetInterval('monthly')).toBe('month');
  });
});

describe('a plan whose first payment is still confirming', () => {
  it('keeps the sheet waiting — a FairCoin payment in flight is not a plan the store has', () => {
    expect(planCheckoutOutcome('complete', status('payment_pending'))).toBeNull();
  });
});
