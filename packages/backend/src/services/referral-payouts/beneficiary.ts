/**
 * Where a referral partner's payout goes, and whether it may go there yet
 * (#146, ADR 0005 D14/D15).
 *
 * ## This module sits OUTSIDE both walled domains, and that is the design
 *
 * ADR 0005 D14 selects one launch rail — Stripe Connect transfers to a
 * payment-ready connected account, through exactly #46's `provider_accounts`.
 * So a referral payout needs the referral domain (which partner, which batch)
 * and the payment domain (which account, and the money) in one place, and
 * NEITHER may import the other:
 *
 *  - `reward-funding-isolation.test.ts` forbids everything under
 *    `services/referrals/` from reaching `services/payments/`, `db/payments`,
 *    `schema/ledger` or `refund.service`, exempting three named seams and no
 *    others. A Stripe client under `services/referrals/` is exactly what that
 *    wall refuses.
 *  - The reverse edge does not exist today (measured: no file under
 *    `services/payments/` names a referral), and creating one to satisfy this
 *    join is what #123 warned about in the same shape — satisfying a step by
 *    importing across a wall "would widen it to admit the REVERSE edge, which
 *    is the one it exists to prevent".
 *
 * `services/retail-checkout/` is the precedent, taken for the identical reason:
 * when two walled domains must meet, the join gets its own module rather than a
 * hole in either wall. The referral domain publishes the PORT
 * (`payout-rail.port.ts`) and this side registers an implementation into it, so
 * the dependency runs join → domain in both directions and never domain →
 * domain.
 *
 * ## The beneficiary is the OWNER KEY, and D14's reuse is then free
 *
 * ADR 0005 D14: "a partner who is already a payment-ready seller reuses the
 * SAME account — `UNIQUE(provider, owner_type, owner_id)` guarantees one
 * account per owner, so a referral payout can never mint a second". That
 * property is DERIVED here rather than checked: the beneficiary ref is the
 * seller key for the partner's own owner, so a partner who sells through
 * Mercaria resolves to the row #46 already created for their sales, and there
 * is no code path that could look up a second one. A check somebody has to
 * remember would be strictly weaker than an index that cannot be worked around.
 *
 * `ReferralPartnerOwnerType` and `ProviderAccountOwnerType` are both
 * `'user' | 'store'`, so the translation is an IDENTITY — and a test pins that,
 * because the day one of those tuples grows a member the identity stops being
 * one and this file must decide what the new member means rather than silently
 * passing it through to an account lookup.
 */

import type {
  ProviderOnboardingState,
  ReferralPartnerOwnerType,
  ReferralReadinessSummary,
} from '@mercaria/shared-types';
import { sellerKeyFor, type SellerAccountOwner } from '../payments/provider-account.service.js';

/** The partner facts this module reads, and the whole of them. */
export interface ReferralPayoutPartnerIdentity {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
}

/**
 * The `provider_accounts` owner a partner's payout resolves to.
 *
 * Deliberately NOT a lookup: this is the pure translation, so the seam between
 * "which account" and "read that account" stays visible and the first half is
 * testable without a database.
 */
export function referralPayoutAccountOwner(
  partner: ReferralPayoutPartnerIdentity,
): SellerAccountOwner {
  return { ownerType: partner.ownerType, ownerId: partner.ownerId };
}

/**
 * The value stored in `referral_partners.payout_beneficiary_ref`.
 *
 * #145's port documents this as "#142's opaque pointer at the rail account.
 * Never a bank detail", and the seller key satisfies that literally: it names an
 * owner Mercaria already knows and carries no account number, no address and no
 * tax identifier, so the rail resolves the destination under its own
 * authorization rather than being handed one by a marketing ledger.
 */
export function referralPayoutBeneficiaryRef(partner: ReferralPayoutPartnerIdentity): string {
  return sellerKeyFor(referralPayoutAccountOwner(partner));
}

/**
 * ADR 0005 D15 gate 1, derived from #46's ONE stored verdict.
 *
 * `identity_readiness` and `payout_readiness` are two columns #142 owns and this
 * is the ONLY function that writes either, so they cannot disagree. That is not
 * laziness about a distinction — under ADR 0001 D9 the connected account's
 * `onboarding_state` already IS the conjunction of identity verification and a
 * usable payout destination, and Stripe publishes no verdict that separates
 * them. Deriving two columns from one source through two functions is how they
 * would drift; deriving them through one is how the schema keeps room for a rail
 * that does distinguish them, without pretending today's rail does.
 *
 * `unknown` is NEVER returned, and that is what makes the column's default mean
 * something: `unknown` is "nobody has looked", so a partner whose readiness has
 * never been synced blocks (`PayoutGateFacts` inverts the
 * `SELLER_TRUST_RESTRICTED_TIERS` rule on purpose — an absent KYC verdict is
 * Mercaria not knowing whether it may send somebody money). An ABSENT account
 * row is a different fact from an unread one: Mercaria looked and there is no
 * account, which is `pending` because starting onboarding is the partner's next
 * action.
 *
 * `restricted` is `blocked` rather than `pending` even though #46 documents it
 * as seller-recoverable: `pending` reads as "in progress and nothing is wrong",
 * and an account that was working and has stopped is something wrong. The
 * recoverable/terminal distinction #46 draws is preserved where it belongs — on
 * the partner's own status projection, which can carry the underlying state —
 * and is not collapsed into a four-valued summary that cannot express it.
 */
export function deriveReferralPayoutReadiness(
  onboardingState: ProviderOnboardingState | undefined,
): ReferralReadinessSummary {
  if (onboardingState === undefined) return 'pending';
  switch (onboardingState) {
    case 'ready':
      return 'ready';
    case 'not_connected':
    case 'action_required':
    case 'under_review':
      return 'pending';
    case 'restricted':
    case 'disabled':
      return 'blocked';
  }
}
