/**
 * Automation rules — the `automation_rules` paid capability (#89):
 * `automation_rules`, `automation_rule_listing_states`, `automation_rule_runs`.
 *
 * Postgres-born, no source model. The domain references `stores` (whose rule it
 * is) and `listings` (the episode a stock rule is in for one listing) and
 * NOTHING in the order, payment or moderation domains: a rule acts through the
 * services those domains already expose, so the schema has no column a rule
 * could use to write around them. Reference: `docs/automation-rules.md`.
 *
 * ## The trigger/action pairing is a CHECK rendered from the shared-types map
 *
 * `AUTOMATION_RULE_ACTIONS_BY_TRIGGER` is the one list of which action may
 * follow which trigger, and `automation_rules_pairing_check` is rendered from
 * it, so an order trigger with a listing action has no row shape.
 *
 * ## Each trigger's own fields are TWO biconditionals, never one
 *
 * `stock_threshold` is present exactly when the trigger is the stock trigger,
 * and `min_order_total_*` only on the order trigger — each written as the pair
 * of implications the house rule asks for, because one CHECK over the
 * conjunction is satisfied when both sides are false.
 *
 * ## The episode table is what makes a stock rule fire ONCE per dip
 *
 * A stock rule fires when a listing's stock falls to its threshold and must not
 * fire again on every evaluation while it stays there. A row in
 * `automation_rule_listing_states` IS that episode: inserting it (`ON CONFLICT DO
 * NOTHING RETURNING`) is the claim to act, deleting it when stock recovers is the
 * claim to undo, and `paused_by_rule` records whether THIS rule put the listing
 * into `draft` — the only listing a republish may ever touch.
 *
 * ## The run log names its subject without a foreign key
 *
 * A run is the record of what a rule did to a listing or an order, and it must
 * outlive both: a deleted listing's runs are still the history of the rule. The
 * subject is therefore a kind plus an id with no reference, ledgered in
 * `deferredForeignKeys.ts`. `(rule_id, subject_id, occurrence)` is unique and is
 * the idempotency key: the run is inserted in the same transaction as the
 * action's claim, so a crash rolls both back and the next evaluation retries.
 * Runs are swept after 90 days (`db/expiryTargets.ts`).
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  AUTOMATION_RULE_ACTIONS,
  AUTOMATION_RULE_ACTIONS_BY_TRIGGER,
  AUTOMATION_RULE_NAME_MAX_LENGTH,
  AUTOMATION_RULE_RUN_OUTCOMES,
  AUTOMATION_RULE_RUN_STEPS,
  AUTOMATION_RULE_STOCK_THRESHOLD_MAX,
  AUTOMATION_RULE_SUBJECT_KINDS,
  AUTOMATION_RULE_TAG_MAX_LENGTH,
  AUTOMATION_RULE_TRIGGERS,
  type AutomationRuleTrigger,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, optionalMoney } from './columns';
import { stores } from './stores';
import { listings } from './catalog';

/** `(trigger = 'a' and action in (…)) or …`, rendered from the one pairing map. */
function pairingPredicate(trigger: PgColumn, action: PgColumn) {
  return sql.join(
    (Object.keys(AUTOMATION_RULE_ACTIONS_BY_TRIGGER) as AutomationRuleTrigger[]).map(
      (value) =>
        sql`(${trigger} = ${sql.raw(inList([value]))} and ${action} in (${sql.raw(
          inList(AUTOMATION_RULE_ACTIONS_BY_TRIGGER[value]),
        )}))`,
    ),
    sql` or `,
  );
}

