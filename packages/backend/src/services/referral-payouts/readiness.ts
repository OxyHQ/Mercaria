/**
 * Reading a partner's connected account, and answering the referral domain's
 * readiness port (#146, ADR 0005 D15 gate 1).
 *
 * `beneficiary.ts` holds the PURE half — which owner a partner resolves to, and
 * what one `onboarding_state` means. This is the half that touches the database,
 * kept separate for the reason that file gives: the seam between "which account"
 * and "read that account" stays visible, and the decision is testable without a
 * server.
 *
 * ## The beneficiary is present exactly when there is an account
 *
 * `no_payout_beneficiary` is a block reason #145 published, and a derivation
 * that always produced a ref would make it unreachable — a dead reason reads as
 * coverage. So the ref is returned only when a `provider_accounts` row exists.
 * That is also the honest meaning: the ref names an account to pay, and a
 * partner who never started onboarding has none. Whether the account that DOES
 * exist may be paid is the readiness verdict beside it, which is a different
 * question and gets a different answer.
 */

import type { ProviderOnboardingState } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import {
  findSellerAccount,
  type SellerAccountOwner,
} from '../payments/provider-account.service.js';
import type {
  ReferralPartnerReadiness,
  ReferralPartnerReadinessSubject,
} from '../referrals/earnings/partner-readiness.port.js';
import {
  deriveReferralPayoutReadiness,
  referralPayoutAccountOwner,
  referralPayoutBeneficiaryRef,
} from './beneficiary.js';

/**
 * The port's implementation.
 *
 * With `STRIPE_ENABLED` off this returns `unknown` for both summaries and no
 * beneficiary, BEFORE touching Postgres — and that is deliberately NOT the
 * `readSellerPaymentReadiness` treatment, which maps every seller to `false`.
 * The two questions differ: a checkout affordance asks "may this seller be sold
 * through", where `false` is the fail-closed answer and no rail means no. A
 * payout gate asks "may Mercaria send this person money", where the fail-closed
 * answer is that Mercaria cannot currently tell — `unknown`, which blocks. A
 * `blocked` here would state that something is wrong with the PARTNER, when what
 * is wrong is that this deployment has no rail configured.
 */
export async function readPartnerPayoutReadiness(
  subject: ReferralPartnerReadinessSubject,
): Promise<ReferralPartnerReadiness> {
  if (!config.payments.stripe.enabled) {
    return { identity: 'unknown', payout: 'unknown', payoutBeneficiaryRef: undefined };
  }

  const owner: SellerAccountOwner = referralPayoutAccountOwner(subject);
  const account = await findSellerAccount(owner);
  const summary = deriveReferralPayoutReadiness(account?.onboardingState);

  return {
    identity: summary,
    payout: summary,
    ...(account
      ? { payoutBeneficiaryRef: referralPayoutBeneficiaryRef(subject) }
      : { payoutBeneficiaryRef: undefined }),
  };
}

/**
 * The connected-account id a transfer is addressed to, or `undefined`.
 *
 * Separate from the readiness read because the rail needs the id and the GATE
 * must never see it: an account id in `PayoutGateFacts` would be a provider
 * handle inside a pure marketing derivation, and the port's answer is carried
 * across a transaction boundary and into a batch record.
 */
export async function resolvePartnerTransferDestination(
  owner: SellerAccountOwner,
): Promise<{ accountId: string; onboardingState: ProviderOnboardingState } | undefined> {
  const account = await findSellerAccount(owner);
  if (!account) return undefined;
  return { accountId: account.providerAccountId, onboardingState: account.onboardingState };
}
