/**
 * The REVIEWED merchant plan catalogue — what Mercaria sells, at what price,
 * with what limits (#89; the owner's decision of 2026-11-05 to sell every plan,
 * at economical prices, with the remaining choices left to engineering).
 *
 * This file is the INPUT to `scripts/publish-merchant-plans.ts`, which makes it
 * exist as Orbit catalog rows on Mercaria's Peable merchant and as immutable
 * `merchant_plans` versions. It authorizes nothing on its own: a version is on
 * sale only once that script activated it, and activation still refuses any
 * capability the deployment has not implemented.
 *
 * ## Immutable once published
 *
 * Every (plan key, version) here becomes an active row whose prices,
 * entitlements, terms and grace are frozen by trigger. A change — a price, a
 * limit, a capability — is a NEW version number with its own Orbit prices
 * (`lookup_key` carries the version), never an edit of a published one. The
 * publish script refuses an existing version that differs from this file.
 *
 * The rationale for every number is in docs/merchant-plans.md §4–§5.
 */

import type {
  BillingInterval,
  CurrencyCode,
  MerchantEntitlementCapability,
} from '@mercaria/shared-types';
import { CURRENT_MERCHANT_PLAN_TERMS_VERSION } from './terms/merchant-plan-terms.js';

export interface CataloguePrice {
  readonly interval: BillingInterval;
  readonly currency: CurrencyCode;
  /** Minor units, TAX-EXCLUSIVE. */
  readonly amount: number;
}

export interface CatalogueEntitlement {
  readonly capability: MerchantEntitlementCapability;
  /** NULL for a `flag` capability (and would mean unlimited for a quantified one). */
  readonly limit: number | null;
}

export interface CataloguePlan {
  readonly planKey: string;
  readonly version: number;
  readonly name: string;
  readonly summary: string;
  readonly entitlements: readonly CatalogueEntitlement[];
  readonly prices: readonly CataloguePrice[];
}

/** No trial: a native subscription checkout cannot start one (`trial_not_supported`). */
export const PLAN_TRIAL_DAYS = 0;

/**
 * Days a paid plan's tools keep working after a failed renewal.
 *
 * Peable's default dunning (`billing_settings.retry_schedule_days` `{1,3,5,7}`,
 * each delay counted from the previous attempt, then `final_action: cancel`)
 * makes its last retry 16 days after the first failure. Sixteen days of grace
 * keeps the tools working for exactly as long as the rail is still trying, so a
 * merchant whose card succeeds on the last retry never loses a day.
 */
export const PLAN_GRACE_PERIOD_DAYS = 16;

export const PLAN_TERMS_VERSION = CURRENT_MERCHANT_PLAN_TERMS_VERSION;

/** One monthly amount, in USD and EUR, monthly and annual (ten months: two free). */
function ladder(monthlyMinor: number): CataloguePrice[] {
  return (['USD', 'EUR'] as const).flatMap((currency) => [
    { interval: 'monthly' as const, currency, amount: monthlyMinor },
    { interval: 'annual' as const, currency, amount: monthlyMinor * 10 },
  ]);
}

export const FREE_PLAN = {
  planKey: 'free',
  version: 1,
  name: 'Free',
  summary: 'Everything a store needs to sell on Mercaria, for every store, always.',
} as const;

export const PAID_PLANS: readonly CataloguePlan[] = [
  {
    planKey: 'go',
    version: 1,
    name: 'Mercaria Go',
    summary: 'Automate repeat tasks and get your data delivered on a schedule.',
    entitlements: [
      { capability: 'automation_rules', limit: 10 },
      { capability: 'scheduled_exports', limit: 60 },
    ],
    prices: ladder(499),
  },
  {
    planKey: 'creator',
    version: 1,
    name: 'Mercaria Creator',
    summary:
      'Run drops and merch launches: automation, scheduled merchandising and demand insight.',
    entitlements: [
      { capability: 'automation_rules', limit: 25 },
      { capability: 'scheduled_exports', limit: 150 },
      { capability: 'advanced_demand_analytics', limit: null },
      { capability: 'advanced_merchandising_rules', limit: 20 },
    ],
    prices: ladder(999),
  },
  {
    planKey: 'plus',
    version: 1,
    name: 'Mercaria Plus',
    summary: 'Plan stock across locations and run an established shop.',
    entitlements: [
      { capability: 'automation_rules', limit: 50 },
      { capability: 'scheduled_exports', limit: 300 },
      { capability: 'advanced_demand_analytics', limit: null },
      { capability: 'advanced_merchandising_rules', limit: 20 },
      { capability: 'replenishment_planning', limit: null },
    ],
    prices: ladder(1499),
  },
  {
    planKey: 'ultra',
    version: 1,
    name: 'Mercaria Ultra',
    summary: 'Every Mercaria tool, with competitive pricing insight and more POS registers.',
    entitlements: [
      { capability: 'automation_rules', limit: 200 },
      { capability: 'scheduled_exports', limit: 1500 },
      { capability: 'advanced_demand_analytics', limit: null },
      { capability: 'advanced_merchandising_rules', limit: 100 },
      { capability: 'replenishment_planning', limit: null },
      { capability: 'competitive_price_analytics', limit: null },
      { capability: 'expanded_pos_registers', limit: 20 },
    ],
    prices: ladder(2499),
  },
];

/** The Orbit price `lookup_key` for one catalogue price — stable, versioned. */
export function planPriceLookupKey(plan: CataloguePlan, price: CataloguePrice): string {
  return `mercaria_${plan.planKey}_v${plan.version}_${price.interval}_${price.currency.toLowerCase()}`;
}

/** The Orbit product's identity, in `metadata.mercaria_plan`. */
export const planProductKey = (plan: CataloguePlan) => `${plan.planKey}@${plan.version}`;

/** The Orbit entitlement feature for one capability, shared by every plan that grants it. */
export const capabilityFeatureLookupKey = (capability: MerchantEntitlementCapability) =>
  `mercaria:${capability}`;
