/**
 * The referral partner TAX QUESTIONNAIRE (#146, ADR 0005 D15 gate 2).
 *
 * D15 states the gate in one sentence: "the partner has completed Mercaria's tax
 * questionnaire (residency, and business/VAT status for invoicing). **Mercaria
 * issues an annual earnings statement per partner; partners are responsible for
 * their own income tax.**"
 *
 * ## Mercaria WITHHOLDS NOTHING, and that is why there is no withholding here
 *
 * The word "withholding" appears in #146's own text, and the ruling recorded on
 * the issue is that it does not become a ledger account. Mercaria withholds
 * nothing, so it owes no remittance to any tax authority, and an account for
 * withheld money would put a liability in a book nobody reconciles against one.
 * `referral_payout_batches.withholding_minor` stays where #145 put it, with its
 * CHECK tying `net = gross − withholding`, and `withholding_not_supported` stays
 * the refusal a batch carrying one earns.
 *
 * The consequence for THIS file is the shape of what it does not contain: no
 * rate, no exemption, no treaty, no certificate. A platform reporting regime
 * (DAC7 and its analogues) is ADR 0005's own open item 1 and is confirmed with
 * the legal entity before live payouts — and when it lands it changes what the
 * QUESTIONNAIRE COLLECTS, never what the ledger holds, which is why it would
 * arrive here as a new version rather than anywhere near an account.
 *
 * ## No tax IDENTIFIER is representable, and that is the privacy property
 *
 * D15 asks for residency and business/VAT STATUS. A status is what invoicing
 * needs to know; the NUMBER would be needed only for self-billing, which
 * Mercaria does not do — it issues an earnings statement, which is a record of
 * what it paid rather than an invoice raised on the partner's behalf. So no
 * column, field or DTO here can hold a VAT number, a TIN, an NIF or a national
 * identifier, and {@link REFERRAL_TAX_FORBIDDEN_FIELDS} names the prohibition as
 * a VALUE a gate scans for rather than as a rule somebody remembers. Identity
 * documents are Stripe's under ADR 0001 D2 and reach Mercaria in no form at all.
 */

/**
 * Which kind of person or entity is being paid.
 *
 * The pair is what decides whether a VAT status is a meaningful question, and it
 * is the partner's own declaration — Mercaria verifies none of it, which is
 * exactly what makes the KYC gate (D15 gate 1, Stripe's) a separate gate rather
 * than this one.
 */
export type ReferralTaxParticipantType = 'individual' | 'business';

/** {@link ReferralTaxParticipantType} as the tuple the column and its CHECK read. */
export const REFERRAL_TAX_PARTICIPANT_TYPES: readonly ReferralTaxParticipantType[] = [
  'individual',
  'business',
];

/**
 * The partner's VAT standing, for invoicing.
 *
 * `not_registered` and `exempt` are deliberately DIFFERENT values rather than
 * one "no VAT": a partner below a registration threshold and one holding an
 * exemption are answering different questions, and collapsing them would make
 * the earnings statement unable to say which.
 *
 * There is no `unknown` member. A questionnaire whose VAT answer is unknown is
 * an INCOMPLETE questionnaire, which is the absence of a submission rather than
 * a submission carrying a shrug — the gate reads "did they complete it", and a
 * storable "I do not know" would let an incomplete answer satisfy it.
 */
export type ReferralTaxVatStatus = 'not_registered' | 'registered' | 'exempt';

/** {@link ReferralTaxVatStatus} as the tuple the column and its CHECK read. */
export const REFERRAL_TAX_VAT_STATUSES: readonly ReferralTaxVatStatus[] = [
  'not_registered',
  'registered',
  'exempt',
];

/**
 * The published versions of the questionnaire, oldest first.
 *
 * A tuple in shared-types because the column's CHECK is rendered from it (the
 * `ALL_CURRENCY_CODES` device), so a version that was never published has no row
 * shape — a submission citing one is refused by the database, not merely by the
 * service that happens to be in front of it today.
 *
 * The QUESTIONS each version asks are a code constant in the backend
 * (`services/referrals/tax-terms.ts`), never a table, for #126's reason: a table
 * would let somebody publish a questionnaire nobody shipped, and it would be
 * cited by real submissions as what those partners were asked.
 */
export type ReferralTaxQuestionnaireVersion = 'tax-2026-08';

/** {@link ReferralTaxQuestionnaireVersion} as a tuple, oldest first. */
export const REFERRAL_TAX_QUESTIONNAIRE_VERSIONS: readonly ReferralTaxQuestionnaireVersion[] = [
  'tax-2026-08',
];

/**
 * The version a submission must cite to satisfy the gate today.
 *
 * Bumping this SCHEDULES a re-completion rather than performing one: every
 * partner whose latest submission cites an older version reads `pending` at the
 * next derivation, with no sweep having run and no stored verdict to go stale.
 * That is #85's policy-version decision and #94's frozen-meaning decision in one
 * — the older submissions stay exactly as they were made, because what somebody
 * declared under the questions they were asked is not something a later version
 * may reinterpret.
 */
export const REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION: ReferralTaxQuestionnaireVersion =
  'tax-2026-08';

/**
 * Facts a tax profile may NEVER carry, named as values so a gate can scan for
 * them.
 *
 * Disjoint from everything this domain records, and each is here for its own
 * reason: the first four are identifiers Mercaria has no use for and every
 * reason not to hold, the next two are Stripe's under ADR 0001 D2, and the last
 * three are the withholding vocabulary the D15 ruling keeps out of the ledger —
 * present here so that a future reader adding "just the rate" to the
 * questionnaire fails the build and finds the reasoning rather than the absence.
 */
export const REFERRAL_TAX_FORBIDDEN_FIELDS: readonly string[] = [
  'taxIdentifier',
  'vatNumber',
  'taxpayerIdentificationNumber',
  'nationalIdentityNumber',
  'identityDocument',
  'bankAccount',
  'withholdingRate',
  'withholdingExemption',
  'treatyBenefit',
];

/**
 * One partner's current tax declaration, as a surface may read it.
 *
 * Every field is named explicitly rather than spread from the row — the
 * `ProviderAccountStatus` precedent, and the reason is the same: the row carries
 * who declared it, and a projection that spread would carry that the day
 * somebody added a column.
 */
export interface ReferralTaxProfile {
  partnerId: string;
  revision: number;
  questionnaireVersion: ReferralTaxQuestionnaireVersion;
  participantType: ReferralTaxParticipantType;
  /** ISO 3166-1 alpha-2, upper case. */
  residencyCountry: string;
  vatStatus: ReferralTaxVatStatus;
  declaredAt: string;
  /** Whether this declaration answers the version the gate currently requires. */
  answersCurrentQuestionnaire: boolean;
}
