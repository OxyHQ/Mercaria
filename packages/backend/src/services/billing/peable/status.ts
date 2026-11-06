/**
 * A native subscription's status in Mercaria's vocabulary.
 *
 * Peable's subscription statuses are Stripe's (Peable ADR 0018); Mercaria
 * spells cancellation the way the order domain does, and the mapping is stated
 * here, once, so no service ever branches on the gateway's spelling.
 *
 * A subscription set to cancel at period end is `cancelled` while it still
 * runs — "cancel now, keep what you paid for until the period ends" — and
 * `expired` once the gateway ends it.
 *
 * `incomplete` — the first invoice is open and unpaid: a FairCoin payment
 * confirming on chain (ADR 0019), or a card payment awaiting action — is
 * `payment_pending`, never `expired`: the merchant has not lost a plan, they are
 * part-way through buying one. It entitles nothing (it is not in
 * `ENTITLING_SUBSCRIPTION_STATUSES`), exactly as before. Only the rail's own end
 * of an unpaid first invoice, `incomplete_expired`, is `expired`.
 */

import type { MerchantSubscriptionStatus } from '@mercaria/shared-types';

export function mapPeableSubscriptionStatus(
  status: string,
  cancelAtPeriodEnd: boolean,
): MerchantSubscriptionStatus {
  switch (status) {
    case 'trialing':
      return cancelAtPeriodEnd ? 'cancelled' : 'trialing';
    case 'active':
      return cancelAtPeriodEnd ? 'cancelled' : 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'incomplete':
      return 'payment_pending';
    case 'canceled':
    case 'incomplete_expired':
      return 'expired';
    default:
      // An unrecognised status is treated as non-entitling rather than guessed
      // at: a status the gateway adds must not silently grant a paid capability.
      return 'expired';
  }
}
