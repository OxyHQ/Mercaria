/**
 * What each published version of Mercaria's referral PARTNER AGREEMENT says
 * (#146 increment 2, "Terms acceptance").
 *
 * ## A CODE CONSTANT, never a table
 *
 * The tax questionnaire took this decision one document over and #126 took it
 * for the consumer-rights terms; the reasoning does not change. A table would
 * let somebody publish an agreement nobody shipped, and — worse — real
 * acceptances would then cite it as what those partners agreed to. A version
 * pointer is only as durable as the code that can still resolve it, so the text
 * lives where the code that resolves it lives.
 *
 * The VERSION TUPLE is in `@mercaria/shared-types` because the acceptance
 * column's CHECK is rendered from it; the CLAUSES are here because they are
 * prose, and prose in a shared type is prose three packages recompile for.
 *
 * ## Frozen once published, and a bump SCHEDULES rather than performs
 *
 * Editing a clause in place would reinterpret what somebody accepted — #94's
 * frozen-meaning rule. A change is a NEW entry in
 * `REFERRAL_PARTNER_AGREEMENT_VERSIONS` plus a bump of
 * `REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION`, after which every partner whose
 * latest acceptance names an older version reads
 * `partner_agreement_superseded` at the next derivation, with no sweep having
 * run and no stored verdict to go stale.
 *
 * #146 terms rule 6 — "future attribution may pause until new terms are
 * accepted" — is therefore available and deliberately NOT wired: pausing
 * attribution on a terms bump is a policy decision with a partner-visible cost,
 * `referral_program_controls.attribution_enabled` is the lever that already
 * expresses it, and #143 owns that lever. What #146 supplies is the fact the
 * decision would read.
 *
 * ## Rule 9, held by the shape of the request rather than by copy
 *
 * "Do not preselect acceptance." There is no default and no boolean an absent
 * field could fall back to: the acceptance route takes a VERSION, and not
 * sending one is not an acceptance of anything. A checkbox that arrives ticked
 * is a client bug this server cannot be made to commit.
 */

import {
  REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
  REFERRAL_PARTNER_AGREEMENT_VERSIONS,
  type ReferralPartnerAgreementVersion,
} from '@mercaria/shared-types';

/** One clause of one version, as a partner reads it. */
export interface ReferralPartnerAgreementClause {
  /** Stable within a version, so a client may anchor to it. */
  readonly key: string;
  readonly heading: string;
  readonly body: string;
}

/** One published version of the partner agreement. */
export interface ReferralPartnerAgreementTerms {
  readonly version: ReferralPartnerAgreementVersion;
  /** The date this version began to be the one acceptance is measured against. */
  readonly effectiveFrom: string;
  /**
   * Whether adopting this version requires everyone to accept it again.
   *
   * #146 terms rule 4: "Re-accept only when a material new version requires
   * it." A version that only fixes a typo would carry `false` and leave earlier
   * acceptances satisfying the gate — which is why the flag is on the VERSION
   * rather than being inferred from the version string being different.
   */
  readonly requiresReacceptance: boolean;
  readonly clauses: readonly ReferralPartnerAgreementClause[];
}

/**
 * Every published version, keyed by version rather than ordered by convention
 * so a lookup cannot silently resolve to a neighbour.
 *
 * A `Record` over the union, so a version added to the shared-types tuple and
 * not written here fails `tsc` — two lists of versions can disagree, and the
 * direction they would disagree in is an acceptance citing a version whose text
 * nobody can produce.
 */
export const REFERRAL_PARTNER_AGREEMENT_TERMS: Readonly<
  Record<ReferralPartnerAgreementVersion, ReferralPartnerAgreementTerms>
