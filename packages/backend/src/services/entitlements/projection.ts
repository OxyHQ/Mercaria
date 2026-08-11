/**
 * What a merchant SEES — the plan comparison and their own plan screen.
 *
 * ## The comparison never advertises something that does not exist
 *
 * {@link listMerchantPlanCatalog} emits only ACTIVE versions, and only
 * capabilities whose definition is `available`. Activation already refuses a
 * version naming a postponed capability, so the filter here is the second layer
 * over the same rule — it catches the one case activation cannot, a definition
 * WITHDRAWN to `postponed` after the version went live. Issue #89: "Plan
 * comparison with exact current capabilities", and "do not sell a placeholder
 * plan whose advertised features are not implemented".
 *
 * ## Nothing here is a decision, and that is issue #89 entitlement rule 4
 *
 * Every field is a RESULT the server computed. `billingAvailable` says whether
 * an upgrade could be started on this deployment so a client can hide a button
 * it would only be refused for pressing; it is not an input to anything, and the
 * server re-decides on every write regardless of what a client believed. A
 * client may hide or explain, and it can never grant.
 *
 * ## No provider id crosses this boundary
 *
 * The status view names no customer, subscription, price or invoice id in any
 * form — the `provider_accounts` projection rule (#46), for the same reason: an
 * id a merchant holds is one a support conversation eventually asks them to read
 * out, and their key space changes between test and live mode anyway.
 */

import type {
  BillingInterval,
  MerchantEntitlementView,
  MerchantPlanCapabilityView,
  MerchantPlanCatalogEntry,
  MerchantPlanPriceView,
  MerchantPlanStatusView,
  MerchantSubscriptionView,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  listActiveMerchantPlans,
  listEntitlementDefinitions,
  listMerchantPlanPrices,
  listPlanEntitlements,
  findMerchantPlanById,
  type EntitlementDefinitionRow,
} from '../../db/merchantPlans/planRepository.js';
import {
  findBillingCustomer,
  findSubscriptionByStore,
} from '../../db/merchantPlans/subscriptionRepository.js';
import { listEntitlementUsage } from '../../db/merchantPlans/usageRepository.js';
import { getBillingProvider } from '../billing/provider.js';
import { entitlementPeriodKey } from './capabilities.js';
import { resolveMerchantEntitlements } from './resolve.js';

/** Which billing MODE this deployment's prices are published in. */
function billingLivemode(): boolean {
  return config.payments.stripe.livemode;
}

/**
 * Every plan a merchant may compare, with exact current capabilities.
 *
 * A plan whose entitlements include a postponed capability is emitted WITHOUT
 * it rather than being hidden entirely: the rest of what it offers is still
 * true, and hiding the plan would leave a subscribed merchant looking at a
 * comparison their own plan is absent from.
 */
