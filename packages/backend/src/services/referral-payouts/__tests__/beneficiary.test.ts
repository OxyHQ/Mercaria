/**
 * The referral payout join's pure half (#146, ADR 0005 D14/D15).
 *
 * Pure, so a plain unit test is the right instrument: there is no CHECK, no
 * trigger and no index in this file's behaviour, and a real server would only
 * make the same assertions slower. The parts that DO need one — the account
 * lookup, the rail call and the batch settling — are the increment's realdb
 * work and are not what this file measures.
 */

import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ACCOUNT_OWNER_TYPES,
  PROVIDER_ONBOARDING_STATES,
  REFERRAL_PARTNER_OWNER_TYPES,
  type ProviderOnboardingState,
  type ReferralReadinessSummary,
} from '@mercaria/shared-types';
import {
  deriveReferralPayoutReadiness,
  referralPayoutAccountOwner,
  referralPayoutBeneficiaryRef,
} from '../beneficiary.js';

describe('the beneficiary is the partner’s own owner key', () => {
  it('resolves a partner to the SAME owner #46 keys an account by', () => {
    // ADR 0005 D14's "reuses the SAME account" is this identity plus
    // `UNIQUE(provider, owner_type, owner_id)` — there is no second account a
    // referral payout could resolve to, so nothing here has to refuse one.
    expect(referralPayoutAccountOwner({ ownerType: 'store', ownerId: 'store-1' })).toEqual({
      ownerType: 'store',
      ownerId: 'store-1',
    });
    expect(referralPayoutBeneficiaryRef({ ownerType: 'store', ownerId: 'store-1' })).toBe(
      'store:store-1',
    );
    expect(referralPayoutBeneficiaryRef({ ownerType: 'user', ownerId: 'oxy-9' })).toBe(
      'user:oxy-9',
    );
  });

  it('carries NO bank detail, address or tax identifier — only the owner', () => {
    // #145's port: "the request carries no beneficiary DETAIL, deliberately".
    // The ref is two known values joined, so there is nothing in it to leak; a
    // rail that needs more reads it under its own authorization.
    const ref = referralPayoutBeneficiaryRef({ ownerType: 'user', ownerId: 'oxy-9' });
    expect(ref.split(':')).toHaveLength(2);
  });

  it('pins the two owner tuples as IDENTICAL, so a new member cannot pass through', () => {
    // The translation in `referralPayoutAccountOwner` is an identity, and it is
    // only sound while these two sets agree. The day either grows a member —
    // a `platform` partner, say — the identity stops being one and this file
    // must decide what it means rather than handing an unknown owner type to an
    // account lookup that would answer "no account" and read as `pending`.
    expect([...REFERRAL_PARTNER_OWNER_TYPES].sort()).toEqual(
      [...PROVIDER_ACCOUNT_OWNER_TYPES].sort(),
    );
  });
});

describe('readiness derives from #46’s one stored verdict', () => {
  const EXPECTED: Record<ProviderOnboardingState, ReferralReadinessSummary> = {
    ready: 'ready',
    not_connected: 'pending',
    action_required: 'pending',
    under_review: 'pending',
    restricted: 'blocked',
    disabled: 'blocked',
  };

  it('maps every onboarding state, and the map covers the whole tuple', () => {
    // The vacuity floor: a `Record` over the union already fails `tsc` on a
    // missing key, and this asserts the TUPLE the CHECK is rendered from is the
    // same set — so a state added to the column and not to the union cannot
    // reach the switch unmapped.
    expect(Object.keys(EXPECTED).sort()).toEqual([...PROVIDER_ONBOARDING_STATES].sort());
    for (const state of PROVIDER_ONBOARDING_STATES) {
      expect(deriveReferralPayoutReadiness(state)).toBe(EXPECTED[state]);
    }
  });

  it('answers `pending` for a partner with NO account row', () => {
    // Mercaria looked and there is no account — a different fact from nobody
    // having looked, which is the column's `unknown` default.
    expect(deriveReferralPayoutReadiness(undefined)).toBe('pending');
  });

  it('NEVER answers `unknown`, which is what makes the default block', () => {
    // If this function could return `unknown`, the column could not distinguish
    // "never synced" from "synced and indeterminate", and `PayoutGateFacts`
    // blocks on `unknown` precisely to catch the first.
    const answers = [undefined, ...PROVIDER_ONBOARDING_STATES].map((state) =>
      deriveReferralPayoutReadiness(state),
    );
    expect(answers).not.toContain('unknown');
    // The positive control: this set is not empty and does contain a real
    // verdict, so "no `unknown`" is not what an empty scan reports.
    expect(answers).toContain('ready');
    expect(answers).toContain('blocked');
  });

  it('separates a stopped account from one still in progress', () => {
    // `restricted` is seller-recoverable and still `blocked`: `pending` reads as
    // "nothing is wrong", and an account that was working and stopped is not
    // that. Collapsing the two is what would let a batch include a partner
    // whose rail has paused payouts.
    expect(deriveReferralPayoutReadiness('restricted')).toBe('blocked');
    expect(deriveReferralPayoutReadiness('under_review')).toBe('pending');
  });
});
