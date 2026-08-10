/**
 * A merchant's standing, in safe public language (#73 merchant requirement 2).
 *
 * PURE, over two facts that are already public: `merchants.claim_state` (ADR
 * 0002 D9's one stored verdict) and #54's derived native-checkout verdict.
 * Nothing here reads a claim row, an evidence record, a reviewer or a token —
 * it cannot, because none of those is a parameter.
 *
 * ## Why a derived label rather than the raw state
 *
 * `claim_pending` and `claimed` are engineering words, and a page that printed
 * them would be inviting every client to invent its own copy for them — which
 * is how one surface ends up saying "verified" about a state another calls
 * "pending". The vocabulary is closed, it is derived in one place, and the two
 * inputs travel BESIDE it so a client that needs the precise verdict has it
 * without having to reconstruct one from the other.
 *
 * ## What no label can say
 *
 * There is no member meaning "a claim was rejected", "an operator is reviewing
 * evidence", "this merchant was reported" or "N people are claiming this". Each
 * is a statement about a person's dealings with Mercaria and belongs on the
 * claimant's own surface (#83), never on a page anybody can load. #83 already
 * publishes `claimInProgress` as a BOOLEAN for exactly that reason, and this
 * function consumes that boolean rather than a count.
 */

import type {
  ClaimState,
  MerchantNativeCheckoutEligibility,
  MerchantPublicStanding,
} from '@mercaria/shared-types';

/**
 * Derive the standing.
 *
 * The order of the branches is the severity order: being able to sell on
 * Mercaria implies being claimed, and a claim in progress is only meaningful
 * while the merchant is not already claimed. Reading them the other way round
 * would let a claimed merchant with a squatter's live claim be described as
 * "claim in progress", which understates a verified fact and would make the
 * `Claim this merchant` button appear beside a merchant that has an operator.
 */
export function deriveMerchantPublicStanding(input: {
  claimState: ClaimState;
  claimInProgress: boolean;
  nativeCheckout: MerchantNativeCheckoutEligibility;
}): MerchantPublicStanding {
  if (input.claimState === 'claimed') {
    return input.nativeCheckout.eligible ? 'selling_on_mercaria' : 'claimed';
  }
  if (input.claimState === 'claim_pending' || input.claimInProgress) return 'claim_in_progress';
  return 'unclaimed';
}
