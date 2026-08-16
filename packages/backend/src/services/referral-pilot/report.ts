/**
 * COMPOSING THE PILOT REPORT (#149 "Pilot metrics", "Unit economics").
 *
 * PURE. The aggregates arrive from `measurementRepository.ts`; what happens
 * here is the arithmetic and, much more of the work, deciding which of the
 * thirty measures this repository can honestly put a number against.
 *
 * ## The producer registry is the whole point
 *
 * #149 asks for thirty figures, each with an exact numerator, denominator,
 * window and source. Defining them is done (`REFERRAL_PILOT_MEASURES`).
 * PRODUCING them is not: eight are classified `unavailable` in the definition
 * itself, two need a figure only a person holds, and of the twenty that could
 * in principle be derived from Mercaria's own records this issue ships eight.
 *
 * A report that quietly rendered the other twelve as zero would be the exact
 * failure #125 named one domain over — "a sweep computing only the five it can
 * reach would report no breaches for the other eight, which is precisely the
 * vacuous monitor `unmeasured` exists to make visible". So the registry below
 * is the LIST of measures a producer exists for, the report marks every other
 * one `unmeasured` with its reason, and `unmeasuredCount` is rendered beside
 * the figures rather than in a footnote.
 *
 * Closing a gap is adding a key here and the arithmetic beside it — not editing
 * a definition, which is what the partner and the reviewer were shown.
 */

import {
  REFERRAL_PILOT_MEASURES,
  type ReferralPilotMeasureDefinition,
  type ReferralPilotUnmeasuredReason,
} from '@mercaria/shared-types';
import type { ReferralPilotAggregates } from '../../db/referralPilot/measurementRepository.js';

/** One measure as the report renders it. */
export type ReferralPilotReportLine =
  | {
      readonly outcome: 'measured';
      readonly definition: ReferralPilotMeasureDefinition;
      readonly value: number;
      /** How many observations the value was derived from — the vacuity floor. */
      readonly sampleSize: number;
    }
  | {
      readonly outcome: 'unmeasured';
      readonly definition: ReferralPilotMeasureDefinition;
      readonly reason: ReferralPilotUnmeasuredReason;
      /** The issue that owes the producer, when the definition names one. */
      readonly seam?: string;
    };

/** The whole report for one cohort version. */
export interface ReferralPilotReport {
  readonly cohortId: string;
  readonly cohortVersion: number;
  readonly from: Date;
  readonly to: Date;
  readonly lines: readonly ReferralPilotReportLine[];
  /** How many of the thirty carry no number, and why. */
  readonly unmeasuredCount: number;
  /**
   * Whether the report may be read as a basis for expansion.
   *
   * FALSE while any component of `net_contribution` is unmeasured, and that is
   * #149's own rule made mechanical: "a program with attractive GMV but
   * negative contribution must not expand automatically" only bites if
   * contribution is a number somebody actually has. A report that cannot state
   * it says so in one field rather than leaving a reader to notice.
   */
  readonly netContributionMeasurable: boolean;
}

/**
 * The measures a producer exists for TODAY.
 *
 * EIGHT of thirty, all computed from the two aggregates
 * `readReferralPilotAggregates` takes. The twenty-two absent are the honest
 * state of this repository, and `docs/referral-pilots.md` lists each with what
 * would close it — three of them (`payout_and_fx_fees`, and the two retention
 * measures) cannot be closed here at all, because the data does not exist.
 */
const PRODUCED_MEASURE_KEYS: readonly string[] = [
  'eligible_referred_subjects',
  'qualified_conversion_rate',
  'native_revenue_generated',
  'commission_pending',
  'commission_approved',
  'budget_utilization',
  'eligible_mercaria_revenue',
  'referral_commission_expense',
];

/** The components `net_contribution` is composed from (#149 unit economics 6). */
export const NET_CONTRIBUTION_COMPONENTS: readonly string[] = [
  'eligible_mercaria_revenue',
  'referral_commission_expense',
  'payout_and_fx_fees',
  'fraud_and_reversal_loss',
  'support_and_operational_cost',
];

/**
 * Basis points, floored.
 *
 * Floored rather than rounded, so a rate never reads higher than the sample
 * supports — the direction that matters when the number decides whether a stop
 * fires. A zero denominator answers `null`, which the caller renders
 * `unmeasured/empty_sample` rather than as 0%.
 */
function rateBps(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.floor((numerator * 10_000) / denominator);
}

/** The value and sample for one produced measure, or `null` if the sample is empty. */
function produce(
  key: string,
  aggregates: ReferralPilotAggregates,
  budgetMinor: number,
): { value: number; sampleSize: number } | null {
  switch (key) {
    case 'eligible_referred_subjects':
      return { value: aggregates.distinctSubjects, sampleSize: aggregates.attributions };
    case 'qualified_conversion_rate': {
      const bps = rateBps(aggregates.verifiedConversions, aggregates.attributions);
      return bps === null ? null : { value: bps, sampleSize: aggregates.attributions };
    }
    case 'native_revenue_generated':
    case 'eligible_mercaria_revenue':
      return { value: aggregates.realizedBaseMinor, sampleSize: aggregates.rewards };
    case 'commission_pending':
      return { value: aggregates.heldNetMinor, sampleSize: aggregates.rewards };
    case 'commission_approved':
      return { value: aggregates.vestedNetMinor, sampleSize: aggregates.rewards };
    case 'referral_commission_expense':
      return { value: aggregates.accruedNetMinor, sampleSize: aggregates.rewards };
    case 'budget_utilization': {
      const bps = rateBps(aggregates.accruedNetMinor, budgetMinor);
      return bps === null ? null : { value: bps, sampleSize: aggregates.rewards };
    }
    default:
      return null;
  }
}

/**
 * Compose the report.
 *
 * Iterates the DEFINITIONS, never the produced set — so a measure nobody
 * computes is present in the output with a reason, which is the difference
 * between a report that is short and a report that is silent.
 */
export function composeReferralPilotReport(input: {
  cohortId: string;
  cohortVersion: number;
  from: Date;
  to: Date;
  budgetMinor: number;
  aggregates: ReferralPilotAggregates;
}): ReferralPilotReport {
  const lines: ReferralPilotReportLine[] = REFERRAL_PILOT_MEASURES.map((definition) => {
    if (!PRODUCED_MEASURE_KEYS.includes(definition.key)) {
      return {
        outcome: 'unmeasured',
        definition,
        reason: 'no_producer',
        ...(definition.seam === undefined ? {} : { seam: definition.seam }),
      };
    }
    const produced = produce(definition.key, input.aggregates, input.budgetMinor);
    if (produced === null) {
      return { outcome: 'unmeasured', definition, reason: 'empty_sample' };
    }
    return {
      outcome: 'measured',
      definition,
      value: produced.value,
      sampleSize: produced.sampleSize,
    };
  });

  const measured = new Set(
    lines.filter((line) => line.outcome === 'measured').map((line) => line.definition.key),
  );

  return {
    cohortId: input.cohortId,
    cohortVersion: input.cohortVersion,
    from: input.from,
    to: input.to,
    lines,
    unmeasuredCount: lines.filter((line) => line.outcome === 'unmeasured').length,
    netContributionMeasurable: NET_CONTRIBUTION_COMPONENTS.every((key) => measured.has(key)),
  };
}
