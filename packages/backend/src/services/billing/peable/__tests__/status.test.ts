/**
 * Peable's subscription statuses in Mercaria's vocabulary — and the one that
 * was wrong: a FairCoin-paid plan is `incomplete` while its first payment
 * confirms on chain (ADR 0019), and reading that as `expired` told the merchant
 * who had just paid that their plan had ended.
 */

import { ENTITLING_SUBSCRIPTION_STATUSES } from '@mercaria/shared-types';
import { describe, expect, it } from 'vitest';
import { mapPeableSubscriptionStatus } from '../status.js';

describe('mapPeableSubscriptionStatus', () => {
  it('reads a first payment still confirming as payment_pending, never as ended', () => {
    expect(mapPeableSubscriptionStatus('incomplete', false)).toBe('payment_pending');
    expect(mapPeableSubscriptionStatus('incomplete', true)).toBe('payment_pending');
  });

  it('grants nothing while the payment confirms — access waits for the rail to say active', () => {
    expect(ENTITLING_SUBSCRIPTION_STATUSES).not.toContain(
      mapPeableSubscriptionStatus('incomplete', false),
    );
  });

  it('keeps an unpaid first invoice the rail ended, and a cancelled one, as expired', () => {
    expect(mapPeableSubscriptionStatus('incomplete_expired', false)).toBe('expired');
    expect(mapPeableSubscriptionStatus('canceled', false)).toBe('expired');
  });

  it('maps the running statuses, honouring a cancellation at period end', () => {
    expect(mapPeableSubscriptionStatus('active', false)).toBe('active');
    expect(mapPeableSubscriptionStatus('active', true)).toBe('cancelled');
    expect(mapPeableSubscriptionStatus('trialing', false)).toBe('trialing');
    expect(mapPeableSubscriptionStatus('trialing', true)).toBe('cancelled');
    expect(mapPeableSubscriptionStatus('past_due', false)).toBe('past_due');
    expect(mapPeableSubscriptionStatus('unpaid', false)).toBe('past_due');
    expect(mapPeableSubscriptionStatus('paused', false)).toBe('paused');
  });

  it('treats a status the gateway adds as non-entitling', () => {
    expect(mapPeableSubscriptionStatus('something_new', false)).toBe('expired');
  });
});
