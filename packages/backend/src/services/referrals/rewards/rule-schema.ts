/**
 * The `.strict()` schema every reward-rule draft passes through (#144).
 *
 * It lives beside its only consumer rather than in `middleware/` because there
 * is no HTTP surface for reward rules yet — the operator dashboards are #147's.
 * The schema is not waiting for one: `rule.service.ts` runs it on every draft
 * and every edit, so the write CHOKEPOINT is validated whether the caller is a
 * route, a seed script or a test.
 *
 * ## Strictness is doing more than refusing a typo here
 *
 * This body is the one place in Mercaria where somebody would type a referral
 * funding source. The schema below enumerates the COMPLETE set of levers a
 * reward rule version has, and it contains no retail margin, no cost variance,
 * no supplier cost, no tax share, no buyer surcharge and no fee uplift — so a
 * rule funded from any of them cannot be written down. `.strict()` is what
 * makes an extra key a refusal instead of a silently dropped field, and
 * `assertNoForbiddenReferralFunding` runs over the RAW body first so the
 * refusal names the prohibition rather than saying "unrecognized key".
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  assertSafeMoneyAmount,
  REFERRAL_CONVERSION_TYPES,
  REFERRAL_FUNDING_SOURCE_IDS,
  REFERRAL_REWARD_CAP_PERIODS,
  REFERRAL_REWARD_CURRENCY_MODES,
  REFERRAL_REWARD_FORMULAS,
  REFERRAL_REWARD_REVERSAL_POLICIES,
  type CurrencyCode,
  type ReferralConversionType,
  type ReferralFundingSourceId,
  type ReferralRewardCapPeriod,
  type ReferralRewardCurrencyMode,
  type ReferralRewardFormula,
  type ReferralRewardReversalPolicy,
} from '@mercaria/shared-types';
import { REWARD_RATE_BPS_DENOMINATOR } from './amount.js';

const CURRENCY_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const CONVERSION_TYPE_VALUES = REFERRAL_CONVERSION_TYPES as readonly [
  ReferralConversionType,
  ...ReferralConversionType[],
];
const FUNDING_SOURCE_VALUES = REFERRAL_FUNDING_SOURCE_IDS as readonly [
  ReferralFundingSourceId,
  ...ReferralFundingSourceId[],
];
const FORMULA_VALUES = REFERRAL_REWARD_FORMULAS as readonly [
  ReferralRewardFormula,
  ...ReferralRewardFormula[],
];
const CURRENCY_MODE_VALUES = REFERRAL_REWARD_CURRENCY_MODES as readonly [
  ReferralRewardCurrencyMode,
  ...ReferralRewardCurrencyMode[],
];
const CAP_PERIOD_VALUES = REFERRAL_REWARD_CAP_PERIODS as readonly [
  ReferralRewardCapPeriod,
  ...ReferralRewardCapPeriod[],
];
const REVERSAL_POLICY_VALUES = REFERRAL_REWARD_REVERSAL_POLICIES as readonly [
  ReferralRewardReversalPolicy,
  ...ReferralRewardReversalPolicy[],
];

/**
 * A positive minor-unit amount WITHIN the representable ceiling.
 * `z.number().int()` alone accepts `1e300`; `assertSafeMoneyAmount` is what
 * makes the bound real — the rule every money boundary in this codebase obeys.
 */
