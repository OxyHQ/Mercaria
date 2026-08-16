/**
 * The payout gate, as a pure function (#145, ADR 0005 D14/D15).
 *
 * These are unit tests because `deriveRewardPayability` and
 * `deriveBatchEligibility` are pure: no database, no clock, no configuration.
 * The properties they pin are the ones a realdb case would exercise once each
 * and this exercises exhaustively — every gate withholding on its own, every
 * gate collected together, and the minimum's one documented exception.
 */

import { describe, expect, it } from 'vitest';
import { REFERRAL_PAYOUT_BLOCK_REASONS } from '@mercaria/shared-types';
import {
  deriveBatchEligibility,
  deriveRewardPayability,
  referralPayoutMinimumMinor,
  type PayoutGateFacts,
} from '../payability.js';

/** A partner and a reward that pass every gate. Each case moves ONE thing. */
const PASSING: PayoutGateFacts = {
  rewardState: 'vested',
  rewardNetAmountMinor: 5_000,
  rewardCurrency: 'EUR',
  claimedByOpenBatch: false,
  partnerState: 'approved',
  identityReadiness: 'ready',
  taxReadiness: 'ready',
  payoutReadiness: 'ready',
  hasPayoutBeneficiary: true,
  programPayoutEnabled: true,
  enrollmentEarnsProductionRewards: true,
};

describe('deriveRewardPayability', () => {
  it('passes a vested reward held by an approved, ready partner', () => {
    const verdict = deriveRewardPayability(PASSING);
    expect(verdict.verdict).toBe('payable');
    if (verdict.verdict !== 'payable') return;
    expect(verdict.netAmountMinor).toBe(5_000);
    expect(verdict.currency).toBe('EUR');
  });

  it.each([
    ['held', 'reward_not_vested'],
    ['frozen', 'reward_frozen'],
    ['paid', 'reward_already_paid'],
    ['voided', 'reward_voided'],
  ] as const)('withholds a %s reward as %s', (state, reason) => {
    const verdict = deriveRewardPayability({ ...PASSING, rewardState: state });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    expect(verdict.reasons).toContain(reason);
  });

  it.each([
    [{ identityReadiness: 'pending' }, 'identity_not_ready'],
    [{ taxReadiness: 'blocked' }, 'tax_not_ready'],
    [{ payoutReadiness: 'unknown' }, 'payout_not_ready'],
    [{ hasPayoutBeneficiary: false }, 'no_payout_beneficiary'],
    [{ programPayoutEnabled: false }, 'program_payout_paused'],
    [{ claimedByOpenBatch: true }, 'reward_claimed_by_open_batch'],
    [{ partnerState: 'suspended' }, 'partner_suspended'],
    [{ partnerState: 'terminated' }, 'partner_suspended'],
    [{ partnerState: 'applied' }, 'partner_not_approved'],
    [{ rewardNetAmountMinor: 0 }, 'reward_net_is_zero'],
  ] as const)('withholds on %o as %s', (patch, reason) => {
    const verdict = deriveRewardPayability({ ...PASSING, ...patch });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    expect(verdict.reasons).toContain(reason);
  });

  it('reports EVERY unmet gate rather than the first', () => {
    // An operator asking why a partner has not been paid needs the whole answer;
    // a first-reason-wins derivation sends them to fix one thing at a time.
    const verdict = deriveRewardPayability({
      ...PASSING,
      identityReadiness: 'pending',
      taxReadiness: 'pending',
      hasPayoutBeneficiary: false,
    });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    expect(verdict.reasons).toEqual(
      expect.arrayContaining(['identity_not_ready', 'tax_not_ready', 'no_payout_beneficiary']),
    );
  });

  it('reads an UNKNOWN readiness as blocking, not as permitting', () => {
    // The deliberate inversion of the `SELLER_TRUST_RESTRICTED_TIERS` rule: an
    // absent trust signal withholds nothing because restricting on absence turns
    // an outage into a delisting, but an absent KYC verdict is Mercaria not
    // knowing whether it is allowed to send somebody money.
    for (const readiness of ['unknown', 'pending', 'blocked']) {
      const verdict = deriveRewardPayability({ ...PASSING, identityReadiness: readiness });
      expect(verdict.verdict, readiness).toBe('blocked');
    }
  });

  /**
   * #146 enrollment mode 7. The reward is VESTED and the partner passes every
   * other gate — which is the point: a staff or test enrollment is isolated at
   * the payout gate and nowhere earlier, so everything upstream of this line
   * works exactly as it does for a real partner and the money still does not
   * move.
   */
  it('withholds a test enrollment even when every other gate passes', () => {
    const verdict = deriveRewardPayability({
      ...PASSING,
      enrollmentEarnsProductionRewards: false,
    });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    expect(verdict.reasons).toEqual(['partner_enrollment_is_test']);
  });

  it('emits only reasons the closed vocabulary names', () => {
    const verdict = deriveRewardPayability({
      ...PASSING,
      rewardState: 'held',
      partnerState: 'suspended',
      identityReadiness: 'pending',
      taxReadiness: 'pending',
      payoutReadiness: 'pending',
      hasPayoutBeneficiary: false,
      programPayoutEnabled: false,
      claimedByOpenBatch: true,
      rewardNetAmountMinor: 0,
      enrollmentEarnsProductionRewards: false,
    });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    // A floor, so an empty reason list cannot satisfy the containment below.
    // Raised with #146's ninth simultaneous block — a floor that never moves
    // when a reason is added is one the next reason can hide behind.
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(9);
    for (const reason of verdict.reasons) {
      expect(REFERRAL_PAYOUT_BLOCK_REASONS).toContain(reason);
    }
  });
});

