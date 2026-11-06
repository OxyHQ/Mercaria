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
 * `incomplete` is its own state, never `expired`: Peable creates a
 * subscription at checkout and activates it only when its FIRST invoice is
 * paid, and a FairCoin first payment keeps it `incomplete` for as long as the
 * payer's transaction takes to confirm (Peable ADR 0021 D3). It does not
 * entitle; an unpaid one lapses at the rail as `incomplete_expired`, which is
 * `expired` here.
 */

import type { MerchantSubscriptionStatus } from '@mercaria/shared-types';

export function mapPeableSubscriptionStatus(
  status: string,
  cancelAtPeriodEnd: boolean,
): MerchantSubscriptionStatus {
  switch (status) {
    case 'incomplete':
      return 'incomplete';
    case 'trialing':
      return cancelAtPeriodEnd ? 'cancelled' : 'trialing';
    case 'active':
      return cancelAtPeriodEnd ? 'cancelled' : 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'canceled':
    case 'incomplete_expired':
      return 'expired';
    default:
      // An unrecognised status is treated as non-entitling rather than guessed
      // at: a status the gateway adds must not silently grant a paid capability.
      return 'expired';
  }
}
