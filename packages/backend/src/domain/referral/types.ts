import type { Money } from "@mercaria/shared-types";

export type ReferralFundingSource =
  | "marketplace_commission"
  | "affiliate_commission"
  | "subscription_revenue"
  | "fixed_acquisition_budget";

export type ReferralConversionKind =
  | "order"
  | "subscription_signup"
  | "affiliate_click"
  | "campaign_conversion";

export type ReferralRewardFormulaType = "percentage" | "fixed";

export type ReferralCurrencyBehavior =
  | "funding_currency"
  | "partner_currency"
  | "fixed_usd";

export type ReferralHoldPolicy = "none" | "fixed_days" | "refund_window" | "custom";

export type ReferralReversalReason =
  | "order_refund"
  | "chargeback"
  | "affiliate_rejected"
  | "subscription_refund"
  | "fraud_self_referral"
  | "budget_invalid"
  | "dispute_lost";

export type ReferralRuleStatus = "draft" | "active" | "superseded" | "retired";

export type ReferralRewardStatus = "pending" | "held" | "released" | "reversed" | "recovery";

export interface ReferralRuleVersion {
  id: string;
  ruleId: string;
  version: number;
  name: string;
  description: string | null;
  campaignScope: string | null;
  programScope: string | null;
  conversionKind: ReferralConversionKind;
  fundingSource: ReferralFundingSource;
  formulaType: ReferralRewardFormulaType;
  formulaValue: number;
  currencyBehavior: ReferralCurrencyBehavior;
  currencyCode: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  holdPolicy: ReferralHoldPolicy;
  holdPolicyConfig: Record<string, unknown> | null;
  perConversionCapMinor: number | null;
  perConversionMinMinor: number | null;
  partnerCapMinor: number | null;
  campaignCapMinor: number | null;
  refundReversalPolicy: Record<string, unknown>;
  termsVersion: string;
  createdBy: string;
  approvedBy: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  status: ReferralRuleStatus;
  supersededBy: string | null;
}

export interface ReferralReward {
  id: string;
  ruleVersionId: string;
  partnerId: string;
  campaignId: string | null;
  conversionId: string;
  conversionKind: ReferralConversionKind;
  fundingSource: ReferralFundingSource;
  fundingRecordId: string;
  fundingRecordVersion: number;
  fundingAmountMinor: number;
  fundingCurrency: string;
  rewardAmountMinor: number;
  rewardCurrency: string;
  formulaType: ReferralRewardFormulaType;
  formulaValue: number;
  holdPolicy: ReferralHoldPolicy;
  holdUntil: Date | null;
  status: ReferralRewardStatus;
  idempotencyKey: string;
  createdAt: Date;
  releasedAt: Date | null;
  reversedAt: Date | null;
}

export interface ReferralRewardReversal {
  id: string;
  rewardId: string;
  reason: ReferralReversalReason;
  reversalAmountMinor: number;
  reversalCurrency: string;
  fundingRecordId: string | null;
  fundingRecordVersion: number | null;
  referenceId: string | null;
  referenceType: string | null;
  idempotencyKey: string;
  createdAt: Date;
  processedAt: Date | null;
  liabilityCreated: boolean;
}

export interface ReferralCampaignBudget {
  id: string;
  campaignId: string;
  ruleVersionId: string;
  allocatedMinor: number;
  currency: string;
  spentMinor: number;
  createdAt: Date;
  exhaustedAt: Date | null;
}

export interface ReferralPartnerBalanceEvent {
  id: string;
  partnerId: string;
  rewardId: string;
  reversalId: string | null;
  eventType: string;
  amountMinor: number;
  currency: string;
  balanceAfterMinor: number;
  createdAt: Date;
}

export interface FundingRecord {
  id: string;
  version: number;
  amountMinor: number;
  currency: string;
  source: ReferralFundingSource;
  metadata: Record<string, unknown>;
}

export interface RewardCalculationInput {
  ruleVersion: ReferralRuleVersion;
  fundingRecord: FundingRecord;
  partnerId: string;
  campaignId: string | null;
  conversionId: string;
  conversionKind: ReferralConversionKind;
  idempotencyKey: string;
  existingPartnerRewardsMinor?: number;
  existingCampaignRewardsMinor?: number;
  existingCampaignBudgetSpentMinor?: number;
}

export interface RewardCalculationResult {
  rewardAmountMinor: number;
  rewardCurrency: string;
  holdUntil: Date | null;
  capped: boolean;
  capReason: string | null;
}

export interface ReversalCalculationInput {
  reward: ReferralReward;
  reason: ReferralReversalReason;
  refundAmountMinor?: number;
  fundingRecord?: FundingRecord;
  idempotencyKey: string;
}

export interface ReversalCalculationResult {
  reversalAmountMinor: number;
  reversalCurrency: string;
  liabilityCreated: boolean;
}
