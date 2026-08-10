/**
 * Accruing a reward, and reversing one (#144 "Calculation rules" and "Reversal
 * semantics", ADR 0005 D10–D19 and R1–R8).
 *
 * ## The pipeline, and the order it runs in
 *
 * 1. **Idempotency first.** An existing reward for the conversion is RETURNED
 *    before anything else — before the base is re-read, before a budget is
 *    touched. A retry that re-realized the base would produce a different
 *    figure the moment a refund had landed in between, which is the opposite of
 *    "an idempotent conversion retry produces the same reward".
 * 2. The rule VERSION pinned on the attribution (ADR 0005 D19), never the one
 *    active now.
 * 3. The funding adapter, which is the only base computation in the domain.
 * 4. The formula, the ceilings, the de-minimis threshold — each of which can
 *    only ever LOWER the figure.
 * 5. The budget claim, atomically, for a `fixed_budget` reward.
 * 6. The row, `ON CONFLICT DO NOTHING` on the conversion.
 *
 * ## Every refusal is RECORDED and nothing is rejected
 *
 * A refused accrual appends a `reward_accrual_refused` audit row naming the
 * reason and returns — it does not reject the conversion. A conversion is a
 * verified milestone that genuinely happened; refusing to pay for it does not
 * unmake it, and rewriting #142's state machine from here would make "the
 * milestone occurred" and "we chose not to pay" one field (ADR 0005 D16: an
 * effect that did not happen must be distinguishable from one that silently
 * vanished).
 *
 * ## What this file cannot do, and it is the point
 *
 * It writes no fee, no price, no discount, no ranking input and no order. It
 * imports no pricing, fee, retail, procurement or ranking module, and the ONE
 * payment-side thing it can reach is the read-only ledger seam in
 * `db/referrals/commissionBaseRepository.ts`.
 * `reward-funding-isolation.test.ts` fails the build if that changes.
 */

import type {
  CurrencyCode,
  ReferralFundingSourceId,
  ReferralRewardRefusalReason,
  ReferralRewardReversalCause,
  ReferralRewardState,
} from '@mercaria/shared-types';
import { notFound } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { findAttributionById } from '../../../db/referrals/attributionRepository.js';
import {
  claimCampaignBudget,
  findCampaignBudget,
  findCampaignBudgetById,
  releaseCampaignBudget,
  transitionCampaignBudgetStatus,
} from '../../../db/referrals/campaignBudgetRepository.js';
import { findConversionById } from '../../../db/referrals/conversionRepository.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import {
  findRewardRuleVersion,
  findRewardRuleVersionById,
  parseRewardRuleVersionRef,
  type ReferralRewardRuleRow,
} from '../../../db/referrals/rewardRuleRepository.js';
import {
  appendRewardAdjustment,
  findRewardById,
  findRewardByConversion,
  lockCampaignCapWindow,
  lockPartnerCapWindow,
  listRewardsForFundingRecord,
  sumCampaignAccruals,
  sumPartnerAccruals,
  insertReward,
  type ReferralRewardAdjustmentRow,
  type ReferralRewardRow,
} from '../../../db/referrals/rewardRepository.js';
import {
  capPeriodStart,
  clampReward,
  isBelowMinimumAccrual,
  percentageOfRealizedBase,
} from './amount.js';
import { resolveFundingAdapter } from './funding.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * What an accrual produced. A STRING discriminant, because this backend
 * compiles with `strict: false` and TypeScript does not narrow on a
 * boolean-literal one.
 */
export type ReferralAccrualOutcome =
  | { outcome: 'accrued'; reward: ReferralRewardRow; created: boolean }
  | { outcome: 'refused'; reason: ReferralRewardRefusalReason };

/** What an accrual is asked for. */
export interface AccrueRewardInput {
  conversionId: string;
  /**
   * The funding record the base is read from — a `payments.id` for
   * `connected_marketplace`, a #67/#89 record for the deferred sources.
   *
   * Supplied by the CALLER rather than derived here, because the caller is the
   * payment-success processing that already holds it (ADR 0005 D11), and
   * because deriving it would mean this domain reading the order→payment link.
   * A `fixed_budget` rule needs none: its record is the campaign budget the
   * rule itself names.
   */
  fundingRecordRef?: string;
  at?: Date;
}

