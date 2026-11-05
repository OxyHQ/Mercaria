/**
 * Make the reviewed plan catalogue (`plan-catalogue.ts`) exist — as Orbit
 * catalog rows on Mercaria's Peable merchant, and as active `merchant_plans`
 * versions bound to those rows. Mirrors oxy's `sync-peable-catalogue.ts`.
 *
 * Idempotent, and every write is found by its stable key first:
 * - an Orbit PRODUCT per plan version, by `metadata['mercaria_plan']`;
 * - an Orbit PRICE per (version, cadence, currency), by `lookup_key`; an
 *   existing price that differs from the catalogue is a REFUSAL (Orbit prices
 *   never change what they charge, and neither do plan versions);
 * - an Orbit entitlement FEATURE per capability (`mercaria:<capability>`),
 *   attached to every product that grants it — so Peable's own entitlements
 *   answer "has this capability" the same way Mercaria does;
 * - a Mercaria plan VERSION per catalogue plan, drafted with its entitlements
 *   and prices and then activated — where activation still refuses any
 *   capability this deployment has not implemented.
 *
 * Without `apply` it reads only, and answers the actions it WOULD take.
 */

import type { Peable } from '@peable.to/sdk';
import type { MerchantEntitlementCapability } from '@mercaria/shared-types';
import type { Database } from '../../db/postgres.js';
import {
  activateMerchantPlan,
  findActiveFreeMerchantPlan,
  insertMerchantPlan,
  insertMerchantPlanPrice,
  insertPlanEntitlement,
  listMerchantPlanPrices,
  listMerchantPlans,
  listPlanEntitlements,
  type MerchantPlanRow,
} from '../../db/merchantPlans/planRepository.js';
import {
  MERCHANT_CAPABILITY_CATALOG,
  syncEntitlementDefinitions,
} from '../entitlements/catalog.js';
import {
  FREE_PLAN,
  PAID_PLANS,
  PLAN_GRACE_PERIOD_DAYS,
  PLAN_TERMS_VERSION,
  PLAN_TRIAL_DAYS,
  capabilityFeatureLookupKey,
  planPriceLookupKey,
  planProductKey,
  type CataloguePlan,
} from './plan-catalogue.js';
import {
  findMerchantPlanTerms,
  merchantPlanTermsPlaceholders,
} from './terms/merchant-plan-terms.js';

export type CatalogueSyncClient = Pick<
  Peable,
  'merchants' | 'products' | 'prices' | 'entitlements' | 'billingSettings'
>;

export interface CatalogueSyncOptions {
  /** The Peable merchant the workload must own (`merch_…`). */
  merchantId: string;
  /** The mode this deployment bills in; the merchant must be in it. */
  livemode: boolean;
  apply: boolean;
  /** Recorded as `created_by` / `approved_by` on the versions. */
  actor: string;
  /** Plans to publish; defaults to the whole catalogue. */
  plans?: readonly CataloguePlan[];
  /**
   * Whether to publish the free version and sync the capability definitions
   * (default true). Tests turn both off: the active free version is a GLOBAL
   * unique row and the definitions are shared by every parallel test file.
   */
  includeSharedRows?: boolean;
}

export interface CatalogueSyncResult {
  apply: boolean;
  merchantId: string;
  livemode: boolean;
  /** Placeholders the terms version the plans name still carries (owner to complete). */
  termsPlaceholders: string[];
  /** Peable's dunning schedule, read so the grace period can be checked against it. */
  dunningRetryScheduleDays: readonly number[] | null;
  actions: string[];
  products: { planKey: string; version: number; productId: string | null }[];
  prices: { lookupKey: string; priceId: string | null }[];
  versions: { planKey: string; version: number; id: string | null; status: string }[];
}

const MONTHS = { monthly: 'month', annual: 'year' } as const;

/** A refusal that names the row and why; safe to print. */
export class CatalogueDrift extends Error {}

