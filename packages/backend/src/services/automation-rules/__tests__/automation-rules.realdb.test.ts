/**
 * Automation rules (#89, `automation_rules`) against a real server: the plan
 * slot a create takes and a delete gives back (including two concurrent creates
 * at the ceiling), the refusal when the store is not entitled, the evaluator's
 * idempotency per (rule, subject, occurrence), and the moderation escapes a
 * rule must not open.
 *
 * Every evaluator pass is SCOPED to the stores this file minted (`storeIds`),
 * because the test database is shared across parallel files.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { CreateAutomationRuleInput, StorePermission } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { notifications } from '../../../db/schema/notifications.js';
import { orders } from '../../../db/schema/orders.js';
import { automationRules } from '../../../db/schema/automationRules.js';
import { insertStore } from '../../../db/stores/storeRepository.js';
import { insertLocation } from '../../../db/stores/locationRepository.js';
import { insertCategory } from '../../../db/taxonomy/taxonomyRepository.js';
import { findListingById, setListingStatusIfIn } from '../../../db/catalog/listingRepository.js';
import { findVariantsByListing } from '../../../db/catalog/variantRepository.js';
import {
  findOrderById,
  insertOrder,
  nextOrderNumber,
  setOrderModerationHold,
} from '../../../db/orders/orderRepository.js';
import { findEntitlementUsage } from '../../../db/merchantPlans/usageRepository.js';
import {
  insertAutomationRule,
  listAutomationRuleRuns,
  listStockEpisodes,
} from '../../../db/automationRules/automationRuleRepository.js';
import { ErrorCodes } from '../../../utils/api-response.js';
import { createStoreProduct } from '../../catalog-write.service.js';
import { setAvailable } from '../../inventory.service.js';
import { PlanCapabilityRefusal } from '../../entitlements/enforce.js';
import {
  ensureCapabilityAvailable,
  entitleStoreForTest,
} from '../../entitlements/__tests__/entitle-store.js';
import { createRule, deleteRule, listRules, listRuns, updateRule } from '../rule.service.js';
import { evaluateAutomationRules } from '../evaluator.js';

let db: Database;
const CAPABILITY = 'automation_rules' as const;
const EDITOR: readonly StorePermission[] = ['products:read', 'products:write', 'orders:fulfill'];
const AUTHOR = { oxyUserId: 'oxy-rule-author', permissions: EDITOR };

beforeAll(async () => {
  db = await connectPostgres();
  await ensureCapabilityAvailable(db, CAPABILITY);
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

interface StoreFixture {
  storeId: string;
  ownerAccountId: string;
  locationId: string;
  categorySlug: string;
}

async function mintStore(input: { limit?: number | null; entitled?: boolean } = {}) {
  const suffix = uuidv7();
  const ownerAccountId = `owner-${suffix}`;
  const store = await insertStore({
    oxyAccountId: ownerAccountId,
    handle: `automation-${suffix}`,
    name: 'Automation store',
    description: '',
    brandColor: '#123456',
    defaultCurrency: 'FAIR',
  });
  const location = await insertLocation(store.id, {
    name: 'Default location',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });
  const category = await insertCategory({
    key: `automation-goods-${suffix}`,
    name: 'Automation goods',
    slug: `automation-goods-${suffix}`,
  });
  if (input.entitled !== false) {
    await entitleStoreForTest(db, {
      storeId: store.id,
      capability: CAPABILITY,
      limit: input.limit === undefined ? null : input.limit,
    });
  }
  return {
    storeId: store.id,
    ownerAccountId,
    locationId: location.id,
    categorySlug: category.slug,
  } satisfies StoreFixture;
}

async function mintProduct(
  fixture: StoreFixture,
  available: number,
  tags: string[] = [],
): Promise<{ listingId: string; variantId: string }> {
  const listingId = await createStoreProduct(
    fixture.storeId,
    {
      title: `Automation tee ${available}`,
      description: '',
      category: fixture.categorySlug,
      handle: `automation-tee-${uuidv7()}`,
      imageFileIds: [],
      options: [],
      tags,
      variants: [
        {
          optionValues: [],
          price: { amount: 1500, currency: 'FAIR' },
          inventory: { tracked: true, available },
        },
      ],
    },
    { locationId: fixture.locationId, status: 'active' },
  );
  const [variant] = await findVariantsByListing(listingId);
  if (!variant) throw new Error('product has no variant');
  return { listingId, variantId: variant.id };
}

async function statusOf(listingId: string): Promise<string | undefined> {
  return (await findListingById(listingId))?.status;
}

async function used(storeId: string): Promise<number> {
  const counter = await findEntitlementUsage(db, {
    storeId,
    capabilityKey: CAPABILITY,
    periodKey: 'total',
  });
  return counter?.used ?? 0;
}

async function refusalOf(promise: Promise<unknown>): Promise<PlanCapabilityRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlanCapabilityRefusal) return error;
    throw error;
  }
  throw new Error('expected a plan refusal, and the call succeeded');
}

const PAUSE_RULE: CreateAutomationRuleInput = {
  name: 'Pause sold-out listings',
  trigger: 'listing_stock_at_or_below',
  action: 'pause_listing',
  stockThreshold: 0,
  republishWhenRestocked: true,
};

/** A `paid` store order for one listing, paid at `paidAt`. */
async function mintPaidOrder(
  fixture: StoreFixture,
  product: { listingId: string; variantId: string },
  input: { total?: number; paidAt?: Date; shippingMethod?: 'standard' | 'pickup' } = {},
): Promise<string> {
  const total = input.total ?? 1500;
  const fair = (amount: number) =>
    ({ shop: { amount, currency: 'FAIR' }, presentment: { amount, currency: 'FAIR' } }) as const;
  const order = await insertOrder({
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${uuidv7()}`,
    sellerType: 'store',
    storeId: fixture.storeId,
    commercialRole: 'connected_marketplace',
    items: [
      {
        listingId: product.listingId,
        variantId: product.variantId,
        title: 'Automation tee',
        variantTitle: 'Default',
        optionValues: [],
        unitPrice: fair(total),
        quantity: 1,
        lineTotal: fair(total),
      },
    ],
    shippingAddress: {
      recipientName: 'Buyer',
      line1: '1 Street',
      city: 'Barcelona',
      postalCode: '08001',
      country: 'ES',
    },
    shippingMethod: input.shippingMethod ?? 'standard',
    shippingLabel: 'Standard shipping',
    shippingCost: fair(0),
    totals: {
      subtotal: fair(total),
      discountTotal: fair(0),
      shipping: fair(0),
      tax: fair(0),
      grandTotal: fair(total),
    },
    status: 'paid',
    paymentStatus: 'paid',
    statusHistory: [{ status: 'paid', at: new Date(), actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
  } as Parameters<typeof insertOrder>[0]);
  await db
    .update(orders)
    .set({ paymentPaidAt: input.paidAt ?? new Date() })
    .where(eq(orders.id, order.id));
  return order.id;
}

describe('the plan slot', () => {
  it('a create takes one slot, the next past the limit is PLAN_LIMIT_REACHED, a delete gives it back', async () => {
    const fixture = await mintStore({ limit: 2 });
    const first = await createRule(fixture.storeId, PAUSE_RULE, AUTHOR);
    await createRule(fixture.storeId, { ...PAUSE_RULE, name: 'Second' }, AUTHOR);
    expect(await used(fixture.storeId)).toBe(2);

    const refusal = await refusalOf(
      createRule(fixture.storeId, { ...PAUSE_RULE, name: 'Third' }, AUTHOR),
    );
    expect(refusal.code).toBe(ErrorCodes.PLAN_LIMIT_REACHED);
    // The refused create wrote nothing: the slot and the row commit together.
    expect(await listRules(fixture.storeId)).toHaveLength(2);

    // Disabling keeps the slot.
    await updateRule(fixture.storeId, first.id, { enabled: false }, AUTHOR);
    expect(await used(fixture.storeId)).toBe(2);

    await deleteRule(fixture.storeId, first.id, AUTHOR);
    expect(await used(fixture.storeId)).toBe(1);
    // A second delete of the same rule is a 404 and gives nothing back twice.
    await expect(deleteRule(fixture.storeId, first.id, AUTHOR)).rejects.toThrow(/not found/i);
    expect(await used(fixture.storeId)).toBe(1);

    await createRule(fixture.storeId, { ...PAUSE_RULE, name: 'Third, again' }, AUTHOR);
    expect(await used(fixture.storeId)).toBe(2);
  });

  it('two CONCURRENT creates at the last slot produce exactly one rule', async () => {
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const fixture = await mintStore({ limit: 1 });
      const results = await Promise.allSettled([
        createRule(fixture.storeId, { ...PAUSE_RULE, name: 'A' }, AUTHOR),
        createRule(fixture.storeId, { ...PAUSE_RULE, name: 'B' }, AUTHOR),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(PlanCapabilityRefusal);
      expect(await listRules(fixture.storeId)).toHaveLength(1);
      expect(await used(fixture.storeId)).toBe(1);
    }
  });

  it('an unlimited allowance still counts, and still releases', async () => {
    const fixture = await mintStore({ limit: null });
    const rule = await createRule(fixture.storeId, PAUSE_RULE, AUTHOR);
    expect(await used(fixture.storeId)).toBe(1);
    await deleteRule(fixture.storeId, rule.id, AUTHOR);
    expect(await used(fixture.storeId)).toBe(0);
  });

  it('a store without the capability is refused a create, and may still read, disable and delete', async () => {
    const fixture = await mintStore({ entitled: false });
    const refusal = await refusalOf(createRule(fixture.storeId, PAUSE_RULE, AUTHOR));
    expect(refusal.code).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);

    // A rule written while the store held the plan (inserted directly here).
    const leftover = await insertAutomationRule(db, {
      storeId: fixture.storeId,
      name: 'From an earlier plan',
      trigger: 'listing_stock_at_or_below',
      action: 'notify_owner',
      stockThreshold: 2,
      createdByOxyUserId: 'oxy-rule-author',
    });
    expect(await listRules(fixture.storeId)).toHaveLength(1);
    expect(await listRuns(fixture.storeId, {})).toEqual([]);
    // Editing needs the plan; turning it off never does.
    const editRefusal = await refusalOf(
      updateRule(fixture.storeId, leftover.id, { stockThreshold: 5 }, AUTHOR),
    );
    expect(editRefusal.code).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    const disabled = await updateRule(fixture.storeId, leftover.id, { enabled: false }, AUTHOR);
    expect(disabled.enabled).toBe(false);
    await deleteRule(fixture.storeId, leftover.id, AUTHOR);
    expect(await listRules(fixture.storeId)).toHaveLength(0);
  });

  it('a rule that moves orders needs orders:fulfill as well', async () => {
    const fixture = await mintStore();
    await expect(
      createRule(
        fixture.storeId,
        { name: 'Process', trigger: 'order_paid', action: 'mark_order_processing' },
        { oxyUserId: 'oxy-x', permissions: ['products:read', 'products:write'] },
      ),
    ).rejects.toThrow(/orders:fulfill/);
    expect(await used(fixture.storeId)).toBe(0);
  });
});

describe('the rule shape', () => {
  it('refuses an action the trigger cannot take, in the service AND in the table', async () => {
    const fixture = await mintStore();
    await expect(
      createRule(
        fixture.storeId,
        { name: 'Bad', trigger: 'order_paid', action: 'pause_listing' },
        AUTHOR,
      ),
    ).rejects.toThrow(/cannot pause_listing/);
    // The same shape written past the service is refused by the pairing CHECK.
    await expect(
      insertAutomationRule(db, {
        storeId: fixture.storeId,
        name: 'Bad',
        trigger: 'order_paid',
        action: 'pause_listing',
        createdByOxyUserId: 'oxy-x',
      }),
    ).rejects.toThrow();
    // ...as is a stock rule with no threshold (one half of the biconditional).
    await expect(
      insertAutomationRule(db, {
        storeId: fixture.storeId,
        name: 'Bad',
        trigger: 'listing_stock_at_or_below',
        action: 'notify_owner',
        createdByOxyUserId: 'oxy-x',
      }),
    ).rejects.toThrow();
    // A minimum in a currency the store does not total orders in is refused.
    await expect(
      createRule(
        fixture.storeId,
        {
          name: 'Big orders',
          trigger: 'order_paid',
          action: 'notify_owner',
          minOrderTotal: { amount: 100, currency: 'EUR' },
        },
        AUTHOR,
      ),
    ).rejects.toThrow(/FAIR/);
    expect(await used(fixture.storeId)).toBe(0);
  });
});

describe('a stock rule pauses once per dip and republishes what it paused', () => {
  it('pauses a sold-out listing, does nothing on the next pass, and republishes on restock', async () => {
    const fixture = await mintStore();
    const soldOut = await mintProduct(fixture, 0);
    const inStock = await mintProduct(fixture, 7);
    const rule = await createRule(fixture.storeId, PAUSE_RULE, AUTHOR);
    const scope = { storeIds: [fixture.storeId] };

    const first = await evaluateAutomationRules(scope);
    expect(first.runsRecorded).toBe(1);
    expect(await statusOf(soldOut.listingId)).toBe('draft');
    expect(await statusOf(inStock.listingId)).toBe('active');
    const [episode] = await listStockEpisodes(rule.id);
    expect(episode?.pausedByRule).toBe(true);

    // Idempotent: the open episode is the occurrence, so a second pass is silent.
    expect((await evaluateAutomationRules(scope)).runsRecorded).toBe(0);
    expect(await listRuns(fixture.storeId, { ruleId: rule.id })).toHaveLength(1);

    await setAvailable(soldOut.variantId, soldOut.listingId, fixture.locationId, 4);
    const restocked = await evaluateAutomationRules(scope);
    expect(restocked.runsRecorded).toBe(1);
    expect(await statusOf(soldOut.listingId)).toBe('active');
    expect(await listStockEpisodes(rule.id)).toHaveLength(0);
    const runs = await listRuns(fixture.storeId, { ruleId: rule.id });
    expect(runs.map((run) => [run.step, run.outcome])).toEqual([
      ['republish_listing', 'succeeded'],
      ['pause_listing', 'succeeded'],
    ]);
    expect((await evaluateAutomationRules(scope)).runsRecorded).toBe(0);
  });

  it('two CONCURRENT passes act on a listing once', async () => {
    const fixture = await mintStore();
    const product = await mintProduct(fixture, 0);
    const rule = await createRule(fixture.storeId, PAUSE_RULE, AUTHOR);
    const scope = { storeIds: [fixture.storeId] };
    const [a, b] = await Promise.all([
      evaluateAutomationRules(scope),
      evaluateAutomationRules(scope),
    ]);
    expect(a.runsRecorded + b.runsRecorded).toBe(1);
    expect(await listAutomationRuleRuns({ storeId: fixture.storeId, limit: 10 })).toHaveLength(1);
    expect(await statusOf(product.listingId)).toBe('draft');
    expect((await listStockEpisodes(rule.id)).length).toBe(1);
  });

  it('never touches a RESTRICTED listing, and never republishes one a jury restricted', async () => {
    const fixture = await mintStore();
    const restricted = await mintProduct(fixture, 0);
    expect(await setListingStatusIfIn(restricted.listingId, 'restricted', ['active'])).toBe(true);
    const paused = await mintProduct(fixture, 0);
    await createRule(fixture.storeId, PAUSE_RULE, AUTHOR);
    const scope = { storeIds: [fixture.storeId] };

    await evaluateAutomationRules(scope);
    expect(await statusOf(restricted.listingId)).toBe('restricted');
    expect(await statusOf(paused.listingId)).toBe('draft');

    // A jury restricts the listing the rule paused; then stock comes back.
    expect(await setListingStatusIfIn(paused.listingId, 'restricted', ['draft'])).toBe(true);
    await setAvailable(paused.variantId, paused.listingId, fixture.locationId, 3);
    await setAvailable(restricted.variantId, restricted.listingId, fixture.locationId, 3);
    await evaluateAutomationRules(scope);
    expect(await statusOf(paused.listingId)).toBe('restricted');
    expect(await statusOf(restricted.listingId)).toBe('restricted');
    const republish = (await listRuns(fixture.storeId, {})).find(
      (run) => run.step === 'republish_listing',
    );
    expect(republish?.outcome).toBe('skipped');
    expect(republish?.subjectId).toBe(paused.listingId);
  });

  it('leaves a listing the MERCHANT republished alone, and never republishes one it did not pause', async () => {
    const fixture = await mintStore();
    const product = await mintProduct(fixture, 0);
    const alreadyDraft = await mintProduct(fixture, 0);
    expect(await setListingStatusIfIn(alreadyDraft.listingId, 'draft', ['active'])).toBe(true);
    await createRule(fixture.storeId, PAUSE_RULE, AUTHOR);
    const scope = { storeIds: [fixture.storeId] };

    await evaluateAutomationRules(scope);
    expect(await statusOf(product.listingId)).toBe('draft');
    // The merchant's own draft opened no episode at all.
    expect(await statusOf(alreadyDraft.listingId)).toBe('draft');

    await setAvailable(alreadyDraft.variantId, alreadyDraft.listingId, fixture.locationId, 2);
    await evaluateAutomationRules(scope);
    expect(await statusOf(alreadyDraft.listingId)).toBe('draft');
  });

  it('scopes by tag and never reaches another store', async () => {
    const mine = await mintStore();
    const theirs = await mintStore();
    const tagged = await mintProduct(mine, 0, ['Seasonal']);
    const untagged = await mintProduct(mine, 0);
    const foreign = await mintProduct(theirs, 0, ['seasonal']);
    await createRule(mine.storeId, { ...PAUSE_RULE, tag: 'seasonal' }, AUTHOR);

    // Even a pass over BOTH stores acts only within the rule's own store.
    await evaluateAutomationRules({ storeIds: [mine.storeId, theirs.storeId] });
    expect(await statusOf(tagged.listingId)).toBe('draft');
    expect(await statusOf(untagged.listingId)).toBe('active');
    expect(await statusOf(foreign.listingId)).toBe('active');
  });

  it('a notify rule tells the store owner once per dip', async () => {
    const fixture = await mintStore();
    const product = await mintProduct(fixture, 1);
    await createRule(
      fixture.storeId,
      {
        name: 'Running low',
        trigger: 'listing_stock_at_or_below',
        action: 'notify_owner',
        stockThreshold: 2,
      },
      AUTHOR,
    );
    const scope = { storeIds: [fixture.storeId] };
    await evaluateAutomationRules(scope);
    await evaluateAutomationRules(scope);
    const sent = await db
      .select({ id: notifications.id, type: notifications.type })
      .from(notifications)
      .where(eq(notifications.oxyUserId, fixture.ownerAccountId));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('low_inventory');
    expect(await statusOf(product.listingId)).toBe('active');
  });

  it('runs nothing for a store that does not hold the capability', async () => {
    const fixture = await mintStore({ entitled: false });
    const product = await mintProduct(fixture, 0);
    await insertAutomationRule(db, {
      storeId: fixture.storeId,
      name: 'From an earlier plan',
      trigger: 'listing_stock_at_or_below',
      action: 'pause_listing',
      stockThreshold: 0,
      createdByOxyUserId: 'oxy-rule-author',
    });
    const summary = await evaluateAutomationRules({ storeIds: [fixture.storeId] });
    expect(summary.rulesSkippedNotEntitled).toBe(1);
    expect(summary.runsRecorded).toBe(0);
    expect(await statusOf(product.listingId)).toBe('active');
  });

  it('still runs a store sitting exactly at its ceiling', async () => {
    const fixture = await mintStore({ limit: 1 });
    const product = await mintProduct(fixture, 0);
    await createRule(fixture.storeId, PAUSE_RULE, AUTHOR);
    expect(await used(fixture.storeId)).toBe(1);
    const summary = await evaluateAutomationRules({ storeIds: [fixture.storeId] });
    expect(summary.runsRecorded).toBe(1);
    expect(await statusOf(product.listingId)).toBe('draft');
  });
});

describe('an order rule acts once per paid order, through order.service', () => {
  const PROCESS_RULE: CreateAutomationRuleInput = {
    name: 'Start packing',
    trigger: 'order_paid',
    action: 'mark_order_processing',
  };

  it('marks a paid shipped order processing once, and skips what it may not move', async () => {
    const fixture = await mintStore();
    const product = await mintProduct(fixture, 5);
    const rule = await createRule(fixture.storeId, PROCESS_RULE, AUTHOR);
    const before = await mintPaidOrder(fixture, product, {
      paidAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const fresh = await mintPaidOrder(fixture, product);
    const held = await mintPaidOrder(fixture, product);
    await setOrderModerationHold([held], true);
    const pickup = await mintPaidOrder(fixture, product, { shippingMethod: 'pickup' });
    const scope = { storeIds: [fixture.storeId] };

    const summary = await evaluateAutomationRules(scope);
    expect(summary.runsRecorded).toBe(3);
    expect((await findOrderById(fresh))?.status).toBe('processing');
    // The moderation freeze outranks the rule: the order stays paid.
    expect((await findOrderById(held))?.status).toBe('paid');
    expect((await findOrderById(pickup))?.status).toBe('paid');
    // Paid before the rule was armed: never considered.
    expect((await findOrderById(before))?.status).toBe('paid');

    const runs = await listRuns(fixture.storeId, { ruleId: rule.id });
    const bySubject = new Map(runs.map((run) => [run.subjectId, run]));
    expect(bySubject.get(fresh)?.outcome).toBe('succeeded');
    expect(bySubject.get(held)?.outcome).toBe('skipped');
    expect(bySubject.get(held)?.detail).toMatch(/held/);
    expect(bySubject.get(pickup)?.outcome).toBe('skipped');
    expect(bySubject.has(before)).toBe(false);

    // Idempotent per (rule, order, paid).
    expect((await evaluateAutomationRules(scope)).runsRecorded).toBe(0);
  });

  it('honours the minimum total in the store currency', async () => {
    const fixture = await mintStore();
    const product = await mintProduct(fixture, 5);
    await createRule(
      fixture.storeId,
      {
        name: 'Big orders',
        trigger: 'order_paid',
        action: 'notify_owner',
        minOrderTotal: { amount: 10_000, currency: 'FAIR' },
      },
      AUTHOR,
    );
    const small = await mintPaidOrder(fixture, product, { total: 500 });
    const big = await mintPaidOrder(fixture, product, { total: 20_000 });
    await evaluateAutomationRules({ storeIds: [fixture.storeId] });
    const runs = await listRuns(fixture.storeId, {});
    expect(runs.map((run) => run.subjectId)).toEqual([big]);
    expect(runs.map((run) => run.subjectId)).not.toContain(small);
    const sent = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.oxyUserId, fixture.ownerAccountId),
          eq(notifications.type, 'order_paid'),
        ),
      );
    expect(sent).toHaveLength(1);
  });

  it('re-arms on enable, so a rule switched back on never reaches back over the gap', async () => {
    const fixture = await mintStore();
    const product = await mintProduct(fixture, 5);
    const rule = await createRule(fixture.storeId, { ...PROCESS_RULE, enabled: false }, AUTHOR);
    const duringGap = await mintPaidOrder(fixture, product);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await updateRule(fixture.storeId, rule.id, { enabled: true }, AUTHOR);
    const [stored] = await db
      .select({ armedAt: automationRules.armedAt })
      .from(automationRules)
      .where(eq(automationRules.id, rule.id));
    expect(stored?.armedAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
    await evaluateAutomationRules({ storeIds: [fixture.storeId] });
    expect((await findOrderById(duringGap))?.status).toBe('paid');
  });
});
