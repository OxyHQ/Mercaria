/**
 * Turning observed behaviour into risk signals (#148 "Risk signals",
 * ADR 0005 D17).
 *
 * PURE — facts in, signals out. No database, no clock beyond the window the
 * caller measured, no configuration read from inside.
 *
 * ## What a signal is allowed to be about
 *
 * {@link ReferralRiskSignalFacts} is the whole input, and it has a field for
 * every permitted signal and NO field for any member of
 * `REFERRAL_FORBIDDEN_RISK_SIGNALS`. So a detector here cannot be tuned into a
 * device-fingerprint matcher — the parameter to tune it with does not exist,
 * which is the `SourcingCandidateFacts` device and the reason this file takes a
 * facts object rather than a database handle.
 *
 * Every one of the four ADR 0005 D17 thresholds is a count or a rate over
 * MERCARIA'S OWN COMMERCE RECORDS: touches this domain wrote, conversions it
 * verified, refunds and disputes the payment domain recorded. Not one of them
 * reads the request that produced the traffic. D17 says so in as many words —
 * *"HTTP-edge rate limiting is abuse control on requests and contributes
 * nothing to attribution or identity"* — and this is the other half of that
 * sentence: the part that DOES contribute reads commerce, not requests.
 *
 * ## A threshold produces a signal, never an action
 *
 * Everything returned here carries `basis: 'risk_signal'` when it reaches
 * `referral_enforcement_actions`, and the forfeiture CHECK on that table then
 * makes a money-destroying action on it unrepresentable. So the worst a
 * mis-tuned threshold can do is open a review — which is exactly ADR 0005
 * D17's *"signals freeze; only first-party identity evidence voids"*, and it is
 * why nothing in this file needs to be right to be safe.
 *
 * ## Unmeasured is not zero
 *
 * Every fact is optional and `undefined` means NOT MEASURED. A rate computed
 * over a window with no conversions is not a zero refund rate, it is no
 * measurement; emitting `refund_dispute_concentration` at 0 bps for a brand-new
 * partner would put a clean signal on somebody's record and would make the
 * signal table's counts meaningless. The sample floor below is what stops a
 * rate over three conversions being reported as a rate at all.
 */

import type {
  ReferralRiskSignalFacts,
  ReferralRiskSignalKind,
  ReferralRiskSignalSeverity,
} from '@mercaria/shared-types';

/**
 * ADR 0005 D17's four pilot thresholds, plus the sample floor the ADR does not
 * state and a rate needs.
 *
 * A CODE CONSTANT rather than an environment variable or a column, for the
 * reason the retail pilot's bounds are rows and its incident levers are not:
 * these are the DEFAULTS a program version may override, and a value that
 * decides whether somebody's earnings get reviewed should have an author and a
 * date rather than being whatever the last deployment set.
 */
export interface ReferralRiskThresholds {
  /** Touches per code per day (D17: 500). */
  touchesPerDay: number;
  /** Conversions per code per day (D17: 20). */
  conversionsPerDay: number;
  /** Referred-cohort refund rate over the trailing window (D17: >30%). */
  refundRateBps: number;
  /** Referred-cohort dispute rate over the trailing window (D17: >2%). */
  disputeRateBps: number;
  /**
   * The minimum conversions a RATE may be computed over.
   *
   * D17 names no floor and a rate needs one: one refund out of two conversions
   * is 50% and says nothing at all. Twenty is the same floor #125's pilot
   * thresholds use, chosen there for the same reason and kept the same here so
   * two safety mechanisms in one repository do not disagree about what a small
   * sample is.
   */
  minimumRateSample: number;
  /** Days an Oxy account may be old before `referred_account_maturity` fires. */
  referredAccountMinimumAgeDays: number;
}

/** ADR 0005 D17's pilot defaults. */
export const REFERRAL_RISK_THRESHOLD_DEFAULTS: Readonly<ReferralRiskThresholds> = Object.freeze({
  touchesPerDay: 500,
  conversionsPerDay: 20,
  refundRateBps: 3_000,
  disputeRateBps: 200,
  minimumRateSample: 20,
  referredAccountMinimumAgeDays: 1,
});

/** One signal a detector produced, before it is written down. */
export interface DerivedRiskSignal {
  kind: ReferralRiskSignalKind;
  severity: ReferralRiskSignalSeverity;
  observedValue: number;
  thresholdValue?: number;
}

/**
 * The UNIT each signal's `observed_value` carries.
 *
 * Exhaustive over the kinds, so a kind added without a unit fails `tsc`. There
 * is deliberately no unit COLUMN on `referral_risk_signals`: a per-row unit is
 * how a basis-point rate ends up compared against a count, and the unit is a
 * property of the kind rather than of the observation.
 */
export const REFERRAL_RISK_SIGNAL_UNITS: Record<ReferralRiskSignalKind, string> = {
  declared_related_party: 'boolean',
  referred_account_maturity: 'days',
  repeated_conversion_pattern: 'count',
  refund_dispute_concentration: 'basis_points',
  merchant_membership_overlap: 'boolean',
  shared_payout_beneficiary: 'count',
  provider_risk_outcome: 'count',
  instrument_distribution_anomaly: 'count',
  click_to_conversion_pattern: 'seconds',
  market_mismatch: 'boolean',
  repeated_cap_attempt: 'count',
  source_event_inconsistency: 'boolean',
  prior_confirmed_enforcement: 'count',
  manual_evidence: 'count',
};

