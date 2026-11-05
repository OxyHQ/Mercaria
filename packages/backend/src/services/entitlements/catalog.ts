/**
 * What each capability IS, in code, and the sync that publishes it.
 *
 * ## Why the definitions are CODE and the plans are DATA
 *
 * A plan is a commercial POLICY somebody signs, so it is rows an operator
 * publishes and a version nobody can edit afterwards — the fee-schedule shape.
 * A capability definition is a statement about what this DEPLOYMENT has built,
 * which is a fact about the code and nothing else. Publishing it as data would
 * let somebody mark a capability `available` that no code implements, and the
 * only symptom would be a plan going on sale with a feature behind it that does
 * nothing.
 *
 * So the catalogue below is the source and {@link syncEntitlementDefinitions}
 * writes it into `entitlement_definitions`, where the plan entitlements' foreign
 * keys can reach it. `limit_kind` is frozen by trigger once the row exists, so
 * the sync can refresh COPY forever and can never reinterpret a plan somebody
 * already published against it.
 *
 * ## A capability is `postponed` until it is built, and that is the honest state
 *
 * Issue #89's binding constraint is that this work must not put an EXISTING
 * capability behind a plan. None of the eight existed when this domain shipped,
 * so each started `postponed` — which makes a paid plan naming it UNACTIVATABLE
 * (`activateMerchantPlan` refuses it), which is "do not sell a placeholder plan
 * whose advertised features are not implemented" holding as a mechanism rather
 * than as a promise. The day one of them ships, its entry here moves to
 * `available` in the same change as the feature.
 */

import type {
  EntitlementAvailability,
  EntitlementLimitKind,
  MerchantEntitlementCapability,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  upsertEntitlementDefinition,
  type EntitlementDefinitionRow,
} from '../../db/merchantPlans/planRepository.js';
import { invalidateAllMerchantEntitlements } from './resolve.js';

/** One capability, as this deployment defines it. */
export interface MerchantCapabilityDefinition {
  readonly key: MerchantEntitlementCapability;
  readonly name: string;
  readonly description: string;
  readonly limitKind: EntitlementLimitKind;
  readonly availability: EntitlementAvailability;
}

/**
 * The eight capabilities a plan may grant, and what each would mean.
 *
 * `Record<MerchantEntitlementCapability, …>` so a capability added to the tuple
 * without a definition is a COMPILE error rather than a key nothing describes.
 */
export const MERCHANT_CAPABILITY_CATALOG: Readonly<
  Record<MerchantEntitlementCapability, MerchantCapabilityDefinition>
