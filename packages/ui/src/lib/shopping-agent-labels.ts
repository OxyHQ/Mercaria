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
 * behalf, and {@link SHOPPING_AGENT_OBSERVATION_DISCLAIMER} is the line that
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

/** The short name of what an agent watches for. */
export const SHOPPING_AGENT_JOB_LABELS: Readonly<Record<ShoppingAgentJobKind, string>> = {
  offer_price_threshold: "Price threshold",
  used_or_refurbished_appearance: "Used or refurbished appears",
  official_channel_availability: "Official channel appears",
  basket_target_total: "Set target total",
  materially_better_plan: "Materially better plan",
  constraint_satisfiable: "Requirements become satisfiable",
};

/** One line saying what the agent is actually watching for. */
export const SHOPPING_AGENT_JOB_EXPLANATIONS: Readonly<Record<ShoppingAgentJobKind, string>> = {
  offer_price_threshold: "Tell me when a current eligible offer meets the price I set.",
  used_or_refurbished_appearance: "Tell me when a matching used or refurbished item appears.",
  official_channel_availability:
    "Tell me when this becomes available from a verified official channel.",
  basket_target_total: "Tell me when the whole set falls below the total I set.",
  materially_better_plan: "Tell me when a materially better plan exists for what I saved.",
  constraint_satisfiable: "Tell me when something finally meets every requirement I set.",
};

/**
 * The lifecycle a shopper reads.
 *
 * `blocked` is deliberately not worded as a pause: a shopper pauses their own
 * agent and can resume it, while a blocked one is waiting for a question only
 * they can answer (#97 model 9).
 */
export const SHOPPING_AGENT_STATE_LABELS: Readonly<Record<ShoppingAgentState, string>> = {
  enabled: "Watching",
  paused: "Paused",
  blocked: "Needs your answer",
  completed: "Finished",
  deleted: "Removed",
};

/** What one evaluation concluded. Three values, three genuinely different facts. */
export const SHOPPING_AGENT_OUTCOME_LABELS: Readonly<
  Record<ShoppingAgentFindingOutcome, string>
> = {
  qualified: "Matched",
  not_qualified: "No match",
  incomplete: "Could not tell",
};

export const SHOPPING_AGENT_OUTCOME_EXPLANATIONS: Readonly<
  Record<ShoppingAgentFindingOutcome, string>
> = {
  qualified: "What you asked for was true at this moment.",
  not_qualified: "We looked at complete information and what you asked for was not true.",
  incomplete: "We could not tell — some of what we needed was missing.",
};

/**
 * Why a stored observation no longer describes the world (#97 finding 12).
 *
 * Both non-current values are SHOWN rather than hidden: an observation is never
 * rewritten and never removed to tidy a history, so a shopper who saw the old
 * one is entitled to find it and to be told what happened to it.
 */
export const SHOPPING_AGENT_LIFECYCLE_LABELS: Readonly<
  Record<ShoppingAgentFindingLifecycle, string>
> = {
  current: "Current",
  superseded: "Superseded",
  invalidated: "No longer valid",
};

export const SHOPPING_AGENT_LIFECYCLE_EXPLANATIONS: Readonly<
  Record<ShoppingAgentFindingLifecycle, string>
> = {
  current: "This is the most recent look at your objective.",
  superseded: "A later look replaced this one. It is kept so you can see what changed.",
  invalidated:
    "A catalogue correction means this no longer describes anything. It is kept rather than removed.",
};

/** Each reason names a fact the evaluation read, or failed to read. */
export const SHOPPING_AGENT_INCOMPLETE_REASON_TEXT: Readonly<
  Record<ShoppingAgentIncompleteReason, string>
> = {
  offer_comparison_unavailable: "The offer comparison could not be run just then.",
  no_eligible_offer: "Nothing eligible was available to compare.",
  price_not_convertible: "A price could not be expressed in your currency.",
  delivery_cost_unknown: "A delivery cost was never published.",
  basket_partially_covered: "Part of the set had nothing to price against.",
  constraint_set_invalid: "One of your requirements is no longer valid.",
  constraint_facts_unavailable: "The facts behind one of your requirements were unavailable.",
  agent_ambiguous_after_split: "This agent is waiting for you to say which product you meant.",
  no_comparable_prior_finding: "There was nothing earlier to compare this against.",
  catalogue_discovery_unavailable: "The catalogue search behind this could not be run.",
};

/** How complete the evidence behind a finding was — separate from its outcome. */
export const SHOPPING_AGENT_COMPLETENESS_LABELS: Readonly<
  Record<ShoppingAgentEvidenceCompleteness, string>
