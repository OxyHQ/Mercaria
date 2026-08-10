/**
 * Versioned referral reward rules and the funding boundary (#144, under
 * ADR 0005).
 *
 * #142 declared every referral vocabulary EXCEPT this one, and said why: a
 * funding source id is added only together with the code that can realize its
 * base. This file is that addition — the closed set of funding sources, the
 * DISJOINT set of things that may never fund a reward, the immutable rule
 * version's vocabulary, and the append-only reversal vocabulary #145 consumes.
 *
 * ## The names
 *
 * Issue #144 lists its four adapters as `marketplace_commission`,
 * `affiliate_commission`, `subscription_revenue` and
 * `fixed_acquisition_budget`, prefixed "for example" and qualified "approved by
 * #141". ADR 0005 — which is what #141 actually decided, and which the #142
 * code cites by name in three places — names them `connected_marketplace`,
 * `affiliate`, `subscription` and `fixed_budget`. The ADR's spellings win: they
 * are the ones already written down as binding, and `connected_marketplace` is
 * additionally the `CommercialMode` an order already carries, so a reward's
 * source and the order's mode are one word rather than two that must be kept in
 * step.
 *
 * ## Two disjoint unions, and why the second one exists
 *
 * {@link REFERRAL_FUNDING_SOURCE_IDS} is what a reward MAY be funded from.
 * {@link REFERRAL_FORBIDDEN_FUNDING_KINDS} is what it may never be funded from,
 * named as VALUES rather than left as an absence — the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device. The absence alone would already
 * make `mercaria_retail` margin unwritable; naming it is what lets a refusal
 * say WHICH prohibition was reached, and what makes a later widening of the
 * allowed set fail a disjointness test instead of passing silently.
 *
 * ## This domain performs NO currency conversion
 *
 * A reward is denominated in the currency its funding was realized in. A rule
 * that pins a currency refuses funding in another
 * ({@link ReferralRewardRefusalReason.funding_currency_mismatch}) rather than
 * converting: an FX rate moving between accrual and vesting would change an
 * amount that ADR 0005 D19 says is fixed by the rule version pinned at
 * attribution.
 */

import type { CurrencyCode } from './money';

/**
 * The CLOSED set of sources a referral reward may be funded from (ADR 0005,
 * "The funding boundary").
 *
 * | Source | Realized base |
 * |---|---|
 * | `connected_marketplace` | Mercaria's marketplace commission ACTUALLY EARNED under #88 — the `commission_revenue` ledger postings for the referred purchase, net of commission returned on its refunds. Never gross buyer spend. |
 * | `affiliate` | RECONCILED affiliate commission under #67 — never a click estimate. |
 * | `subscription` | RECOGNIZED Mercaria Pro subscription revenue under #89 — never a booking. |
 * | `fixed_budget` | An explicit campaign budget allocation, drawn down atomically per accrual. |
 *
 * `mercaria_retail` is deliberately absent and is named in
 * {@link REFERRAL_FORBIDDEN_FUNDING_KINDS} instead: #116/#120 define that
 * channel as zero markup and zero intended item profit, so there is no margin
 * to share, and #128 reserves a positive cost variance for the CUSTOMER.
 *
 * `affiliate` and `subscription` are present because #144 requires their
 * adapters and their tests, and they are unrealizable by default: each reads
 * through a PORT whose default answers
 * {@link ReferralFundingUnavailableReason.reader_not_registered}, so no
 * deployment can produce one until #67/#89 register a reader. That is a
 * DIVERGENCE from ADR 0005 fact 8 ("no id before the revenue"), taken
 * deliberately and recorded in `docs/referral-rewards.md`: the id exists, and
 * the thing fact 8 actually guards against — a row nothing can ever reconcile —
 * is prevented by the refusing port rather than by the absent id.
 */
export type ReferralFundingSourceId =
  | 'connected_marketplace'
  | 'affiliate'
  | 'subscription'
  | 'fixed_budget';

/** {@link ReferralFundingSourceId} as the tuple the column types and CHECKs read. */
export const REFERRAL_FUNDING_SOURCE_IDS: readonly ReferralFundingSourceId[] = [
  'connected_marketplace',
  'affiliate',
  'subscription',
  'fixed_budget',
];

