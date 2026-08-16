/**
 * The reader-facing copy for the referral partner dashboard (#147
 * "Accessibility and localization").
 *
 * The KEYS live in `@mercaria/shared-types` and never change; this file is the
 * part that is deliberately free to — the `condition.ts` split, one domain over,
 * for the same reason.
 *
 * ## Every financial state carries a plain-language explanation (#147
 * accessibility rule 1)
 *
 * "Held" tells a partner nothing. Each state's explanation says what is
 * actually true of that money — whether it can still change, whether anything
 * is owed and what would move it — and the `Record` type makes an unexplained
 * state a compile error rather than a blank line in a UI.
 *
 * ## Nothing here relies on colour (#147 accessibility rule 2)
 *
 * The exports are LABELS and SENTENCES. There is deliberately no colour map in
 * this file: a surface that wanted one would have to write it beside the label
 * it belongs to, where a reviewer can see that the label carries the meaning on
 * its own.
 *
 * ## No abbreviation obscures the revenue base (#147 accessibility rule 8)
 *
 * `describeRewardBasis` renders the FULL sentence a program's funding source
 * carries — never "20% comm." — because the difference between a percentage of
 * Mercaria's commission and a percentage of the order is the whole thing a
 * partner is agreeing to.
 */

import type {
  ReferralMetricDefinition,
  ReferralPartnerOutstandingItem,
  ReferralRewardBasisCopy,
  ReferralRewardState,
} from "@mercaria/shared-types";

/** The short label a badge shows for one reward state. */
export const REFERRAL_REWARD_STATE_LABELS: Readonly<Record<ReferralRewardState, string>> = {
  held: "On hold",
  vested: "Vested",
  frozen: "Under review",
  paid: "Paid",
  voided: "Reversed",
};

/** What is actually true of money in that state. */
export const REFERRAL_REWARD_STATE_EXPLANATIONS: Readonly<Record<ReferralRewardState, string>> = {
  held:
    "Earned and waiting out its hold period. Nothing is lost while it waits, and the amount can still fall if the purchase behind it is refunded.",
  vested:
    "The hold has passed and no reversal reached it. It joins the next payout run once your account clears the payout checks and the balance reaches the minimum.",
  frozen:
    "Paused while something is reviewed — a dispute on the purchase, or a check on the account. The hold clock stops rather than restarting, and it returns to where it was if the review clears.",
  paid: "Sent to your payout destination. A payment is never un-made after the fact.",
  voided:
    "The money it was drawn from went away — usually a refund — so the reward went with it. The record stays, with the reason.",
};

/** Why a partner cannot be paid yet, in the partner's own words. */
export const REFERRAL_OUTSTANDING_LABELS: Readonly<
  Record<ReferralPartnerOutstandingItem, string>
> = {
  application_not_submitted: "Finish and submit your application.",
  application_under_review: "Your application is with our team.",
  application_changes_requested: "We have asked for a change to your application.",
  partner_agreement_not_accepted: "Accept the partner agreement.",
  partner_agreement_superseded: "The partner agreement has changed — accept the new version.",
  tax_questionnaire_not_completed: "Complete the short tax questionnaire.",
  identity_verification_not_ready: "Finish identity verification with our payment provider.",
  payout_destination_not_ready: "Add a payout destination.",
  partner_suspended: "Your participation is suspended.",
  partner_terminated: "Your participation has ended.",
  enrollment_is_test_only: "This is a test enrolment and does not pay out.",
};

/**
 * The one sentence a percentage is rendered with.
 *
 * `percentageOf` is NON-OPTIONAL on the type, so there is no branch here that
 * could render a bare rate — #147 acceptance 7 held by the shape rather than by
 * whoever writes the next surface.
 */
export function describeRewardBasis(basis: ReferralRewardBasisCopy): string {
  switch (basis.kind) {
    case "percentage_of_realized_base":
      return `${(basis.rateBps / 100).toFixed(basis.rateBps % 100 === 0 ? 0 : 2)}% of ${basis.percentageOf}`;
    case "fixed_amount":
      return `A fixed amount per qualifying referral, drawn from ${basis.fundingSourceId === "fixed_budget" ? "an approved marketing budget" : "the approved funding source"}.`;
    case "not_published":
      // NOT "0%" and not an empty string: a program whose rule is still a draft
      // pays nothing YET, which is a different statement from paying nothing.
      return "The rate for this programme has not been published yet.";
  }
}

/**
 * One metric's definition as a sentence a reader can check a figure against.
 *
 * The ATTRIBUTION LIMIT is included and is not optional prose: it is where the
 * number says what it cannot see, and it is the half somebody reconciling their
 * own earnings actually needs.
 */
export function describeMetric(definition: ReferralMetricDefinition): string {
  const denominator = definition.denominator ? ` Divided by: ${definition.denominator}` : "";
  return `${definition.numerator}${denominator} Window: ${definition.window} Source: ${definition.source}. What it cannot see: ${definition.attributionLimit}`;
}

/**
 * The sentence a suppressed breakdown is rendered with.
 *
 * It explains the SUPPRESSION rather than reporting an absence of activity,
 * because those are different facts and a partner told the wrong one goes
 * looking for a bug in their promotion.
 */
export function describeWithheldRows(input: {
  withheldRowCount: number;
  floor: number;
  everythingWithheld: boolean;
}): string {
  if (input.withheldRowCount === 0) return "";
  if (input.everythingWithheld) {
    return `This breakdown is hidden until more people have arrived. Grouping by market or device can single somebody out at these numbers, so we show the totals instead. Your totals below are complete.`;
  }
  return `${input.withheldRowCount} ${input.withheldRowCount === 1 ? "group is" : "groups are"} hidden because they hold fewer than ${input.floor} people. Their activity is still counted in the totals.`;
}

/** How a payout batch's state reads to the partner waiting on it. */
export const REFERRAL_PAYOUT_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: "Being prepared",
  approved: "Approved",
  processing: "On its way",
  paid: "Paid",
  failed: "Could not be sent",
  cancelled: "Cancelled",
};
