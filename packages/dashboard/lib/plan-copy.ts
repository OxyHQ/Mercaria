import type { MerchantEntitlementCapability } from '@mercaria/shared-types';

/**
 * The plan screen's localised copy for what the SERVER sells.
 *
 * The catalogue (`GET /plan/catalog`) is the authority on which plans exist,
 * what they cost and what each includes; its `name` is the brand name and is
 * shown as-is. Summaries and capability names are product copy, so they are
 * translated here, keyed by the server's own `planKey` and capability key — a
 * plan the server sells that has no entry falls back to the server's summary.
 *
 * KEYS rather than sentences (#398): module scope runs before the locale store
 * rehydrates.
 */
export const PLAN_SUMMARY_KEYS: Readonly<Record<string, string>> = {
  go: 'settings.plan.design.goSummary',
  creator: 'settings.plan.design.creatorSummary',
  plus: 'settings.plan.design.plusSummary',
  ultra: 'settings.plan.design.ultraSummary',
};

export const CAPABILITY_COPY_KEYS = {
  automation_rules: 'settings.plan.design.automation',
  scheduled_exports: 'settings.plan.design.exports',
  advanced_demand_analytics: 'settings.plan.design.analytics',
  advanced_merchandising_rules: 'settings.plan.design.merchandising',
  replenishment_planning: 'settings.plan.design.replenishment',
  competitive_price_analytics: 'settings.plan.design.pricing',
  expanded_pos_registers: 'settings.plan.design.registers',
  ai_catalog_assistance: 'settings.plan.design.assistance',
} as const satisfies Record<MerchantEntitlementCapability, string>;