/**
 * The things that may NEVER fund a referral reward — ADR 0005's eight
 * prohibitions plus #144's four pricing-isolation rules, named as values.
 *
 * DISJOINT from {@link REFERRAL_FUNDING_SOURCE_IDS} by construction and by a
 * test. No table column, no adapter and no rule field can hold one; what these
 * members buy is the ANSWER a refusal gives, and a build failure the day
 * somebody adds a source whose name collides with a prohibition.
 */
export type ReferralForbiddenFundingKind =
  | 'mercaria_retail_margin'
  | 'mercaria_retail_cost_variance'
  | 'supplier_acquisition_cost'
  | 'supplier_shipping_handling'
  | 'customer_tax_duty'
  | 'direct_payment_fx_cost'
  | 'customer_refund_credit'
  | 'dropship_markup'
  | 'buyer_service_charge'
  | 'merchant_fee_increase'
  | 'item_price_increase'
  | 'paid_ranking';

/** {@link ReferralForbiddenFundingKind} as a tuple. */
export const REFERRAL_FORBIDDEN_FUNDING_KINDS: readonly ReferralForbiddenFundingKind[] = [
  'mercaria_retail_margin',
  'mercaria_retail_cost_variance',
  'supplier_acquisition_cost',
  'supplier_shipping_handling',
  'customer_tax_duty',
  'direct_payment_fx_cost',
  'customer_refund_credit',
  'dropship_markup',
  'buyer_service_charge',
  'merchant_fee_increase',
  'item_price_increase',
  'paid_ranking',
];

/**
 * Why each prohibited kind can never be referral funding — the sentence a
 * refusal carries, so an operator learns the model rather than reading
 * "unrecognized key".
 */
export const REFERRAL_FORBIDDEN_FUNDING_LABELS: Record<ReferralForbiddenFundingKind, string> = {
  mercaria_retail_margin:
    'the margin of a mercaria_retail order, which is zero by construction (#116/#120): the ' +
    'channel is cost recovery with zero intended item profit, so there is nothing to share',
  mercaria_retail_cost_variance:
    'a positive cost variance on a mercaria_retail order, which #128 reserves for CUSTOMER ' +
    'adjustment — it is the customer’s money awaiting return, not a Mercaria revenue pool',
  supplier_acquisition_cost:
    'what Mercaria paid a supplier for the goods, which is a cost and never income',
  supplier_shipping_handling:
    'supplier shipping and handling, which is a cost and is additionally an order snapshot ' +
    'rather than a revenue posting',
  customer_tax_duty:
    'customer tax or duty, which is collected on behalf of an authority and is excluded from ' +
    'the #88 fee base for the same reason',
  direct_payment_fx_cost:
    'the direct payment and FX cost inside cost-only retail pricing, which is the customer’s ' +
    'cost rather than Mercaria’s income',
  customer_refund_credit:
    'a customer refund or credit, which only ever REDUCES a realized base — funding cannot be ' +
    'constructed out of money going the other way',
  dropship_markup:
    'a new markup added to a dropship order, which #120’s zero-markup policy forbids and which ' +
    'the referral domain has no write path to create',
  buyer_service_charge:
    'a service charge added to the buyer, which would make a referred buyer pay for the ' +
    'referral (ADR 0005 I2: referred buyers see the same item price)',
  merchant_fee_increase:
    'an increase to the #88 marketplace fee, which would make a merchant pay for the referral ' +
    '(ADR 0005 I3: the fee snapshot is computed with no referral input)',
  item_price_increase:
    'an increase to an item or listing price, which the pricing engine takes no referral input ' +
    'to perform (ADR 0005 I2)',
  paid_ranking:
    'paid ranking, which Mercaria does not have and which referral spend may never buy ' +
    '(ADR 0005 I1: no referral field enters organic ranking)',
};

/**
 * A reward rule VERSION's lifecycle (#144 field 14).
 *
 * `draft` is the only editable state. `active` is frozen by a database trigger;
 * publishing a successor moves the incumbent to `superseded`, and `retired` is
 * the terminal business decision that stops new accruals while every reward
 * already accrued under the version keeps its terms.
 */
export type ReferralRewardRuleStatus = 'draft' | 'active' | 'superseded' | 'retired';

/** {@link ReferralRewardRuleStatus} as a tuple. */
export const REFERRAL_REWARD_RULE_STATUSES: readonly ReferralRewardRuleStatus[] = [
  'draft',
  'active',
  'superseded',
  'retired',
];