/**
 * Accrue the reward one conversion earns, or record why it earned none.
 *
 * Everything commits in ONE transaction: the budget claim, the reward row and
 * the audit line. A budget claimed without a reward is money spent on nothing,
 * and a reward without its claim is money spent twice.
 */
export async function accrueRewardForConversion(
  input: AccrueRewardInput,
): Promise<ReferralAccrualOutcome> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const conversion = await findConversionById(tx, input.conversionId);
    if (!conversion) throw notFound('Referral conversion not found');

    // Step 1, before anything that could observe a moved world.
    const existing = await findRewardByConversion(tx, conversion.id);
    if (existing) return { outcome: 'accrued', reward: existing, created: false };

    const refuse = async (
      reason: ReferralRewardRefusalReason,
      detail: string,
    ): Promise<ReferralAccrualOutcome> => {
      await appendReferralEvent(tx, {
        subjectType: 'conversion',
        subjectId: conversion.id,
        action: 'reward_accrual_refused',
        actorKind: 'system',
        reason: `${reason}: ${detail}`,
      });
      return { outcome: 'refused', reason };
    };

    if (conversion.state !== 'eligible') {
      return await refuse('conversion_not_eligible', `conversion is ${conversion.state}`);
    }

    const attribution = await findAttributionById(tx, conversion.attributionId);
    if (!attribution) throw notFound('Referral attribution not found');

    const pinned = parseRewardRuleVersionRef(attribution.ruleVersionRef);
    if (!pinned) {
      return await refuse(
        'no_pinned_rule_version',
        `attribution ${attribution.id} pins \`${attribution.ruleVersionRef}\`, which names no ` +
          'exact rule version',
      );
    }
    const rule = await findRewardRuleVersion(tx, pinned);
    if (!rule) {
      return await refuse('rule_version_not_found', `no rule version ${attribution.ruleVersionRef}`);
    }
    // `superseded` is FINE and that is ADR 0005 D19 working: the pinned version
    // governs how much is earned, forever. Only RETIREMENT stops new accruals,
    // and it is prospective.
    if (rule.status === 'retired' || rule.status === 'draft') {
      return await refuse('rule_not_active', `rule version is ${rule.status}`);
    }
    if (rule.conversionType !== conversion.conversionType) {
      return await refuse(
        'conversion_type_mismatch',
        `rule pays on ${rule.conversionType}, conversion is ${conversion.conversionType}`,
      );
    }
    if (
      conversion.occurredAt < rule.effectiveStartAt ||
      (rule.effectiveEndAt !== null && conversion.occurredAt >= rule.effectiveEndAt)
    ) {
      return await refuse(
        'rule_not_effective',
        `conversion at ${conversion.occurredAt.toISOString()} is outside the version's window`,
      );
    }

    const budget =
      rule.fundingSourceId === 'fixed_budget' && rule.campaignRef !== null
        ? await findCampaignBudget(tx, {
            programId: rule.programId,
            campaignRef: rule.campaignRef,
          })
        : undefined;
    const recordRef =
      rule.fundingSourceId === 'fixed_budget' ? budget?.id : input.fundingRecordRef;
    if (!recordRef) {
      return await refuse(
        'funding_source_unavailable',
        rule.fundingSourceId === 'fixed_budget'
          ? `no campaign budget for ${rule.programId}/${String(rule.campaignRef)}`
          : `no funding record supplied for source ${rule.fundingSourceId}`,
      );
    }

    const realized = await resolveFundingAdapter(rule.fundingSourceId).realize({
      recordRef,
      db: tx,
    });
    if (realized.outcome === 'unavailable') {
      return await refuse(
        realized.reason === 'not_yet_reconciled'
          ? 'funding_not_reconciled'
          : 'funding_source_unavailable',
        `${rule.fundingSourceId} adapter answered ${realized.reason} for ${recordRef}`,
      );
    }
    if (rule.currencyMode === 'fixed_currency' && realized.currency !== rule.rewardCurrency) {
      // No conversion, deliberately. An FX rate moving between accrual and
      // vesting would change an amount ADR 0005 D19 fixes at attribution.
      return await refuse(
        'funding_currency_mismatch',
        `rule pays ${String(rule.rewardCurrency)}, funding realized in ${realized.currency}`,
      );
    }
    if (realized.amountMinor <= 0) {
      return await refuse(
        'zero_base',
        `${rule.fundingSourceId} realized nothing for ${recordRef}`,
      );
    }

    const currency = realized.currency;
    const computed =
      rule.formula === 'percentage_of_realized_base'
        ? percentageOfRealizedBase(realized.amountMinor, rule.rateBps ?? 0)
        : (rule.fixedAmountMinor ?? 0);

    // A FIXED reward is refused rather than clamped. Clamping a bounty to what
    // is left of a budget pays a number nobody agreed to — half a bounty is not
    // a smaller bounty, it is a different promise — and ADR 0005 D16 says an
    // exhausted budget REFUSES the accrual and records the outcome.
    if (rule.formula === 'fixed_amount' && computed > realized.amountMinor) {
      return await refuse(
        rule.fundingSourceId === 'fixed_budget' ? 'budget_exhausted' : 'insufficient_funding',
        `${rule.fundingSourceId} offers ${String(realized.amountMinor)} ${currency}, the rule ` +
          `pays a fixed ${String(computed)}`,
      );
    }

    // Take the cap locks BEFORE either sum is read, and hold them to commit.
    // Both, in this fixed order, in one place: a sum-then-insert is not a bound
    // under READ COMMITTED, and two locks acquired in two orders by two callers
    // is a deadlock. Uncapped rules take neither, so an ordinary accrual
    // serializes against nothing.
    await lockAccrualCapWindows(tx, { rule, partnerId: attribution.partnerId, currency });

    const partnerHeadroom = await resolvePartnerHeadroom(tx, {
      rule,
      partnerId: attribution.partnerId,
      currency,
      at,
    });
    const campaignHeadroom = await resolveCampaignHeadroom(tx, { rule, currency });

    const clamped = clampReward(computed, {
      realizedFundingMinor: realized.amountMinor,
      perConversionMinor: rule.maxRewardPerConversionMinor ?? undefined,
      partnerHeadroomMinor: partnerHeadroom,
      campaignHeadroomMinor: campaignHeadroom,
    });
    if (clamped.amountMinor <= 0) {
      // A cap that left no headroom is `cap_reached`; a formula that rounded to
      // nothing is below the implicit one-minor-unit minimum the row's
      // `gross_amount_minor > 0` CHECK imposes.
      return clamped.applied === 'partner_period' || clamped.applied === 'campaign'
        ? await refuse('cap_reached', `the ${clamped.applied} cap left no headroom`)
        : await refuse('below_min_accrual', 'the computed reward rounds to zero minor units');
    }
    if (isBelowMinimumAccrual(clamped.amountMinor, rule.minAccrualMinor ?? undefined)) {
      return await refuse(
        'below_min_accrual',
        `${String(clamped.amountMinor)} is under the rule's minimum of ` +
          `${String(rule.minAccrualMinor)}`,
      );
    }

    let campaignBudgetId: string | undefined;
    if (rule.fundingSourceId === 'fixed_budget') {
      if (!budget) return await refuse('budget_exhausted', 'the campaign budget disappeared');
      const claimed = await claimCampaignBudget(tx, {
        budgetId: budget.id,
        amountMinor: clamped.amountMinor,
      });
      if (!claimed) {
        return await refuse(
          'budget_exhausted',
          `campaign ${budget.campaignRef} could not fund ${String(clamped.amountMinor)}`,
        );
      }
      campaignBudgetId = claimed.id;
      if (claimed.claimedMinor >= claimed.budgetMinor) {
        await transitionCampaignBudgetStatus(tx, {
          budgetId: claimed.id,
          expected: 'open',
          to: 'exhausted',
          at,
        });
      }
    }

    const { row, created } = await insertReward(tx, {
      conversionId: conversion.id,
      attributionId: attribution.id,
      partnerId: attribution.partnerId,
      programVersionId: attribution.programVersionId,
      ruleVersionId: rule.id,
      fundingSourceId: rule.fundingSourceId,
      fundingRecordRef: realized.recordRef,
      fundingRecordVersion: realized.recordVersion,
      fundingAmountMinor: realized.amountMinor,
      fundingObservedAt: realized.observedAt,
      campaignBudgetId,
      grossAmountMinor: clamped.amountMinor,
      currency,
      accruedAt: at,
      holdUntilAt: new Date(at.getTime() + rule.holdDays * MILLISECONDS_PER_DAY),
    });
    if (created) {
      await appendReferralEvent(tx, {
        subjectType: 'reward',
        subjectId: row.id,
        action: 'reward_accrued',
        actorKind: 'system',
        reason:
          `${rule.fundingSourceId} ${String(clamped.amountMinor)} ${currency} under ` +
          `${rule.ruleId}@v${String(rule.version)} from ${realized.recordRef}` +
          (clamped.applied === 'none' ? '' : ` (clamped by ${clamped.applied})`),
      });
    }
    return { outcome: 'accrued', reward: row, created };
  });
}

