/**
 * What each published version of the tax questionnaire ASKS (#146, ADR 0005 D15
 * gate 2).
 *
 * ## A CODE CONSTANT, never a table
 *
 * #126 took this decision for the consumer-rights terms and the reasoning
 * transfers without change: a table would let somebody publish a questionnaire
 * nobody shipped, and — worse — real submissions would then cite it as the
 * questions those partners were asked. A version pointer is only ever as durable
 * as the code that can still resolve it, so the questions live where the code
 * that resolved them lives.
 *
 * The VERSION TUPLE is in `@mercaria/shared-types` because the column's CHECK is
 * rendered from it; the QUESTIONS are here because they are prose, and prose in
 * a shared type is prose three packages recompile for.
 *
 * ## Frozen once published
 *
 * A version's declarations are what somebody answered. Editing them in place
 * would reinterpret a stored declaration — #94's frozen-meaning rule, one domain
 * over — so a change of questions is a NEW entry in
 * `REFERRAL_TAX_QUESTIONNAIRE_VERSIONS` plus a bump of
 * `REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION`, which schedules a re-completion
 * for every partner rather than performing one.
 *
 * ## What is deliberately NOT asked
 *
 * No tax identifier, no VAT number, no identity document, and no withholding
 * question of any kind. The last is the D15 ruling recorded on #146: Mercaria
 * withholds nothing and issues an annual earnings statement, so a rate or an
 * exemption would be a number with no consumer and an obligation with no book.
 * `REFERRAL_TAX_FORBIDDEN_FIELDS` names all of it as values, and a gate scans
 * this domain for them.
 */

import {
  REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION,
  REFERRAL_TAX_QUESTIONNAIRE_VERSIONS,
  type ReferralTaxQuestionnaireVersion,
} from '@mercaria/shared-types';

/** One declaration a version of the questionnaire requires. */
export interface ReferralTaxDeclaration {
  /** The stored field this declaration lands in. */
  readonly field: 'participantType' | 'residencyCountry' | 'vatStatus';
  /** What the partner is being asked, in plain language. */
  readonly question: string;
  /** Why Mercaria needs it — shown beside the question, per #146 privacy 1. */
  readonly purpose: string;
}

/** One published version of the questionnaire. */
export interface ReferralTaxQuestionnaireTerms {
  readonly version: ReferralTaxQuestionnaireVersion;
  /** The date this version began to be the one the gate requires. */
  readonly effectiveFrom: string;
  /**
   * What Mercaria commits to doing with the answers. Shown with the form and
   * stated here so the commitment and the questions cannot drift apart.
   */
  readonly statement: string;
  readonly declarations: readonly ReferralTaxDeclaration[];
}

/**
 * Every published version, oldest first.
 *
 * Keyed by version rather than ordered-by-convention so a lookup cannot silently
 * resolve to a neighbour, and asserted against the shared-types tuple by a test
 * — two lists of versions can disagree, and the direction they would disagree in
 * is a submission citing a version whose questions nobody can produce.
 */
export const REFERRAL_TAX_QUESTIONNAIRE_TERMS: Readonly<
  Record<ReferralTaxQuestionnaireVersion, ReferralTaxQuestionnaireTerms>
> = {
  'tax-2026-08': {
    version: 'tax-2026-08',
    effectiveFrom: '2026-08-16',
    statement:
      'Mercaria withholds no tax from referral payouts. It issues one earnings statement per ' +
      'partner per year recording what it paid; you remain responsible for your own income tax. ' +
      'These answers are used to produce that statement and to decide whether a payout may be ' +
      'made, and for nothing else.',
    declarations: [
      {
        field: 'participantType',
        question: 'Are you taking part as an individual or as a business?',
        purpose: 'It decides whether a VAT question applies to you at all.',
      },
      {
        field: 'residencyCountry',
        question: 'Which country are you tax resident in?',
        purpose: 'It is the jurisdiction your annual earnings statement is issued for.',
      },
      {
        field: 'vatStatus',
        question: 'Are you registered for VAT, exempt from it, or not registered?',
        purpose: 'It decides how your earnings statement presents the amounts Mercaria paid you.',
      },
    ],
  },
};

/** The terms the gate currently requires a submission to answer. */
export function activeReferralTaxQuestionnaire(): ReferralTaxQuestionnaireTerms {
  return REFERRAL_TAX_QUESTIONNAIRE_TERMS[REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION];
}

/**
 * Whether a stored submission answers the version the gate requires.
 *
 * The whole of the version rule, in one place, so the derivation and any surface
 * that explains it to a partner cannot disagree about what "out of date" means.
 */
export function answersCurrentReferralTaxQuestionnaire(
  version: ReferralTaxQuestionnaireVersion,
): boolean {
  return version === REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION;
}

/** Every published version, for a surface that lists them. */
export function publishedReferralTaxQuestionnaires(): readonly ReferralTaxQuestionnaireTerms[] {
  return REFERRAL_TAX_QUESTIONNAIRE_VERSIONS.map(
    (version) => REFERRAL_TAX_QUESTIONNAIRE_TERMS[version],
  );
}