/**
 * The two reward shapes (ADR 0005 D10). One reward row has exactly one, named
 * by its rule.
 *
 * There is deliberately no hybrid "percentage with a floor": a floor above the
 * realized base is money from nowhere, which is the whole class of bug the
 * funding boundary exists to make unrepresentable. A rule's
 * {@link ReferralRewardRule.minAccrualMinor} is therefore a THRESHOLD below
 * which nothing accrues, never a top-up.
 */
export type ReferralRewardFormula = 'percentage_of_realized_base' | 'fixed_amount';

/** {@link ReferralRewardFormula} as a tuple. */
export const REFERRAL_REWARD_FORMULAS: readonly ReferralRewardFormula[] = [
  'percentage_of_realized_base',
  'fixed_amount',
];

/**
 * How a rule decides the currency a reward is denominated in (#144 field 6).
 *
 * `funding_currency` takes whatever the realized funding was booked in.
 * `fixed_currency` pins one and REFUSES funding in another — no conversion
 * happens in this domain either way.
 *
 * A rule carrying any amount-valued term (a fixed amount, a minimum, a cap)
 * must be `fixed_currency`: an amount with no currency cannot be compared
 * against a base whose currency varies. That is a CHECK, not a convention.
 */
export type ReferralRewardCurrencyMode = 'funding_currency' | 'fixed_currency';

/** {@link ReferralRewardCurrencyMode} as a tuple. */
export const REFERRAL_REWARD_CURRENCY_MODES: readonly ReferralRewardCurrencyMode[] = [
  'funding_currency',
  'fixed_currency',
];

/** The period a per-partner accrual cap is measured over (#144 field 10). */
export type ReferralRewardCapPeriod = 'day' | 'week' | 'month' | 'lifetime';

/** {@link ReferralRewardCapPeriod} as a tuple. */
export const REFERRAL_REWARD_CAP_PERIODS: readonly ReferralRewardCapPeriod[] = [
  'day',
  'week',
  'month',
  'lifetime',
];

/**
 * What a rule does when its funding is later reversed (#144 field 11, ADR 0005
 * R1–R8).
 *
 * - `proportional_to_realized_base` — recompute the reward from the base as it
 *   now stands. A partial refund shrinks it; a base reaching zero voids it.
 *   The only correct policy for a percentage reward.
 * - `void_on_funding_reversal` — any reversal of the funding voids the whole
 *   reward. Correct where the base is all-or-nothing (a rejected affiliate
 *   commission, a reversed subscription charge).
 * - `fraud_only` — ADR 0005 R6: a budgeted bounty is not reversed by an
 *   ordinary refund of the activating order, because that order's commission
 *   never funded it. Only a fraud finding reverses it.
 */
export type ReferralRewardReversalPolicy =
  | 'proportional_to_realized_base'
  | 'void_on_funding_reversal'
  | 'fraud_only';

/** {@link ReferralRewardReversalPolicy} as a tuple. */
export const REFERRAL_REWARD_REVERSAL_POLICIES: readonly ReferralRewardReversalPolicy[] = [
  'proportional_to_realized_base',
  'void_on_funding_reversal',
  'fraud_only',
];

/**
 * A reward's state, ADR 0005's machine in full.
 *
 * #144 writes exactly two of them: `held` at accrual and `voided` when the
 * funding ceased to exist. `vested`, `frozen` and `paid` belong to #145's
 * earnings ledger and #148's fraud controls — the vocabulary is complete here
 * so those land as writers of an existing column rather than as a breaking
 * widen of a state set that shipped half-declared.
 */
export type ReferralRewardState = 'held' | 'vested' | 'frozen' | 'paid' | 'voided';

/** {@link ReferralRewardState} as a tuple. */
export const REFERRAL_REWARD_STATES: readonly ReferralRewardState[] = [
  'held',
  'vested',
  'frozen',
  'paid',
  'voided',
];

/**
 * The states a `frozen` reward can have come FROM (ADR 0005: freezing is a
 * pause, never a shortcut to void, so the origin travels with it).
 */
export type ReferralRewardFrozenOrigin = 'held' | 'vested';

/** {@link ReferralRewardFrozenOrigin} as a tuple. */
export const REFERRAL_REWARD_FROZEN_ORIGINS: readonly ReferralRewardFrozenOrigin[] = [
  'held',
  'vested',
];

/**
 * A campaign budget's lifecycle. `exhausted` is reached by the atomic claim
 * itself; `closed` is an operator stopping NEW claims (prospective, ADR 0005
 * D16); `invalidated` is #144's reversal cause 6 — the allocation should never
 * have existed.
 */