describe('deriveBatchEligibility', () => {
  it('pays a batch at or above the published minimum', () => {
    const verdict = deriveBatchEligibility({
      currency: 'EUR',
      grossEligibleMinor: 2_500,
      withholdingMinor: 0,
      finalPayout: false,
    });
    expect(verdict).toEqual({ verdict: 'eligible', netPayoutMinor: 2_500 });
    expect(referralPayoutMinimumMinor('EUR')).toBe(2_500);
  });

  it('rolls a sub-minimum balance forward (ADR 0005 D14)', () => {
    const verdict = deriveBatchEligibility({
      currency: 'EUR',
      grossEligibleMinor: 2_499,
      withholdingMinor: 0,
      finalPayout: false,
    });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    expect(verdict.reasons).toEqual(['below_minimum']);
  });

  it('pays a sub-minimum FINAL balance — D14’s own exception', () => {
    const verdict = deriveBatchEligibility({
      currency: 'EUR',
      grossEligibleMinor: 100,
      withholdingMinor: 0,
      finalPayout: true,
    });
    expect(verdict).toEqual({ verdict: 'eligible', netPayoutMinor: 100 });
  });

  it('BLOCKS a currency with no published minimum rather than defaulting to zero', () => {
    // A defaulted minimum is a policy nobody signed, and defaulting it to zero
    // would pay out one-cent balances at a rail's per-transfer cost.
    const verdict = deriveBatchEligibility({
      currency: 'USD',
      grossEligibleMinor: 100_000,
      withholdingMinor: 0,
      finalPayout: false,
    });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    expect(verdict.reasons).toEqual(['payout_minimum_not_published']);
    expect(referralPayoutMinimumMinor('USD')).toBeUndefined();
  });

  it('subtracts the withholding before comparing against the minimum', () => {
    const verdict = deriveBatchEligibility({
      currency: 'EUR',
      grossEligibleMinor: 2_600,
      withholdingMinor: 200,
      finalPayout: false,
    });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    expect(verdict.reasons).toEqual(['below_minimum']);
  });

  it('refuses a batch that nets to nothing', () => {
    const verdict = deriveBatchEligibility({
      currency: 'EUR',
      grossEligibleMinor: 500,
      withholdingMinor: 500,
      finalPayout: true,
    });
    expect(verdict.verdict).toBe('blocked');
    if (verdict.verdict !== 'blocked') return;
    expect(verdict.reasons).toEqual(['reward_net_is_zero']);
  });
});
