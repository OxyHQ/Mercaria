/**
 * The reader-facing copy for saved shopping agents (#97).
 *
 * The VOCABULARIES live in `@mercaria/shared-types` and are what a stored row,
 * an evaluation key and an operator trace carry; this file is the half that is
 * deliberately free to change, exactly as `condition.ts` is for the #90 taxonomy
 * and `offer-labels.ts` is for the #74 labels. A value's meaning is stable, its
 * wording is not, and keeping the two apart is what stops a copy change becoming
 * a contract change.
 *
 * ## Three vocabularies get a sentence per MEMBER, not a shared one
 *
 * `ShoppingAgentFindingOutcome` is three-valued and the middle one is the one
 * people collapse, so `not_qualified` and `incomplete` have genuinely different
 * sentences: "we looked and it was not true" and "we could not tell" send a
 * shopper to opposite places. The same holds for the finding LIFECYCLE — a
 * superseded observation and an invalidated one are kept for different reasons —
 * and for the incomplete REASONS, each of which names a fact the evaluation read
 * or failed to read.
 *
 * ## Nothing here describes an action
 *
 * A saved agent watches and tells; it never acts. There is no member of any map
 * below whose sentence could be read as something Mercaria did on a shopper's
 * behalf, and {@link SHOPPING_AGENT_OBSERVATION_DISCLAIMER_KEY} is the line that
 * says so wherever a figure is rendered.
 */

import type {
  ShoppingAgentChannelPolicy,
  ShoppingAgentDeliveryFailure,
  ShoppingAgentEvidenceCompleteness,
  ShoppingAgentFindingLifecycle,
  ShoppingAgentFindingOutcome,
  ShoppingAgentFreshness,
  ShoppingAgentIncompleteReason,
  ShoppingAgentJobKind,
  ShoppingAgentNotificationChannel,
  ShoppingAgentNotificationState,
  ShoppingAgentOptimality,
  ShoppingAgentPriceBasis,
  ShoppingAgentState,
  ShoppingAgentSuppressionReason,
  ShoppingAgentTriggerSource,
} from "@mercaria/shared-types";
import type { Translate } from "../i18n/create-app-i18n";

/** The short name of what an agent watches for. */
export const SHOPPING_AGENT_JOB_LABEL_KEYS: Readonly<Record<ShoppingAgentJobKind, string>> = {
  offer_price_threshold: "ui.shoppingAgent.job.label.offer_price_threshold",
  used_or_refurbished_appearance: "ui.shoppingAgent.job.label.used_or_refurbished_appearance",
  official_channel_availability: "ui.shoppingAgent.job.label.official_channel_availability",
  basket_target_total: "ui.shoppingAgent.job.label.basket_target_total",
  materially_better_plan: "ui.shoppingAgent.job.label.materially_better_plan",
  constraint_satisfiable: "ui.shoppingAgent.job.label.constraint_satisfiable",
};

/** One line saying what the agent is actually watching for. */
export const SHOPPING_AGENT_JOB_EXPLANATION_KEYS: Readonly<Record<ShoppingAgentJobKind, string>> = {
  offer_price_threshold: "ui.shoppingAgent.job.explanation.offer_price_threshold",
  used_or_refurbished_appearance: "ui.shoppingAgent.job.explanation.used_or_refurbished_appearance",
  official_channel_availability: "ui.shoppingAgent.job.explanation.official_channel_availability",
  basket_target_total: "ui.shoppingAgent.job.explanation.basket_target_total",
  materially_better_plan: "ui.shoppingAgent.job.explanation.materially_better_plan",
  constraint_satisfiable: "ui.shoppingAgent.job.explanation.constraint_satisfiable",
};

/**
 * The lifecycle a shopper reads.
 *
 * `blocked` is deliberately not worded as a pause: a shopper pauses their own
 * agent and can resume it, while a blocked one is waiting for a question only
 * they can answer (#97 model 9).
 */
export const SHOPPING_AGENT_STATE_LABEL_KEYS: Readonly<Record<ShoppingAgentState, string>> = {
  enabled: "ui.shoppingAgent.state.enabled",
  paused: "ui.shoppingAgent.state.paused",
  blocked: "ui.shoppingAgent.state.blocked",
  completed: "ui.shoppingAgent.state.completed",
  deleted: "ui.shoppingAgent.state.deleted",
};

/** What one evaluation concluded. Three values, three genuinely different facts. */
export const SHOPPING_AGENT_OUTCOME_LABEL_KEYS: Readonly<
  Record<ShoppingAgentFindingOutcome, string>
> = {
  qualified: "ui.shoppingAgent.outcome.label.qualified",
  not_qualified: "ui.shoppingAgent.outcome.label.not_qualified",
  incomplete: "ui.shoppingAgent.outcome.label.incomplete",
};