export type ReferralCampaignBudgetStatus = 'open' | 'exhausted' | 'closed' | 'invalidated';

/** {@link ReferralCampaignBudgetStatus} as a tuple. */
export const REFERRAL_CAMPAIGN_BUDGET_STATUSES: readonly ReferralCampaignBudgetStatus[] = [
  'open',
  'exhausted',
  'closed',
  'invalidated',
];

/**
 * The six reversal causes #144 names, one per bullet of its "Reversal
 * semantics" section.
 *
 * A partial and a full refund are DIFFERENT causes because they lead to
 * different outcomes under `proportional_to_realized_base` — one shrinks the
 * net, the other voids the reward — and an operator reading the trail needs to
 * see which happened without recomputing it.
 */
export type ReferralRewardReversalCause =
  | 'order_partially_refunded'
  | 'order_fully_refunded'
  | 'dispute_lost'
  | 'affiliate_commission_reversed'
  | 'subscription_revenue_reversed'
  | 'fraud_invalidation'
  | 'invalid_budget_allocation';

/** {@link ReferralRewardReversalCause} as a tuple. */
export const REFERRAL_REWARD_REVERSAL_CAUSES: readonly ReferralRewardReversalCause[] = [
  'order_partially_refunded',
  'order_fully_refunded',
  'dispute_lost',
  'affiliate_commission_reversed',
  'subscription_revenue_reversed',
  'fraud_invalidation',
  'invalid_budget_allocation',
];

/**
 * What a reversal MEANS for the partner's balance — the seam #145 consumes.
 *
 * `partner_liability` is ADR 0005 R7: the payout is never un-paid and the paid
 * record is never rewritten, so a reversal after payment is a debit against a
 * balance that may go negative. #144 RECORDS that; it holds no balance and
 * moves no money.
 */
export type ReferralRewardRecoveryState =
  | 'not_applicable'
  | 'offset_against_balance'
  | 'partner_liability';

/** {@link ReferralRewardRecoveryState} as a tuple. */
export const REFERRAL_REWARD_RECOVERY_STATES: readonly ReferralRewardRecoveryState[] = [
  'not_applicable',
  'offset_against_balance',
  'partner_liability',
];

/**
 * Why an accrual produced no reward — ADR 0005 D16's rule that an effect that
 * did not happen must be distinguishable from one that silently vanished.
 *
 * Every member names a condition the caller can act on. There is no `other`
 * bucket: a refusal this list cannot express is a defect in the list.
 */
export type ReferralRewardRefusalReason =
  | 'no_pinned_rule_version'
  | 'rule_version_not_found'
  | 'rule_not_active'
  | 'rule_not_effective'
  | 'conversion_not_eligible'
  | 'conversion_type_mismatch'
  | 'funding_source_unavailable'
  | 'funding_not_reconciled'
  | 'funding_currency_mismatch'
  | 'zero_base'
  | 'insufficient_funding'
  | 'below_min_accrual'
  | 'budget_exhausted'
  | 'cap_reached';

/** {@link ReferralRewardRefusalReason} as a tuple. */
export const REFERRAL_REWARD_REFUSAL_REASONS: readonly ReferralRewardRefusalReason[] = [
  'no_pinned_rule_version',
  'rule_version_not_found',
  'rule_not_active',
  'rule_not_effective',
  'conversion_not_eligible',
  'conversion_type_mismatch',
  'funding_source_unavailable',
  'funding_not_reconciled',
  'funding_currency_mismatch',
  'zero_base',
  // A FIXED reward whose funding cannot cover it is refused, never paid in
  // part: a bounty has one value, and paying half of it is a number nobody
  // agreed to. For a `fixed_budget` source the same condition is reported as
  // `budget_exhausted`, because that is what it IS.
  'insufficient_funding',
  'below_min_accrual',
  'budget_exhausted',
  'cap_reached',
];

/**
 * Why a funding adapter could not state a realized base.
 *
 * `not_yet_reconciled` is #144 calculation rule 8 held by the vocabulary: an
 * affiliate commission the network has not confirmed has a DIFFERENT answer
 * from one that is confirmed at zero, and collapsing the two is exactly how an
 * estimate gets paid as though it were realized.
 */
export type ReferralFundingUnavailableReason =
  | 'reader_not_registered'
  | 'record_not_found'
  | 'not_yet_reconciled'
  | 'ambiguous_currency';

