/**
 * The Stripe billing adapter's two translations (#89).
 *
 * Both are places where a provider's vocabulary becomes Mercaria's, and both
 * have a case that reads plausibly and is wrong: a subscription Stripe still
 * calls `active` while the merchant has cancelled it, and a connected-account id
 * arriving where a billing customer belongs.
 */

import { describe, expect, it } from 'vitest';
import { mapStripeSubscriptionStatus } from '../stripe-billing.js';
import { ENTITLING_SUBSCRIPTION_STATUSES } from '@mercaria/shared-types';

describe('mapStripeSubscriptionStatus', () => {
  it('records a SCHEDULED cancellation, which Stripe still calls active', () => {
    // Stripe keeps a subscription `active` with `cancel_at_period_end` until the
    // period ends. Mercaria records the merchant's DECISION, because the plan
    // screen has to be able to say "cancels on the 14th".
    expect(mapStripeSubscriptionStatus('active', true)).toBe('cancelled');
    expect(mapStripeSubscriptionStatus('trialing', true)).toBe('cancelled');
    expect(mapStripeSubscriptionStatus('active', false)).toBe('active');
    expect(mapStripeSubscriptionStatus('trialing', false)).toBe('trialing');
  });

  it('maps both failure states onto past_due, which is where the grace runs', () => {
    expect(mapStripeSubscriptionStatus('past_due', false)).toBe('past_due');
    expect(mapStripeSubscriptionStatus('unpaid', false)).toBe('past_due');
  });

  it('treats a first payment that never succeeded as non-entitling', () => {
    expect(mapStripeSubscriptionStatus('incomplete', false)).toBe('expired');
    expect(mapStripeSubscriptionStatus('incomplete_expired', false)).toBe('expired');
    expect(mapStripeSubscriptionStatus('canceled', false)).toBe('expired');
  });

  it('treats an UNRECOGNISED status as non-entitling rather than guessing', () => {
    // Stripe adding a status must not silently grant a paid capability. The
    // assertion is against the ENTITLING set rather than against the literal, so
    // it stays true if the fallback is ever changed to another non-entitling
    // state.
    const mapped = mapStripeSubscriptionStatus('something_stripe_added_later', false);
    expect(ENTITLING_SUBSCRIPTION_STATUSES).not.toContain(mapped);
  });

  it('the entitling set is exactly the three states that still hold a plan', () => {
    expect([...ENTITLING_SUBSCRIPTION_STATUSES]).toEqual(['trialing', 'active', 'past_due']);
  });
});