export async function syncMerchantPlanCatalogue(
  client: CatalogueSyncClient,
  db: Database,
  options: CatalogueSyncOptions,
): Promise<CatalogueSyncResult> {
  const plans = options.plans ?? PAID_PLANS;
  const merchant = await client.merchants.retrieve();
  if (merchant.id !== options.merchantId) {
    throw new CatalogueDrift(
      `The workload's Peable merchant is ${merchant.id}, not ${options.merchantId}.`,
    );
  }
  if (merchant.livemode !== options.livemode) {
    throw new CatalogueDrift(
      `The Peable merchant is ${merchant.livemode ? 'live' : 'test'}; this deployment bills in ${options.livemode ? 'live' : 'test'} mode.`,
    );
  }
  for (const plan of plans) {
    for (const entitlement of plan.entitlements) {
      const kind = MERCHANT_CAPABILITY_CATALOG[entitlement.capability].limitKind;
      if (kind === 'flag' && entitlement.limit !== null) {
        throw new CatalogueDrift(
          `${plan.planKey}: ${entitlement.capability} is a flag and takes no limit.`,
        );
      }
    }
  }

  const result: CatalogueSyncResult = {
    apply: options.apply,
    merchantId: merchant.id,
    livemode: merchant.livemode,
    termsPlaceholders: merchantPlanTermsPlaceholders(
      findMerchantPlanTerms(PLAN_TERMS_VERSION) ??
        (() => {
          throw new CatalogueDrift(`No terms text exists for ${PLAN_TERMS_VERSION}.`);
        })(),
    ),
    dunningRetryScheduleDays: null,
    actions: [],
    products: [],
    prices: [],
    versions: [],
  };
  try {
    const settings = await client.billingSettings.retrieve();
    result.dunningRetryScheduleDays = settings.dunning.retry_schedule_days;
  } catch {
    // Informational only: the grace period is the catalogue's, and a merchant
    // without settings yet runs Peable's defaults.
  }

  // ---- Orbit: features, products, prices --------------------------------------
  const featureIds = new Map<MerchantEntitlementCapability, string | undefined>();
  const ensureFeature = async (capability: MerchantEntitlementCapability) => {
    if (featureIds.has(capability)) return featureIds.get(capability);
    const lookupKey = capabilityFeatureLookupKey(capability);
    const found = await client.entitlements.features.list({ lookup_key: lookupKey });
    let id = found.data.find((feature) => feature.lookup_key === lookupKey)?.id;
    if (!id) {
      result.actions.push(`create feature ${lookupKey}`);
      if (options.apply) {
        id = (
          await client.entitlements.features.create(
            { lookup_key: lookupKey, name: MERCHANT_CAPABILITY_CATALOG[capability].name },
            { idempotencyKey: `mercaria-plan-feature:${lookupKey}` },
          )
        ).id;
      }
    }
    featureIds.set(capability, id);
    return id;
  };

  const orbitPrice = new Map<string, string | null>();
  for (const plan of plans) {
    const productKey = planProductKey(plan);
    // The SDK's search answer types as `never` under this package's non-strict
    // compiler settings (its conditional type cannot infer through them), so
    // the one field read here is named explicitly.
    const products = (await client.products.search({
      query: `metadata['mercaria_plan']:'${productKey}'`,
      limit: 2,
    })) as unknown as { data: { id: string }[] };
    if (products.data.length > 1)
      throw new CatalogueDrift(`Orbit product ${productKey} is ambiguous.`);
    let productId: string | undefined = products.data[0]?.id;
    if (!productId) {
      result.actions.push(`create product ${productKey}`);
      if (options.apply) {
        productId = (
          await client.products.create(
            {
              name: plan.name,
              description: plan.summary,
              metadata: { mercaria_plan: productKey, mercaria_plan_key: plan.planKey },
            },
            { idempotencyKey: `mercaria-plan-product:${productKey}` },
          )
        ).id;
      }
    }
    result.products.push({
      planKey: plan.planKey,
      version: plan.version,
      productId: productId ?? null,
    });

    const attached = productId
      ? new Set(
          (await client.entitlements.productFeatures.list(productId)).data.map(
            (value) => value.entitlement_feature.id,
          ),
        )
      : new Set<string>();
    for (const entitlement of plan.entitlements) {
      const featureId = await ensureFeature(entitlement.capability);
      if (featureId && attached.has(featureId)) continue;
      result.actions.push(
        `attach ${capabilityFeatureLookupKey(entitlement.capability)} to ${productKey}`,
      );
      if (options.apply && productId && featureId) {
        await client.entitlements.productFeatures.attach(
          productId,
          { entitlement_feature: featureId },
          { idempotencyKey: `mercaria-plan-attach:${productKey}:${entitlement.capability}` },
        );
      }
    }

    const lookupKeys = plan.prices.map((price) => planPriceLookupKey(plan, price));
    const existing = new Map<
      string,
      Awaited<ReturnType<CatalogueSyncClient['prices']['list']>>['data'][number]
    >();
    for (let index = 0; index < lookupKeys.length; index += 10) {
      const page = await client.prices.list({
        lookup_keys: lookupKeys.slice(index, index + 10),
        limit: 10,
      });
      for (const price of page.data) if (price.lookup_key) existing.set(price.lookup_key, price);
    }
    for (const price of plan.prices) {
      const lookupKey = planPriceLookupKey(plan, price);
      const found = existing.get(lookupKey);
      if (found) {
        const same =
          found.currency === price.currency &&
          found.unit_amount === String(price.amount) &&
          found.recurring?.interval === MONTHS[price.interval] &&
          (found.recurring?.interval_count ?? 1) === 1 &&
          found.active &&
          (productId === undefined ||
            (typeof found.product === 'string' ? found.product : found.product.id) === productId);
        if (!same) {
          throw new CatalogueDrift(
            `Orbit price ${lookupKey} (${found.id}) does not match the catalogue; publish a new plan version instead of editing one.`,
          );
        }
        orbitPrice.set(lookupKey, found.id);
        result.prices.push({ lookupKey, priceId: found.id });
        continue;
      }
      result.actions.push(
        `create price ${lookupKey} = ${price.amount} ${price.currency} per ${MONTHS[price.interval]}`,
      );
      let priceId: string | null = null;
      if (options.apply && productId) {
        priceId = (
          await client.prices.create(
            {
              product: productId,
              currency: price.currency as Parameters<
                CatalogueSyncClient['prices']['create']
              >[0]['currency'],
              unit_amount: String(price.amount),
              recurring: { interval: MONTHS[price.interval] },
              tax_behavior: 'exclusive',
              lookup_key: lookupKey,
              metadata: { mercaria_plan: productKey, mercaria_interval: price.interval },
            },
            { idempotencyKey: `mercaria-plan-price:${lookupKey}` },
          )
        ).id;
      }
      orbitPrice.set(lookupKey, priceId);
      result.prices.push({ lookupKey, priceId });
    }
  }

  // ---- Mercaria: definitions, the free version, the paid versions -------------
  const shared = options.includeSharedRows ?? true;
  if (shared && options.apply) {
    await syncEntitlementDefinitions(db);
  } else if (shared) {
    result.actions.push('sync entitlement definitions from the code catalogue');
  }

  const free = shared ? await findActiveFreeMerchantPlan(db) : undefined;
  if (!shared) {
    // Not this run's to publish.
  } else if (free) {
    result.versions.push({
      planKey: free.planKey,
      version: free.version,
      id: free.id,
      status: free.status,
    });
  } else {
    const drafted = (await listMerchantPlans(db, { planKey: FREE_PLAN.planKey })).find(
      (row) => row.version === FREE_PLAN.version,
    );
    if (drafted && drafted.status !== 'draft') {
      throw new CatalogueDrift(
        `free v${FREE_PLAN.version} is ${drafted.status}; publish a new free version.`,
      );
    }
    result.actions.push(
      `${drafted ? 'activate' : 'draft and activate'} free v${FREE_PLAN.version}`,
    );
    if (options.apply) {
      const row =
        drafted ??
        (await insertMerchantPlan(db, {
          planKey: FREE_PLAN.planKey,
          version: FREE_PLAN.version,
          tier: 'free',
          name: FREE_PLAN.name,
          summary: FREE_PLAN.summary,
          termsVersion: PLAN_TERMS_VERSION,
          trialDays: 0,
          gracePeriodDays: 0,
          createdByOxyUserId: options.actor,
        }));
      const outcome = await activateMerchantPlan(db, {
        id: row.id,
        approvedByOxyUserId: options.actor,
      });
      if (outcome.outcome !== 'activated') {
        throw new CatalogueDrift(
          `free v${FREE_PLAN.version} could not be activated: ${outcome.outcome}`,
        );
      }
      result.versions.push({
        planKey: row.planKey,
        version: row.version,
        id: row.id,
        status: 'active',
      });
    } else {
      result.versions.push({
        planKey: FREE_PLAN.planKey,
        version: FREE_PLAN.version,
        id: drafted?.id ?? null,
        status: 'would-activate',
      });
    }
  }

  for (const plan of plans) {
    const label = `${plan.planKey} v${plan.version}`;
    let row: MerchantPlanRow | undefined = (
      await listMerchantPlans(db, { planKey: plan.planKey })
    ).find((candidate) => candidate.version === plan.version);
    if (row) assertSameVersion(row, plan);
    if (row && row.status !== 'draft') {
      await assertSameChildren(db, row, plan, orbitPrice, options.livemode);
      result.versions.push({
        planKey: plan.planKey,
        version: plan.version,
        id: row.id,
        status: row.status,
      });
      continue;
    }
    if (!options.apply) {
      result.actions.push(`${row ? 'complete and activate' : 'draft and activate'} ${label}`);
      result.versions.push({
        planKey: plan.planKey,
        version: plan.version,
        id: row?.id ?? null,
        status: 'would-activate',
      });
      continue;
    }
    row ??= await insertMerchantPlan(db, {
      planKey: plan.planKey,
      version: plan.version,
      tier: 'paid',
      name: plan.name,
      summary: plan.summary,
      termsVersion: PLAN_TERMS_VERSION,
      trialDays: PLAN_TRIAL_DAYS,
      gracePeriodDays: PLAN_GRACE_PERIOD_DAYS,
      createdByOxyUserId: options.actor,
    });
    const draft = row;
    const haveEntitlements = new Set(
      (await listPlanEntitlements(db, [draft.id])).map((value) => value.capabilityKey),
    );
    for (const entitlement of plan.entitlements) {
      if (haveEntitlements.has(entitlement.capability)) continue;
      await insertPlanEntitlement(db, {
        planId: draft.id,
        capabilityKey: entitlement.capability,
        limitKind: MERCHANT_CAPABILITY_CATALOG[entitlement.capability].limitKind,
        limitValue: entitlement.limit,
      });
    }
    const havePrices = new Set(
      (await listMerchantPlanPrices(db, { planIds: [draft.id], livemode: options.livemode })).map(
        (value) => value.providerPriceId,
      ),
    );
    for (const price of plan.prices) {
      const providerPriceId = orbitPrice.get(planPriceLookupKey(plan, price));
      if (!providerPriceId)
        throw new CatalogueDrift(
          `${label}: no Orbit price for ${price.interval} ${price.currency}.`,
        );
      if (havePrices.has(providerPriceId)) continue;
      await insertMerchantPlanPrice(db, {
        planId: draft.id,
        provider: 'peable',
        livemode: options.livemode,
        interval: price.interval,
        unitPrice: { amount: price.amount, currency: price.currency },
        providerPriceId,
      });
    }
    const outcome = await activateMerchantPlan(db, {
      id: draft.id,
      approvedByOxyUserId: options.actor,
    });
    if (outcome.outcome !== 'activated') {
      throw new CatalogueDrift(
        `${label} could not be activated: ${outcome.outcome}${'capabilities' in outcome ? ` (${outcome.capabilities.join(', ')})` : ''}`,
      );
    }
    result.actions.push(`activated ${label}`);
    result.versions.push({
      planKey: plan.planKey,
      version: plan.version,
      id: draft.id,
      status: 'active',
    });
  }
  return result;
}

