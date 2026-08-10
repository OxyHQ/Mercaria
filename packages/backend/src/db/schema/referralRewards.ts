/**
 * Versioned referral reward rules, campaign budgets, accrued rewards and their
 * append-only reversals (#144, under ADR 0005).
 *
 * Four tables, born in Postgres beside the nine #142 declared:
 * `referral_reward_rules`, `referral_campaign_budgets`, `referral_rewards`,
 * `referral_reward_adjustments`.
 *
 * ## The rules this file exists to hold
 *
 * **A rule version is immutable once it leaves `draft`** — the `fee_schedules`
 * device: a `BEFORE UPDATE OR DELETE` trigger refuses every column change on a
 * non-draft row, and a partial unique keeps ONE `active` version per rule. A
 * policy change is a new version, and an attribution pinned the version it was
 * created under (ADR 0005 D19), so a rule edit can never rewrite a historical
 * reward — there is no edit to make.
 *
 * **A reward names exactly one rule version AND exactly one funding record.**
 * `rule_version_id` is a real foreign key; `funding_source_id`,
 * `funding_record_ref`, `funding_record_version` and `funding_amount_minor` are
 * the snapshot of the base it drew on (#144 calculation rule 4). A CHECK holds
 * `gross_amount_minor <= funding_amount_minor`, so "never pay more than the
 * eligible funding" is a property of the ROW rather than of the code that wrote
 * it.
 *
 * **There is ONE currency column on a reward, not two.** The reward and its
 * funding are always denominated the same, because this domain performs no
 * conversion at all — a rule pinning a currency REFUSES funding in another
 * rather than converting it. Two columns forced equal by a CHECK would be two
 * representations of one fact.
 *
 * **Negative is unrepresentable except through a reversal.**
 * `gross_amount_minor > 0`, `0 <= net_amount_minor <= gross_amount_minor`, and
 * an adjustment's `delta_amount_minor <= 0`. A reversal beyond the accrued net
 * does not push the reward negative: the excess becomes
 * `liability_amount_minor` on the adjustment, which is the seam #145's partner
 * balance consumes (ADR 0005 R7 — a payout is never un-paid).
 *
 * **`referral_reward_adjustments` is append-only by TRIGGER**, against UPDATE
 * and DELETE both, and `referral_rewards` refuses DELETE outright plus any
 * change to its immutable columns. "Historical reward rows are never deleted"
 * is enforced by the database, not by review.
 *
 * **A budget is a row and its claim is a compare-and-swap.**
 * `claimed_minor <= budget_minor` is a CHECK; the claim is one conditional
 * `UPDATE` whose empty `RETURNING` set IS the refusal. A trigger makes
 * `budget_minor` and `claimed_minor` monotonically non-decreasing and the
 * identity columns frozen: cutting a campaign is `status = 'closed'`
 * (prospective, ADR 0005 D16), never a shrink that could strand claims already
 * made.
 *
 * **No contact, payment or buyer data, structurally.** Like the #142 tables,
 * the only identities representable here are a partner row id and Oxy operator
 * ids. `funding_record_ref` addresses a payment, a budget or a #67/#89 record —
 * never a person.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  REFERRAL_CAMPAIGN_BUDGET_STATUSES,
  REFERRAL_CONVERSION_TYPES,
  REFERRAL_FUNDING_SOURCE_IDS,
  REFERRAL_REWARD_CAP_PERIODS,
  REFERRAL_REWARD_CURRENCY_MODES,
  REFERRAL_REWARD_FORMULAS,
  REFERRAL_REWARD_FROZEN_ORIGINS,
  REFERRAL_REWARD_RECOVERY_STATES,
  REFERRAL_REWARD_REVERSAL_CAUSES,
  REFERRAL_REWARD_REVERSAL_POLICIES,
  REFERRAL_REWARD_RULE_STATUSES,
  REFERRAL_REWARD_STATES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, CURRENCY_CODE_VALUES } from './columns';
import { referralAttributions, referralConversions, referralPartners, referralPrograms } from './referrals';

/** Bound on a stored reason — the `referral_events` bound, same reasoning. */
const MAX_REASON_LENGTH = 2_000;

/** 100% in basis points — the structural ceiling ADR 0005 D10 puts on a rate. */
const MAX_RATE_BPS = 10_000;