export const SHOPPING_AGENT_OUTCOME_EXPLANATION_KEYS: Readonly<
  Record<ShoppingAgentFindingOutcome, string>
> = {
  qualified: "ui.shoppingAgent.outcome.explanation.qualified",
  not_qualified: "ui.shoppingAgent.outcome.explanation.not_qualified",
  incomplete: "ui.shoppingAgent.outcome.explanation.incomplete",
};

/**
 * Why a stored observation no longer describes the world (#97 finding 12).
 *
 * Both non-current values are SHOWN rather than hidden: an observation is never
 * rewritten and never removed to tidy a history, so a shopper who saw the old
 * one is entitled to find it and to be told what happened to it.
 */
export const SHOPPING_AGENT_LIFECYCLE_LABEL_KEYS: Readonly<
  Record<ShoppingAgentFindingLifecycle, string>
> = {
  current: "ui.shoppingAgent.lifecycle.label.current",
  superseded: "ui.shoppingAgent.lifecycle.label.superseded",
  invalidated: "ui.shoppingAgent.lifecycle.label.invalidated",
};

export const SHOPPING_AGENT_LIFECYCLE_EXPLANATION_KEYS: Readonly<
  Record<ShoppingAgentFindingLifecycle, string>
> = {
  current: "ui.shoppingAgent.lifecycle.explanation.current",
  superseded: "ui.shoppingAgent.lifecycle.explanation.superseded",
  invalidated: "ui.shoppingAgent.lifecycle.explanation.invalidated",
};

/** Each reason names a fact the evaluation read, or failed to read. */
export const SHOPPING_AGENT_INCOMPLETE_REASON_KEYS: Readonly<
  Record<ShoppingAgentIncompleteReason, string>
> = {
  offer_comparison_unavailable: "ui.shoppingAgent.incompleteReason.offer_comparison_unavailable",
  no_eligible_offer: "ui.shoppingAgent.incompleteReason.no_eligible_offer",
  price_not_convertible: "ui.shoppingAgent.incompleteReason.price_not_convertible",
  delivery_cost_unknown: "ui.shoppingAgent.incompleteReason.delivery_cost_unknown",
  basket_partially_covered: "ui.shoppingAgent.incompleteReason.basket_partially_covered",
  constraint_set_invalid: "ui.shoppingAgent.incompleteReason.constraint_set_invalid",
  constraint_facts_unavailable: "ui.shoppingAgent.incompleteReason.constraint_facts_unavailable",
  agent_ambiguous_after_split: "ui.shoppingAgent.incompleteReason.agent_ambiguous_after_split",
  no_comparable_prior_finding: "ui.shoppingAgent.incompleteReason.no_comparable_prior_finding",
  catalogue_discovery_unavailable: "ui.shoppingAgent.incompleteReason.catalogue_discovery_unavailable",
};

/** How complete the evidence behind a finding was — separate from its outcome. */
export const SHOPPING_AGENT_COMPLETENESS_LABEL_KEYS: Readonly<
  Record<ShoppingAgentEvidenceCompleteness, string>
> = {
  complete: "ui.shoppingAgent.completeness.complete",
  partial: "ui.shoppingAgent.completeness.partial",
};

/** How fresh the offers behind a finding were. */
export const SHOPPING_AGENT_FRESHNESS_LABEL_KEYS: Readonly<
  Record<ShoppingAgentFreshness, string>
> = {
  current: "ui.shoppingAgent.freshness.current",
  ageing: "ui.shoppingAgent.freshness.ageing",
  unknown: "ui.shoppingAgent.freshness.unknown",
};

/** Whether the plan behind a finding was PROVED best or merely the best found. */
export const SHOPPING_AGENT_OPTIMALITY_LABEL_KEYS: Readonly<
  Record<ShoppingAgentOptimality, string>
> = {
  proven_optimal: "ui.shoppingAgent.optimality.proven_optimal",
  approximate: "ui.shoppingAgent.optimality.approximate",
};

/** Which cost the objective is measured against. */
export const SHOPPING_AGENT_PRICE_BASIS_LABEL_KEYS: Readonly<
  Record<ShoppingAgentPriceBasis, string>
> = {
  item_price: "ui.shoppingAgent.priceBasis.item_price",
  delivered_total: "ui.shoppingAgent.priceBasis.delivered_total",
};

/** Which sellers an agent's plans may draw on. */
export const SHOPPING_AGENT_CHANNEL_POLICY_LABEL_KEYS: Readonly<
  Record<ShoppingAgentChannelPolicy, string>
> = {
  native_only: "ui.shoppingAgent.channelPolicy.native_only",
  external_only: "ui.shoppingAgent.channelPolicy.external_only",
  official_only: "ui.shoppingAgent.channelPolicy.official_only",
  mixed: "ui.shoppingAgent.channelPolicy.mixed",
};