> = {
  complete: "Complete evidence",
  partial: "Partial evidence",
};

/** How fresh the offers behind a finding were. */
export const SHOPPING_AGENT_FRESHNESS_LABELS: Readonly<
  Record<ShoppingAgentFreshness, string>
> = {
  current: "Fresh sources",
  ageing: "Ageing sources",
  unknown: "Freshness unknown",
};

/** Whether the plan behind a finding was PROVED best or merely the best found. */
export const SHOPPING_AGENT_OPTIMALITY_LABELS: Readonly<
  Record<ShoppingAgentOptimality, string>
> = {
  proven_optimal: "Proven best",
  approximate: "Best we found",
};

/** Which cost the objective is measured against. */
export const SHOPPING_AGENT_PRICE_BASIS_LABELS: Readonly<
  Record<ShoppingAgentPriceBasis, string>
> = {
  item_price: "item price, before delivery",
  delivered_total: "delivered total, delivery included",
};

/** Which sellers an agent's plans may draw on. */
export const SHOPPING_AGENT_CHANNEL_POLICY_LABELS: Readonly<
  Record<ShoppingAgentChannelPolicy, string>
> = {
  native_only: "sellers on Mercaria",
  external_only: "merchants outside Mercaria",
  official_only: "verified official stores",
  mixed: "any seller",
};

/** What made an evaluation happen. */
export const SHOPPING_AGENT_TRIGGER_SOURCE_LABELS: Readonly<
  Record<ShoppingAgentTriggerSource, string>
> = {
  offer_change: "after a catalogue change",
  scheduled: "on a scheduled look",
  manual: "because you asked",
};

/** Where a shopper hears about a match. */
export const SHOPPING_AGENT_NOTIFICATION_CHANNEL_LABELS: Readonly<
  Record<ShoppingAgentNotificationChannel, string>
> = {
  oxy_notification: "Oxy notifications",
  email: "Email",
};

export const SHOPPING_AGENT_NOTIFICATION_STATE_LABELS: Readonly<
  Record<ShoppingAgentNotificationState, string>
> = {
  queued: "Queued",
  delivering: "Sending",
  delivered: "Sent",
  failed: "Failed",
  suppressed: "Held back",
  dead_letter: "Given up",
};

/**
 * Why a shopper was NOT told about a qualifying observation.
 *
 * Every one of these leaves a row rather than a silent skip, so every one of
 * them is something a shopper can be shown — which is the whole reason the
 * withheld count is countable at all.
 */
export const SHOPPING_AGENT_SUPPRESSION_REASON_TEXT: Readonly<
  Record<ShoppingAgentSuppressionReason, string>
> = {
  cooldown_active: "Held back — you were told recently.",
  not_materially_better: "Held back — not materially better than last time.",
  agent_not_enabled: "Held back — this agent was not watching.",
  agent_deleted: "Held back — this agent had been removed.",
  finding_superseded: "Held back — a later look replaced this one.",
  destination_no_longer_eligible: "Held back — what it pointed at is no longer eligible.",
  channel_unavailable: "Held back — that channel was unavailable.",
};

export const SHOPPING_AGENT_DELIVERY_FAILURE_TEXT: Readonly<
  Record<ShoppingAgentDeliveryFailure, string>
> = {
  transport_unconfigured: "Not sent — no delivery route is configured yet.",
  transport_rejected: "Not sent — the delivery route refused it.",
  transport_unavailable: "Not sent — the delivery route was unavailable.",
  finding_unreadable: "Not sent — the observation could not be read.",
  unexpected_error: "Not sent — something went wrong.",
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
export const SHOPPING_AGENT_SUMMARY_SOURCE_TEXT: Readonly<
  Record<"deterministic_template" | "provider", string>
> = {
  deterministic_template: "Written by Mercaria from the observation itself.",
  provider:
    "Worded by a language model from the observation. Every figure in it comes from the observation, never from the model.",
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
export const SHOPPING_AGENT_OBSERVATION_DISCLAIMER =
  "A finding is what Mercaria saw at that moment. It is not held for you and it is not a quoted price — prices and availability can change at any time.";

/** The short name of a job kind. */
export function shoppingAgentJobLabel(kind: ShoppingAgentJobKind): string {
  return SHOPPING_AGENT_JOB_LABELS[kind];
}

/** What the agent is watching for, in one line. */
export function shoppingAgentJobExplanation(kind: ShoppingAgentJobKind): string {
  return SHOPPING_AGENT_JOB_EXPLANATIONS[kind];
}
