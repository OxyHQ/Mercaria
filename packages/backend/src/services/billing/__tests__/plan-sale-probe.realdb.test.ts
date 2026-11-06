/**
 * The live no-money probe ALWAYS expires what it opened — including when the
 * hosted page fails — and probes every published price of every active paid
 * version. Real SQL, a fake gateway.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  activateMerchantPlan,
  insertMerchantPlan,
  insertMerchantPlanPrice,
} from '../../../db/merchantPlans/planRepository.js';
import { probePlanCheckouts, type CheckoutProbeClient } from '../plan-sale-probe.js';

let db: Database;
const N = randomUUID().replaceAll('-', '').slice(0, 12);
const priceIds = [`price_pa${N}`, `price_pb${N}`];

beforeAll(async () => {
  db = await connectPostgres();
  const plan = await insertMerchantPlan(db, {
    planKey: `probe-${N}`,
    version: 1,
    tier: 'paid',
    name: 'Probe fixture',
    summary: 'test fixture',
    termsVersion: 'fixture',
    createdByOxyUserId: 'test',
  });
  for (const [index, id] of priceIds.entries()) {
    await insertMerchantPlanPrice(db, {
      planId: plan.id,
      provider: 'peable',
      livemode: false,
      interval: index === 0 ? 'monthly' : 'annual',
      unitPrice: { amount: 499, currency: 'USD' },
      providerPriceId: id,
    });
  }
  await activateMerchantPlan(db, { id: plan.id, approvedByOxyUserId: 'test' });
}, 120_000);
afterAll(async () => {
  await closePostgres();
});

it('opens, fetches and expires one session per price, even when a page fails', async () => {
  const created: string[] = [];
  const expired: string[] = [];
  const client = {
    customers: { create: async () => ({ id: 'cus_probe' }) },
    checkout: {
      sessions: {
        create: async (body: {
          line_items: { price: string }[];
          payment_method_types?: unknown;
        }) => {
          const price = body.line_items[0]?.price ?? '';
          created.push(price);
          // Mercaria never narrows a plan session's methods (Peable ADR 0021):
          // the field is absent and the gateway answers card AND FairCoin.
          expect(body.payment_method_types).toBeUndefined();
          return {
            id: `cs_${price}`,
            url: `https://checkout.peable.to/c/${price}`,
            payment_method_types: ['card', 'faircoin'],
          };
        },
        expire: async (id: string) => {
          expired.push(id);
          return { id, status: 'expired' };
        },
      },
    },
  } as unknown as CheckoutProbeClient;

  const results = await probePlanCheckouts(client, db, {
    livemode: false,
    returnUrl: 'https://dashboard.mercaria.co/settings/plan',
    runId: N,
    fetchPage: async (url) => {
      if (url.endsWith(priceIds[1] ?? '')) throw new Error('page down');
      return 200;
    },
  });
  const mine = results.filter((r) => r.planKey === `probe-${N}`);
  expect(mine.map((r) => r.providerPriceId).sort()).toEqual([...priceIds].sort());
  for (const id of priceIds) expect(expired).toContain(`cs_${id}`);
  expect(mine.find((r) => r.providerPriceId === priceIds[0])).toMatchObject({
    pageStatus: 200,
    expired: true,
    paymentMethodTypes: ['card', 'faircoin'],
  });
  expect(mine.find((r) => r.providerPriceId === priceIds[1])?.error).toMatch(/page down/);
});
