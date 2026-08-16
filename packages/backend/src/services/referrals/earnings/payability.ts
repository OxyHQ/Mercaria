/**
 * May this reward be paid, and may this batch go out? (#145, ADR 0005 D14/D15.)
 *
 * PURE — no database, no clock, no configuration. Everything it reads is on
 * {@link PayoutGateFacts}, and what that type does NOT have is the point: no
 * order, no payment, no buyer, no retail cost, no funding record. The
 * `SourcingCandidateFacts` device, applied to a payout: a gate that cannot see
 * a buyer's money cannot be made to pay out of it.
 *
 * ## The verdict is DERIVED and never stored
 *
 * The `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, and for the reason that rule itself gives: the inputs sit on tables this
 * domain does not own and move without anybody touching the reward. A stored
 * `payable` state would go stale the instant a rail restricts a partner's
 * account, and the place that must not happen is a batch builder including
 * somebody it should not.
 *
 * ## Every gate WITHHOLDS and none of them destroys anything
 *
 * ADR 0005 D15: "A partner failing a gate is skipped, not voided: the balance
 * stays payable and enters the next batch that passes." So there is no branch
 * here that voids, reverses or reduces a reward — the type cannot express one,
 * because `blocked` carries reasons and nothing else.
 */

import {
  REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY,
  type CurrencyCode,
  type ReferralPayoutBlockReason,
  type ReferralRewardPayability,
  type ReferralRewardState,
} from '@mercaria/shared-types';

/**
 * Everything the payout gate reads, and the whole of it.
 *
 * `ReferralReadinessSummary` is #142's four-valued `unknown | pending | ready |
 * blocked`, and only `ready` passes. `unknown` BLOCKS rather than passing, which
 * inverts the `SELLER_TRUST_RESTRICTED_TIERS` rule deliberately: an absent trust
 * signal withholds nothing because restricting on absence turns an outage into a
 * delisting, but an absent KYC verdict is Mercaria not knowing whether it is
 * allowed to send somebody money.
 */
export interface PayoutGateFacts {
  rewardState: ReferralRewardState;
  rewardNetAmountMinor: number;
  rewardCurrency: CurrencyCode;
  /** Whether a live `referral_payout_batch_items` row already holds this reward. */
  claimedByOpenBatch: boolean;
  /** #142's `referral_partners.state`. */
  partnerState: string;
  /** #142's three readiness summaries — ADR 0005 D15's gates 1 and 2. */
  identityReadiness: string;
  taxReadiness: string;
  payoutReadiness: string;
  /** #142's `payout_beneficiary_ref` — the rail account #146 resolves. */
  hasPayoutBeneficiary: boolean;
  /** #145's program-level lever (`referral_program_controls.payout_enabled`). */
  programPayoutEnabled: boolean;
  /**
   * Whether this partner's ENROLLMENT MODE earns real money (#146 enrollment
   * mode 7: "Staff or test enrollment isolated from production earnings").
   *
   * A boolean rather than the mode itself, deliberately: this gate must not be
   * able to ask WHICH mode, or the isolation becomes a list of mode names that
   * somebody extends without reading `REFERRAL_ENROLLMENT_MODE_RULES`. The
   * caller reads the answer off that table, where a mode added without one
   * fails `tsc`.
   *
   * It is a PAYOUT gate rather than an attribution refusal because refusing
   * attribution would make a test enrollment unable to exercise the thing it
   * exists to test, while this is the exact point at which real money would
   * otherwise leave.
   */
  enrollmentEarnsProductionRewards: boolean;
  /**
   * #148's scoped `payout_hold`, derived from the live enforcement actions by
   * `deriveEnforcementEffects` — the ONE derivation the three gates share.
   *
   * A BOOLEAN rather than the action list, deliberately: this gate must not be
   * able to ask WHICH action, or the isolation becomes a list of action names
   * somebody extends without reading `REFERRAL_ENFORCEMENT_ACTION_EFFECTS`.
   * The `enrollmentEarnsProductionRewards` device, one field up.
   */
  payoutHeldByEnforcement: boolean;
}

/**
 * Whether ONE reward may enter a batch right now.
 *
 * Every reason is collected rather than short-circuited: an operator asking why
 * a partner has not been paid needs the whole answer, and a first-reason-wins
 * derivation sends them to fix one thing at a time.
 */
