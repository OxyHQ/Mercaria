import type { MerchantEntitlementCapability } from '@mercaria/shared-types';

/** Product designs, not published billing plans or grants. Nothing here authorizes checkout. */
export const MERCHANT_PLAN_DESIGNS = [
  { key: 'go', nameKey: 'settings.plan.design.go', summaryKey: 'settings.plan.design.goSummary', capabilities: ['automation_rules', 'scheduled_exports'] },
  { key: 'plus', nameKey: 'settings.plan.design.plus', summaryKey: 'settings.plan.design.plusSummary', capabilities: ['automation_rules', 'scheduled_exports', 'advanced_demand_analytics', 'advanced_merchandising_rules', 'replenishment_planning'] },
  { key: 'creator', nameKey: 'settings.plan.design.creator', summaryKey: 'settings.plan.design.creatorSummary', capabilities: ['automation_rules', 'scheduled_exports', 'advanced_demand_analytics', 'advanced_merchandising_rules', 'ai_catalog_assistance'] },
  { key: 'ultra', nameKey: 'settings.plan.design.ultra', summaryKey: 'settings.plan.design.ultraSummary', capabilities: ['automation_rules', 'scheduled_exports', 'advanced_demand_analytics', 'advanced_merchandising_rules', 'replenishment_planning', 'competitive_price_analytics', 'expanded_pos_registers', 'ai_catalog_assistance'] },
] as const satisfies readonly {
  key: string;
  nameKey: string;
  summaryKey: string;
  capabilities: readonly MerchantEntitlementCapability[];
}[];

export const MERCHANT_PLAN_DESIGN_COPY = {
  automation_rules: 'settings.plan.design.automation',
  scheduled_exports: 'settings.plan.design.exports',
  advanced_demand_analytics: 'settings.plan.design.analytics',
  advanced_merchandising_rules: 'settings.plan.design.merchandising',
  replenishment_planning: 'settings.plan.design.replenishment',
  competitive_price_analytics: 'settings.plan.design.pricing',
  expanded_pos_registers: 'settings.plan.design.registers',
  ai_catalog_assistance: 'settings.plan.design.assistance',
} as const satisfies Record<MerchantEntitlementCapability, string>;
