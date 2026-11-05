import {
  Calculator,
  CalendarClock,
  LayoutList,
  Scale,
  TrendingUp,
  Workflow,
  type LucideIcon,
} from 'lucide-react-native';
import type { RoutePath } from 'expo-router';
import type { MerchantEntitlementCapability, StorePermission } from '@mercaria/shared-types';

/**
 * The paid tools a Mercaria plan unlocks, as the dashboard navigates to them.
 *
 * One entry per IMPLEMENTED capability, added in the same change as the tool's
 * screen (`app/(app)/tools/…`). The Tools hub lists these and gates each with
 * the store's capabilities; a capability with no entry here has no screen, and
 * the server's catalogue will not sell a plan naming one that is postponed.
 *
 * KEYS rather than sentences (#398): this module is evaluated at import, before
 * the locale store rehydrates.
 */
export interface PlanTool {
  capability: MerchantEntitlementCapability;
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  /** Typed against the real route tree, so renaming a screen fails the build. */
  href: RoutePath;
  /** The store permission the tool's screen requires. */
  permission: StorePermission;
}

export const PLAN_TOOLS: readonly PlanTool[] = [
  {
    capability: 'competitive_price_analytics',
    labelKey: 'priceAnalytics.toolLabel',
    descriptionKey: 'priceAnalytics.toolDescription',
    icon: Scale,
    href: '/tools/price-analytics',
    // "What is the market doing around my products" (`STORE_PERMISSIONS`), the
    // permission the API route requires.
    permission: 'analytics:read',
  },
  {
    capability: 'expanded_pos_registers',
    labelKey: 'posRegisters.title',
    descriptionKey: 'posRegisters.toolDescription',
    icon: Calculator,
    href: '/tools/pos-registers',
    permission: 'locations:write',
  },
  {
    capability: 'scheduled_exports',
    labelKey: 'scheduledExports.title',
    descriptionKey: 'scheduledExports.toolDescription',
    icon: CalendarClock,
    href: '/tools/scheduled-exports',
    // Each schedule is checked against its own dataset's read permission; the
    // hub row shows to anyone who reads the store's orders.
    permission: 'orders:read',
  },
  {
    capability: 'advanced_demand_analytics',
    labelKey: 'demandAnalytics.label',
    descriptionKey: 'demandAnalytics.description',
    icon: TrendingUp,
    href: '/tools/demand-analytics',
    permission: 'stats:read',
  },
  {
    capability: 'automation_rules',
    labelKey: 'automations.title',
    descriptionKey: 'automations.toolDescription',
    icon: Workflow,
    href: '/tools/automations',
    // What a rule does is catalogue work (pause, republish) or a notification;
    // a rule that moves an order additionally needs `orders:fulfill`, which the
    // server checks against the rule's action.
    permission: 'products:write',
  },
  {
    capability: 'advanced_merchandising_rules',
    labelKey: 'merchandising.title',
    descriptionKey: 'merchandising.toolDescription',
    icon: LayoutList,
    href: '/tools/merchandising',
    permission: 'products:read',
  },
];