export function deriveRewardPayability(facts: PayoutGateFacts): ReferralRewardPayability {
  const reasons: ReferralPayoutBlockReason[] = [];

  switch (facts.rewardState) {
    case 'vested':
      break;
    case 'held':
      reasons.push('reward_not_vested');
      break;
    case 'frozen':
      reasons.push('reward_frozen');
      break;
    case 'paid':
      reasons.push('reward_already_paid');
      break;
    case 'voided':
      reasons.push('reward_voided');
      break;
  }

  // A reward whose net a reversal took to zero is not payable and is not an
  // error: #144 voids it, and this covers the window before that lands.
  if (facts.rewardNetAmountMinor <= 0) reasons.push('reward_net_is_zero');
  if (facts.claimedByOpenBatch) reasons.push('reward_claimed_by_open_batch');

  if (facts.partnerState === 'suspended' || facts.partnerState === 'terminated') {
    reasons.push('partner_suspended');
  } else if (facts.partnerState !== 'approved') {
    reasons.push('partner_not_approved');
  }

  if (facts.identityReadiness !== 'ready') reasons.push('identity_not_ready');
  if (facts.taxReadiness !== 'ready') reasons.push('tax_not_ready');
  if (facts.payoutReadiness !== 'ready') reasons.push('payout_not_ready');
  if (!facts.hasPayoutBeneficiary) reasons.push('no_payout_beneficiary');
  if (!facts.programPayoutEnabled) reasons.push('program_payout_paused');
  if (!facts.enrollmentEarnsProductionRewards) reasons.push('partner_enrollment_is_test');
  // #148: a SCOPED `payout_hold`. A separate reason from `partner_suspended`
  // deliberately — the whole point of the scoped action is that a partner can
  // be under a payout hold WITHOUT being suspended, and an operator reading
  // `partner_suspended` on an approved partner would go looking for a state
  // that is not there. Like every gate above it, this WITHHOLDS: the balance
  // stays and enters the next batch that passes (ADR 0005 D15).
  if (facts.payoutHeldByEnforcement) reasons.push('enforcement_payout_hold');

  if (reasons.length > 0) return { verdict: 'blocked', reasons };
  return {
    verdict: 'payable',
    netAmountMinor: facts.rewardNetAmountMinor,
    currency: facts.rewardCurrency,
  };
}

/** Whether a batch of this size in this currency may go out. */
export type ReferralBatchEligibility =
  | { verdict: 'eligible'; netPayoutMinor: number }
  | { verdict: 'blocked'; reasons: readonly ReferralPayoutBlockReason[] };

/**
 * The MINIMUM, which is a property of the batch and not of a reward (ADR 0005
 * D14: balances below it roll forward).
 *
 * `finalPayout` is D14's own exception, stated as a parameter rather than as a
 * branch somewhere: "on voluntary program exit or non-fraud termination, the
 * final vested balance is paid in the next batch regardless of the minimum".
 * Whoever decides that a payout is final is an operator, so the decision arrives
 * here as an input.
 *
 * A currency Mercaria has published no minimum for is BLOCKED
 * (`payout_minimum_not_published`) rather than defaulted to zero. A defaulted
 * minimum is a policy nobody signed, and defaulting it to zero would pay out one
 * cent balances at a rail's per-transfer cost.
 */
export function deriveBatchEligibility(input: {
  currency: CurrencyCode;
  grossEligibleMinor: number;
  withholdingMinor: number;
  finalPayout: boolean;
}): ReferralBatchEligibility {
  const net = input.grossEligibleMinor - input.withholdingMinor;
  if (net <= 0) return { verdict: 'blocked', reasons: ['reward_net_is_zero'] };

  const minimum = REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY[input.currency];
  if (minimum === undefined) {
    return { verdict: 'blocked', reasons: ['payout_minimum_not_published'] };
  }
  if (!input.finalPayout && net < minimum) {
    return { verdict: 'blocked', reasons: ['below_minimum'] };
  }
  return { verdict: 'eligible', netPayoutMinor: net };
}

/**
 * The published minimum for one currency, or `undefined`.
 *
 * Exported so the operator surface can SHOW the threshold beside a blocked
 * batch. A partner asking "why have I not been paid" is answered by a number,
 * not by the word `below_minimum`.
 */
export function referralPayoutMinimumMinor(currency: CurrencyCode): number | undefined {
  return REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY[currency];
}
