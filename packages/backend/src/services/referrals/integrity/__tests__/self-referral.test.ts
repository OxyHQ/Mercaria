/**
 * The self-referral verdict and the enforcement effects (#148, ADR 0005 D7).
 *
 * Both derivations are PURE, so every combination is constructible here —
 * including the ones that are hard to build in a database and easy to get
 * wrong, which is the whole reason `self-referral.ts` reads facts rather than
 * rows.
 */

import { describe, expect, it } from 'vitest';
import { assessSelfReferral, selfReferralPermitsAttribution } from '../self-referral.js';
import {
  deriveEnforcementEffects,
  enforcementActionIsLive,
  enforcementPermitsAttribution,
  NO_ENFORCEMENT_EFFECTS,
  type EnforcementActionFact,
} from '../effects.js';
import { deriveRiskSignals, REFERRAL_RISK_THRESHOLD_DEFAULTS } from '../risk-thresholds.js';

/**
 * A fixed instant safely in the PAST.
 *
 * `fixture-date-census.test.ts` fails the build on a fixture the real clock is
 * still travelling toward: it passes today, keeps passing, and breaks CI for
 * whoever pushes on the day it arrives, in a file they did not touch. Every
 * other instant here is derived as an OFFSET from this one rather than written
 * as a second literal.
 */
const NOW = new Date('2026-01-15T12:00:00.000Z');

describe('assessSelfReferral (ADR 0005 D7)', () => {
  it('permits a referral with no evidence at all', () => {
    expect(assessSelfReferral({})).toEqual({ verdict: 'permitted' });
  });

  it('REFUSES on the same Oxy actor, naming only that evidence', () => {
    const verdict = assessSelfReferral({ subjectIsPartnerOwner: true });
    expect(verdict).toEqual({ verdict: 'refused', evidence: ['same_oxy_actor'] });
  });

  it('REFUSES on store membership in the referred merchant (D8s hard exclusion)', () => {
    const verdict = assessSelfReferral({ partnerHoldsReferredStoreMembership: true });
    expect(verdict).toEqual({
      verdict: 'refused',
      evidence: ['partner_administers_referred_merchant'],
    });
  });

  it('a refusal carries ONLY the deterministic evidence, never the reviewable', () => {
    // An explanation given to a partner has to be exactly the rule that was
    // applied; quoting a reviewable fact beside a deterministic one invites an
    // appeal against the wrong half.
    const verdict = assessSelfReferral({
      subjectIsPartnerOwner: true,
      relatedPartyDeclared: true,
      beneficiaryOverlapsSubject: true,
    });
    expect(verdict).toEqual({ verdict: 'refused', evidence: ['same_oxy_actor'] });
  });

  it('a BENEFICIARY OVERLAP alone REVIEWS and never refuses', () => {
    // The issue calls it strong evidence; D7 says refusal on identity is
    // "deterministic and final" and suspicion on signals is reviewable. Two
    // partners legitimately share a beneficiary — an agency, a household
    // business — so a rule that refused here would be final on evidence the
    // ADR did not make final.
    const verdict = assessSelfReferral({ beneficiaryOverlapsSubject: true });
    expect(verdict).toEqual({
      verdict: 'review',
      evidence: ['verified_beneficiary_overlap'],
    });
  });

  it('collects EVERY reviewable fact rather than short-circuiting', () => {
    const verdict = assessSelfReferral({
      beneficiaryOverlapsSubject: true,
      relatedPartyDeclared: true,
      enrollmentIsStaffOrTest: true,
    });
    expect(verdict).toEqual({
      verdict: 'review',
      evidence: [
        'verified_beneficiary_overlap',
        'explicit_related_party_declaration',
        'staff_or_test_activity',
      ],
    });
  });

  it('`undefined` is NOT read as false, and false is not read as evidence', () => {
    // "We could not check" and "we checked and it is not so" lead a reviewer to
    // opposite conclusions. Neither produces evidence, and neither refuses.
    expect(assessSelfReferral({ subjectIsPartnerOwner: undefined })).toEqual({
      verdict: 'permitted',
    });
    expect(assessSelfReferral({ subjectIsPartnerOwner: false })).toEqual({
      verdict: 'permitted',
    });
  });

  it('ONLY `permitted` attributes — `review` is not a soft yes', () => {
    expect(selfReferralPermitsAttribution({ verdict: 'permitted' })).toBe(true);
    expect(
      selfReferralPermitsAttribution({ verdict: 'review', evidence: ['staff_or_test_activity'] }),
    ).toBe(false);
    expect(
      selfReferralPermitsAttribution({ verdict: 'refused', evidence: ['same_oxy_actor'] }),
    ).toBe(false);
  });
});

