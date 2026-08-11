/**
 * `merchant_plans`, `merchant_plan_prices`, `merchant_plan_acceptances`,
 * `entitlement_definitions` and `plan_entitlements` — the versioned commercial
 * policy, the capability catalogue it grants from, and the record of a merchant
 * agreeing to it (#89).
 *
 * ## Activation is a compare-and-swap, and its ORDER is load-bearing
 *
 * {@link activateMerchantPlan} locks the target, refuses anything that is not a
 * draft, supersedes the key's current active version and only THEN flips the new
 * one — the `fee_schedules` sequence exactly, because
 * `merchant_plans_one_active_per_key` refuses any other ordering. Two operators
 * racing the button serialize on the lock and the loser reports "nothing to do"
 * rather than superseding a version that is already live.
 *
 * ## Activation additionally refuses a PLACEHOLDER plan, and that lives here
 *
 * Issue #89: "Do not sell a placeholder plan whose advertised features are not
 * implemented." A version whose entitlements name a `postponed` definition is
 * refused activation, in the same transaction that would have activated it, so
 * the check cannot be raced past by a definition being withdrawn mid-flight. It
 * is not a CHECK because it is a cross-table condition and a CHECK may not
 * contain a subquery.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import type {
  BillingInterval,
  BillingProviderId,
  CurrencyCode,
  EntitlementAvailability,
  EntitlementLimitKind,
  MerchantEntitlementCapability,
  MerchantPlanTier,
} from '@mercaria/shared-types';
import {
  entitlementDefinitions,
  merchantPlanAcceptances,
  merchantPlanPrices,
  merchantPlans,
  planEntitlements,
} from '../schema/merchantPlans.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `merchant_plans`. */
export type MerchantPlanRow = typeof merchantPlans.$inferSelect;

/** One row of `merchant_plan_prices`. */
export type MerchantPlanPriceRow = typeof merchantPlanPrices.$inferSelect;

/** One row of `entitlement_definitions`. */
export type EntitlementDefinitionRow = typeof entitlementDefinitions.$inferSelect;

/** One row of `plan_entitlements`. */
export type PlanEntitlementRow = typeof planEntitlements.$inferSelect;

/** A new DRAFT plan version, as the operator surface supplies it. */
export interface NewMerchantPlan {
  planKey: string;
  version: number;
  tier: MerchantPlanTier;
  name: string;
  summary: string;
  termsVersion: string;
  trialDays?: number;
  gracePeriodDays?: number;
  createdByOxyUserId: string;
}

/** Insert one draft version. The CHECKs and unique indexes do the arguing. */
export async function insertMerchantPlan(
  db: DatabaseOrTransaction,
  input: NewMerchantPlan,
): Promise<MerchantPlanRow> {
  const [row] = await db
    .insert(merchantPlans)
    .values({
      planKey: input.planKey,
      version: input.version,
      tier: input.tier,
      name: input.name,
      summary: input.summary,
      termsVersion: input.termsVersion,
      ...(input.trialDays === undefined ? {} : { trialDays: input.trialDays }),
      ...(input.gracePeriodDays === undefined ? {} : { gracePeriodDays: input.gracePeriodDays }),
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (!row) {
    throw new Error(
      `Inserting merchant plan ${input.planKey} v${String(input.version)} returned no row.`,
    );
  }
  return row;
}

/** One version by its row id, or `undefined`. */
export async function findMerchantPlanById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MerchantPlanRow | undefined> {
  const [row] = await db.select().from(merchantPlans).where(eq(merchantPlans.id, id)).limit(1);
  return row;
}

/** Every version, oldest first — the operator listing. */
export async function listMerchantPlans(
  db: DatabaseOrTransaction,
  filter?: { planKey?: string },
): Promise<MerchantPlanRow[]> {
  const base = db.select().from(merchantPlans);
  const query = filter?.planKey ? base.where(eq(merchantPlans.planKey, filter.planKey)) : base;
  return await query.orderBy(asc(merchantPlans.planKey), asc(merchantPlans.version));
}

/** Every ACTIVE version — the plan comparison, and the free-plan lookup. */
export async function listActiveMerchantPlans(
  db: DatabaseOrTransaction,
): Promise<MerchantPlanRow[]> {
  return await db
    .select()
    .from(merchantPlans)
    .where(eq(merchantPlans.status, 'active'))
    .orderBy(asc(merchantPlans.planKey));
}

/**
 * The one active FREE version, or `undefined`.
 *
 * `merchant_plans_one_active_free_plan` makes at most one exist, so this reads
 * a row rather than choosing between candidates — which is the whole reason that
 * index is there.
 */
export async function findActiveFreeMerchantPlan(
  db: DatabaseOrTransaction,
): Promise<MerchantPlanRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantPlans)
    .where(and(eq(merchantPlans.tier, 'free'), eq(merchantPlans.status, 'active')))
    .limit(1);
  return row;
}