> = {
  advanced_demand_analytics: {
    key: 'advanced_demand_analytics',
    name: 'Advanced demand analytics',
    // v1 is the checkout conversion report (`services/conversion-report.service.ts`,
    // `…/analytics/advanced/*`): order-sourced, because discovery collection is
    // off in production and no impression or search is tied to a store's
    // listing, so views and search terms are not in it and the copy says so.
    description:
      'Checkout conversion reporting from your own orders: checkouts started, paid, open and ' +
      'abandoned per listing with conversion rates, a daily or weekly trend compared with the ' +
      'previous period, best and worst converters, and CSV export. Views and search terms are ' +
      'not included.',
    limitKind: 'flag',
    availability: 'available',
  },
  competitive_price_analytics: {
    key: 'competitive_price_analytics',
    name: 'Competitive price analytics',
    description:
      "How a store's own live listings are priced against the other offers in their public " +
      'comparisons — how many other sellers, their lowest and median price, where the store sits ' +
      '(lowest, within 5%, at or below the median, above it) — and how that moved by day or week ' +
      'over 30 or 90 days, with a CSV export. Aggregates only, never another seller by name; it ' +
      'never changes a price. Free claimed-merchant competitiveness (#82) is unchanged.',
    limitKind: 'flag',
    // Built: `services/store-price-benchmark/`, `/admin/stores/:storeId/price-analytics`
    // and the dashboard's `tools/price-analytics`.
    availability: 'available',
  },
  automation_rules: {
    key: 'automation_rules',
    name: 'Automation rules',
    description:
      'Rules that act on your own catalogue and orders: when a listing’s stock falls to a ' +
      'threshold, notify the store owner or pause the listing (and put it back on sale once ' +
      'restocked); when an order is paid, notify the store owner or mark a shipped order ' +
      'as processing. The limit is the number of rules a store has.',
    limitKind: 'total',
    availability: 'available',
  },
  replenishment_planning: {
    key: 'replenishment_planning',
    name: 'Replenishment planning',
    description:
      "A demand forecast and purchase suggestions over the store's own multi-location " +
      'inventory: units sold over the last 28 and 90 days net of refunds, average daily ' +
      'demand, days of cover, projected stock-out date and a suggested order quantity per ' +
      'variant and location, from lead-time, cover and safety-stock settings, exportable as ' +
      'CSV. It suggests; it never places a supplier order.',
    limitKind: 'flag',
    availability: 'available',
  },
  advanced_merchandising_rules: {
    key: 'advanced_merchandising_rules',
    name: 'Advanced merchandising rules',
    description:
      "Rules for the store's own storefront page beyond the collections, sort orders, featured " +
      'shelves and discounts every store already has: a default order for the whole page or one ' +
      'collection (best-selling by units sold over a window, newest, or price, with in-stock ' +
      'first and pinned listings on top), and spotlight shelves for a collection, each on an ' +
      'optional start and end time. Rules affect only that store page, never search, ranking ' +
      'or any other surface. Each rule counts one against the limit.',
    limitKind: 'total',
    availability: 'available',
  },
  expanded_pos_registers: {
    key: 'expanded_pos_registers',
    name: 'Expanded POS registers',
    description:
      'Named point-of-sale registers beyond the one default register every location has: ' +
      "sales rung up on a named register carry its identity and appear in that register's " +
      'daily sales summary. The limit counts named registers; the default register, used by ' +
      'any number of devices, stays free.',
    limitKind: 'total',
    availability: 'available',
  },
  scheduled_exports: {
    key: 'scheduled_exports',
    name: 'Scheduled exports',
    description:
      'Recurring CSV exports of the store’s orders, products or customers — daily, weekly or ' +
      'monthly at a local hour — each kept downloadable for 30 days. Every scheduled run uses ' +
      'one export from the billing period’s allowance. A merchant may always export the same ' +
      'data on demand for free; what this adds is the SCHEDULE.',
    limitKind: 'per_period',
    availability: 'available',
  },
  ai_catalog_assistance: {
    key: 'ai_catalog_assistance',
    name: 'AI-assisted catalogue operations',
    description: 'Assisted catalogue authoring and enrichment, once #42 is grounded.',
    limitKind: 'per_period',
    availability: 'postponed',
  },
};

/**
 * Publish the code catalogue into `entitlement_definitions`.
 *
 * Idempotent: an upsert per capability that refreshes the COPY and leaves the
 * frozen contract columns alone. Called from the operator surface rather than at
 * boot, so it is an act somebody takes and can see the result of — and so a
 * deployment that shipped a capability but never synced it FAILS CLOSED, with
 * the definition still `postponed` and every check refusing.
 */
export async function syncEntitlementDefinitions(
  db: DatabaseOrTransaction,
): Promise<EntitlementDefinitionRow[]> {
  const rows: EntitlementDefinitionRow[] = [];
  for (const definition of Object.values(MERCHANT_CAPABILITY_CATALOG)) {
    rows.push(
      await upsertEntitlementDefinition(db, {
        capabilityKey: definition.key,
        name: definition.name,
        description: definition.description,
        limitKind: definition.limitKind,
        availability: definition.availability,
      }),
    );
  }
  // Availability is part of every store's resolution, so a sync changes what
  // every one of them answers.
  invalidateAllMerchantEntitlements();
  return rows;
}
