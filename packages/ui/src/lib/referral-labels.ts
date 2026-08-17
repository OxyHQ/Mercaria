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

import { formatPercent } from "./format";
import type { Translate } from "../i18n/create-app-i18n";
import type {
  ReferralMetricDefinition,
  ReferralPartnerOutstandingItem,
  ReferralRewardBasisCopy,
  ReferralRewardState,
} from "@mercaria/shared-types";

/** The short label a badge shows for one reward state, as a KEY (#437). */
export const REFERRAL_REWARD_STATE_LABEL_KEYS: Readonly<Record<ReferralRewardState, string>> = {
  held: "ui.referral.rewardState.label.held",
  vested: "ui.referral.rewardState.label.vested",
  frozen: "ui.referral.rewardState.label.frozen",
  paid: "ui.referral.rewardState.label.paid",
  voided: "ui.referral.rewardState.label.voided",
};

/** What is actually true of money in that state, as a KEY. */
export const REFERRAL_REWARD_STATE_EXPLANATION_KEYS: Readonly<
  Record<ReferralRewardState, string>
> = {
  held: "ui.referral.rewardState.explanation.held",
  vested: "ui.referral.rewardState.explanation.vested",
  frozen: "ui.referral.rewardState.explanation.frozen",
  paid: "ui.referral.rewardState.explanation.paid",
  voided: "ui.referral.rewardState.explanation.voided",
};

/** Why a partner cannot be paid yet, in the partner's own words, as KEYS. */
export const REFERRAL_OUTSTANDING_KEYS: Readonly<
  Record<ReferralPartnerOutstandingItem, string>
> = {
  application_not_submitted: "ui.referral.outstanding.application_not_submitted",
  application_under_review: "ui.referral.outstanding.application_under_review",
  application_changes_requested: "ui.referral.outstanding.application_changes_requested",
  partner_agreement_not_accepted: "ui.referral.outstanding.partner_agreement_not_accepted",
  partner_agreement_superseded: "ui.referral.outstanding.partner_agreement_superseded",
  tax_questionnaire_not_completed: "ui.referral.outstanding.tax_questionnaire_not_completed",
  identity_verification_not_ready: "ui.referral.outstanding.identity_verification_not_ready",
  payout_destination_not_ready: "ui.referral.outstanding.payout_destination_not_ready",
  partner_suspended: "ui.referral.outstanding.partner_suspended",
  partner_terminated: "ui.referral.outstanding.partner_terminated",
  enrollment_is_test_only: "ui.referral.outstanding.enrollment_is_test_only",
};

/**
 * The one sentence a percentage is rendered with.
 *
 * `percentageOf` is NON-OPTIONAL on the type, so there is no branch here that
 * could render a bare rate — #147 acceptance 7 held by the shape rather than by
 * whoever writes the next surface.
 */
export function describeRewardBasis(
  t: Translate,
  locale: string,
  basis: ReferralRewardBasisCopy,
): string {
  switch (basis.kind) {
    case "percentage_of_realized_base":
      // The numeral goes through the formatter chokepoint, so a German reader
      // gets `8,25 %` rather than localized words around an ASCII number —
      // #541 translated the sentence and left this half, which is the same
      // mixed sentence inverted. TWO decimals only when the rate has them: a
      // published rate must not be rounded into a different number (#544).
      return t("ui.referral.rewardBasis.percentage", {
        rate: formatPercent(basis.rateBps, locale, basis.rateBps % 100 === 0 ? 0 : 2),
        base: basis.percentageOf,
      });
    case "fixed_amount":
      // TWO keys rather than one with an interpolated clause: the funding
      // source is a different sentence in a language that inflects the
      // preposition, and splicing a translated fragment into a translated
      // frame is how that goes wrong invisibly.
      return t(
        basis.fundingSourceId === "fixed_budget"
          ? "ui.referral.rewardBasis.fixedBudget"
          : "ui.referral.rewardBasis.fixedOther",
      );
    case "not_published":
      // NOT "0%" and not an empty string: a program whose rule is still a draft
      // pays nothing YET, which is a different statement from paying nothing.
      return t("ui.referral.rewardBasis.notPublished");
  }
}

/**
 * One metric's definition as a sentence a reader can check a figure against.
 *
 * The ATTRIBUTION LIMIT is included and is not optional prose: it is where the
 * number says what it cannot see, and it is the half somebody reconciling their
 * own earnings actually needs.
 */
export function describeMetric(t: Translate, definition: ReferralMetricDefinition): string {
  // A whole sentence per shape, never a frame with an optional clause spliced
  // in: the denominator clause sits in a different position in several of the
  // twelve, which a conditional fragment cannot express.
  return definition.denominator
    ? t("ui.referral.metric.withDenominator", {
        numerator: definition.numerator,
        denominator: definition.denominator,
        window: definition.window,
        source: definition.source,
        limit: definition.attributionLimit,
      })
    : t("ui.referral.metric.withoutDenominator", {
        numerator: definition.numerator,
        window: definition.window,
        source: definition.source,
        limit: definition.attributionLimit,
      });
}

/**
 * The sentence a suppressed breakdown is rendered with.
 *
 * It explains the SUPPRESSION rather than reporting an absence of activity,
 * because those are different facts and a partner told the wrong one goes
 * looking for a bug in their promotion.
 */
export function describeWithheldRows(
  t: Translate,
  input: {
    withheldRowCount: number;
    floor: number;
    everythingWithheld: boolean;
  },
): string {
  if (input.withheldRowCount === 0) return "";
  if (input.everythingWithheld) return t("ui.referral.withheld.all");
  // `count` drives i18n-js's pluralisation, which is why the English reads
  // "group is"/"groups are" from two leaves rather than from a ternary here —
  // a language with a different plural rule cannot be served by an English one.
  return t("ui.referral.withheld.some", { count: input.withheldRowCount, floor: input.floor });
}

/** How a payout batch's state reads to the partner waiting on it, as KEYS. */
export const REFERRAL_PAYOUT_STATUS_KEYS: Readonly<Record<string, string>> = {
  open: "ui.referral.payoutStatus.open",
  approved: "ui.referral.payoutStatus.approved",
  processing: "ui.referral.payoutStatus.processing",
  paid: "ui.referral.payoutStatus.paid",
  failed: "ui.referral.payoutStatus.failed",
  cancelled: "ui.referral.payoutStatus.cancelled",
};