export async function listMerchantPlanCatalog(
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantPlanCatalogEntry[]> {
  const plans = await listActiveMerchantPlans(db);
  if (plans.length === 0) return [];

  const planIds = plans.map((plan) => plan.id);
  const [prices, entitlements, definitions] = await Promise.all([
    listMerchantPlanPrices(db, { planIds, livemode: billingLivemode() }),
    listPlanEntitlements(db, planIds),
    listEntitlementDefinitions(db),
  ]);

  const byKey = new Map<string, EntitlementDefinitionRow>(
    definitions.map((definition) => [definition.capabilityKey, definition]),
  );

  return plans.map((plan) => {
    const planPrices: MerchantPlanPriceView[] = prices
      .filter((price) => price.planId === plan.id)
      .map((price) => ({
        currency: price.unitPriceCurrency,
        interval: price.interval,
        unitPrice: { amount: price.unitPriceAmount, currency: price.unitPriceCurrency },
      }));

    const planCapabilities: MerchantPlanCapabilityView[] = entitlements
      .filter((entitlement) => entitlement.planId === plan.id)
      .flatMap((entitlement) => {
        const definition = byKey.get(entitlement.capabilityKey);
        if (!definition || definition.availability !== 'available') return [];
        return [
          {
            key: entitlement.capabilityKey,
            name: definition.name,
            description: definition.description,
            limitKind: definition.limitKind,
            availability: definition.availability,
            limit: entitlement.limitValue,
          },
        ];
      });

    return {
      planId: plan.id,
      planKey: plan.planKey,
      version: plan.version,
      tier: plan.tier,
      name: plan.name,
      summary: plan.summary,
      termsVersion: plan.termsVersion,
      trialDays: plan.trialDays,
      gracePeriodDays: plan.gracePeriodDays,
      prices: planPrices,
      capabilities: planCapabilities,
    };
  });
}

/**
 * One store's plan screen — issue #89 UX 3 and 5.
 *
 * `graceExpiresAt` is surfaced so past-due messaging can say exactly when paid
 * extras stop, which is the honest version of a warning: #89 UX 5 asks that it
 * "does not threaten existing order access", and it cannot, because order access
 * is not an entitlement and has no key to be withdrawn.
 */
export async function buildMerchantPlanStatus(input: {
  storeId: string;
  at?: Date;
}): Promise<MerchantPlanStatusView> {
  const at = input.at ?? new Date();
  const db = getDb();
  const resolved = await resolveMerchantEntitlements(input.storeId, { at, fresh: true, db });
  const subscription = await findSubscriptionByStore(db, input.storeId);

  const provider = getBillingProvider('stripe');
  const customer = provider
    ? await findBillingCustomer(db, {
        storeId: input.storeId,
        provider: provider.id,
        livemode: provider.livemode,
      })
    : undefined;

  const periodKeys = new Set<string>();
  for (const entitlement of resolved.entitlements.values()) {
    if (entitlement.limitKind === 'flag') continue;
    periodKeys.add(entitlementPeriodKey(entitlement.limitKind, at, resolved.currentPeriodStart));
  }
  const counters = await listEntitlementUsage(db, {
    storeId: input.storeId,
    periodKeys: [...periodKeys],
  });
  const usedByCapability = new Map<string, number>(
    counters.map((counter) => [counter.capabilityKey, counter.used]),
  );

  const entitlements: MerchantEntitlementView[] = [...resolved.entitlements.values()]
    .filter((entitlement) => resolved.availability.get(entitlement.capability) === 'available')
    .map((entitlement) => ({
      capability: entitlement.capability,
      limitKind: entitlement.limitKind,
      limit: entitlement.limit,
      source: entitlement.source,
      used: usedByCapability.get(entitlement.capability) ?? 0,
    }));

  const subscriptionView = subscription
    ? await buildSubscriptionView(db, subscription.planId, {
        status: subscription.status,
        interval: subscription.interval,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        trialEndsAt: subscription.trialEndsAt,
        graceExpiresAt: subscription.graceExpiresAt,
        cancellationBehavior: subscription.cancellationBehavior,
        cancelAt: subscription.cancelAt,
        acceptedTermsVersion: subscription.acceptedTermsVersion,
      })
    : null;

  return {
    storeId: input.storeId,
    subscription: subscriptionView,
    effectivePlanKey: resolved.planKey,
    effectivePlanVersion: resolved.planVersion,
    entitlements,
    billingAvailable: config.merchantBilling.enabled && provider !== undefined,
    portalAvailable:
      config.merchantBilling.enabled && provider !== undefined && customer !== undefined,
  };
}

/** The subscription half of the status view, with the plan's own names attached. */
async function buildSubscriptionView(
  db: DatabaseOrTransaction,
  planId: string,
  subscription: {
    status: MerchantSubscriptionView['status'];
    interval: BillingInterval;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    trialEndsAt: Date | null;
    graceExpiresAt: Date | null;
    cancellationBehavior: MerchantSubscriptionView['cancellationBehavior'];
    cancelAt: Date | null;
    acceptedTermsVersion: string;
  },
): Promise<MerchantSubscriptionView> {
  const plan = await findMerchantPlanById(db, planId);
  return {
    status: subscription.status,
    planKey: plan?.planKey ?? '',
    planVersion: plan?.version ?? 0,
    planName: plan?.name ?? '',
    interval: subscription.interval,
    currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    graceExpiresAt: subscription.graceExpiresAt?.toISOString() ?? null,
    cancellationBehavior: subscription.cancellationBehavior,
    cancelAt: subscription.cancelAt?.toISOString() ?? null,
    acceptedTermsVersion: subscription.acceptedTermsVersion,
  };
}