/**
 * Take the advisory locks the rule's caps need, in ONE fixed order.
 *
 * The order is partner-then-campaign and is the only order any caller uses,
 * which is what stops two accruals that each need both from deadlocking against
 * each other. A rule with no cap of a kind takes no lock of that kind: an
 * uncapped accrual must not queue behind an unrelated one.
 *
 * There is deliberately no lock for the `fixed_budget` claim beside these:
 * `claimCampaignBudget` is already an atomic compare-and-swap on the budget ROW
 * and needs none — and it runs strictly AFTER these, so the acquisition order
 * across all three is fixed too.
 */
async function lockAccrualCapWindows(
  db: DatabaseOrTransaction,
  input: { rule: ReferralRewardRuleRow; partnerId: string; currency: CurrencyCode },
): Promise<void> {
  if (input.rule.maxRewardPerPartnerPeriodMinor !== null) {
    await lockPartnerCapWindow(db, { partnerId: input.partnerId, currency: input.currency });
  }
  if (input.rule.maxRewardPerCampaignMinor !== null && input.rule.campaignRef !== null) {
    await lockCampaignCapWindow(db, {
      campaignRef: input.rule.campaignRef,
      currency: input.currency,
    });
  }
}

/** What the per-partner period cap leaves, or `undefined` when the rule sets none. */
async function resolvePartnerHeadroom(
  db: DatabaseOrTransaction,
  input: { rule: ReferralRewardRuleRow; partnerId: string; currency: CurrencyCode; at: Date },
): Promise<number | undefined> {
  const cap = input.rule.maxRewardPerPartnerPeriodMinor;
  if (cap === null || input.rule.partnerCapPeriod === null) return undefined;
  const used = await sumPartnerAccruals(db, {
    partnerId: input.partnerId,
    currency: input.currency,
    since: capPeriodStart(input.rule.partnerCapPeriod, input.at),
  });
  return cap - used;
}

