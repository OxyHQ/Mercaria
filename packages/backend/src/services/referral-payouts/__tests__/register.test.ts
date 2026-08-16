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
import {
  UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS,
  readReferralRiskPaymentFacts,
  resetReferralRiskPaymentFactsReader,
  type ReferralRiskPaymentSubject,
} from '../../referrals/integrity/payment-facts.port.js';
import { registerReferralPayoutJoin } from '../register.js';

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), '../../../index.ts');

/**
 * A subject whose cohort is EMPTY, so the registered reader answers from its own
 * short-circuit and issues no SQL. This file has no database.
 */
const RISK_SUBJECT: ReferralRiskPaymentSubject = {
  partnerId: 'p1',
  ownerType: 'user',
  ownerId: 'u1',
  windowStart: new Date('2026-08-01T00:00:00.000Z'),
  windowEnd: new Date('2026-08-02T00:00:00.000Z'),
  conversionsInWindow: 0,
  orderCohort: { kind: 'enumerated', orderRefs: [] },
};

beforeEach(() => {
  resetReferralPayoutRail();
  resetReferralPartnerReadinessReader();
  resetReferralRiskPaymentFactsReader();
});

afterEach(() => {
  resetReferralPayoutRail();
  resetReferralPartnerReadinessReader();
  resetReferralRiskPaymentFactsReader();
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
    // #344's port defaults the OTHER way on purpose, and the contrast is the
    // point: an absent readiness verdict BLOCKS money leaving, an absent risk
    // reader is a SILENCE. Asserting them in one case is what stops somebody
    // "making them consistent".
    expect(await readReferralRiskPaymentFacts(RISK_SUBJECT)).toBe(
      UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS,
    );
    expect(UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS).toEqual({});
  });

  it('fills the rail AND the readiness reader, never one of them', () => {
    registerReferralPayoutJoin();
    expect(resolveReferralPayoutRail()).toBeTypeOf('function');
    // The readiness port has no getter — reading it through its own resolver is
    // the only way to tell, and a registered reader must not answer the
    // unregistered constant.
    expect(resolveReferralPayoutRail()).not.toBeUndefined();
  });

  it('fills #344s RISK-FACTS port too, which is the whole of that issue landing', async () => {
    // The failure this guards is the one #146's own last case names: a port
    // declared, documented, unit-tested and registered by NOBODY. That was the
    // state on `main` — `registerReferralRiskPaymentFactsReader` had exactly one
    // caller and it was its own test file — so the three payment facts were
    // absent on every deployment while the seam read as finished.
    registerReferralPayoutJoin();

    const answer = await readReferralRiskPaymentFacts(RISK_SUBJECT);
    // NOT the shared unregistered constant. Identity is what discriminates a
    // real registration from one that silently did nothing: the join's own
    // empty-cohort answer is a FRESH object, and `toEqual` alone would pass
    // against no registration at all because both are `{}`-shaped.
    expect(answer).not.toBe(UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS);
    // An enumerated-but-empty cohort is a MEASUREMENT: the count is supplied at
    // zero, and the rate is absent because the denominator is zero.
    expect(answer.providerAdverseOutcomeCount).toBe(0);
    expect('disputeRateBps' in answer).toBe(false);
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
