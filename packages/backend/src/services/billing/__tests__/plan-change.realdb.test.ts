/**
 * Selling FOUR paid plans makes "one subscription per store" load-bearing: a
 * second checkout while one is live would start a second rail subscription
 * that `merchant_subscriptions_store_key` could only record by overwriting the
 * first. So a store that already pays CHANGES plan (one rail subscription, its
 * price swapped) and a checkout is refused. Real SQL, a fake rail.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { stores } from '../../../db/schema/stores.js';
import { merchantSubscriptions } from '../../../db/schema/merchantPlans.js';
import {
  activateMerchantPlan,
  findMerchantPlanAcceptance,
  insertMerchantPlan,
  insertMerchantPlanPrice,
} from '../../../db/merchantPlans/planRepository.js';
import { ensureBillingCustomer } from '../../../db/merchantPlans/subscriptionRepository.js';
import {
  registerBillingProvider,
  resetBillingProviders,
  type BillingProvider,
  type BillingSubscriptionSnapshot,
} from '../provider.js';
import { changeMerchantPlan, startMerchantPlanCheckout } from '../subscription.service.js';
import { MercariaError } from '../../../lib/errors/error-codes.js';

vi.mock('../../../config/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../config/index.js')>();
  return {
    ...original,
    config: {
      ...original.config,
      merchantBilling: {
        ...original.config.merchantBilling,
        enabled: true,
        returnUrl: 'https://dashboard.mercaria.co/settings/plan',
      },
    },
  };
});

let db: Database;
const N = randomUUID().replaceAll('-', '').slice(0, 16);
const storeId = `${N}0000000000plan`.slice(0, 26);
const customer = `cus_chg${N}`;
const subscriptionRef = `sub_chg${N}`;
const price = {
  goMonthlyUsd: `price_gomusd${N}`,
  goAnnualUsd: `price_goausd${N}`,
  plusMonthlyUsd: `price_plmusd${N}`,
  plusMonthlyEur: `price_plmeur${N}`,
};
const plans: Record<'go' | 'plus', string> = { go: '', plus: '' };

/** The rail's state for the one subscription. */
let railPrice = price.goMonthlyUsd;
const changes: { price: string; key: string }[] = [];
const checkouts: string[] = [];

function snapshot(): BillingSubscriptionSnapshot {
  return {
    providerSubscriptionId: subscriptionRef,
    providerCustomerId: customer,
    livemode: false,
    status: 'active',
    interval: railPrice === price.goAnnualUsd ? 'annual' : 'monthly',
    providerPriceId: railPrice,
    currentPeriodStart: new Date(Date.now() - 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 29 * 86_400_000),
  };
}

const fakeRail: BillingProvider = {
  id: 'peable',
  livemode: false,
  ensureCustomer: async () => ({ providerCustomerId: customer }),
  createCheckoutSession: async (input) => {
    checkouts.push(input.providerPriceId);
    return {
      sessionId: 'cs_fixture',
      clientSecret: 'cs_fixture_secret_fixture',
      amountMinor: 0,
      currency: 'USD',
      livemode: false,
    };
  },
  createPortalSession: async () => ({ url: 'https://checkout.peable.to/p/fixture' }),
  retrieveSubscription: async () => snapshot(),
  retrieveInvoice: async () => {
    throw new Error('not used');
  },
  cancelAtPeriodEnd: async () => snapshot(),
  changeSubscriptionPrice: async (input) => {
    changes.push({ price: input.providerPriceId, key: input.idempotencyKey });
    railPrice = input.providerPriceId;
    return snapshot();
  },
};

async function paidPlan(
  key: 'go' | 'plus',
  rows: { interval: 'monthly' | 'annual'; currency: 'USD' | 'EUR'; id: string }[],
) {
  const plan = await insertMerchantPlan(db, {
    planKey: `${key}-${N}`,
    version: 1,
    tier: 'paid',
    name: `Fixture ${key}`,
    summary: 'test fixture',
    termsVersion: `terms-${key}`,
    createdByOxyUserId: 'test',
  });
  for (const row of rows) {
    await insertMerchantPlanPrice(db, {
      planId: plan.id,
      provider: 'peable',
      livemode: false,
      interval: row.interval,
      unitPrice: { amount: 499, currency: row.currency },
      providerPriceId: row.id,
    });
  }
  await activateMerchantPlan(db, { id: plan.id, approvedByOxyUserId: 'test' });
  return plan.id;
}