/** What the campaign cap leaves, or `undefined` when the rule sets none. */
async function resolveCampaignHeadroom(
  db: DatabaseOrTransaction,
  input: { rule: ReferralRewardRuleRow; currency: CurrencyCode },
): Promise<number | undefined> {
  const cap = input.rule.maxRewardPerCampaignMinor;
  if (cap === null || input.rule.campaignRef === null) return undefined;
  const used = await sumCampaignAccruals(db, {
    campaignRef: input.rule.campaignRef,
    currency: input.currency,
  });
  return cap - used;
}

/**
 * What each reversal cause does, before the rule's own policy is consulted.
 *
 * `void` is ADR 0005's deterministic outcome for the causes where the funding
 * is gone as a whole — a lost dispute (R3), a fraud finding (R6/R8), a budget
 * allocation that should never have existed (#144 reversal 6), and a full
 * refund (R1). `recompute` is R2's partial-refund mechanics, which R4 and R5
 * adopt verbatim for the deferred sources.
 */
const REVERSAL_OUTCOME: Record<ReferralRewardReversalCause, 'void' | 'recompute'> = {
  order_partially_refunded: 'recompute',
  order_fully_refunded: 'void',
  dispute_lost: 'void',
  affiliate_commission_reversed: 'recompute',
  subscription_revenue_reversed: 'recompute',
  fraud_invalidation: 'void',
  invalid_budget_allocation: 'void',
};