> = {
  'partner-2026-08': {
    version: 'partner-2026-08',
    effectiveFrom: '2026-08-16',
    requiresReacceptance: true,
    clauses: [
      {
        key: 'what_this_is',
        heading: 'What you are agreeing to',
        body:
          'You may promote Mercaria using the referral instruments Mercaria issues to you, and ' +
          'Mercaria will pay you the commission the program you are approved for defines, on the ' +
          'terms that program publishes. This agreement covers your participation; each program ' +
          'publishes its own terms and its own commission rules, and you accept those separately.',
      },
      {
        key: 'earning_and_withdrawal',
        heading: 'Earning is not the same as being paid',
        body:
          'You begin earning when a referral you made converts under an approved program. You are ' +
          'paid once your identity verification and your tax questionnaire are complete and a ' +
          'payout destination is ready. Until then earnings accrue and are held; nothing is lost ' +
          'and nothing expires while you complete them.',
      },
      {
        key: 'prohibited_methods',
        heading: 'How you may not promote',
        body:
          'No unsolicited messaging, no paid search on Mercaria or Oxy brand terms, no browser ' +
          'extensions or toolbars that inject referral instruments, no cookie stuffing, no ' +
          'self-referral through accounts you control, and no claim that you speak for Mercaria. ' +
          'Referrals obtained this way do not convert, and repeated use ends your participation.',
      },
      {
        key: 'tax',
        heading: 'Tax',
        body:
          'Mercaria withholds no tax from what it pays you. It issues one earnings statement per ' +
          'year recording what it paid; you remain responsible for your own income tax. Your ' +
          'answers to the tax questionnaire are used to produce that statement and to decide ' +
          'whether a payout may be made, and for nothing else.',
      },
      {
        key: 'suspension_and_termination',
        heading: 'Suspension, termination and notice',
        body:
          'Mercaria may suspend your participation while it reviews a concern, which stops new ' +
          'referrals being credited and leaves everything already earned exactly where it is. ' +
          'Either side may end this agreement; ending it does not cancel commission already ' +
          'earned and vested. You will be told when either happens and why, and you may ask for ' +
          'the decision to be reconsidered.',
      },
      {
        key: 'no_permissions',
        heading: 'What this does not grant you',
        body:
          'Being a referral partner gives you no access to any shop, no ability to act for any ' +
          'merchant, no payment permissions and no administrative role. It is a commercial ' +
          'arrangement about referrals and nothing else.',
      },
    ],
  },
};

/** The agreement acceptance is currently measured against. */
export function activeReferralPartnerAgreement(): ReferralPartnerAgreementTerms {
  return REFERRAL_PARTNER_AGREEMENT_TERMS[REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION];
}

/**
 * Whether a stored acceptance still satisfies the gate.
 *
 * The whole of the version rule in ONE place, so the derivation and any surface
 * explaining itself to a partner cannot disagree about what "out of date"
 * means. An acceptance of the ACTIVE version always satisfies it; an older one
 * satisfies it only while no version at or after it required re-acceptance —
 * which is #146 terms rule 4 read literally rather than "any newer version
 * invalidates everything".
 */
export function acceptanceSatisfiesPartnerAgreement(accepted: string): boolean {
  const acceptedIndex = REFERRAL_PARTNER_AGREEMENT_VERSIONS.indexOf(
    accepted as ReferralPartnerAgreementVersion,
  );
  if (acceptedIndex < 0) return false;

  const activeIndex = REFERRAL_PARTNER_AGREEMENT_VERSIONS.indexOf(
    REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
  );
  if (acceptedIndex >= activeIndex) return true;

  // Every version strictly AFTER the one accepted, up to and including the
  // active one. If any of them is material, the old acceptance no longer
  // satisfies the gate.
  return !REFERRAL_PARTNER_AGREEMENT_VERSIONS.slice(acceptedIndex + 1, activeIndex + 1).some(
    (version) => REFERRAL_PARTNER_AGREEMENT_TERMS[version].requiresReacceptance,
  );
}

/** Every published version, for a surface that lists them. */
export function publishedReferralPartnerAgreements(): readonly ReferralPartnerAgreementTerms[] {
  return REFERRAL_PARTNER_AGREEMENT_VERSIONS.map(
    (version) => REFERRAL_PARTNER_AGREEMENT_TERMS[version],
  );
}