/** Why an activation was refused. A string discriminant — see `EntitlementDecision`. */
export type PlanActivationOutcome =
  | { readonly outcome: 'activated'; readonly plan: MerchantPlanRow }
  | { readonly outcome: 'not_a_draft' }
  /** One or more entitlements name a capability this deployment has not built. */
  | { readonly outcome: 'postponed_capabilities'; readonly capabilities: readonly string[] };

/**
 * Activate one draft version, superseding the key's current active version.
 *
 * Runs the placeholder refusal INSIDE the transaction that would activate, so a
 * definition moving to `postponed` cannot slip between the check and the flip.
 */
export async function activateMerchantPlan(
  db: DatabaseOrTransaction,
  input: { id: string; approvedByOxyUserId: string; at?: Date },
): Promise<PlanActivationOutcome> {
  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(merchantPlans)
      .where(eq(merchantPlans.id, input.id))
      .limit(1)
      .for('update');
    if (!current || current.status !== 'draft') return { outcome: 'not_a_draft' };

    const postponed = await tx
      .select({ capabilityKey: planEntitlements.capabilityKey })
      .from(planEntitlements)
      .innerJoin(
        entitlementDefinitions,
        eq(entitlementDefinitions.capabilityKey, planEntitlements.capabilityKey),
      )
      .where(
        and(
          eq(planEntitlements.planId, input.id),
          eq(entitlementDefinitions.availability, 'postponed'),
        ),
      )
      .orderBy(asc(planEntitlements.capabilityKey));
    if (postponed.length > 0) {
      return {
        outcome: 'postponed_capabilities',
        capabilities: postponed.map((row) => row.capabilityKey),
      };
    }

    await tx
      .update(merchantPlans)
      .set({ status: 'superseded' })
      .where(and(eq(merchantPlans.planKey, current.planKey), eq(merchantPlans.status, 'active')));

    const [activated] = await tx
      .update(merchantPlans)
      .set({
        status: 'active',
        approvedByOxyUserId: input.approvedByOxyUserId,
        activatedAt: input.at ?? new Date(),
      })
      .where(and(eq(merchantPlans.id, input.id), eq(merchantPlans.status, 'draft')))
      .returning();
    if (!activated) return { outcome: 'not_a_draft' };
    return { outcome: 'activated', plan: activated };
  });
}

/**
 * Retire one version — an active one withdrawn without a replacement, or a draft
 * abandoned. A superseded version stays `superseded`: replaced and withdrawn are
 * different facts.
 */