describe('deriveEnforcementEffects (#148 acceptance 2)', () => {
  const live = (
    action: EnforcementActionFact['action'],
    extra: Partial<EnforcementActionFact> = {},
  ): EnforcementActionFact => ({
    action,
    startsAt: new Date(NOW.getTime() - 1_000),
    ...extra,
  });

  it('an approved partner with no actions has nothing in force', () => {
    expect(deriveEnforcementEffects([], 'approved', NOW)).toEqual(NO_ENFORCEMENT_EFFECTS);
  });

  it('pausing attribution leaves payout and link issuance OPEN', () => {
    const effects = deriveEnforcementEffects(
      [live('new_attribution_suspension')],
      'approved',
      NOW,
    );
    expect(effects.newAttributionSuspended).toBe(true);
    expect(effects.payoutHeld).toBe(false);
    expect(effects.newLinksSuspended).toBe(false);
  });

  it('holding payout leaves attribution and link issuance OPEN', () => {
    const effects = deriveEnforcementEffects([live('payout_hold')], 'approved', NOW);
    expect(effects.payoutHeld).toBe(true);
    expect(effects.newAttributionSuspended).toBe(false);
    expect(effects.newLinksSuspended).toBe(false);
  });

  it('#142s coarse `suspended` still raises all three — today s behaviour, preserved', () => {
    const effects = deriveEnforcementEffects([], 'suspended', NOW);
    expect(effects.newAttributionSuspended).toBe(true);
    expect(effects.payoutHeld).toBe(true);
    expect(effects.newLinksSuspended).toBe(true);
    expect(effects.terminated).toBe(false);
  });

  it('`terminated` raises the three AND terminates', () => {
    const effects = deriveEnforcementEffects([], 'terminated', NOW);
    expect(effects.terminated).toBe(true);
    expect(effects.payoutHeld).toBe(true);
  });

  it('`monitoring`, `partner_warning` and `cleared` raise NOTHING', () => {
    for (const action of ['monitoring', 'partner_warning', 'cleared'] as const) {
      expect(deriveEnforcementEffects([live(action)], 'approved', NOW)).toEqual(
        NO_ENFORCEMENT_EFFECTS,
      );
    }
  });

  it('a LIFTED action is not live, and an EXPIRED one is not live', () => {
    const lifted = live('payout_hold', { liftedAt: new Date(NOW.getTime() - 500) });
    const expired = live('payout_hold', { expiresAt: new Date(NOW.getTime() - 500) });
    const future = { ...live('payout_hold'), startsAt: new Date(NOW.getTime() + 500) };
    expect(enforcementActionIsLive(lifted, NOW)).toBe(false);
    expect(enforcementActionIsLive(expired, NOW)).toBe(false);
    expect(enforcementActionIsLive(future, NOW)).toBe(false);
    expect(deriveEnforcementEffects([lifted, expired, future], 'approved', NOW).payoutHeld).toBe(
      false,
    );
  });

  it('a program removal is per PROGRAM and reaches no other', () => {
    const effects = deriveEnforcementEffects(
      [live('program_removal', { programId: 'prog-a' })],
      'approved',
      NOW,
    );
    expect(effects.removedFromProgramIds).toEqual(['prog-a']);
    expect(enforcementPermitsAttribution(effects, 'prog-a')).toBe(false);
    expect(enforcementPermitsAttribution(effects, 'prog-b')).toBe(true);
  });

  it('deduplicates program ids rather than repeating them', () => {
    const effects = deriveEnforcementEffects(
      [
        live('program_removal', { programId: 'prog-a' }),
        live('program_removal', { programId: 'prog-a' }),
      ],
      'approved',
      NOW,
    );
    expect(effects.removedFromProgramIds).toEqual(['prog-a']);
  });
});

describe('deriveRiskSignals (ADR 0005 D17s four thresholds)', () => {
  it('an unmeasured fact produces NO signal — never a zero', () => {
    expect(deriveRiskSignals({})).toEqual([]);
  });

  it('a rate over ZERO conversions is not reported at all', () => {
    // A rate over an empty sample is undefined, not clean. Reporting 0 bps
    // would put a clean refund rate on a record that has none.
    expect(deriveRiskSignals({ conversionsInWindow: 0 })).toEqual([]);
  });

  it('a rate under the SAMPLE FLOOR is not reported', () => {
    const signals = deriveRiskSignals({ conversionsInWindow: 3, refundRateBps: 6_600 });
    expect(signals.map((s) => s.kind)).not.toContain('refund_dispute_concentration');
  });

  it('reports a refund concentration over the floor and above the threshold', () => {
    const signals = deriveRiskSignals({ conversionsInWindow: 40, refundRateBps: 4_000 });
    expect(signals).toContainEqual({
      kind: 'refund_dispute_concentration',
      severity: 'elevated',
      observedValue: 4_000,
      thresholdValue: REFERRAL_RISK_THRESHOLD_DEFAULTS.refundRateBps,
    });
  });

  it('reports at most ONE concentration signal per window', () => {
    // Two rows of one kind for one window would double-count a single cohort in
    // every operator count that reads them.
    const signals = deriveRiskSignals({
      conversionsInWindow: 40,
      refundRateBps: 4_000,
      disputeRateBps: 900,
    });
    expect(signals.filter((s) => s.kind === 'refund_dispute_concentration')).toHaveLength(1);
  });

  it('reports a conversion velocity strictly ABOVE the threshold', () => {
    expect(deriveRiskSignals({ conversionsInWindow: 20 }).map((s) => s.kind)).not.toContain(
      'repeated_conversion_pattern',
    );
    expect(deriveRiskSignals({ conversionsInWindow: 21 }).map((s) => s.kind)).toContain(
      'repeated_conversion_pattern',
    );
  });

  it('a DECLARED related party is high severity; a declared NON-relationship is silent', () => {
    expect(deriveRiskSignals({ declaredRelatedParty: true })[0]).toEqual({
      kind: 'declared_related_party',
      severity: 'high',
      observedValue: 1,
    });
    expect(deriveRiskSignals({ declaredRelatedParty: false })).toEqual([]);
  });

  it('collects every signal that fired rather than short-circuiting', () => {
    const signals = deriveRiskSignals({
      declaredRelatedParty: true,
      conversionsInWindow: 40,
      touchesInWindow: 900,
      refundRateBps: 4_000,
      merchantMembershipOverlap: true,
    });
    expect(signals.map((s) => s.kind).sort()).toEqual([
      'declared_related_party',
      'instrument_distribution_anomaly',
      'merchant_membership_overlap',
      'refund_dispute_concentration',
      'repeated_conversion_pattern',
    ]);
  });
});