beforeAll(async () => {
  db = await connectPostgres();
  await db.insert(stores).values({
    id: storeId,
    oxyAccountId: `fixture-${N}`,
    handle: `plan-change-${N}`,
    name: 'Plan change fixture',
    description: '',
    brandColor: '#101010',
  });
  plans.go = await paidPlan('go', [
    { interval: 'monthly', currency: 'USD', id: price.goMonthlyUsd },
    { interval: 'annual', currency: 'USD', id: price.goAnnualUsd },
  ]);
  plans.plus = await paidPlan('plus', [
    { interval: 'monthly', currency: 'USD', id: price.plusMonthlyUsd },
    { interval: 'monthly', currency: 'EUR', id: price.plusMonthlyEur },
  ]);
  const billing = await ensureBillingCustomer(db, {
    storeId,
    provider: 'peable',
    livemode: false,
    providerCustomerId: customer,
  });
  const now = new Date();
  await db.insert(merchantSubscriptions).values({
    storeId,
    planId: plans.go,
    billingCustomerId: billing.row.id,
    provider: 'peable',
    livemode: false,
    providerSubscriptionId: subscriptionRef,
    status: 'active',
    interval: 'monthly',
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    acceptedTermsVersion: 'terms-go',
    acceptedByOxyUserId: 'owner',
    acceptedAt: now,
  });
}, 120_000);

beforeEach(() => {
  resetBillingProviders();
  registerBillingProvider(fakeRail);
});

afterAll(async () => {
  resetBillingProviders();
  await closePostgres();
});

const subscriptionRow = async () =>
  (
    await db.select().from(merchantSubscriptions).where(eq(merchantSubscriptions.storeId, storeId))
  )[0];

describe('a store that already pays', () => {
  it('cannot start a second subscription through checkout', async () => {
    await expect(
      startMerchantPlanCheckout({
        storeId,
        storeName: 'fixture',
        planId: plans.plus,
        interval: 'monthly',
        currency: 'USD',
        actorOxyUserId: 'owner',
      }),
    ).rejects.toThrow(/Change plan instead/);
    expect(checkouts).toEqual([]);
  });

  it('changes plan on the ONE rail subscription, accepting the new terms first', async () => {
    const row = await changeMerchantPlan({
      storeId,
      planId: plans.plus,
      interval: 'monthly',
      currency: 'USD',
      actorOxyUserId: 'owner',
    });
    expect(changes.at(-1)?.price).toBe(price.plusMonthlyUsd);
    expect(row.planId).toBe(plans.plus);
    expect((await subscriptionRow())?.providerSubscriptionId).toBe(subscriptionRef);
    expect(
      await findMerchantPlanAcceptance(db, { storeId, planKey: `plus-${N}`, planVersion: 1 }),
    ).toMatchObject({ termsVersion: 'terms-plus', acceptedByOxyUserId: 'owner' });
  });

  it('refuses the plan and period it is already on, and a different currency', async () => {
    await expect(
      changeMerchantPlan({
        storeId,
        planId: plans.plus,
        interval: 'monthly',
        currency: 'USD',
        actorOxyUserId: 'owner',
      }),
    ).rejects.toThrow(/already on that plan/);
    await expect(
      changeMerchantPlan({
        storeId,
        planId: plans.plus,
        interval: 'monthly',
        currency: 'EUR',
        actorOxyUserId: 'owner',
      }),
    ).rejects.toThrow(/keeps that currency/);
  });

  it('moves between monthly and annual', async () => {
    const row = await changeMerchantPlan({
      storeId,
      planId: plans.go,
      interval: 'annual',
      currency: 'USD',
      actorOxyUserId: 'owner',
    });
    expect(row).toMatchObject({ planId: plans.go, interval: 'annual' });
  });

  it('is refused while the last payment failed', async () => {
    await db
      .update(merchantSubscriptions)
      .set({ status: 'past_due', graceExpiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(merchantSubscriptions.storeId, storeId));
    const refusal = await changeMerchantPlan({
      storeId,
      planId: plans.plus,
      interval: 'monthly',
      currency: 'USD',
      actorOxyUserId: 'owner',
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MercariaError);
    expect((refusal as MercariaError).httpStatus).toBe(409);
  });
});
