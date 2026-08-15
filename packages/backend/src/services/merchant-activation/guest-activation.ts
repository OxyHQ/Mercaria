/**
 * #107's `#85` seam, CLOSED.
 *
 * `guest-rollout.ts` shipped `GuestSellerActivation` with two members and no
 * `activated`, so that `GUEST_SELLER_ACTIVATION_REQUIRED=true` refused every
 * guest checkout by name until this domain existed. Its docblock said the day
 * #85 landed its author would "add the third beside a repository read"; this is
 * that read, and nothing else in the checkout path changed — the gate, the
 * refusal shape and the reason code were already in place around it.
 *
 * ## The verdict is the guest CONJUNCTION, not a new flag
 *
 * ADR 0006 G14 decided guest eligibility is the intersection of the gates that
 * already exist, and that a per-merchant guest OPT-IN list would be a second,
 * drifting answer to what `onboarding_state` already answers. That decision
 * survives here: `activated` means the guest requirement set holds, which is
 * payment readiness plus the twelve facts #85 guest 2–14 name. There is no
 * column a merchant or an operator could set to `activated` directly, and no
 * configuration that produces one.
 *
 * ## An individual seller answers `not_activated`, always
 *
 * A P2P seller has no store, no activation settings row and no policy the
 * `store` half of this domain could hold — #112's `policies_accepted` criterion
 * is exactly that gap, and #112's answer is a recorded no-go. So the guest P2P
 * path stays refused here as well as at the earlier gate, which is the
 * fail-closed direction on the one path where two gates disagreeing would matter.
 */

import type { MerchantActivationBlockReason } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { deriveMerchantActivation } from './activation.service.js';

/**
 * What #85 answers about one seller.
 *
 * A STRING discriminant, because the backend compiles with `strict: false` and
 * a caller must be able to act on the difference between the three.
 */
export type GuestSellerActivation =
  /** The guest conjunction holds for this seller. */
  | { readonly state: 'activated' }
  /** It does not, and this is the first requirement that said so. */
  | { readonly state: 'not_activated'; readonly reason: MerchantActivationBlockReason }
  /** An operator has withdrawn this seller from guest checkout by hand. */
  | { readonly state: 'blocked_by_operator' };

/**
 * The ONE function that decides whether a seller may sell to a guest, beyond
 * what payment readiness already decided.
 *
 * The operator block list is read FIRST and synchronously in the caller (see
 * `guest-rollout.ts`), so this is reached only for sellers nobody has withdrawn
 * — but it is also checked here, because this function is the seam a future
 * caller will reach for and a seam that answered `activated` for a blocked
 * seller would be a hole with a helpful name on it.
 */
export async function readGuestSellerActivation(
  sellerKey: string,
): Promise<GuestSellerActivation> {
  if (config.guest.checkoutRollout.blockedSellerKeys.includes(sellerKey)) {
    return { state: 'blocked_by_operator' };
  }
  if (!sellerKey.startsWith('store:')) {
    return { state: 'not_activated', reason: 'p2p_activation_unavailable' };
  }
  const storeId = sellerKey.slice('store:'.length);
  if (storeId.length === 0) return { state: 'not_activated', reason: 'no_linked_merchant' };

  const derived = await deriveMerchantActivation(storeId);
  if (!derived) return { state: 'not_activated', reason: 'no_linked_merchant' };
  if (derived.guestBlocking.length === 0) return { state: 'activated' };

  // The FIRST unmet requirement in registry order, which is ordered by how early
  // it bites — so the reason a log line carries is the one furthest upstream
  // rather than whichever happened to be checked last.
  const first = derived.guest.find((result) =>
    derived.guestBlocking.includes(result.requirement),
  );
  const outcome = first?.outcome;
  return {
    state: 'not_activated',
    reason:
      outcome && outcome.state !== 'satisfied' ? outcome.reason : 'native_checkout_not_ready',
  };
}
