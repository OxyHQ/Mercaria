/**
 * The merchant plan domain against a REAL Postgres database (#89).
 *
 * Every property here is a property of the SERVER rather than of any caller: six
 * triggers, four load-bearing CHECKs, three partial unique indexes, a composite
 * foreign key and one conditional upsert whose empty result IS a refusal. A
 * mocked insert accepts any statement, including one the server rejects
 * outright — which is exactly the class of guarantee this file exists to pin.
 *
 * ## `merchant_plans_one_active_free_plan` is a GLOBAL index
 *
 * At most one active `free` version in the whole database, which makes it a
 * shared resource inside this file the way `match_policy_versions_active_key` is
 * across files. The tests that need an active free plan retire it before they
 * finish, and they say so; nothing else in this suite may leave one standing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../postgres.js';
import { stores } from '../../schema/stores.js';
import {
  entitlementDefinitions,
  merchantPlanPrices,
  merchantPlans,
  merchantSubscriptionEvents,
  planEntitlements,
} from '../../schema/merchantPlans.js';
import {
  activateMerchantPlan,
  findMerchantPlanByProviderPrice,
  insertMerchantPlan,
  insertMerchantPlanAcceptance,
  insertMerchantPlanPrice,
  insertPlanEntitlement,
  retireMerchantPlan,
  upsertEntitlementDefinition,
} from '../planRepository.js';
import {
  appendSubscriptionEvent,
  ensureBillingCustomer,
  findSubscriptionByStore,
  hasSubscriptionEventSince,
  updateSubscriptionState,
  upsertMerchantSubscription,
} from '../subscriptionRepository.js';
import { insertEntitlementGrant, revokeEntitlementGrant } from '../grantRepository.js';
import { consumeEntitlementUsage } from '../usageRepository.js';
import {
  invalidateAllMerchantEntitlements,
  resolveMerchantEntitlements,
} from '../../../services/entitlements/resolve.js';

let db: Database;

/** Unique per run, so a shared throwaway database never collides. */
const RUN = uuidv7().slice(-12);

beforeAll(async () => {
  db = await connectPostgres();
  // The capability definitions every plan entitlement's composite foreign key
  // points at. `flag` and `per_period` cover both shapes the CHECKs distinguish.
  await upsertEntitlementDefinition(db, {
    capabilityKey: 'advanced_demand_analytics',
    name: 'Advanced demand analytics',
    description: 'test fixture',
    limitKind: 'flag',
    availability: 'available',
  });
  await upsertEntitlementDefinition(db, {
    capabilityKey: 'scheduled_exports',
    name: 'Scheduled exports',
    description: 'test fixture',
    limitKind: 'per_period',
    availability: 'available',
  });
  await upsertEntitlementDefinition(db, {
    capabilityKey: 'ai_catalog_assistance',
    name: 'AI catalogue assistance',
    description: 'test fixture — deliberately POSTPONED',
    limitKind: 'per_period',
    availability: 'postponed',
  });
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/** A store to hang a subscription, a grant and a counter on. */
async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      handle: `plan-store-${RUN}-${label}`,
      name: `Plan Store ${label}`,
      description: '',
      brandColor: '#101010',
    })
    .returning();
  if (!row) throw new Error('store insert returned no row');
  return row.id;
}

/**
 * Assert a write is refused BY POSTGRES, matching the server's own words.
 *
 * drizzle wraps the driver error in a `Failed query: …` message and keeps the
 * PostgresError as `cause`, so a trigger's RAISE text and a violated
 * constraint's name are only reachable there. Matching the top-level message
 * would pass on ANY failed statement — a vacuous assertion wearing a precise
 * one's clothes — so this digs the real text out and fails loudly when the
 * promise resolves. Lifted from `fee-schedules.realdb.test.ts`, whose finding it
 * is.
 */