/** What made an evaluation happen. */
export const SHOPPING_AGENT_TRIGGER_SOURCE_LABEL_KEYS: Readonly<
  Record<ShoppingAgentTriggerSource, string>
> = {
  offer_change: "ui.shoppingAgent.triggerSource.offer_change",
  scheduled: "ui.shoppingAgent.triggerSource.scheduled",
  manual: "ui.shoppingAgent.triggerSource.manual",
};

/** Where a shopper hears about a match. */
export const SHOPPING_AGENT_NOTIFICATION_CHANNEL_LABEL_KEYS: Readonly<
  Record<ShoppingAgentNotificationChannel, string>
> = {
  oxy_notification: "ui.shoppingAgent.notificationChannel.oxy_notification",
  email: "ui.shoppingAgent.notificationChannel.email",
};

export const SHOPPING_AGENT_NOTIFICATION_STATE_LABEL_KEYS: Readonly<
  Record<ShoppingAgentNotificationState, string>
> = {
  queued: "ui.shoppingAgent.notificationState.queued",
  delivering: "ui.shoppingAgent.notificationState.delivering",
  delivered: "ui.shoppingAgent.notificationState.delivered",
  failed: "ui.shoppingAgent.notificationState.failed",
  suppressed: "ui.shoppingAgent.notificationState.suppressed",
  dead_letter: "ui.shoppingAgent.notificationState.dead_letter",
};

/**
 * Why a shopper was NOT told about a qualifying observation.
 *
 * Every one of these leaves a row rather than a silent skip, so every one of
 * them is something a shopper can be shown — which is the whole reason the
 * withheld count is countable at all.
 */
export const SHOPPING_AGENT_SUPPRESSION_REASON_KEYS: Readonly<
  Record<ShoppingAgentSuppressionReason, string>
> = {
  cooldown_active: "ui.shoppingAgent.suppressionReason.cooldown_active",
  not_materially_better: "ui.shoppingAgent.suppressionReason.not_materially_better",
  agent_not_enabled: "ui.shoppingAgent.suppressionReason.agent_not_enabled",
  agent_deleted: "ui.shoppingAgent.suppressionReason.agent_deleted",
  finding_superseded: "ui.shoppingAgent.suppressionReason.finding_superseded",
  destination_no_longer_eligible: "ui.shoppingAgent.suppressionReason.destination_no_longer_eligible",
  channel_unavailable: "ui.shoppingAgent.suppressionReason.channel_unavailable",
};

export const SHOPPING_AGENT_DELIVERY_FAILURE_KEYS: Readonly<
  Record<ShoppingAgentDeliveryFailure, string>
> = {
  transport_unconfigured: "ui.shoppingAgent.deliveryFailure.transport_unconfigured",
  transport_rejected: "ui.shoppingAgent.deliveryFailure.transport_rejected",
  transport_unavailable: "ui.shoppingAgent.deliveryFailure.transport_unavailable",
  finding_unreadable: "ui.shoppingAgent.deliveryFailure.finding_unreadable",
  unexpected_error: "ui.shoppingAgent.deliveryFailure.unexpected_error",
};

/**
 * Where the words of a summary came from (#97 UX 10, evaluation 5).
 *
 * BOTH members have copy, because both are ordinary. `deterministic_template` is
 * the normal case — no provider is registered — and a surface that only said
 * something when a model had been involved would make the deterministic summary
 * look like a degraded one. A model may only phrase what the finding already
 * says, so the provider sentence states that limit rather than implying the
 * model knows anything.
 */
export const SHOPPING_AGENT_SUMMARY_SOURCE_KEYS: Readonly<
  Record<"deterministic_template" | "provider", string>
> = {
  deterministic_template: "ui.shoppingAgent.summarySource.deterministic_template",
  provider: "ui.shoppingAgent.summarySource.provider",
};

/**
 * The one sentence a rendered finding must never let a shopper forget
 * (#97 UX 7).
 *
 * A finding is an OBSERVATION about a moment, and the two things it is most
 * likely to be mistaken for are the two named here. `CONDITION_DISCLAIMER_KEY` is
 * the precedent: the sentence sits beside the figure rather than in a help page,
 * because the misreading happens where the figure is.
 */
export const SHOPPING_AGENT_OBSERVATION_DISCLAIMER_KEY =
  "ui.shoppingAgent.observationDisclaimer";

/** The short name of a job kind. */
export function shoppingAgentJobLabel(t: Translate, kind: ShoppingAgentJobKind): string {
  return t(SHOPPING_AGENT_JOB_LABEL_KEYS[kind]);
}

/** What the agent is watching for, in one line. */
export function shoppingAgentJobExplanation(t: Translate, kind: ShoppingAgentJobKind): string {
  return t(SHOPPING_AGENT_JOB_EXPLANATION_KEYS[kind]);
}