/** A boolean fact, as the integer the column stores. `undefined` stays absent. */
function flag(value: boolean | undefined): number | undefined {
  return value === undefined ? undefined : value ? 1 : 0;
}

/**
 * Every signal these facts justify.
 *
 * Collected rather than short-circuited: a reviewer opening a case wants
 * everything that fired, and a first-signal-wins derivation would hide the
 * second reason behind the first exactly when a pattern is what matters.
 *
 * A fact that was not measured produces NO signal — never a zero — and a rate
 * measured over fewer than `minimumRateSample` conversions produces none
 * either. Both are the same rule: a signal asserts an observation, and an
 * observation nobody made is not one.
 */
export function deriveRiskSignals(
  facts: ReferralRiskSignalFacts,
  thresholds: ReferralRiskThresholds = REFERRAL_RISK_THRESHOLD_DEFAULTS,
): readonly DerivedRiskSignal[] {
  const signals: DerivedRiskSignal[] = [];

  const declared = flag(facts.declaredRelatedParty);
  if (declared === 1) {
    signals.push({ kind: 'declared_related_party', severity: 'high', observedValue: 1 });
  }

  if (
    facts.referredAccountAgeDays !== undefined &&
    facts.referredAccountAgeDays < thresholds.referredAccountMinimumAgeDays
  ) {
    signals.push({
      kind: 'referred_account_maturity',
      severity: 'elevated',
      observedValue: facts.referredAccountAgeDays,
      thresholdValue: thresholds.referredAccountMinimumAgeDays,
    });
  }

  if (
    facts.conversionsInWindow !== undefined &&
    facts.conversionsInWindow > thresholds.conversionsPerDay
  ) {
    signals.push({
      kind: 'repeated_conversion_pattern',
      severity: 'elevated',
      observedValue: facts.conversionsInWindow,
      thresholdValue: thresholds.conversionsPerDay,
    });
  }

  if (facts.touchesInWindow !== undefined && facts.touchesInWindow > thresholds.touchesPerDay) {
    signals.push({
      kind: 'instrument_distribution_anomaly',
      severity: 'informational',
      observedValue: facts.touchesInWindow,
      thresholdValue: thresholds.touchesPerDay,
    });
  }

  // The two RATES share one sample floor and one reason for it. A rate over a
  // handful of conversions is arithmetic, not evidence.
  const rateSampleSufficient =
    facts.conversionsInWindow !== undefined &&
    facts.conversionsInWindow >= thresholds.minimumRateSample;

  if (
    rateSampleSufficient &&
    facts.refundRateBps !== undefined &&
    facts.refundRateBps > thresholds.refundRateBps
  ) {
    signals.push({
      kind: 'refund_dispute_concentration',
      severity: 'elevated',
      observedValue: facts.refundRateBps,
      thresholdValue: thresholds.refundRateBps,
    });
  } else if (
    rateSampleSufficient &&
    facts.disputeRateBps !== undefined &&
    facts.disputeRateBps > thresholds.disputeRateBps
  ) {
    // A dispute rate is reported only when the refund rate did NOT already
    // report — one `refund_dispute_concentration` signal per window, because
    // two rows of one kind for one window would double-count a single cohort
    // in every operator count that reads them.
    signals.push({
      kind: 'refund_dispute_concentration',
      severity: 'high',
      observedValue: facts.disputeRateBps,
      thresholdValue: thresholds.disputeRateBps,
    });
  }

  if (facts.merchantMembershipOverlap === true) {
    signals.push({ kind: 'merchant_membership_overlap', severity: 'high', observedValue: 1 });
  }

  if (
    facts.sharedPayoutBeneficiaryPartnerCount !== undefined &&
    facts.sharedPayoutBeneficiaryPartnerCount > 0
  ) {
    signals.push({
      kind: 'shared_payout_beneficiary',
      severity: 'high',
      observedValue: facts.sharedPayoutBeneficiaryPartnerCount,
    });
  }

  if (
    facts.providerAdverseOutcomeCount !== undefined &&
    facts.providerAdverseOutcomeCount > 0
  ) {
    signals.push({
      kind: 'provider_risk_outcome',
      severity: 'elevated',
      observedValue: facts.providerAdverseOutcomeCount,
    });
  }

  if (facts.medianClickToConversionSeconds !== undefined) {
    // A conversion in under five seconds of the click is not somebody reading a
    // product page. It is `informational` rather than `high` because a
    // re-clicked link on an already-full cart legitimately produces one.
    if (facts.medianClickToConversionSeconds < 5) {
      signals.push({
        kind: 'click_to_conversion_pattern',
        severity: 'informational',
        observedValue: facts.medianClickToConversionSeconds,
        thresholdValue: 5,
      });
    }
  }

  if (facts.marketOutsideProgramScope === true) {
    signals.push({ kind: 'market_mismatch', severity: 'informational', observedValue: 1 });
  }

  if (facts.capRefusalCount !== undefined && facts.capRefusalCount > 0) {
    signals.push({
      kind: 'repeated_cap_attempt',
      severity: 'informational',
      observedValue: facts.capRefusalCount,
    });
  }

  if (facts.sourceEventInconsistent === true) {
    signals.push({ kind: 'source_event_inconsistency', severity: 'elevated', observedValue: 1 });
  }

  if (
    facts.priorConfirmedEnforcementCount !== undefined &&
    facts.priorConfirmedEnforcementCount > 0
  ) {
    signals.push({
      kind: 'prior_confirmed_enforcement',
      severity: 'high',
      observedValue: facts.priorConfirmedEnforcementCount,
    });
  }

  return signals;
}