/** {@link ReferralFundingUnavailableReason} as a tuple. */
export const REFERRAL_FUNDING_UNAVAILABLE_REASONS: readonly ReferralFundingUnavailableReason[] = [
  'reader_not_registered',
  'record_not_found',
  'not_yet_reconciled',
  'ambiguous_currency',
];

/**
 * What an adapter answers. A discriminated union with a STRING discriminant,
 * because this backend compiles with `strict: false` and TypeScript does not
 * narrow a union on a boolean-literal discriminant without `strictNullChecks`.
 *
 * The `unavailable` branch has NO amount and NO currency: "we cannot say" is
 * structurally different from "zero", so nothing can read silence as a base of
 * nothing and accrue against it.
 */
export type RealizedFunding =
  | {
      outcome: 'realized';
      /** Integer minor units of {@link RealizedFunding.currency}. Never negative. */
      amountMinor: number;
      currency: CurrencyCode;
      /** The funding record this base was read from — a payment id, a budget id, … */
      recordRef: string;
      /** What version of that record was read, so a later change is detectable. */
      recordVersion: string;
      observedAt: Date;
    }
  | { outcome: 'unavailable'; reason: ReferralFundingUnavailableReason };

/**
 * An immutable reward rule version, as its fourteen #144 fields.
 *
 * Every amount is integer minor units of {@link ReferralRewardRule.rewardCurrency},
 * which is present exactly when `currencyMode` is `fixed_currency`.
 */
export interface ReferralRewardRule {
  /** 1 — the stable rule identity every version row shares. */
  ruleId: string;
  /** 1 — 1-based, dense per rule. */
  version: number;
  /** 2 — the program this rule pays under. */
  programId: string;
  /** 2 — the campaign it is scoped to, when it is scoped to one. */
  campaignRef?: string;
  /** 3 — the conversion kind it may pay on. */
  conversionType: string;
  /** 4 — the one funding source its base comes from. */
  fundingSourceId: ReferralFundingSourceId;
  /** 5 */
  formula: ReferralRewardFormula;
  /** 5 — basis points of the realized base; `> 0` and `<= 10_000`. */
  rateBps?: number;
  /** 5 — the fixed reward, in minor units of `rewardCurrency`. */
  fixedAmountMinor?: number;
  /** 6 */
  currencyMode: ReferralRewardCurrencyMode;
  /** 6 — present exactly when `currencyMode` is `fixed_currency`. */
  rewardCurrency?: CurrencyCode;
  /** 7 — ISO-8601. */
  effectiveStartAt: string;
  /** 7 — ISO-8601, when the version has an end. */
  effectiveEndAt?: string;
  /** 8 — the #145/#146 hold policy this version pays under. */
  holdPolicyRef: string;
  /** 8 — days from accrual to vesting. */
  holdDays: number;
  /** 9 — below this, nothing accrues. Never a top-up. */
  minAccrualMinor?: number;
  /** 9 */
  maxRewardPerConversionMinor?: number;
  /** 10 — present together with `partnerCapPeriod`. */
  maxRewardPerPartnerPeriodMinor?: number;
  /** 10 */
  partnerCapPeriod?: ReferralRewardCapPeriod;
  /** 10 */
  maxRewardPerCampaignMinor?: number;
  /** 11 */
  reversalPolicy: ReferralRewardReversalPolicy;
  /** 12 */
  termsVersion: string;
  /** 13 */
  createdByOxyUserId: string;
  /** 13 — set at activation, never before. */
  approvedByOxyUserId?: string;
  /** 13 — ISO-8601. */
  createdAt: string;
  /** 13 — ISO-8601, when activated. */
  activatedAt?: string;
  /** 14 */
  status: ReferralRewardRuleStatus;
}

/**
 * A reward as its OWNING partner may see it (ADR 0005 A5: day-granularity date,
 * state, net amount, source, campaign — and nothing else).
 *
 * Deliberately no conversion id, no order reference, no funding record and no
 * buyer-shaped field of any kind, at any aggregation level.
 */
export interface ReferralRewardPartnerView {
  /** Day granularity, `YYYY-MM-DD`. */
  date: string;
  state: ReferralRewardState;
  netAmountMinor: number;
  currency: CurrencyCode;
  fundingSourceId: ReferralFundingSourceId;
  campaignRef?: string;
}
