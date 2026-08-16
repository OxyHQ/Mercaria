/**
 * Where the risk signals' PAYMENT-domain facts come from — a named seam
 * (#344, #148 "Risk signals", ADR 0005 D17).
 *
 * ## Why this is a port and not an import
 *
 * Three of #148's fourteen risk-signal facts are answerable only from the
 * payment domain, and WALL 2 of `referral-integrity-isolation.test.ts` forbids
 * everything under `services/referrals/integrity/` from reaching it. That wall
 * is right: a fraud detector that can read the payment domain is one join from
 * a fraud DECISION that depends on it, and the whole of D17 rests on a signal
 * being a reason to look rather than a reason to keep somebody's money.
 *
 * So the dependency runs the other way. `services/referral-payouts/` — which
 * sits outside BOTH walled domains and already joins them for #146's readiness
 * — registers INTO this port at boot. Every edge points join → domain, and this
 * domain names no module outside itself. That is #146's shape exactly, and
 * reusing it rather than inventing a second join is deliberate: two places
 * bridging referrals and payments would be two places to get the direction
 * wrong.
 *
 * A TRANSITIVE import is the version worth naming, because a text-scanning gate
 * cannot see it: this domain importing `services/referral-payouts/`, which
 * imports `services/payments/`, would defeat WALL 2 while reading as clean.
 * Nothing here imports the join.
 *
 * ## The default is UNMEASURED, and it INVERTS the sibling port on purpose
 *
 * #124's ruling is that ports have DIFFERENT defaults and getting one backwards
 * breaks something, so this one states its direction out loud rather than
 * copying the file next door.
 *
 * `partner-readiness.port.ts` REFUSES when unregistered: an absent KYC verdict
 * is Mercaria not knowing whether it may send somebody money, so it blocks.
 *
 * This port answers `undefined` — NOT MEASURED — for every fact, and that is
 * the safe direction here for a reason that does not transfer between the two:
 *
 *  - `deriveRiskSignals` emits NOTHING for an undefined fact, so an
 *    unregistered deployment records no signal rather than a clean one. The
 *    absence is a silence.
 *  - The opposite default would have to invent a NUMBER — a zero dispute rate,
 *    a zero adverse-outcome count, zero shared beneficiaries — and every one of
 *    those is an assertion nobody measured, written onto a partner's record. It
 *    is the exact failure the domain's own "unmeasured is not zero" rule exists
 *    to prevent, and #149 keeps `no_producer` apart from `no_measurement` for
 *    the same reason.
 *  - Failing "open" is bounded here in a way it is not for readiness: a risk
 *    signal can only ever open a review. It cannot destroy money —
 *    `referral_enforcement_actions_forfeiture_basis_check` makes a forfeiting
 *    action on a `risk_signal` basis unrepresentable — so the worst an absent
 *    reader does is fail to start an investigation, while an invented zero
 *    would report a clean partner nobody examined.
 *
 * Which is to say: the readiness port protects MONEY LEAVING and must block;
 * this one protects a CLAIM ABOUT SOMEBODY and must stay silent.
 */

import { log } from '../../../lib/logger.js';

/**
 * The window's ORDER-sourced conversions, projected onto the order each was
 * derived from — or a statement that they could not be enumerated.
 *
 * A STRING discriminant, not a boolean one: this package compiles with
 * `strict: false` and therefore without `strictNullChecks`, under which
 * TypeScript does not narrow a union on the truthiness of a boolean-literal
 * member and the reader would be left holding the whole union (#68 and #110 hit
 * this and it is written down in both).
 *
 * `{ kind: 'enumerated', orderRefs: [] }` is a MEASUREMENT — the domain counted
 * and none of this partner's window conversions came from an order — and it is
 * a different fact from `not_enumerable`, which is Mercaria declining to answer.
 * The reader must land on silence for the second and on an honest zero for the
 * first, so collapsing them would be the "unknown read as zero" defect the whole
 * facts type exists to prevent.
 */
export type ReferralRiskOrderCohort =
  | { kind: 'enumerated'; orderRefs: readonly string[] }
  /**
   * The cohort was larger than {@link REFERRAL_RISK_ORDER_COHORT_BOUND}, so what
   * the domain holds is a PREFIX of it. A rate over a truncated cohort
   * under-reports in the reassuring direction, which is the one direction a
   * fraud measurement must never fail in — so the whole answer is withheld
   * rather than served short.
   */
  | { kind: 'not_enumerable'; reason: 'cohort_exceeds_bound' };

/**
 * How many order-sourced conversions one partner may have in one window before
 * the cohort stops being enumerable.
 *
 * It bounds the array crossing this port AND the parameter count of the
 * reader's `in (…)` predicates. Generous on purpose: the window is 24 hours and
 * one partner, so a cohort this size is itself an operator conversation.
 */
export const REFERRAL_RISK_ORDER_COHORT_BOUND = 10_000;