export async function retireMerchantPlan(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MerchantPlanRow | undefined> {
  const [row] = await db
    .update(merchantPlans)
    .set({ status: 'retired' })
    .where(and(eq(merchantPlans.id, id), inArray(merchantPlans.status, ['active', 'draft'])))
    .returning();
  return row;
}

/** A published price for one plan version. */
export interface NewMerchantPlanPrice {
  planId: string;
  provider: BillingProviderId;
  livemode: boolean;
  interval: BillingInterval;
  unitPrice: { amount: number; currency: CurrencyCode };
  providerPriceId: string;
}

/** Insert one price row. Refused by the trigger once the version is active. */
export async function insertMerchantPlanPrice(
  db: DatabaseOrTransaction,
  input: NewMerchantPlanPrice,
): Promise<MerchantPlanPriceRow> {
  const [row] = await db
    .insert(merchantPlanPrices)
    .values({
      planId: input.planId,
      provider: input.provider,
      livemode: input.livemode,
      interval: input.interval,
      unitPriceAmount: input.unitPrice.amount,
      unitPriceCurrency: input.unitPrice.currency,
      providerPriceId: input.providerPriceId,
    })
    .returning();
  if (!row) throw new Error(`Inserting a price for plan ${input.planId} returned no row.`);
  return row;
}

/** Every price of the given plan versions, for the catalogue projection. */
export async function listMerchantPlanPrices(
  db: DatabaseOrTransaction,
  input: { planIds: readonly string[]; livemode?: boolean },
): Promise<MerchantPlanPriceRow[]> {
  if (input.planIds.length === 0) return [];
  return await db
    .select()
    .from(merchantPlanPrices)
    .where(
      and(
        inArray(merchantPlanPrices.planId, [...input.planIds]),
        ...(input.livemode === undefined ? [] : [eq(merchantPlanPrices.livemode, input.livemode)]),
      ),
    )
    .orderBy(asc(merchantPlanPrices.planId), asc(merchantPlanPrices.interval));
}

/** One plan version's price in one currency and cadence, or `undefined`. */
export async function findMerchantPlanPrice(
  db: DatabaseOrTransaction,
  input: {
    planId: string;
    provider: BillingProviderId;
    livemode: boolean;
    interval: BillingInterval;
    currency: CurrencyCode;
  },
): Promise<MerchantPlanPriceRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantPlanPrices)
    .where(
      and(
        eq(merchantPlanPrices.planId, input.planId),
        eq(merchantPlanPrices.provider, input.provider),
        eq(merchantPlanPrices.livemode, input.livemode),
        eq(merchantPlanPrices.interval, input.interval),
        eq(merchantPlanPrices.unitPriceCurrency, input.currency),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The plan VERSION one provider price belongs to, or `undefined`.
 *
 * How a subscription arriving from the rail is mapped back to a Mercaria plan:
 * the rail names a price, and a price row names exactly one version. A price
 * that no version publishes resolves to nothing, which is what makes an
 * unrecognised subscription a NAMED outcome instead of one attached to whichever
 * plan happened to be first.
 */
export async function findMerchantPlanByProviderPrice(
  db: DatabaseOrTransaction,
  input: { provider: BillingProviderId; livemode: boolean; providerPriceId: string },
): Promise<MerchantPlanRow | undefined> {
  const [row] = await db
    .select({ plan: merchantPlans })
    .from(merchantPlanPrices)
    .innerJoin(merchantPlans, eq(merchantPlans.id, merchantPlanPrices.planId))
    .where(
      and(
        eq(merchantPlanPrices.provider, input.provider),
        eq(merchantPlanPrices.livemode, input.livemode),
        eq(merchantPlanPrices.providerPriceId, input.providerPriceId),
      ),
    )
    .limit(1);
  return row?.plan;
}

/** A capability definition, as the operator surface supplies it. */
export interface NewEntitlementDefinition {
  capabilityKey: MerchantEntitlementCapability;
  name: string;
  description: string;
  limitKind: EntitlementLimitKind;
  availability?: EntitlementAvailability;
}

/**
 * Register or refresh one capability definition.
 *
 * `ON CONFLICT DO UPDATE` on the capability key, updating only the COPY: the
 * contract columns (`limit_kind`, `enforcement_point`) are frozen by trigger, so
 * an upsert that tried to move one raises rather than silently reinterpreting
 * every plan entitlement written against it.
 */
export async function upsertEntitlementDefinition(
  db: DatabaseOrTransaction,
  input: NewEntitlementDefinition,
): Promise<EntitlementDefinitionRow> {
  const [row] = await db
    .insert(entitlementDefinitions)
    .values({
      capabilityKey: input.capabilityKey,
      name: input.name,
      description: input.description,
      limitKind: input.limitKind,
      ...(input.availability ? { availability: input.availability } : {}),
    })
    .onConflictDoUpdate({
      target: entitlementDefinitions.capabilityKey,
      set: {
        name: input.name,
        description: input.description,
        ...(input.availability ? { availability: input.availability } : {}),
      },
    })
    .returning();
  if (!row) throw new Error(`Upserting definition ${input.capabilityKey} returned no row.`);
  return row;
}

/** Every capability definition, by key. */
export async function listEntitlementDefinitions(
  db: DatabaseOrTransaction,
): Promise<EntitlementDefinitionRow[]> {
  return await db
    .select()
    .from(entitlementDefinitions)
    .orderBy(asc(entitlementDefinitions.capabilityKey));
}

/** One capability definition, or `undefined`. */
export async function findEntitlementDefinition(
  db: DatabaseOrTransaction,
  capabilityKey: MerchantEntitlementCapability,
): Promise<EntitlementDefinitionRow | undefined> {
  const [row] = await db
    .select()
    .from(entitlementDefinitions)
    .where(eq(entitlementDefinitions.capabilityKey, capabilityKey))
    .limit(1);
  return row;
}

/** A capability one plan version grants, with its limit. */
export interface NewPlanEntitlement {
  planId: string;
  capabilityKey: MerchantEntitlementCapability;
  limitKind: EntitlementLimitKind;
  limitValue?: number | null;
}

/**
 * Add one capability to a DRAFT plan version.
 *
 * The composite foreign key refuses a `limit_kind` that is not the definition's
 * own, and the trigger refuses the write outright once the version is active —
 * so "a plan version's entitlements are frozen when it is published" needs no
 * check in this function.
 */
export async function insertPlanEntitlement(
  db: DatabaseOrTransaction,
  input: NewPlanEntitlement,
): Promise<PlanEntitlementRow> {
  const [row] = await db
    .insert(planEntitlements)
    .values({
      planId: input.planId,
      capabilityKey: input.capabilityKey,
      limitKind: input.limitKind,
      ...(input.limitValue === undefined ? {} : { limitValue: input.limitValue }),
    })
    .returning();
  if (!row) {
    throw new Error(
      `Inserting entitlement ${input.capabilityKey} on plan ${input.planId} returned no row.`,
    );
  }
  return row;
}

/** Every entitlement of the given plan versions. */
export async function listPlanEntitlements(
  db: DatabaseOrTransaction,
  planIds: readonly string[],
): Promise<PlanEntitlementRow[]> {
  if (planIds.length === 0) return [];
  return await db
    .select()
    .from(planEntitlements)
    .where(inArray(planEntitlements.planId, [...planIds]))
    .orderBy(asc(planEntitlements.planId), asc(planEntitlements.capabilityKey));
}

/** One row of `merchant_plan_acceptances`. */
export type MerchantPlanAcceptanceRow = typeof merchantPlanAcceptances.$inferSelect;

/** An owner accepting one plan version's terms. */
export interface NewMerchantPlanAcceptance {
  storeId: string;
  planKey: string;
  planVersion: number;
  termsVersion: string;
  acceptedByOxyUserId: string;
}

/**
 * Record an acceptance, converging on a replay.
 *
 * `ON CONFLICT DO NOTHING` against `(store_id, plan_key, plan_version)`: a
 * double-tap or a retried upgrade is the SAME consent and must not duplicate the
 * audit trail. The empty vs one-row `RETURNING` set is the "already accepted"
 * answer, exactly as the fee domain's acceptance reads it.
 */
export async function insertMerchantPlanAcceptance(
  db: DatabaseOrTransaction,
  input: NewMerchantPlanAcceptance,
): Promise<{ created: boolean; row: MerchantPlanAcceptanceRow }> {
  const [inserted] = await db
    .insert(merchantPlanAcceptances)
    .values(input)
    .onConflictDoNothing({
      target: [
        merchantPlanAcceptances.storeId,
        merchantPlanAcceptances.planKey,
        merchantPlanAcceptances.planVersion,
      ],
    })
    .returning();
  if (inserted) return { created: true, row: inserted };

  const existing = await findMerchantPlanAcceptance(db, input);
  if (!existing) {
    throw new Error(
      `Acceptance of ${input.planKey} v${String(input.planVersion)} by store ` +
        `${input.storeId} conflicted but cannot be read back.`,
    );
  }
  return { created: false, row: existing };
}

/** One store's acceptance of one plan version, or `undefined`. */
export async function findMerchantPlanAcceptance(
  db: DatabaseOrTransaction,
  input: { storeId: string; planKey: string; planVersion: number },
): Promise<MerchantPlanAcceptanceRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantPlanAcceptances)
    .where(
      and(
        eq(merchantPlanAcceptances.storeId, input.storeId),
        eq(merchantPlanAcceptances.planKey, input.planKey),
        eq(merchantPlanAcceptances.planVersion, input.planVersion),
      ),
    )
    .limit(1);
  return row;
}