async function expectPgRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (err) {
    failure = err;
  }
  expect(failure, `expected a rejection matching ${String(pattern)}`).toBeDefined();
  const cause = (failure as { cause?: { message?: string; constraint_name?: string } }).cause;
  const text = [
    (failure as Error).message,
    cause?.message ?? '',
    cause?.constraint_name ?? '',
  ].join(' ');
  expect(text).toMatch(pattern);
}

/** A DRAFT plan version under a freshly minted key. */
async function draftPlan(input: {
  label: string;
  tier?: 'free' | 'paid';
  gracePeriodDays?: number;
}) {
  return await insertMerchantPlan(db, {
    planKey: `plan-${RUN}-${input.label}`,
    version: 1,
    tier: input.tier ?? 'paid',
    name: `Plan ${input.label}`,
    summary: 'a test plan',
    termsVersion: 'terms-1',
    ...(input.gracePeriodDays === undefined ? {} : { gracePeriodDays: input.gracePeriodDays }),
    createdByOxyUserId: `oxy-operator-${RUN}`,
  });
}

describe('plan versions are immutable once active', () => {
  it('refuses an edit to a published version, and refuses deleting it', async () => {
    const plan = await draftPlan({ label: 'immutable' });
    const activated = await activateMerchantPlan(db, {
      id: plan.id,
      approvedByOxyUserId: `oxy-approver-${RUN}`,
    });
    expect(activated.outcome).toBe('activated');

    await expectPgRejection(
      db.update(merchantPlans).set({ summary: 'rewritten' }).where(eq(merchantPlans.id, plan.id)),
      /immutable/i,
    );

    await expectPgRejection(
      db.delete(merchantPlans).where(eq(merchantPlans.id, plan.id)),
      /never deleted/i,
    );

    // The lifecycle columns MUST still move, or a version could never be
    // superseded or retired.
    const retired = await retireMerchantPlan(db, plan.id);
    expect(retired?.status).toBe('retired');
  });

  it('freezes a version s prices and entitlements once it is published', async () => {
    const plan = await draftPlan({ label: 'frozen-children' });
    await insertPlanEntitlement(db, {
      planId: plan.id,
      capabilityKey: 'advanced_demand_analytics',
      limitKind: 'flag',
    });
    await activateMerchantPlan(db, { id: plan.id, approvedByOxyUserId: `oxy-${RUN}` });

    await expectPgRejection(
      insertPlanEntitlement(db, {
        planId: plan.id,
        capabilityKey: 'scheduled_exports',
        limitKind: 'per_period',
        limitValue: 10,
      }),
      /frozen/i,
    );

    await expectPgRejection(
      insertMerchantPlanPrice(db, {
        planId: plan.id,
        provider: 'stripe',
        livemode: false,
        interval: 'monthly',
        unitPrice: { amount: 1_000, currency: 'EUR' },
        providerPriceId: `price_${RUN}_late`,
      }),
      /frozen/i,
    );

    await retireMerchantPlan(db, plan.id);
  });

  it('activation supersedes the key s previous active version', async () => {
    const key = `plan-${RUN}-supersede`;
    const first = await insertMerchantPlan(db, {
      planKey: key,
      version: 1,
      tier: 'paid',
      name: 'v1',
      summary: 'first',
      termsVersion: 'terms-1',
      createdByOxyUserId: `oxy-${RUN}`,
    });
    const second = await insertMerchantPlan(db, {
      planKey: key,
      version: 2,
      tier: 'paid',
      name: 'v2',
      summary: 'second',
      termsVersion: 'terms-2',
      createdByOxyUserId: `oxy-${RUN}`,
    });
    await activateMerchantPlan(db, { id: first.id, approvedByOxyUserId: `oxy-${RUN}` });
    await activateMerchantPlan(db, { id: second.id, approvedByOxyUserId: `oxy-${RUN}` });

    const rows = await db.select().from(merchantPlans).where(eq(merchantPlans.planKey, key));
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(rows.find((row) => row.id === first.id)?.status).toBe('superseded');
    await retireMerchantPlan(db, second.id);
  });
});

