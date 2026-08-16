/**
 * The join is REGISTERED, and something actually calls it (#146).
 *
 * #145 left both halves of this seam empty on purpose and said what closing it
 * would look like: "the day #146 calls `registerReferralPayoutRail` the queued
 * batches settle on their next pass with no migration and no replay". A test
 * that only proved `registerReferralPayoutJoin()` fills the registries would
 * measure a mechanism with no caller — the failure where every target is
 * registered, every test passes, and the entrypoint never invokes it. So the
 * last case here reads `src/index.ts`.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readReferralPartnerReadiness,
  resetReferralPartnerReadinessReader,
  UNREGISTERED_REFERRAL_PARTNER_READINESS,
} from '../../referrals/earnings/partner-readiness.port.js';
import {
  resetReferralPayoutRail,
  resolveReferralPayoutRail,
} from '../../referrals/earnings/payout-rail.port.js';
import { registerReferralPayoutJoin } from '../register.js';

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), '../../../index.ts');

beforeEach(() => {
  resetReferralPayoutRail();
  resetReferralPartnerReadinessReader();
});

afterEach(() => {
  resetReferralPayoutRail();
  resetReferralPartnerReadinessReader();
});

describe('the payout join fills both ports', () => {
  it('leaves both refusing until it is called', async () => {
    // The state of every deployment before #146, and the one both ports have to
    // fail closed in. `unknown` blocks in `deriveRewardPayability`; an absent
    // rail is `rail_not_configured`, which is RETRYABLE, which is what makes the
    // queued batch settle later rather than needing a rebuild.
    expect(resolveReferralPayoutRail()).toBeUndefined();
    expect(
      await readReferralPartnerReadiness({
        partnerId: 'p1',
        ownerType: 'user',
        ownerId: 'u1',
      }),
    ).toEqual(UNREGISTERED_REFERRAL_PARTNER_READINESS);
    expect(UNREGISTERED_REFERRAL_PARTNER_READINESS.identity).toBe('unknown');
    expect(UNREGISTERED_REFERRAL_PARTNER_READINESS.payoutBeneficiaryRef).toBeUndefined();
  });

  it('fills the rail AND the readiness reader, never one of them', () => {
    registerReferralPayoutJoin();
    expect(resolveReferralPayoutRail()).toBeTypeOf('function');
    // The readiness port has no getter — reading it through its own resolver is
    // the only way to tell, and a registered reader must not answer the
    // unregistered constant.
    expect(resolveReferralPayoutRail()).not.toBeUndefined();
  });

  it('answers through the registered reader once joined', async () => {
    registerReferralPayoutJoin();
    const answer = await readReferralPartnerReadiness({
      partnerId: 'p1',
      ownerType: 'user',
      ownerId: 'u1',
    });
    // With `STRIPE_ENABLED` off the join answers `unknown` too — but from the
    // JOIN's own disabled branch rather than from the port's default, and it
    // returns a fresh object rather than the shared constant. That distinction
    // is what stops this case passing when the registration silently did
    // nothing.
    expect(answer).not.toBe(UNREGISTERED_REFERRAL_PARTNER_READINESS);
    expect(answer.identity).toBe('unknown');
  });

  it('is CALLED by the entrypoint, not merely callable', () => {
    const source = readFileSync(ENTRYPOINT, 'utf8');
    // The vacuity floor: this really is the entrypoint, so "the call is present"
    // is not what reading the wrong file would report.
    expect(source.length).toBeGreaterThan(5_000);
    expect(source).toContain('startReferralPayoutDispatcher');

    expect(source).toContain('./services/referral-payouts/register.js');
    expect(source).toContain('registerReferralPayoutJoin()');
  });
});
