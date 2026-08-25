import type { Money } from "@mercaria/shared-types";

/**
 * Rounding mode for referral calculations.
 * Uses banker's rounding (round half to even) for consistency.
 */
export const ROUNDING_MODE = "half_even" as const;

/**
 * Calculate percentage reward from funding amount.
 * Uses integer arithmetic with basis points (10000 = 100%).
 * Rounds once at the end using banker's rounding.
 */
export function calculatePercentageReward(
  fundingAmountMinor: number,
  basisPoints: number
): number {
  if (basisPoints < 0 || basisPoints > 10000) {
    throw new Error("Basis points must be between 0 and 10000");
  }
  if (fundingAmountMinor < 0) {
    throw new Error("Funding amount cannot be negative");
  }
  // Multiply first to preserve precision, then divide with rounding
  const raw = fundingAmountMinor * basisPoints;
  return Math.round(raw / 10000);
}

/*** Calculate fixed reward, capped at funding amount.
 */
export function calculateFixedReward(
  fixedAmountMinor: number,
  fundingAmountMinor: number
): number {
  if (fixedAmountMinor < 0) {
    throw new Error("Fixed amount cannot be negative");
  }
  if (fundingAmountMinor < 0) {
    throw new Error("Funding amount cannot be negative");
  }
  return Math.min(fixedAmountMinor, fundingAmountMinor);
}

/*** Apply per-conversion caps and minimums.
 */
export function applyConversionCaps(
  rewardMinor: number,
  capMinor: number | null,
  minMinor: number | null
): { amount: number; capped: boolean; capReason: string | null } {
  let amount = rewardMinor;
  let capped = false;
  let capReason: string | null = null;

  if (capMinor !== null && amount > capMinor) {
    amount = capMinor;
    capped = true;
    capReason = "per_conversion_cap";
  }

  if (minMinor !== null && amount < minMinor) {
    amount = 0;
    capped = true;
    capReason = capReason ? `${capReason},below_minimum` : "below_minimum";
  }

  return { amount, capped, capReason };
}

/*** Apply partner-level cap.
 */
export function applyPartnerCap(
  rewardMinor: number,
  partnerCapMinor: number | null,
  existingPartnerRewardsMinor: number
): { amount: number; capped: boolean; capReason: string | null } {
  if (partnerCapMinor === null) {
    return { amount: rewardMinor, capped: false, capReason: null };
  }

  const available = partnerCapMinor - existingPartnerRewardsMinor;
  if (available <= 0) {
    return { amount: 0, capped: true, capReason: "partner_cap_exhausted" };
  }

  if (rewardMinor > available) {
    return { amount: available, capped: true, capReason: "partner_cap" };
  }

  return { amount: rewardMinor, capped: false, capReason: null };
}

/*** Apply campaign-level cap and budget.
 */
export function applyCampaignCap(
  rewardMinor: number,
  campaignCapMinor: number | null,
  existingCampaignRewardsMinor: number,
  campaignBudget: { allocatedMinor: number; spentMinor: number } | null
): { amount: number; capped: boolean; capReason: string | null } {
  let amount = rewardMinor;
  let capped = false;
  let capReason: string | null = null;

  if (campaignCapMinor !== null) {
    const available = campaignCapMinor - existingCampaignRewardsMinor;
    if (available <= 0) {
      return { amount: 0, capped: true, capReason: "campaign_cap_exhausted" };
    }
    if (amount > available) {
      amount = available;
      capped = true;
      capReason = "campaign_cap";
    }
  }

  if (campaignBudget !== null) {
    const budgetAvailable = campaignBudget.allocatedMinor - campaignBudget.spentMinor;
    if (budgetAvailable <= 0) {
      return { amount: 0, capped: true, capReason: "campaign_budget_exhausted" };
    }
    if (amount > budgetAvailable) {
      amount = budgetAvailable;
      capped = true;
      capReason = capReason ? `${capReason},campaign_budget` : "campaign_budget";
    }
  }

  return { amount, capped, capReason };
}

/*** Determine reward currency based on currency behavior.
 */
export function determineRewardCurrency(
  fundingCurrency: string,
  currencyBehavior: ReferralCurrencyBehavior,
  currencyCode: string | null,
  partnerCurrency: string
): string {
  switch (currencyBehavior) {
    case "funding_currency":
      return fundingCurrency;
    case "partner_currency":
      return partnerCurrency;
    case "fixed_usd":
      if (!currencyCode) {
        throw new Error("currencyCode required for fixed_usd behavior");
      }
      return currencyCode;
    default:
      return fundingCurrency;
  }
}

/*** Convert amount between currencies using a fixed rate.
 * In production, this would use a proper FX service.
 * For now, assumes 1:1 for same currency, throws for different.
 */
export function convertCurrency(
  amountMinor: number,
  fromCurrency: string,
  toCurrency: string,
  rate?: number
): number {
  if (fromCurrency === toCurrency) {
    return amountMinor;
  }
  if (rate === undefined) {
    throw new Error(
      `FX rate required for ${fromCurrency} -> ${toCurrency}`
    );
  }
  return Math.round(amountMinor * rate);
}

/*** Calculate hold release timestamp.
 */
export function calculateHoldUntil(
  policy: ReferralHoldPolicy,
  config: Record<string, unknown> | null,
  createdAt: Date
): Date | null {
  switch (policy) {
    case "none":
      return null;
    case "fixed_days": {
      const days = (config?.days as number) ?? 30;
      const date = new Date(createdAt);
      date.setDate(date.getDate() + days);
      return date;
    }
    case "refund_window": {
      const days = (config?.days as number) ?? 60;
      const date = new Date(createdAt);
      date.setDate(date.getDate() + days);
      return date;
    }
    case "custom":
      // Custom logic would be implemented per campaign
      return null;
    default:
      return null;
  }
}