describe('a placeholder plan cannot be put on sale', () => {
  it('refuses activation when an entitlement names a postponed capability, by NAME', async () => {
    const plan = await draftPlan({ label: 'placeholder' });
    await insertPlanEntitlement(db, {
      planId: plan.id,
      capabilityKey: 'ai_catalog_assistance',
      limitKind: 'per_period',
      limitValue: 100,
    });

    const outcome = await activateMerchantPlan(db, {
      id: plan.id,
      approvedByOxyUserId: `oxy-${RUN}`,
    });
    expect(outcome.outcome).toBe('postponed_capabilities');
    if (outcome.outcome === 'postponed_capabilities') {
      expect(outcome.capabilities).toEqual(['ai_catalog_assistance']);
    }
    // And it really did not activate — the refusal is not just a return value.
    const [row] = await db.select().from(merchantPlans).where(eq(merchantPlans.id, plan.id));
    expect(row?.status).toBe('draft');
  });
});

describe('the capability contract is frozen and the denormalized copy cannot drift', () => {
  it('refuses a change to a definition s limit kind', async () => {
    await expectPgRejection(
      db
        .update(entitlementDefinitions)
        .set({ limitKind: 'total' })
        .where(eq(entitlementDefinitions.capabilityKey, 'advanced_demand_analytics')),
      /frozen contract/i,
    );
  });

  it('refuses a plan entitlement whose limit kind is not the definition s', async () => {
    const plan = await draftPlan({ label: 'wrong-kind' });
    // `advanced_demand_analytics` is a `flag`; claiming it is a `total` has no
    // row in `entitlement_definitions` to point at, so the composite key refuses
    // it — the copy is provably the definition's own.
    await expectPgRejection(
      insertPlanEntitlement(db, {
        planId: plan.id,
        capabilityKey: 'advanced_demand_analytics',
        limitKind: 'total',
        limitValue: 5,
      }),
      /plan_entitlements_capability_fk/i,
    );
  });

  it('refuses a NUMBER on a flag capability', async () => {
    const plan = await draftPlan({ label: 'flag-limit' });
    await expectPgRejection(
      db.insert(planEntitlements).values({
        planId: plan.id,
        capabilityKey: 'advanced_demand_analytics',
        limitKind: 'flag',
        limitValue: 3,
      }),
      /flag_has_no_limit/i,
    );
  });

  it('admits NULL on a quantified capability, which is UNLIMITED', async () => {
    const plan = await draftPlan({ label: 'unlimited' });
    const row = await insertPlanEntitlement(db, {
      planId: plan.id,
      capabilityKey: 'scheduled_exports',
      limitKind: 'per_period',
      limitValue: null,
    });
    expect(row.limitValue).toBeNull();
  });
});

describe('the terms acceptance is append-only and converges', () => {
  it('records one acceptance per version however many times it is submitted', async () => {
    const storeId = await mintStore('acceptance');
    const first = await insertMerchantPlanAcceptance(db, {
      storeId,
      planKey: `plan-${RUN}-accepted`,
      planVersion: 1,
      termsVersion: 'terms-1',
      acceptedByOxyUserId: `oxy-owner-${RUN}`,
    });
    expect(first.created).toBe(true);

    const second = await insertMerchantPlanAcceptance(db, {
      storeId,
      planKey: `plan-${RUN}-accepted`,
      planVersion: 1,
      termsVersion: 'terms-1',
      // A DIFFERENT actor on the replay: the first acceptance is what stands, so
      // a retry cannot rewrite who agreed.
      acceptedByOxyUserId: `oxy-someone-else-${RUN}`,
    });
    expect(second.created).toBe(false);
    expect(second.row.acceptedByOxyUserId).toBe(`oxy-owner-${RUN}`);
  });
});