/**
 * `referral_reward_rules` — one row per immutable rule VERSION (#144's fourteen
 * fields).
 *
 * The stable identity is `rule_id`, a grouping token (the `program_id` and
 * `schedule_key` shape — there is no parent entity to point at); the row is one
 * version of it. `referral_programs.commission_rule_ref` names a `rule_id`, and
 * an attribution pins `<rule_id>@v<version>` at the moment it is created, so
 * everything a reward is worth was decided before any money existed.
 *
 * ## Why `reward_currency` is nullable and why that is the safe direction
 *
 * A rule that pins a currency states one; a rule that takes the funding's own
 * currency has none to state, and a NOT NULL column would force it to name a
 * currency it does not use. The pair of CHECKs below is what keeps the nullable
 * column honest: present exactly when the mode says so, and REQUIRED the moment
 * any amount-valued term exists — because an amount with no currency cannot be
 * compared against a base whose currency varies.
 */
export const referralRewardRules = pgTable(
  'referral_reward_rules',
  {
    id: generatedId(),
    /** Field 1 — the stable rule identity every version row shares. */
    ruleId: text().notNull(),
    /** Field 1 — 1-based, dense per rule. Immutable once the row exists. */
    version: integer().notNull(),
    name: text().notNull(),
    /** Field 2 — the program (stable identity, not a version) this rule pays under. */
    programId: text().notNull(),
    /** Field 2 — the campaign scope, when the rule is scoped to one. */
    campaignRef: text(),
    /** Field 3 — the conversion kind this rule may pay on. */
    conversionType: text({ enum: asEnumValues(REFERRAL_CONVERSION_TYPES) }).notNull(),
    /** Field 4 — the ONE approved funding source its base comes from. */
    fundingSourceId: text({ enum: asEnumValues(REFERRAL_FUNDING_SOURCE_IDS) }).notNull(),
    /** Field 5 */
    formula: text({ enum: asEnumValues(REFERRAL_REWARD_FORMULAS) }).notNull(),
    /** Field 5 — basis points of the realized base. `> 0` and `<= 10_000` (ADR D10). */
    rateBps: integer(),
    /** Field 5 — the fixed reward, in minor units of `reward_currency`. */
    fixedAmountMinor: bigint({ mode: 'number' }),
    /** Field 6 */
    currencyMode: text({ enum: asEnumValues(REFERRAL_REWARD_CURRENCY_MODES) }).notNull(),
    /** Field 6 — present exactly when `currency_mode = 'fixed_currency'`. */
    rewardCurrency: text({ enum: CURRENCY_CODE_VALUES }),
    /** Field 7 */
    effectiveStartAt: timestamptz().notNull(),
    effectiveEndAt: timestamptz(),
    /** Field 8 — the #145/#146 hold and vesting policy this version pays under. */
    holdPolicyRef: text().notNull(),
    /** Field 8 — days from accrual to vesting (ADR 0005 D12). */
    holdDays: integer().notNull(),
    /**
     * Field 9 — the de-minimis THRESHOLD below which nothing accrues.
     *
     * Deliberately not a floor that tops a reward up: ADR 0005 D10 refuses a
     * "percentage with a floor", because a floor above the realized base is
     * money from nowhere. Below this, the accrual is refused with
     * `below_min_accrual` and the refusal is recorded.
     */
    minAccrualMinor: bigint({ mode: 'number' }),
    /** Field 9 */
    maxRewardPerConversionMinor: bigint({ mode: 'number' }),
    /** Field 10 — present together with `partner_cap_period`. */
    maxRewardPerPartnerPeriodMinor: bigint({ mode: 'number' }),
    /** Field 10 */
    partnerCapPeriod: text({ enum: asEnumValues(REFERRAL_REWARD_CAP_PERIODS) }),
    /** Field 10 — the ceiling over every reward this rule's campaign ever pays. */
    maxRewardPerCampaignMinor: bigint({ mode: 'number' }),
    /** Field 11 */
    reversalPolicy: text({ enum: asEnumValues(REFERRAL_REWARD_REVERSAL_POLICIES) }).notNull(),
    /** Field 12 */
    termsVersion: text().notNull(),
    /** Field 13 */
    createdByOxyUserId: text().notNull(),
    /** Field 13 — set at activation, never before; the CHECK holds the pair. */
    approvedByOxyUserId: text(),
    /** Field 14 */
    status: text({ enum: asEnumValues(REFERRAL_REWARD_RULE_STATUSES) }).notNull().default('draft'),
    activatedAt: timestamptz(),
    supersededAt: timestamptz(),
    retiredAt: timestamptz(),
    /**
     * The version this one replaced. Backwards in time, the
     * `referral_attributions.supersedes_attribution_id` direction and for the
     * same reason: the predecessor already exists and never changes.
     */
    supersedesRuleVersionId: text().references((): AnyPgColumn => referralRewardRules.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'referral_reward_rules_conversion_type_check',
      t.conversionType,
      REFERRAL_CONVERSION_TYPES,
    ),
    checkOneOf(
      'referral_reward_rules_funding_source_id_check',
      t.fundingSourceId,
      REFERRAL_FUNDING_SOURCE_IDS,
    ),
    checkOneOf('referral_reward_rules_formula_check', t.formula, REFERRAL_REWARD_FORMULAS),
    checkOneOf(
      'referral_reward_rules_currency_mode_check',
      t.currencyMode,
      REFERRAL_REWARD_CURRENCY_MODES,
    ),
    checkOneOf(
      'referral_reward_rules_partner_cap_period_check',
      t.partnerCapPeriod,
      REFERRAL_REWARD_CAP_PERIODS,
    ),
    checkOneOf(
      'referral_reward_rules_reversal_policy_check',
      t.reversalPolicy,
      REFERRAL_REWARD_REVERSAL_POLICIES,
    ),
    checkOneOf('referral_reward_rules_status_check', t.status, REFERRAL_REWARD_RULE_STATUSES),
    ...currencyChecks('referral_reward_rules', [t.rewardCurrency]),
    check(
      'referral_reward_rules_identity_check',
      sql`length(${t.ruleId}) > 0 and ${t.version} >= 1 and length(${t.name}) > 0
          and length(${t.programId}) > 0 and length(${t.holdPolicyRef}) > 0
          and length(${t.termsVersion}) > 0 and length(${t.createdByOxyUserId}) > 0
          and (${t.campaignRef} is null or length(${t.campaignRef}) > 0)`,
    ),
    // Exactly one shape, and it is the one the formula names. ADR 0005 D10's
    // "one reward row has exactly one shape, named by its source", stated where
    // the shape is chosen.
    check(
      'referral_reward_rules_formula_shape_check',
      sql`(${t.formula} = 'percentage_of_realized_base') = (${t.rateBps} is not null)
          and (${t.formula} = 'fixed_amount') = (${t.fixedAmountMinor} is not null)`,
    ),
    // The rate is structurally bounded: a reward can never be more than the
    // whole of the base it draws on.
    check(
      'referral_reward_rules_rate_check',
      sql`${t.rateBps} is null
          or (${t.rateBps} > 0 and ${t.rateBps} <= ${sql.raw(String(MAX_RATE_BPS))})`,
    ),
    check(
      'referral_reward_rules_amounts_positive_check',
      sql`(${t.fixedAmountMinor} is null or ${t.fixedAmountMinor} > 0)
          and (${t.minAccrualMinor} is null or ${t.minAccrualMinor} > 0)
          and (${t.maxRewardPerConversionMinor} is null or ${t.maxRewardPerConversionMinor} > 0)
          and (${t.maxRewardPerPartnerPeriodMinor} is null
               or ${t.maxRewardPerPartnerPeriodMinor} > 0)
          and (${t.maxRewardPerCampaignMinor} is null or ${t.maxRewardPerCampaignMinor} > 0)`,
    ),
    // A currency is named exactly when the mode says one is pinned. Named
    // `..._currency_pin_check` and not `..._reward_currency_check` because
    // `currencyChecks` already emits the latter for the column's value range —
    // two constraints with one name is a drizzle-kit refusal, and the two are
    // genuinely different questions (is it a known code / should it be here).
    check(
      'referral_reward_rules_currency_pin_check',
      sql`(${t.currencyMode} = 'fixed_currency') = (${t.rewardCurrency} is not null)`,
    ),
    // …and ANY amount-valued term requires one. An amount with no currency
    // cannot be compared against a base whose currency varies, so a capped rule
    // that took the funding's currency would carry a cap meaning nothing.
    check(
      'referral_reward_rules_amount_currency_check',
      sql`${t.rewardCurrency} is not null
          or (${t.fixedAmountMinor} is null and ${t.minAccrualMinor} is null
              and ${t.maxRewardPerConversionMinor} is null
              and ${t.maxRewardPerPartnerPeriodMinor} is null
              and ${t.maxRewardPerCampaignMinor} is null)`,
    ),
    // A per-partner cap states the period it is measured over.
    check(
      'referral_reward_rules_partner_cap_check',
      sql`(${t.maxRewardPerPartnerPeriodMinor} is null) = (${t.partnerCapPeriod} is null)`,
    ),
    // A campaign cap needs a campaign to be a cap ON.
    check(
      'referral_reward_rules_campaign_cap_check',
      sql`${t.maxRewardPerCampaignMinor} is null or ${t.campaignRef} is not null`,
    ),
    // A fixed-budget rule pays a fixed amount from a budget; a percentage of a
    // marketing allocation is a share of a number Mercaria chose, which is not
    // a realized base at all (ADR 0005 D10).
    check(
      'referral_reward_rules_budget_shape_check',
      sql`${t.fundingSourceId} <> 'fixed_budget'
          or (${t.formula} = 'fixed_amount' and ${t.campaignRef} is not null)`,
    ),
    check('referral_reward_rules_hold_check', sql`${t.holdDays} >= 0`),
    check(
      'referral_reward_rules_effective_window_check',
      sql`${t.effectiveEndAt} is null or ${t.effectiveEndAt} > ${t.effectiveStartAt}`,
    ),
    // An active (or once-active) version was approved at a recorded moment. A
    // draft need not be — which is what makes "who approved the terms these
    // rewards were paid under" always answerable.
    check(
      'referral_reward_rules_activation_check',
      sql`${t.status} = 'draft'
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    check(
      'referral_reward_rules_status_times_check',
      sql`(${t.status} <> 'superseded' or ${t.supersededAt} is not null)
          and (${t.status} <> 'retired' or ${t.retiredAt} is not null)`,
    ),
    check(
      'referral_reward_rules_supersedes_check',
      sql`${t.supersedesRuleVersionId} is null or ${t.supersedesRuleVersionId} <> ${t.id}`,
    ),
    uniqueIndex('referral_reward_rules_rule_id_version_key').on(t.ruleId, t.version),
    // ONE active version per rule: an attribution resolves "the rule" to exactly
    // one set of terms, and two activators racing converge instead of both
    // winning.
    uniqueIndex('referral_reward_rules_one_active_key')
      .on(t.ruleId)
      .where(sql`${t.status} = 'active'`),
    index('referral_reward_rules_program_id_idx').on(t.programId, t.status),
    index('referral_reward_rules_campaign_ref_idx')
      .on(t.campaignRef)
      .where(sql`${t.campaignRef} is not null`),
  ],
);

/**
 * `referral_campaign_budgets` — the explicit marketing allocation a
 * `fixed_budget` reward is drawn from (ADR 0005 D16).
 *
 * One row per (program, campaign). The claim is a compare-and-swap —
 * `set claimed_minor = claimed_minor + $amount where budget_minor -
 * claimed_minor >= $amount and status = 'open'` — so two concurrent accruals at
 * the ceiling admit exactly one and the loser is refused with
 * `budget_exhausted` rather than overspending. The empty `RETURNING` set IS the
 * refusal; there is no read-then-write anywhere in the path.
 *
 * `budget_minor` and `claimed_minor` are monotonically non-decreasing, enforced
 * by trigger. Cutting a campaign is `status = 'closed'`, which stops NEW claims
 * and touches nothing already accrued — exhaustion is prospective, never
 * retroactive, and a shrink would be the retroactive version wearing an
 * innocent name.
 */
export const referralCampaignBudgets = pgTable(
  'referral_campaign_budgets',
  {
    id: generatedId(),
    /** The stable program identity this campaign belongs to. */
    programId: text().notNull(),
    campaignRef: text().notNull(),
    name: text().notNull(),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** The whole allocation, in minor units of `currency`. */
    budgetMinor: bigint({ mode: 'number' }).notNull(),
    /** What accruals have claimed so far. Never exceeds `budget_minor`. */
    claimedMinor: bigint({ mode: 'number' }).notNull().default(0),
    status: text({ enum: asEnumValues(REFERRAL_CAMPAIGN_BUDGET_STATUSES) })
      .notNull()
      .default('open'),
    createdByOxyUserId: text().notNull(),
    closedAt: timestamptz(),
    invalidatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'referral_campaign_budgets_status_check',
      t.status,
      REFERRAL_CAMPAIGN_BUDGET_STATUSES,
    ),
    ...currencyChecks('referral_campaign_budgets', [t.currency]),
    check(
      'referral_campaign_budgets_identity_check',
      sql`length(${t.programId}) > 0 and length(${t.campaignRef}) > 0 and length(${t.name}) > 0
          and length(${t.createdByOxyUserId}) > 0`,
    ),
    // The whole of "never pay more than the budget", as a row property.
    check(
      'referral_campaign_budgets_amounts_check',
      sql`${t.budgetMinor} > 0 and ${t.claimedMinor} >= 0 and ${t.claimedMinor} <= ${t.budgetMinor}`,
    ),
    check(
      'referral_campaign_budgets_status_times_check',
      sql`(${t.status} <> 'closed' or ${t.closedAt} is not null)
          and (${t.status} <> 'invalidated' or ${t.invalidatedAt} is not null)`,
    ),
    uniqueIndex('referral_campaign_budgets_campaign_key').on(t.programId, t.campaignRef),
    index('referral_campaign_budgets_status_idx').on(t.status),
  ],
);

/**
 * `referral_rewards` — one accrued reward, pointing at ONE immutable rule
 * version and ONE funding record (#144 acceptance 1).
 *
 * ## `UNIQUE(conversion_id)` is the idempotency
 *
 * A conversion pays at most one reward — the launch programs support no split
 * (#142 identity/uniqueness 5, and `referral_conversions` says so one table
 * over). The accrual insert is `ON CONFLICT DO NOTHING` plus a re-read, so a
 * retried conversion produces the SAME reward rather than a second one, for a
 * structural reason rather than because the caller checked first.
 *
 * ## The funding snapshot
 *
 * `funding_record_ref` is the id of the record the base was read from — a
 * `payments.id` for `connected_marketplace`, a `referral_campaign_budgets.id`
 * for `fixed_budget`, a #67/#89 record for the deferred sources.
 * `funding_record_version` is what that record looked like when it was read
 * (for the ledger: the id of the last contributing transaction), so a later
 * change is DETECTABLE rather than silently reinterpreted.
 * `funding_amount_minor` is the exact amount used, and the CHECK below is what
 * makes a reward larger than its funding unrepresentable.
 *
 * ## `state` carries ADR 0005's whole machine and #144 writes two of it
 *
 * `held` at accrual, `voided` when the funding ceased to exist. `vested`,
 * `frozen` and `paid` are #145's and #148's, declared here so those land as
 * writers of an existing column.
 */
export const referralRewards = pgTable(
  'referral_rewards',
  {
    id: generatedId(),
    /** ONE reward per conversion — the unique below is the replay guarantee. */
    conversionId: text()
      .notNull()
      .references(() => referralConversions.id, { onDelete: 'restrict' }),
    attributionId: text()
      .notNull()
      .references(() => referralAttributions.id, { onDelete: 'restrict' }),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    programVersionId: text()
      .notNull()
      .references(() => referralPrograms.id, { onDelete: 'restrict' }),
    /** The immutable rule version this reward was computed under (ADR 0005 D19). */
    ruleVersionId: text()
      .notNull()
      .references(() => referralRewardRules.id, { onDelete: 'restrict' }),
    fundingSourceId: text({ enum: asEnumValues(REFERRAL_FUNDING_SOURCE_IDS) }).notNull(),
    /** The funding record's own id, in its own key space. */
    fundingRecordRef: text().notNull(),
    /** What that record looked like when the base was read. */
    fundingRecordVersion: text().notNull(),
    /** The exact realized funding the reward was drawn from, in `currency`. */
    fundingAmountMinor: bigint({ mode: 'number' }).notNull(),
    fundingObservedAt: timestamptz().notNull(),
    /** Present exactly when the source is `fixed_budget` — the row that was claimed. */
    campaignBudgetId: text().references(() => referralCampaignBudgets.id, {
      onDelete: 'restrict',
    }),
    /** What the rule computed. Never zero, never negative. */
    grossAmountMinor: bigint({ mode: 'number' }).notNull(),
    /** Gross plus every adjustment. Monotonically decreasing, never below zero. */
    netAmountMinor: bigint({ mode: 'number' }).notNull(),
    /**
     * The one currency this reward and its funding are both denominated in.
     * There is no second column, because this domain converts nothing.
     */
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    state: text({ enum: asEnumValues(REFERRAL_REWARD_STATES) }).notNull().default('held'),
    /** Accrual + the pinned rule version's hold (ADR 0005 D12). */
    holdUntilAt: timestamptz().notNull(),
    /** Where a `frozen` reward came from, so a freeze can only ever be a pause. */
    frozenFromState: text({ enum: asEnumValues(REFERRAL_REWARD_FROZEN_ORIGINS) }),
    accruedAt: timestamptz().notNull(),
    vestedAt: timestamptz(),
    frozenAt: timestamptz(),
    paidAt: timestamptz(),
    voidedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'referral_rewards_funding_source_id_check',
      t.fundingSourceId,
      REFERRAL_FUNDING_SOURCE_IDS,
    ),
    checkOneOf('referral_rewards_state_check', t.state, REFERRAL_REWARD_STATES),
    checkOneOf(
      'referral_rewards_frozen_from_state_check',
      t.frozenFromState,
      REFERRAL_REWARD_FROZEN_ORIGINS,
    ),
    ...currencyChecks('referral_rewards', [t.currency]),
    check(
      'referral_rewards_identity_check',
      sql`length(${t.fundingRecordRef}) > 0 and length(${t.fundingRecordVersion}) > 0`,
    ),
    // Positive is the only representable accrual; a negative reward exists only
    // as an adjustment ROW against a positive one.
    check(
      'referral_rewards_amounts_check',
      sql`${t.grossAmountMinor} > 0 and ${t.netAmountMinor} >= 0
          and ${t.netAmountMinor} <= ${t.grossAmountMinor}`,
    ),
    // #144 calculation rule 7, as a row property: never more than the eligible
    // funding or budget.
    check(
      'referral_rewards_funding_bound_check',
      sql`${t.fundingAmountMinor} >= 0 and ${t.grossAmountMinor} <= ${t.fundingAmountMinor}`,
    ),
    // A budget-funded reward names the budget it claimed; nothing else may.
    check(
      'referral_rewards_budget_link_check',
      sql`(${t.fundingSourceId} = 'fixed_budget') = (${t.campaignBudgetId} is not null)`,
    ),
    // Freezing is a pause and records where it paused (ADR 0005's machine).
    check(
      'referral_rewards_frozen_check',
      sql`((${t.state} = 'frozen') = (${t.frozenFromState} is not null))
          and (${t.state} <> 'frozen' or ${t.frozenAt} is not null)`,
    ),
    check(
      'referral_rewards_state_times_check',
      sql`(${t.state} <> 'vested' or ${t.vestedAt} is not null)
          and (${t.state} <> 'paid' or ${t.paidAt} is not null)
          and (${t.state} <> 'voided' or ${t.voidedAt} is not null)`,
    ),
    // A voided reward is worth nothing; a reward worth nothing that is NOT
    // voided would be a live obligation of zero, which nothing should pay.
    check(
      'referral_rewards_void_net_check',
      sql`${t.state} <> 'voided' or ${t.netAmountMinor} = 0`,
    ),
    check('referral_rewards_hold_check', sql`${t.holdUntilAt} >= ${t.accruedAt}`),
    // One reward per conversion.
    uniqueIndex('referral_rewards_conversion_id_key').on(t.conversionId),
    // The per-partner period cap read, and the partner's own reward list.
    index('referral_rewards_partner_id_accrued_at_idx').on(t.partnerId, t.accruedAt.desc()),
    index('referral_rewards_rule_version_id_idx').on(t.ruleVersionId),
    index('referral_rewards_attribution_id_idx').on(t.attributionId),
    index('referral_rewards_state_hold_until_idx').on(t.state, t.holdUntilAt),
    // "What did this funding record pay?" — the reversal path's entry point.
    index('referral_rewards_funding_record_idx').on(t.fundingSourceId, t.fundingRecordRef),
  ],
);

/**
 * `referral_reward_adjustments` — the append-only reversal record (#144
 * "Reversal semantics", ADR 0005 R1–R8).
 *
 * Nothing is ever deleted and no reward amount is ever edited in place: a
 * reversal is a ROW carrying its cause, the recomputed net it produced, and
 * what it means for the partner's balance. The trigger refuses UPDATE and
 * DELETE both.
 *
 * ## Idempotency is a unique index over a deterministic key
 *
 * `refrewrev:<rewardId>:<cause>:<sourceRef>`. A refund handler retried, a
 * dispute webhook redelivered and a reconciliation sweep re-deriving the same
 * fact all land on the row they already made — `ON CONFLICT DO NOTHING`, whose
 * empty `RETURNING` set IS the "already applied" answer, so a real failure
 * still propagates instead of reading as a duplicate.
 *
 * ## `liability_amount_minor` is the #145 seam and #144 holds no balance
 *
 * When a reward has already been PAID, the payout is never un-paid (ADR 0005
 * R7): the reversal debits a partner balance this domain does not own. The
 * amount is recorded here, `recovery_state = 'partner_liability'`, and #145
 * consumes it. A reversal of an unpaid reward simply reduces the accrual, and
 * one that changes nothing is `not_applicable` with a zero delta — recorded
 * anyway, because an effect that did not happen must be distinguishable from
 * one that silently vanished.
 */
export const referralRewardAdjustments = pgTable(
  'referral_reward_adjustments',
  {
    id: generatedId(),
    rewardId: text()
      .notNull()
      .references(() => referralRewards.id, { onDelete: 'restrict' }),
    cause: text({ enum: asEnumValues(REFERRAL_REWARD_REVERSAL_CAUSES) }).notNull(),
    /** The record that caused it — a refund id, a dispute ref, a finding id. */
    sourceRef: text().notNull(),
    /** Deterministic from `(reward, cause, source)`; the convergence key. */
    idempotencyKey: text().notNull(),
    /** Signed, and never positive: a reversal cannot grow a reward. */
    deltaAmountMinor: bigint({ mode: 'number' }).notNull(),
    /** The reward's net AFTER this adjustment — the reconciliation, stored. */
    resultingNetMinor: bigint({ mode: 'number' }).notNull(),
    /** The realized funding as it stood when this reversal was computed. */
    observedFundingAmountMinor: bigint({ mode: 'number' }).notNull(),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    recoveryState: text({ enum: asEnumValues(REFERRAL_REWARD_RECOVERY_STATES) }).notNull(),
    /** What #145 must recover from the partner. Zero unless `partner_liability`. */
    liabilityAmountMinor: bigint({ mode: 'number' }).notNull().default(0),
    reason: text().notNull(),
    /** When the causing event happened, per its own aggregate. */
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'referral_reward_adjustments_cause_check',
      t.cause,
      REFERRAL_REWARD_REVERSAL_CAUSES,
    ),
    checkOneOf(
      'referral_reward_adjustments_recovery_state_check',
      t.recoveryState,
      REFERRAL_REWARD_RECOVERY_STATES,
    ),
    ...currencyChecks('referral_reward_adjustments', [t.currency]),
    check(
      'referral_reward_adjustments_identity_check',
      sql`length(${t.sourceRef}) > 0 and length(${t.idempotencyKey}) > 0`,
    ),
    check(
      'referral_reward_adjustments_reason_check',
      sql`length(${t.reason}) > 0 and length(${t.reason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}`,
    ),
    check(
      'referral_reward_adjustments_amounts_check',
      sql`${t.deltaAmountMinor} <= 0 and ${t.resultingNetMinor} >= 0
          and ${t.observedFundingAmountMinor} >= 0 and ${t.liabilityAmountMinor} >= 0`,
    ),
    // A liability is recorded exactly when there is one to record.
    check(
      'referral_reward_adjustments_liability_check',
      sql`(${t.recoveryState} = 'partner_liability') = (${t.liabilityAmountMinor} > 0)`,
    ),
    // Nothing moved ⇒ nothing to recover, and vice versa. Together with the
    // clause above this makes the three recovery states exhaustive and
    // mutually exclusive over the (delta, paid?) pair.
    check(
      'referral_reward_adjustments_no_op_check',
      sql`(${t.recoveryState} = 'not_applicable') = (${t.deltaAmountMinor} = 0)`,
    ),
    uniqueIndex('referral_reward_adjustments_idempotency_key_key').on(t.idempotencyKey),
    index('referral_reward_adjustments_reward_id_idx').on(t.rewardId, t.createdAt),
    index('referral_reward_adjustments_recovery_state_idx')
      .on(t.recoveryState, t.createdAt)
      .where(sql`${t.recoveryState} = 'partner_liability'`),
  ],
);