/** `automation_rules` — one rule of one store. */
export const automationRules = pgTable(
  'automation_rules',
  {
    id: generatedId(),
    /**
     * CASCADE, like `discounts`: a rule is the store's configuration and means
     * nothing without it.
     */
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** A disabled rule keeps its plan slot and runs nothing. */
    enabled: boolean().notNull().default(true),
    trigger: text({ enum: asEnumValues(AUTOMATION_RULE_TRIGGERS) }).notNull(),
    action: text({ enum: asEnumValues(AUTOMATION_RULE_ACTIONS) }).notNull(),
    /** `listing_stock_at_or_below` only. */
    stockThreshold: integer(),
    /** Optional scope tag, matched case-insensitively against `listings.tags`. */
    tag: text(),
    /** `order_paid` only: the order's shop-currency grand total must reach this. */
    ...optionalMoney('minOrderTotal'),
    /** `pause_listing` only. */
    republishWhenRestocked: boolean().notNull().default(false),
    /**
     * When the rule last became enabled. An order rule acts only on orders PAID
     * after it, so enabling a rule never reaches back over orders a merchant has
     * already handled.
     */
    armedAt: timestamptz().notNull().defaultNow(),
    /** An Oxy account id — no foreign key. */
    createdByOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('automation_rules_trigger_check', t.trigger, AUTOMATION_RULE_TRIGGERS),
    checkOneOf('automation_rules_action_check', t.action, AUTOMATION_RULE_ACTIONS),
    check('automation_rules_pairing_check', pairingPredicate(t.trigger, t.action)),
    ...currencyChecks('automation_rules', [t.minOrderTotalCurrency]),
    check(
      'automation_rules_name_check',
      sql`char_length(btrim(${t.name})) between 1 and ${sql.raw(String(AUTOMATION_RULE_NAME_MAX_LENGTH))}`,
    ),
    check(
      'automation_rules_tag_check',
      sql`${t.tag} is null or char_length(btrim(${t.tag})) between 1 and ${sql.raw(String(AUTOMATION_RULE_TAG_MAX_LENGTH))}`,
    ),
    // Present exactly when the trigger is the stock trigger: two implications.
    check(
      'automation_rules_stock_threshold_present_check',
      sql`${t.trigger} <> 'listing_stock_at_or_below' or ${t.stockThreshold} is not null`,
    ),
    check(
      'automation_rules_stock_threshold_absent_check',
      sql`${t.trigger} = 'listing_stock_at_or_below' or ${t.stockThreshold} is null`,
    ),
    check(
      'automation_rules_stock_threshold_range_check',
      sql`${t.stockThreshold} is null or ${t.stockThreshold} between 0 and ${sql.raw(String(AUTOMATION_RULE_STOCK_THRESHOLD_MAX))}`,
    ),
    // The minimum total is a whole Money or nothing, and only on the order trigger.
    check(
      'automation_rules_min_order_total_shape_check',
      sql`(${t.minOrderTotalAmount} is null) = (${t.minOrderTotalCurrency} is null)`,
    ),
    check(
      'automation_rules_min_order_total_trigger_check',
      sql`${t.trigger} = 'order_paid' or ${t.minOrderTotalAmount} is null`,
    ),
    check(
      'automation_rules_min_order_total_amount_check',
      sql`${t.minOrderTotalAmount} is null or ${t.minOrderTotalAmount} >= 0`,
    ),
    check(
      'automation_rules_republish_check',
      sql`${t.action} = 'pause_listing' or not ${t.republishWhenRestocked}`,
    ),
    index('automation_rules_store_id_created_at_idx').on(t.storeId, t.createdAt),
  ],
);

/**
 * `automation_rule_listing_states` — a stock rule's open episode for one listing.
 *
 * A row exists exactly while the listing is at or below the rule's threshold
 * as far as the rule last saw. Both foreign keys CASCADE: an episode means
 * nothing once its rule or its listing is gone, and the listing a deleted rule
 * paused stays a `draft` the merchant can publish — a rule that is removed
 * undoes nothing silently.
 */
export const automationRuleListingStates = pgTable(
  'automation_rule_listing_states',
  {
    id: generatedId(),
    ruleId: text()
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** True once THIS rule moved the listing to `draft` in this episode. */
    pausedByRule: boolean().notNull().default(false),
    openedAt: createdAt(),
  },
  (t) => [
    uniqueIndex('automation_rule_listing_states_rule_listing_key').on(t.ruleId, t.listingId),
    index('automation_rule_listing_states_listing_id_idx').on(t.listingId),
  ],
);

/** `automation_rule_runs` — what a rule did, once per (rule, subject, occurrence). */
export const automationRuleRuns = pgTable(
  'automation_rule_runs',
  {
    id: generatedId(),
    ruleId: text()
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    /** Denormalized from the rule so the store's history is one index read. */
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    subjectKind: text({ enum: asEnumValues(AUTOMATION_RULE_SUBJECT_KINDS) }).notNull(),
    /** A listing or order id, by `subject_kind` — no foreign key; see the docblock. */
    subjectId: text().notNull(),
    /**
     * Which occurrence of the trigger this run answers: `paid` for an order, the
     * episode id plus the step for a listing.
     */
    occurrence: text().notNull(),
    step: text({ enum: asEnumValues(AUTOMATION_RULE_RUN_STEPS) }).notNull(),
    outcome: text({ enum: asEnumValues(AUTOMATION_RULE_RUN_OUTCOMES) }).notNull(),
    /** Why a run was skipped or failed. Never a stack, never a payload. */
    detail: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'automation_rule_runs_subject_kind_check',
      t.subjectKind,
      AUTOMATION_RULE_SUBJECT_KINDS,
    ),
    checkOneOf('automation_rule_runs_step_check', t.step, AUTOMATION_RULE_RUN_STEPS),
    checkOneOf('automation_rule_runs_outcome_check', t.outcome, AUTOMATION_RULE_RUN_OUTCOMES),
    check(
      'automation_rule_runs_detail_check',
      sql`${t.detail} is null or char_length(${t.detail}) <= 500`,
    ),
    uniqueIndex('automation_rule_runs_occurrence_key').on(t.ruleId, t.subjectId, t.occurrence),
    index('automation_rule_runs_store_id_created_at_idx').on(t.storeId, t.createdAt.desc()),
    index('automation_rule_runs_created_at_idx').on(t.createdAt),
  ],
);
