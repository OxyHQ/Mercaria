/**
 * Is this a self-referral? (#148 "Self-referral evaluation", ADR 0005 D7.)
 *
 * PURE — no database, no clock, no configuration. Everything it reads is on
 * {@link ReferralSelfReferralFacts}, and what that type does NOT have is the
 * point: no email, no card, no address, no IP, no device. ADR 0005 D7's
 * *"deliberately nothing else"* is a property of the signature rather than a
 * rule somebody reviews, which is the `PayoutGateFacts` device applied to the
 * one decision most likely to be widened by somebody trying to catch a cheat.
 *
 * ## THREE answers, and the middle one is what the issue asked for
 *
 * The issue and the ADR pull in different directions and both are honoured. The
 * ADR admits exactly two facts as grounds for refusal and says everything else
 * *"freezes and routes to manual review"*; the issue lists four more as
 * "strong evidence where available" and then forbids four specific weak ones
 * outright. So: {@link REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH} decides which
 * arm each admissible fact lands in, `deterministic` REFUSES, `reviewable`
 * REVIEWS, and the four weak ones are not in the type at all.
 *
 * `review` is not a soft yes. Two of the three verdicts refuse to attribute;
 * the difference between them is whether a PERSON gets to look first.
 *
 * ## Absence is never read as a negative
 *
 * Every fact is `boolean | undefined`, and `undefined` means NOT ESTABLISHED.
 * "We could not check whether the partner administers this merchant" and "we
 * checked and they do not" lead a reviewer to opposite conclusions, and a
 * coercion to `false` would make the first indistinguishable from the second
 * exactly where the check failed — which is the #58 denominator rule, one
 * domain over.
 *
 * ## Why this is not a score
 *
 * Nothing here adds anything up. The evidence kinds are collected, the
 * strongest verdict wins, and the answer names the evidence that produced it —
 * so a partner told they were refused is told which rule was applied, and an
 * appeal is about a FACT rather than about a number.
 */

import {
  REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH,
  type ReferralSelfReferralAssessment,
  type ReferralSelfReferralEvidence,
  type ReferralSelfReferralFacts,
} from '@mercaria/shared-types';

/**
 * Which fact establishes which evidence kind.
 *
 * A `Record` over the evidence union rather than a chain of `if`s, so an
 * evidence kind added without a fact to establish it fails `tsc`. The fact
 * accessor returns `boolean | undefined` and the `undefined` is passed through
 * rather than defaulted — see the docblock.
 */
const EVIDENCE_FACTS: Record<
  ReferralSelfReferralEvidence,
  (facts: ReferralSelfReferralFacts) => boolean | undefined
> = {
  same_oxy_actor: (facts) => facts.subjectIsPartnerOwner,
  partner_administers_referred_merchant: (facts) => facts.partnerHoldsReferredStoreMembership,
  verified_beneficiary_overlap: (facts) => facts.beneficiaryOverlapsSubject,
  explicit_related_party_declaration: (facts) => facts.relatedPartyDeclared,
  staff_or_test_activity: (facts) => facts.enrollmentIsStaffOrTest,
  approved_operator_finding: (facts) => facts.approvedOperatorFinding,
};

/** Every evidence kind, in the order a reviewer reads them. */
const EVIDENCE_ORDER: readonly ReferralSelfReferralEvidence[] = [
  'same_oxy_actor',
  'partner_administers_referred_merchant',
  'verified_beneficiary_overlap',
  'explicit_related_party_declaration',
  'staff_or_test_activity',
  'approved_operator_finding',
];

/**
 * Every evidence kind the facts ESTABLISH — strictly `true`, never `undefined`.
 *
 * Exported because the enforcement service records exactly this list on the
 * action, so what an operator later reads as the basis is the same list the
 * decision was made from rather than a re-derivation against facts that have
 * since moved.
 */
export function collectSelfReferralEvidence(
  facts: ReferralSelfReferralFacts,
): readonly ReferralSelfReferralEvidence[] {
  return EVIDENCE_ORDER.filter((kind) => EVIDENCE_FACTS[kind](facts) === true);
}

/**
 * The verdict.
 *
 * `refused` carries ONLY the deterministic evidence, so the explanation given
 * to a partner is exactly the rule that was applied — a refusal quoting a
 * reviewable fact beside a deterministic one invites an appeal against the
 * wrong half. `review` carries everything found, because a reviewer wants all
 * of it.
 */
export function assessSelfReferral(
  facts: ReferralSelfReferralFacts,
): ReferralSelfReferralAssessment {
  const found = collectSelfReferralEvidence(facts);
  if (found.length === 0) return { verdict: 'permitted' };

  const deterministic = found.filter(
    (kind) => REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH[kind] === 'deterministic',
  );
  if (deterministic.length > 0) {
    return { verdict: 'refused', evidence: deterministic };
  }
  return { verdict: 'review', evidence: found };
}

/**
 * May an attribution be created under this verdict?
 *
 * A named function rather than a comparison at each call site, because there
 * are three arms and only one of them permits: a caller writing
 * `verdict !== 'refused'` would attribute everything the reviewer was supposed
 * to look at first, and that mistake reads as correct at a glance.
 */
export function selfReferralPermitsAttribution(
  assessment: ReferralSelfReferralAssessment,
): boolean {
  return assessment.verdict === 'permitted';
}
