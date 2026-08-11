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
 * ## Every capability is `postponed`, and that is the honest state
 *
 * Issue #89's binding constraint is that this work must not put an EXISTING
 * capability behind a plan. None of the eight below exists, so every one is
 * `postponed` — which makes a paid plan naming any of them UNACTIVATABLE
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
    description:
      'Demand, conversion and search-intent reporting beyond the aggregate store summary every ' +
      'merchant gets for free.',
    limitKind: 'flag',
    availability: 'postponed',
  },
  competitive_price_analytics: {
    key: 'competitive_price_analytics',
    name: 'Competitive price analytics',
    description:
      "How a merchant's own offers are priced against the rest of the comparison, over time.",
    limitKind: 'flag',
    availability: 'postponed',
  },
  automation_rules: {
    key: 'automation_rules',
    name: 'Automation rules',
    description: 'Rule-driven automation of catalogue and order operations.',
    limitKind: 'total',
    availability: 'postponed',
  },
  replenishment_planning: {
    key: 'replenishment_planning',
    name: 'Replenishment planning',
    description: 'Forecasting and purchase suggestions over multi-location inventory.',
    limitKind: 'flag',
    availability: 'postponed',
  },
  advanced_merchandising_rules: {
    key: 'advanced_merchandising_rules',
    name: 'Advanced merchandising rules',
    description:
      'Merchandising rules beyond the manual collections and discounts every store already has.',
    limitKind: 'total',
    availability: 'postponed',
  },
  expanded_pos_registers: {
    key: 'expanded_pos_registers',
    name: 'Expanded POS registers',
    description: 'Point-of-sale capacity beyond one register per location.',
    limitKind: 'total',
    availability: 'postponed',
  },
  scheduled_exports: {
    key: 'scheduled_exports',
    name: 'Scheduled exports',
    description:
      'Recurring, scheduled exports and outbound integrations. A merchant may always export ' +
      'their own data on demand — that is ungateable — so what this adds is the SCHEDULE.',
    limitKind: 'per_period',
    availability: 'postponed',
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
