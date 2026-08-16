/**
 * Where a partner's IDENTITY and PAYOUT readiness come from — a named,
 * fail-closed seam (#146, ADR 0005 D15 gate 1).
 *
 * ## Why this is a port and not an import
 *
 * D15 gate 1 is #46's verdict: the partner's connected account is payment-ready.
 * That lives in `provider_accounts`, under `services/payments/`, and
 * `reward-funding-isolation.test.ts` forbids everything under
 * `services/referrals/` from reaching it — exempting three named seams and no
 * others. Reaching it here would not merely trip that gate, it would make the
 * card rail structural to a marketing ledger.
 *
 * A TRANSITIVE import would be no better and is the version worth naming,
 * because a text-scanning gate cannot see it: `services/referrals/` importing
 * `services/referral-payouts/`, which imports `services/payments/`, defeats the
 * wall while reading as clean. So the dependency runs the other way — the join
 * registers INTO this port, every edge points join → domain, and the referral
 * domain names no module outside itself.
 *
 * ## The default BLOCKS, and that is the whole point of it being a port
 *
 * #124's ruling is that ports have DIFFERENT defaults and getting one backwards
 * breaks something. This one refuses: an unregistered reader answers `unknown`
 * for both summaries and no beneficiary, which `deriveRewardPayability` turns
 * into `identity_not_ready`, `payout_not_ready` and `no_payout_beneficiary`.
 * That inverts the `SELLER_TRUST_RESTRICTED_TIERS` rule deliberately and for the
 * reason `PayoutGateFacts` already gives — an absent trust signal withholds
 * nothing, but an absent KYC verdict is Mercaria not knowing whether it may send
 * somebody money.
 *
 * It is also exactly the behaviour of the deployment that exists today, which is
 * what makes registering the join a change with no cliff: before it, every batch
 * blocks on readiness; after it, batches block or settle on what Stripe actually
 * says.
 */

import type { ReferralReadinessSummary } from '@mercaria/shared-types';
import { log } from '../../../lib/logger.js';

/** Which partner is being asked about. The whole of what the reader gets. */
export interface ReferralPartnerReadinessSubject {
  partnerId: string;
  ownerType: 'user' | 'store';
  ownerId: string;
}

/**
 * What the rail side answers.
 *
 * `payoutBeneficiaryRef` is present exactly when there is an account to pay,
 * which is what keeps `no_payout_beneficiary` a REACHABLE block reason rather
 * than one a derivation quietly made impossible. It is an owner key and never a
 * bank detail — see `services/referral-payouts/beneficiary.ts`.
 */
export interface ReferralPartnerReadiness {
  identity: ReferralReadinessSummary;
  payout: ReferralReadinessSummary;
  payoutBeneficiaryRef: string | undefined;
}

/** The one function the join implements. */
export type ReferralPartnerReadinessReader = (
  subject: ReferralPartnerReadinessSubject,
) => Promise<ReferralPartnerReadiness>;

/**
 * What an unregistered deployment answers.
 *
 * Exported so a test can assert the DEFAULT rather than only the registered
 * path — a port whose unregistered behaviour is untestable is a port whose
 * unregistered behaviour is unknown (#145's own reasoning about the rail).
 */
export const UNREGISTERED_REFERRAL_PARTNER_READINESS: ReferralPartnerReadiness = {
  identity: 'unknown',
  payout: 'unknown',
  payoutBeneficiaryRef: undefined,
};

let reader: ReferralPartnerReadinessReader | undefined;

/** Register the reader. Called once at boot by the payout join. */
export function registerReferralPartnerReadinessReader(
  implementation: ReferralPartnerReadinessReader,
): void {
  reader = implementation;
}

/** Drop the registration. For tests, for the reason the rail's reset exists. */
export function resetReferralPartnerReadinessReader(): void {
  reader = undefined;
}

/**
 * Read a partner's identity and payout readiness.
 *
 * Never throws and never returns a partial answer: a reader that fails is the
 * same situation as no reader at all — Mercaria cannot currently establish
 * whether this partner may be paid — and both land on the blocking value. A
 * throw here would abort a batch BUILD, which would turn a rail outage into a
 * failure to enumerate what is owed.
 */
export async function readReferralPartnerReadiness(
  subject: ReferralPartnerReadinessSubject,
): Promise<ReferralPartnerReadiness> {
  if (!reader) return UNREGISTERED_REFERRAL_PARTNER_READINESS;
  try {
    return await reader(subject);
  } catch (error) {
    log.general.error(
      { err: error, partnerId: subject.partnerId },
      '[Referrals] the partner readiness reader threw; treating readiness as unknown',
    );
    return UNREGISTERED_REFERRAL_PARTNER_READINESS;
  }
}