function assertSameVersion(row: MerchantPlanRow, plan: CataloguePlan): void {
  const differs =
    row.tier !== 'paid' ||
    row.name !== plan.name ||
    row.summary !== plan.summary ||
    row.termsVersion !== PLAN_TERMS_VERSION ||
    row.trialDays !== PLAN_TRIAL_DAYS ||
    row.gracePeriodDays !== PLAN_GRACE_PERIOD_DAYS;
  if (differs && row.status !== 'draft') {
    throw new CatalogueDrift(
      `${plan.planKey} v${plan.version} is ${row.status} and differs from the catalogue; publish a new version.`,
    );
  }
  if (differs) {
    throw new CatalogueDrift(
      `${plan.planKey} v${plan.version} has a draft that differs from the catalogue; retire it or bump the version.`,
    );
  }
}

async function assertSameChildren(
  db: Database,
  row: MerchantPlanRow,
  plan: CataloguePlan,
  orbitPrice: ReadonlyMap<string, string | null>,
  livemode: boolean,
): Promise<void> {
  const label = `${plan.planKey} v${plan.version}`;
  const entitlements = await listPlanEntitlements(db, [row.id]);
  const want = new Map(plan.entitlements.map((value) => [value.capability, value.limit]));
  if (
    entitlements.length !== want.size ||
    entitlements.some(
      (value) =>
        !want.has(value.capabilityKey) || want.get(value.capabilityKey) !== value.limitValue,
    )
  ) {
    throw new CatalogueDrift(
      `${label} is ${row.status} with other entitlements than the catalogue.`,
    );
  }
  const prices = await listMerchantPlanPrices(db, { planIds: [row.id], livemode });
  for (const price of plan.prices) {
    const providerPriceId = orbitPrice.get(planPriceLookupKey(plan, price));
    const match = prices.find(
      (value) =>
        value.providerPriceId === providerPriceId &&
        value.interval === price.interval &&
        value.unitPriceCurrency === price.currency &&
        value.unitPriceAmount === price.amount,
    );
    if (!match)
      throw new CatalogueDrift(
        `${label} is ${row.status} without its ${price.interval} ${price.currency} price.`,
      );
  }
}