/** Which partner is being asked about. The whole of what the reader gets. */
export interface ReferralRiskPaymentSubject {
  partnerId: string;
  ownerType: 'user' | 'store';
  ownerId: string;
  /** The trailing window every velocity fact is measured over. */
  windowStart: Date;
  windowEnd: Date;
  /**
   * The DENOMINATOR every rate here is taken over, counted by the referral
   * domain and passed in rather than re-counted.
   *
   * This is the single most load-bearing field on the subject. `deriveRiskSignals`
   * guards both rates behind `conversionsInWindow >= minimumRateSample`, so a
   * reader dividing by a number it derived itself would have the sample floor
   * guarding one denominator while the rate measured another — and the two would
   * disagree the first time either read changed, silently, in the permissive
   * direction. One derivation, in the domain that owns the definition of "this
   * partner's conversions in this window".
   */
  conversionsInWindow: number;
  /**
   * The NUMERATOR's population, from that same single derivation.
   *
   * Handed over rather than looked up for the reason above: a reader
   * reconstructing "conversions → attributions → this partner, inside this
   * window" would be a second spelling of a predicate the caller has already
   * evaluated. Duplicates are PRESERVED — two conversions derived from one order
   * are two conversions, and the contract is a rate over conversions.
   *
   * An order id is a Mercaria commerce id the referral domain already stores in
   * `referral_conversions.source_ref`, so nothing new crosses here. The
   * prohibition (#148 boundary 2) is on a PAYMENT identifier travelling the
   * other way, and {@link ReferralRiskPaymentFacts} is where that is refused.
   */
  orderCohort: ReferralRiskOrderCohort;
}

/**
 * The payment-domain facts, each optional and each meaning NOT MEASURED when
 * absent.
 *
 * A strict subset of `ReferralRiskSignalFacts`' field names, deliberately: the
 * caller spreads these into that object, so a name that drifted would fail
 * `tsc` at the spread rather than silently supplying a fact nothing reads.
 *
 * Every member is a COUNT or a RATE. There is no account id, no charge id, no
 * dispute id and no customer reference, and none may be added — #148 boundary 2
 * forbids a payment identifier becoming referral identity, and a port that
 * carried one would hand it across the wall this file exists to respect.
 * `providerAdverseOutcomeCount`'s own contract in `ReferralRiskSignalFacts`
 * says it: *"Payment-domain OUTCOMES on referred orders in the window. Never an
 * id."*
 */
export interface ReferralRiskPaymentFacts {
  /**
   * Other approved partners resolving to the SAME connected account.
   *
   * **UNMEASURABLE TODAY, and not for want of a producer** — see
   * `services/__tests__/referral-risk-payment-facts.realdb.test.ts`, which
   * proves it against a real server. The resolution partner → owner → account
   * row is INJECTIVE at every hop (`referral_partners_owner_key`,
   * `referralPayoutAccountOwner` being the identity, and
   * `provider_accounts_provider_account_id_key`), so two partners cannot share a
   * beneficiary and a producer would answer zero for everybody forever.
   *
   * The member stays because the SIGNAL is real and #146 increment 3's deferred
   * beneficiary change is what makes it measurable; deleting it would lose the
   * question along with the answer.
   */
  sharedPayoutBeneficiaryPartnerCount?: number;
  /**
   * Adverse payment outcomes on this partner's referred orders — the provider
   * DECLINING a charge attempt, and nothing else.
   *
   * Deliberately DISJOINT from the dispute count below, which is the other half
   * of the same cohort. `risk-thresholds.ts` already refuses to report a refund
   * rate and a dispute rate as two rows of one kind, because two rows for one
   * cohort double-count it in every operator total that reads them; letting a
   * dispute score BOTH `refund_dispute_concentration` and `provider_risk_outcome`
   * would reintroduce exactly that across two kinds instead of within one.
   *
   * A count, so ZERO is a measurement — the cohort was enumerated and the
   * provider refused nothing — and `deriveRiskSignals` stays silent at zero.
   */
  providerAdverseOutcomeCount?: number;
  /**
   * Disputed conversions ÷ conversions over the window, in basis points.
   *
   * The denominator is {@link ReferralRiskPaymentSubject.conversionsInWindow}
   * and never a number the reader counted, so this rate and the `refundRateBps`
   * beside it are taken over one cohort and the shared sample floor guards both.
   */
  disputeRateBps?: number;
}

/** The one function the join implements. */
export type ReferralRiskPaymentFactsReader = (
  subject: ReferralRiskPaymentSubject,
) => Promise<ReferralRiskPaymentFacts>;

/**
 * What an unregistered deployment answers.
 *
 * Exported so a test can assert the DEFAULT rather than only the registered
 * path — a port whose unregistered behaviour is untestable is a port whose
 * unregistered behaviour is unknown (`partner-readiness.port.ts`'s reasoning,
 * and #145's about the rail).
 *
 * The empty object rather than three explicit `undefined`s: spreading it adds
 * no keys at all, so a caller cannot accidentally write `disputeRateBps:
 * undefined` into a facts object and make "we looked" indistinguishable from
 * "the field exists".
 */
export const UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS: ReferralRiskPaymentFacts = {};

let reader: ReferralRiskPaymentFactsReader | undefined;

/** Register the reader. Called once at boot by the payout join. */
export function registerReferralRiskPaymentFactsReader(
  implementation: ReferralRiskPaymentFactsReader,
): void {
  reader = implementation;
}

/** Drop the registration. For tests, for the reason the sibling's reset exists. */
export function resetReferralRiskPaymentFactsReader(): void {
  reader = undefined;
}

/**
 * Read the payment-domain facts for one partner.
 *
 * Never throws. A reader that fails is the same situation as no reader at all —
 * Mercaria did not measure these facts on this pass — and both land on the same
 * silence. A throw here would abort `collectRiskSignalFacts`, which would turn
 * a payment-domain outage into a failure to record the SIX facts that have
 * nothing to do with payments, and an operator's risk evaluation would return
 * nothing at the moment they most wanted it.
 */
export async function readReferralRiskPaymentFacts(
  subject: ReferralRiskPaymentSubject,
): Promise<ReferralRiskPaymentFacts> {
  if (!reader) return UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS;
  try {
    return await reader(subject);
  } catch (error) {
    log.general.error(
      { err: error, partnerId: subject.partnerId },
      '[Referrals] the risk payment-facts reader threw; those facts stay unmeasured',
    );
    return UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS;
  }
}