/** The two causes a `fraud_only` rule responds to at all (ADR 0005 R6). */
const FRAUD_ONLY_CAUSES: readonly ReferralRewardReversalCause[] = [
  'fraud_invalidation',
  'invalid_budget_allocation',
];

/** One reversal, applied. `created: false` means it had already been applied. */
export interface RewardReversalResult {
  reward: ReferralRewardRow;
  adjustment: ReferralRewardAdjustmentRow;
  created: boolean;
}

/** What a reversal is asked for. */
export interface ReverseRewardInput {
  cause: ReferralRewardReversalCause;
  /** The record that caused it — a refund id, a dispute ref, a finding id. */
  sourceRef: string;
  reason: string;
  occurredAt?: Date;
}

/**
 * Reverse ONE reward.
 *
 * @returns `undefined` when the rule's policy says this cause does not reach
 *   this reward at all — a `fraud_only` bounty against an ordinary refund (ADR
 *   0005 R6). Nothing is written in that case, deliberately: the reward was
 *   never funded by the thing that changed, so an adjustment row against it
 *   would record a relationship that does not exist.
 */
export async function reverseReward(
  input: ReverseRewardInput & { rewardId: string },
): Promise<RewardReversalResult | undefined> {
  const db = getDb();
  return await db.transaction(async (tx) => await reverseRewardIn(tx, input));
}

/**
 * Reverse every reward drawn from one funding record.
 *
 * The entry point a refund, a dispute or a #67/#89 reversal actually has: those
 * events name a PAYMENT or a commission record, not a reward, so the domain is
 * asked "what did this funding pay" rather than being told.
 *
 * One transaction over all of them: a refund that reversed two of three rewards
 * and then failed would leave a partner's balance describing a refund that only
 * partly happened.
 */
export async function reverseRewardsForFundingRecord(
  input: ReverseRewardInput & {
    fundingSourceId: ReferralFundingSourceId;
    fundingRecordRef: string;
  },
): Promise<RewardReversalResult[]> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const rewards = await listRewardsForFundingRecord(tx, {
      fundingSourceId: input.fundingSourceId,
      fundingRecordRef: input.fundingRecordRef,
    });
    const results: RewardReversalResult[] = [];
    for (const reward of rewards) {
      const result = await reverseRewardIn(tx, { ...input, rewardId: reward.id });
      if (result) results.push(result);
    }
    return results;
  });
}

/**
 * Invalidate a campaign budget allocation and reverse everything it funded
 * (#144 reversal cause 6).
 *
 * The budget is marked `invalidated` — never deleted, never shrunk — and each
 * reward it paid for is voided with its claim released. An allocation that
 * should not have existed is still a thing that DID exist, and the trail of
 * what it paid is the only way anybody can check that the money came back.
 */
export async function invalidateCampaignBudget(input: {
  budgetId: string;
  reason: string;
  occurredAt?: Date;
}): Promise<RewardReversalResult[]> {
  const at = input.occurredAt ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const budget = await findCampaignBudgetById(tx, input.budgetId);
    if (!budget) throw notFound('Referral campaign budget not found');
    if (budget.status !== 'invalidated') {
      await transitionCampaignBudgetStatus(tx, {
        budgetId: budget.id,
        expected: budget.status,
        to: 'invalidated',
        at,
      });
    }
    const rewards = await listRewardsForFundingRecord(tx, {
      fundingSourceId: 'fixed_budget',
      fundingRecordRef: budget.id,
    });
    const results: RewardReversalResult[] = [];
    for (const reward of rewards) {
      const result = await reverseRewardIn(tx, {
        rewardId: reward.id,
        cause: 'invalid_budget_allocation',
        sourceRef: budget.id,
        reason: input.reason,
        occurredAt: at,
      });
      if (result) results.push(result);
    }
    return results;
  });
}

