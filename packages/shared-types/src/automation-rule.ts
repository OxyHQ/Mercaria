/**
 * Automation rules — the `automation_rules` paid capability (#89).
 *
 * A rule is ONE trigger, optional conditions and ONE action, owned by one store.
 * Every value set below is closed, and each is the tuple a Postgres CHECK is
 * rendered from, so a trigger or an action that is not listed here has no row
 * shape at all.
 *
 * ## What a rule may do, and why the list is this short
 *
 * Each action is something a store member can already do by hand, carried out
 * through the SAME service the dashboard calls, so a rule can never do more than
 * the person who wrote it could:
 *
 * - `notify_owner` — an in-app notification to the store's owning Oxy account,
 *   the inbox every other store notification reaches (ADR 0012).
 * - `pause_listing` — move an `active` listing to `draft` through
 *   `catalog-write.service.updateListing`, which refuses a moderation
 *   restriction in both directions. With `republishWhenRestocked`, a listing the
 *   RULE paused (and only such a listing, still a `draft`) is moved back to
 *   `active` once its stock recovers.
 * - `mark_order_processing` — move a `paid` shipped order to `processing`
 *   through `order.service.transition`, which refuses an order held by
 *   moderation.
 *
 * Nothing here can reach another store, set or lift `restricted`, release a
 * held order, move money, or touch ranking, search or promotion.
 */

import type { CurrencyCode, Money } from './money';

/** What starts a rule. */
export const AUTOMATION_RULE_TRIGGERS = ['listing_stock_at_or_below', 'order_paid'] as const;
export type AutomationRuleTrigger = (typeof AUTOMATION_RULE_TRIGGERS)[number];

/** What a rule does. */
export const AUTOMATION_RULE_ACTIONS = [
  'notify_owner',
  'pause_listing',
  'mark_order_processing',
] as const;
export type AutomationRuleAction = (typeof AUTOMATION_RULE_ACTIONS)[number];

/**
 * The actions each trigger may be paired with — the pairing CHECK on
 * `automation_rules` is rendered from this map, so an order trigger with a
 * listing action is unrepresentable rather than merely refused.
 */
export const AUTOMATION_RULE_ACTIONS_BY_TRIGGER: Readonly<
  Record<AutomationRuleTrigger, readonly AutomationRuleAction[]>
> = {
  listing_stock_at_or_below: ['notify_owner', 'pause_listing'],
  order_paid: ['notify_owner', 'mark_order_processing'],
};

/**
 * One step a run carried out. `republish_listing` is not an action a rule is
 * written with: it is the second half of `pause_listing` with
 * `republishWhenRestocked`, recorded as its own run so the history shows both.
 */
export const AUTOMATION_RULE_RUN_STEPS = [
  'notify_owner',
  'pause_listing',
  'republish_listing',
  'mark_order_processing',
] as const;
export type AutomationRuleRunStep = (typeof AUTOMATION_RULE_RUN_STEPS)[number];

/**
 * How a run ended. `skipped` is a refusal the action's own service gave (a
 * listing that is no longer active, an order held by moderation) and is the
 * honest answer rather than a failure; `failed` is anything unexpected.
 */
export const AUTOMATION_RULE_RUN_OUTCOMES = ['succeeded', 'skipped', 'failed'] as const;
export type AutomationRuleRunOutcome = (typeof AUTOMATION_RULE_RUN_OUTCOMES)[number];

/** What a run acted on. */
export const AUTOMATION_RULE_SUBJECT_KINDS = ['listing', 'order'] as const;
export type AutomationRuleSubjectKind = (typeof AUTOMATION_RULE_SUBJECT_KINDS)[number];

/** Bounds the API and the CHECKs share. */
export const AUTOMATION_RULE_NAME_MAX_LENGTH = 120;
export const AUTOMATION_RULE_TAG_MAX_LENGTH = 64;
export const AUTOMATION_RULE_STOCK_THRESHOLD_MAX = 1_000_000;

/** A rule as the dashboard reads it. */
export interface AutomationRule {
  readonly id: string;
  readonly storeId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: AutomationRuleTrigger;
  readonly action: AutomationRuleAction;
  /** `listing_stock_at_or_below` only: the units at or below which the rule fires. */
  readonly stockThreshold: number | null;
  /**
   * Optional scope. For a stock rule, only listings carrying this tag; for an
   * order rule, only orders with a line whose listing carries it. Compared
   * case-insensitively.
   */
  readonly tag: string | null;
  /** `order_paid` only: the order's shop-currency total must be at least this. */
  readonly minOrderTotal: Money | null;
  /** `pause_listing` only: put a listing the rule paused back on sale once restocked. */
  readonly republishWhenRestocked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One thing a rule did, or declined to do. */
export interface AutomationRuleRun {
  readonly id: string;
  readonly ruleId: string;
  readonly subjectKind: AutomationRuleSubjectKind;
  readonly subjectId: string;
  readonly step: AutomationRuleRunStep;
  readonly outcome: AutomationRuleRunOutcome;
  /** Why a run was skipped or failed; NULL on success. */
  readonly detail: string | null;
  readonly createdAt: string;
}

/** `POST /admin/stores/:storeId/automations`. */
export interface CreateAutomationRuleInput {
  name: string;
  enabled?: boolean;
  trigger: AutomationRuleTrigger;
  action: AutomationRuleAction;
  stockThreshold?: number | null;
  tag?: string | null;
  minOrderTotal?: { amount: number; currency: CurrencyCode } | null;
  republishWhenRestocked?: boolean;
}

/**
 * `PATCH /admin/stores/:storeId/automations/:id`. The trigger and the action are
 * fixed once a rule exists: changing either is a different rule, and its run
 * history would describe something it never was.
 */
export interface UpdateAutomationRuleInput {
  name?: string;
  enabled?: boolean;
  stockThreshold?: number | null;
  tag?: string | null;
  minOrderTotal?: { amount: number; currency: CurrencyCode } | null;
  republishWhenRestocked?: boolean;
}