describe('a subscription cannot be past due without a deadline', () => {
  it('refuses the row outright', async () => {
    const storeId = await mintStore('grace-check');
    const plan = await draftPlan({ label: 'grace-check', gracePeriodDays: 7 });
    const customer = await ensureBillingCustomer(db, {
      storeId,
      provider: 'stripe',
      livemode: false,
      providerCustomerId: `cus_${RUN}_grace`,
    });
    await expectPgRejection(
      upsertMerchantSubscription(db, {
        storeId,
        planId: plan.id,
        billingCustomerId: customer.row.id,
        provider: 'stripe',
        livemode: false,
        providerSubscriptionId: `sub_${RUN}_grace`,
        status: 'past_due',
        interval: 'monthly',
        acceptedTermsVersion: 'terms-1',
        acceptedByOxyUserId: `oxy-${RUN}`,
        acceptedAt: new Date(),
      }),
      /grace_deadline/i,
    );
  });
});

describe('a provider event is applied exactly once', () => {
  it('converges a redelivered event on ONE audit row and refuses the second claim', async () => {
    const storeId = await mintStore('dedupe');
    const plan = await draftPlan({ label: 'dedupe' });
    const customer = await ensureBillingCustomer(db, {
      storeId,
      provider: 'stripe',
      livemode: false,
      providerCustomerId: `cus_${RUN}_dedupe`,
    });
    const subscription = await upsertMerchantSubscription(db, {
      storeId,
      planId: plan.id,
      billingCustomerId: customer.row.id,
      provider: 'stripe',
      livemode: false,
      providerSubscriptionId: `sub_${RUN}_dedupe`,
      status: 'active',
      interval: 'monthly',
      acceptedTermsVersion: 'terms-1',
      acceptedByOxyUserId: `oxy-${RUN}`,
      acceptedAt: new Date(),
    });

    const eventId = `evt_${RUN}_dedupe`;
    const first = await appendSubscriptionEvent(db, {
      subscriptionId: subscription.id,
      kind: 'activated',
      note: 'first delivery',
      providerEventId: eventId,
    });
    const second = await appendSubscriptionEvent(db, {
      subscriptionId: subscription.id,
      kind: 'activated',
      note: 'redelivery',
      providerEventId: eventId,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const rows = await db
      .select()
      .from(merchantSubscriptionEvents)
      .where(eq(merchantSubscriptionEvents.providerEventId, eventId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toBe('first delivery');
  });

  it('refuses to edit or delete an audit row', async () => {
    const storeId = await mintStore('append-only');
    const plan = await draftPlan({ label: 'append-only' });
    const customer = await ensureBillingCustomer(db, {
      storeId,
      provider: 'stripe',
      livemode: false,
      providerCustomerId: `cus_${RUN}_append`,
    });
    const subscription = await upsertMerchantSubscription(db, {
      storeId,
      planId: plan.id,
      billingCustomerId: customer.row.id,
      provider: 'stripe',
      livemode: false,
      providerSubscriptionId: `sub_${RUN}_append`,
      status: 'active',
      interval: 'monthly',
      acceptedTermsVersion: 'terms-1',
      acceptedByOxyUserId: `oxy-${RUN}`,
      acceptedAt: new Date(),
    });
    const appended = await appendSubscriptionEvent(db, {
      subscriptionId: subscription.id,
      kind: 'activated',
      note: 'original',
    });
    const rowId = appended.row?.id;
    expect(rowId).toBeDefined();

    await expectPgRejection(
      db
        .update(merchantSubscriptionEvents)
        .set({ note: 'rewritten' })
        .where(eq(merchantSubscriptionEvents.id, rowId ?? '')),
      /append-only/i,
    );
    await expectPgRejection(
      db.delete(merchantSubscriptionEvents).where(eq(merchantSubscriptionEvents.id, rowId ?? '')),
      /append-only/i,
    );
  });
});

describe('a usage limit is enforced by ONE statement', () => {
  it('refuses the increment that would exceed the limit, and takes the ones that fit', async () => {
    const storeId = await mintStore('usage');
    const period = `p:${RUN}`;

    const first = await consumeEntitlementUsage(db, {
      storeId,
      capabilityKey: 'scheduled_exports',
      periodKey: period,
      amount: 2,
      limit: 3,
    });
    expect(first?.used).toBe(2);

    // 2 + 2 = 4 > 3, so the conflict branch's `WHERE` refuses it and the empty
    // `RETURNING` set IS the refusal.
    const overflow = await consumeEntitlementUsage(db, {
      storeId,
      capabilityKey: 'scheduled_exports',
      periodKey: period,
      amount: 2,
      limit: 3,
    });
    expect(overflow).toBeUndefined();

    const exact = await consumeEntitlementUsage(db, {
      storeId,
      capabilityKey: 'scheduled_exports',
      periodKey: period,
      amount: 1,
      limit: 3,
    });
    expect(exact?.used).toBe(3);
  });

  it('does not exceed the limit under CONCURRENT consumers', async () => {
    // A read-then-write leaves a window two callers both fit through, and a
    // sequential pair cannot tell the two implementations apart — which is why
    // these are issued together rather than awaited in turn.
    const storeId = await mintStore('usage-race');
    const period = `p:${RUN}-race`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        consumeEntitlementUsage(db, {
          storeId,
          capabilityKey: 'scheduled_exports',
          periodKey: period,
          amount: 1,
          limit: 3,
        }),
      ),
    );
    const granted = results.filter((row) => row !== undefined);
    expect(granted).toHaveLength(3);
    expect(Math.max(...granted.map((row) => row?.used ?? 0))).toBe(3);
  });

  it('refuses a first use that is already over the limit', async () => {
    // The insert branch creates the counter at `amount`, so the conflict
    // branch's `WHERE` never runs — this is the case a limit check written only
    // in the upsert would let through.
    const storeId = await mintStore('usage-first');
    const refused = await consumeEntitlementUsage(db, {
      storeId,
      capabilityKey: 'scheduled_exports',
      periodKey: `p:${RUN}-first`,
      amount: 9,
      limit: 3,
    });
    expect(refused).toBeUndefined();
  });
});

describe('resolution: what a store is actually entitled to', () => {
  it('falls back to the ACTIVE FREE plan when there is no subscription', async () => {
    const storeId = await mintStore('free-fallback');
    const free = await draftPlan({ label: 'free-fallback', tier: 'free' });
    await insertPlanEntitlement(db, {
      planId: free.id,
      capabilityKey: 'advanced_demand_analytics',
      limitKind: 'flag',
    });
    await activateMerchantPlan(db, { id: free.id, approvedByOxyUserId: `oxy-${RUN}` });
    invalidateAllMerchantEntitlements();

    const resolved = await resolveMerchantEntitlements(storeId, { fresh: true, db });
    expect(resolved.planKey).toBe(free.planKey);
    expect(resolved.entitlements.has('advanced_demand_analytics')).toBe(true);

    // The free-plan index is GLOBAL — retire it before another test needs one.
    await retireMerchantPlan(db, free.id);
    invalidateAllMerchantEntitlements();
  });

  it('refuses a SECOND active free plan', async () => {
    const first = await draftPlan({ label: 'free-one', tier: 'free' });
    const second = await draftPlan({ label: 'free-two', tier: 'free' });
    await activateMerchantPlan(db, { id: first.id, approvedByOxyUserId: `oxy-${RUN}` });
    await expectPgRejection(
      activateMerchantPlan(db, { id: second.id, approvedByOxyUserId: `oxy-${RUN}` }),
      /merchant_plans_one_active_free_plan/i,
    );
    await retireMerchantPlan(db, first.id);
    invalidateAllMerchantEntitlements();
  });

  it('keeps paid entitlements inside the grace and drops them at the deadline', async () => {
    const storeId = await mintStore('grace-window');
    const paid = await draftPlan({ label: 'grace-window', gracePeriodDays: 7 });
    await insertPlanEntitlement(db, {
      planId: paid.id,
      capabilityKey: 'advanced_demand_analytics',
      limitKind: 'flag',
    });
    await activateMerchantPlan(db, { id: paid.id, approvedByOxyUserId: `oxy-${RUN}` });

    const customer = await ensureBillingCustomer(db, {
      storeId,
      provider: 'stripe',
      livemode: false,
      providerCustomerId: `cus_${RUN}_window`,
    });
    const subscription = await upsertMerchantSubscription(db, {
      storeId,
      planId: paid.id,
      billingCustomerId: customer.row.id,
      provider: 'stripe',
      livemode: false,
      providerSubscriptionId: `sub_${RUN}_window`,
      status: 'active',
      interval: 'monthly',
      acceptedTermsVersion: 'terms-1',
      acceptedByOxyUserId: `oxy-${RUN}`,
      acceptedAt: new Date(),
    });

    const graceExpiresAt = new Date('2030-06-01T00:00:00.000Z');
    await updateSubscriptionState(db, subscription.id, { status: 'past_due', graceExpiresAt });

    const inside = await resolveMerchantEntitlements(storeId, {
      at: new Date('2030-05-31T00:00:00.000Z'),
      fresh: true,
      db,
    });
    expect(inside.entitlements.has('advanced_demand_analytics')).toBe(true);

    const after = await resolveMerchantEntitlements(storeId, {
      at: new Date('2030-06-02T00:00:00.000Z'),
      fresh: true,
      db,
    });
    // No active free plan exists at this point, so the fallback is the empty
    // set — which is exactly right: nothing a free merchant needs is an
    // entitlement, so losing every one of them costs a catalogue nothing.
    expect(after.entitlements.has('advanced_demand_analytics')).toBe(false);
    expect(after.planKey).toBeNull();

    await retireMerchantPlan(db, paid.id);
  });

  it('takes the most generous limit when a grant and a plan disagree', async () => {
    const storeId = await mintStore('generous');
    const paid = await draftPlan({ label: 'generous' });
    await insertPlanEntitlement(db, {
      planId: paid.id,
      capabilityKey: 'scheduled_exports',
      limitKind: 'per_period',
      limitValue: 5,
    });
    await activateMerchantPlan(db, { id: paid.id, approvedByOxyUserId: `oxy-${RUN}` });
    const customer = await ensureBillingCustomer(db, {
      storeId,
      provider: 'stripe',
      livemode: false,
      providerCustomerId: `cus_${RUN}_generous`,
    });
    await upsertMerchantSubscription(db, {
      storeId,
      planId: paid.id,
      billingCustomerId: customer.row.id,
      provider: 'stripe',
      livemode: false,
      providerSubscriptionId: `sub_${RUN}_generous`,
      status: 'active',
      interval: 'monthly',
      acceptedTermsVersion: 'terms-1',
      acceptedByOxyUserId: `oxy-${RUN}`,
      acceptedAt: new Date(),
    });

    const grant = await insertEntitlementGrant(db, {
      storeId,
      grantKey: `grant-${RUN}-generous`,
      capabilityKey: 'scheduled_exports',
      limitKind: 'per_period',
      limitValue: 50,
      reason: 'partnership',
      note: 'a partnership raised the ceiling',
      grantedByOxyUserId: `oxy-${RUN}`,
      startsAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(grant.created).toBe(true);

    const withGrant = await resolveMerchantEntitlements(storeId, { fresh: true, db });
    expect(withGrant.entitlements.get('scheduled_exports')?.limit).toBe(50);
    expect(withGrant.entitlements.get('scheduled_exports')?.source).toBe('grant');

    // Revoking it falls back to the plan's own ceiling rather than to nothing.
    await revokeEntitlementGrant(db, {
      id: grant.row.id,
      revokedByOxyUserId: `oxy-${RUN}`,
      revocationReason: 'the partnership ended',
    });
    const afterRevoke = await resolveMerchantEntitlements(storeId, { fresh: true, db });
    expect(afterRevoke.entitlements.get('scheduled_exports')?.limit).toBe(5);
    expect(afterRevoke.entitlements.get('scheduled_exports')?.source).toBe('plan');

    await retireMerchantPlan(db, paid.id);
  });

  it('converges a repeated grant on ONE row', async () => {
    const storeId = await mintStore('grant-replay');
    const key = `grant-${RUN}-replay`;
    const first = await insertEntitlementGrant(db, {
      storeId,
      grantKey: key,
      capabilityKey: 'advanced_demand_analytics',
      limitKind: 'flag',
      reason: 'trial',
      note: 'a trial',
      grantedByOxyUserId: `oxy-${RUN}`,
      startsAt: new Date(),
    });
    const second = await insertEntitlementGrant(db, {
      storeId,
      grantKey: key,
      capabilityKey: 'advanced_demand_analytics',
      limitKind: 'flag',
      reason: 'trial',
      note: 'a retried trial',
      grantedByOxyUserId: `oxy-${RUN}`,
      startsAt: new Date(),
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });
});

describe('a provider price maps back to exactly one plan version', () => {
  it('resolves the plan a subscription is on, and nothing for an unknown price', async () => {
    const plan = await draftPlan({ label: 'price-map' });
    const priceId = `price_${RUN}_map`;
    await insertMerchantPlanPrice(db, {
      planId: plan.id,
      provider: 'stripe',
      livemode: false,
      interval: 'monthly',
      unitPrice: { amount: 2_900, currency: 'EUR' },
      providerPriceId: priceId,
    });

    const found = await findMerchantPlanByProviderPrice(db, {
      provider: 'stripe',
      livemode: false,
      providerPriceId: priceId,
    });
    expect(found?.id).toBe(plan.id);

    // A price in the OTHER mode is a different key space and resolves to
    // nothing — which is what stops a test-mode subscription being recorded
    // against a live plan.
    const wrongMode = await findMerchantPlanByProviderPrice(db, {
      provider: 'stripe',
      livemode: true,
      providerPriceId: priceId,
    });
    expect(wrongMode).toBeUndefined();

    const rows = await db
      .select()
      .from(merchantPlanPrices)
      .where(eq(merchantPlanPrices.planId, plan.id));
    expect(rows).toHaveLength(1);
  });
});

describe('the grace announcement is idempotent', () => {
  it('reports an announcement already made since the deadline', async () => {
    const storeId = await mintStore('grace-announce');
    const plan = await draftPlan({ label: 'grace-announce', gracePeriodDays: 3 });
    const customer = await ensureBillingCustomer(db, {
      storeId,
      provider: 'stripe',
      livemode: false,
      providerCustomerId: `cus_${RUN}_announce`,
    });
    const subscription = await upsertMerchantSubscription(db, {
      storeId,
      planId: plan.id,
      billingCustomerId: customer.row.id,
      provider: 'stripe',
      livemode: false,
      providerSubscriptionId: `sub_${RUN}_announce`,
      status: 'active',
      interval: 'monthly',
      acceptedTermsVersion: 'terms-1',
      acceptedByOxyUserId: `oxy-${RUN}`,
      acceptedAt: new Date(),
    });
    const deadline = new Date('2020-01-01T00:00:00.000Z');
    await updateSubscriptionState(db, subscription.id, {
      status: 'past_due',
      graceExpiresAt: deadline,
    });

    expect(
      await hasSubscriptionEventSince(db, {
        subscriptionId: subscription.id,
        kind: 'grace_expired',
        since: deadline,
      }),
    ).toBe(false);

    await appendSubscriptionEvent(db, {
      subscriptionId: subscription.id,
      kind: 'grace_expired',
      note: 'the grace period ran out',
    });

    expect(
      await hasSubscriptionEventSince(db, {
        subscriptionId: subscription.id,
        kind: 'grace_expired',
        since: deadline,
      }),
    ).toBe(true);
    // And the store's own subscription is untouched: the deadline is what
    // removes the entitlements, not a status this sweep invents.
    const reread = await findSubscriptionByStore(db, storeId);
    expect(reread?.status).toBe('past_due');
  });
});
