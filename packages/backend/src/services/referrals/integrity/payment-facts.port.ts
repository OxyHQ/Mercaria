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

/** Which partner is being asked about. The whole of what the reader gets. */
export interface ReferralRiskPaymentSubject {
  partnerId: string;
  ownerType: 'user' | 'store';
  ownerId: string;
  /** The trailing window every velocity fact is measured over. */
  windowStart: Date;
  windowEnd: Date;
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
  /** Other approved partners resolving to the SAME connected account. */
  sharedPayoutBeneficiaryPartnerCount?: number;
  /** Adverse payment outcomes on this partner's referred orders. */
  providerAdverseOutcomeCount?: number;
  /** Disputed conversions ÷ conversions over the window, in basis points. */
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