/** The body both entry points share, inside the caller's transaction. */
async function reverseRewardIn(
  tx: DatabaseOrTransaction,
  input: ReverseRewardInput & { rewardId: string },
): Promise<RewardReversalResult | undefined> {
  const occurredAt = input.occurredAt ?? new Date();
  const reward = await findRewardById(tx, input.rewardId);
  if (!reward) throw notFound('Referral reward not found');
  const rule = await findRewardRuleVersionById(tx, reward.ruleVersionId);
  if (!rule) throw notFound('Referral reward rule version not found');

  if (rule.reversalPolicy === 'fraud_only' && !FRAUD_ONLY_CAUSES.includes(input.cause)) {
    return undefined;
  }

  const outcome =
    rule.reversalPolicy === 'void_on_funding_reversal' ? 'void' : REVERSAL_OUTCOME[input.cause];

  let observedFundingMinor = reward.fundingAmountMinor;
  let nextNet = 0;
  if (outcome === 'recompute') {
    const realized = await resolveFundingAdapter(reward.fundingSourceId).realize({
      recordRef: reward.fundingRecordRef,
      db: tx,
    });
    // An unavailable base is treated as ZERO here, and only here. Everywhere
    // else "we cannot say" refuses; on the reversal path refusing would leave a
    // reward standing on funding nobody can find, which is the failure that
    // costs money rather than the one that withholds it.
    observedFundingMinor =
      realized.outcome === 'realized' && realized.currency === reward.currency
        ? realized.amountMinor
        : 0;
    const recomputed =
      rule.formula === 'percentage_of_realized_base'
        ? percentageOfRealizedBase(observedFundingMinor, rule.rateBps ?? 0)
        : (rule.fixedAmountMinor ?? 0);
    // Monotone downward, three ways: never above the recomputed figure, never
    // above the base it draws on, never above what the reward already stood at.
    nextNet = Math.min(
      recomputed,
      observedFundingMinor,
      reward.grossAmountMinor,
      reward.netAmountMinor,
    );
  }

  const delta = nextNet - reward.netAmountMinor;
  // A payout is never un-paid (ADR 0005 R7): a paid reward keeps its state and
  // the shortfall becomes a liability #145's partner balance carries.
  const recoveryState =
    delta === 0 ? 'not_applicable' : reward.state === 'paid' ? 'partner_liability' : 'offset_against_balance';
  const nextState: ReferralRewardState =
    reward.state === 'paid' ? 'paid' : nextNet === 0 ? 'voided' : reward.state;

  const { adjustment, created } = await appendRewardAdjustment(tx, {
    rewardId: reward.id,
    cause: input.cause,
    sourceRef: input.sourceRef,
    deltaAmountMinor: delta,
    resultingNetMinor: nextNet,
    observedFundingAmountMinor: observedFundingMinor,
    currency: reward.currency,
    recoveryState,
    liabilityAmountMinor: recoveryState === 'partner_liability' ? -delta : 0,
    reason: input.reason,
    occurredAt,
    rewardState: nextState,
    voidedAt: occurredAt,
  });

  if (!created) {
    return { reward, adjustment, created: false };
  }

  // Hand budget back for the part of a bounty that is no longer owed (ADR 0005
  // R6). Runs after the adjustment so a replay, which writes nothing, cannot
  // release twice.
  if (reward.campaignBudgetId !== null && delta < 0) {
    await releaseCampaignBudget(tx, {
      budgetId: reward.campaignBudgetId,
      amountMinor: -delta,
    });
  }

  await appendReferralEvent(tx, {
    subjectType: 'reward',
    subjectId: reward.id,
    action: nextState === 'voided' ? 'reward_voided' : 'reward_reversed',
    actorKind: 'system',
    reason: `${input.cause} (${input.sourceRef}): net ${String(reward.netAmountMinor)} → ${String(nextNet)} ${reward.currency}`,
  });

  const updated = await findRewardById(tx, reward.id);
  if (!updated) throw notFound('Referral reward not found');
  return { reward: updated, adjustment, created: true };
}