const positiveMinor = z
  .number()
  .int()
  .positive()
  .refine(
    (value) => {
      try {
        assertSafeMoneyAmount(value, 'referral reward rule amount');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'amount exceeds the representable money ceiling' },
  );

const isoInstant = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .describe('ISO-8601');

/**
 * A reward rule DRAFT, complete. Every field #144 lists, and nothing else.
 *
 * The cross-field agreements the database CHECKs enforce are re-stated here as
 * `superRefine` clauses, deliberately duplicating them: a `23514` from Postgres
 * names a constraint, and an operator composing a rule deserves a sentence.
 * The database remains the authority — these are the message, not the guard.
 */
export const referralRewardRuleDraftSchema = z
  .object({
    ruleId: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    programId: z.string().min(1).max(120),
    campaignRef: z.string().min(1).max(120).optional(),
    conversionType: z.enum(CONVERSION_TYPE_VALUES),
    fundingSourceId: z.enum(FUNDING_SOURCE_VALUES),
    formula: z.enum(FORMULA_VALUES),
    rateBps: z.number().int().positive().max(REWARD_RATE_BPS_DENOMINATOR).optional(),
    fixedAmountMinor: positiveMinor.optional(),
    currencyMode: z.enum(CURRENCY_MODE_VALUES),
    rewardCurrency: z.enum(CURRENCY_VALUES).optional(),
    effectiveStartAt: isoInstant,
    effectiveEndAt: isoInstant.optional(),
    holdPolicyRef: z.string().min(1).max(120),
    holdDays: z.number().int().min(0).max(3_650),
    minAccrualMinor: positiveMinor.optional(),
    maxRewardPerConversionMinor: positiveMinor.optional(),
    maxRewardPerPartnerPeriodMinor: positiveMinor.optional(),
    partnerCapPeriod: z.enum(CAP_PERIOD_VALUES).optional(),
    maxRewardPerCampaignMinor: positiveMinor.optional(),
    reversalPolicy: z.enum(REVERSAL_POLICY_VALUES),
    termsVersion: z.string().min(1).max(120),
    createdByOxyUserId: z.string().min(1).max(120),
  })
  .strict()
  .superRefine((body, ctx) => {
    const isPercentage = body.formula === 'percentage_of_realized_base';
    if (isPercentage === (body.rateBps === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rateBps'],
        message:
          'a percentage rule states a rate and nothing else does — one reward row has exactly ' +
          'one shape (ADR 0005 D10)',
      });
    }
    if ((body.formula === 'fixed_amount') === (body.fixedAmountMinor === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fixedAmountMinor'],
        message: 'a fixed rule states an amount and nothing else does',
      });
    }
    if ((body.currencyMode === 'fixed_currency') === (body.rewardCurrency === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rewardCurrency'],
        message: 'a currency is named exactly when the mode pins one',
      });
    }
    const hasAmountTerm =
      body.fixedAmountMinor !== undefined ||
      body.minAccrualMinor !== undefined ||
      body.maxRewardPerConversionMinor !== undefined ||
      body.maxRewardPerPartnerPeriodMinor !== undefined ||
      body.maxRewardPerCampaignMinor !== undefined;
    if (hasAmountTerm && body.rewardCurrency === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rewardCurrency'],
        message:
          'a rule carrying any amount must pin the currency it pays in — an amount cannot be ' +
          'compared against a base whose currency varies',
      });
    }
    if ((body.maxRewardPerPartnerPeriodMinor === undefined) !== (body.partnerCapPeriod === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['partnerCapPeriod'],
        message: 'a per-partner cap states the period it is measured over',
      });
    }
    if (body.maxRewardPerCampaignMinor !== undefined && body.campaignRef === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['campaignRef'],
        message: 'a campaign cap needs a campaign to be a cap on',
      });
    }
    if (
      body.fundingSourceId === 'fixed_budget' &&
      (body.formula !== 'fixed_amount' || body.campaignRef === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fundingSourceId'],
        message:
          'a fixed_budget rule pays a fixed amount from a named campaign: a percentage of a ' +
          'marketing allocation is a share of a number Mercaria chose, not a realized base',
      });
    }
    if (
      body.effectiveEndAt !== undefined &&
      Date.parse(body.effectiveEndAt) <= Date.parse(body.effectiveStartAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveEndAt'],
        message: 'a version ends after it starts',
      });
    }
  });

/** A validated reward-rule draft body. */
export type ReferralRewardRuleDraftBody = z.infer<typeof referralRewardRuleDraftSchema>;
