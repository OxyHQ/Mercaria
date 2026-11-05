/**
 * The plan catalogue publish against migrated SQL and an in-memory Orbit: it
 * creates what is missing exactly once, binds the Mercaria versions to the
 * Orbit prices it found or made, activates them, converges on a re-run, and
 * REFUSES drift instead of editing a published price or version.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  listMerchantPlanPrices,
  listMerchantPlans,
  listPlanEntitlements,
} from '../../../db/merchantPlans/planRepository.js';
import { ensureCapabilityAvailable } from '../../entitlements/__tests__/entitle-store.js';
import {
  CatalogueDrift,
  syncMerchantPlanCatalogue,
  type CatalogueSyncClient,
} from '../plan-catalogue-sync.js';
import type { CataloguePlan } from '../plan-catalogue.js';

let db: Database;
const RUN = randomUUID().replaceAll('-', '').slice(0, 10);

beforeAll(async () => {
  db = await connectPostgres();
  await ensureCapabilityAvailable(db, 'automation_rules');
  await ensureCapabilityAvailable(db, 'advanced_demand_analytics');
}, 120_000);
afterAll(async () => {
  await closePostgres();
});

function plan(key: string, amount = 499): CataloguePlan {
  return {
    planKey: `${key}${RUN}`,
    version: 1,
    name: `Fixture ${key}`,
    summary: 'test fixture',
    entitlements: [
      { capability: 'automation_rules', limit: 5 },
      { capability: 'advanced_demand_analytics', limit: null },
    ],
    prices: [
      { interval: 'monthly', currency: 'USD', amount },
      { interval: 'annual', currency: 'USD', amount: amount * 10 },
      { interval: 'monthly', currency: 'EUR', amount },
    ],
  };
}

/** An in-memory Orbit with just the calls the sync makes. */
function fakeOrbit(merchant = { id: 'merch_fixture', livemode: false }) {
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${RUN}${++seq}`;
  const products: { id: string; metadata: Record<string, string> }[] = [];
  const prices: Record<string, unknown>[] = [];
  const features: { id: string; lookup_key: string }[] = [];
  const attached = new Map<string, Set<string>>();
  const calls: string[] = [];
  const client = {
    merchants: { retrieve: async () => merchant },
    billingSettings: { retrieve: async () => ({ dunning: { retry_schedule_days: [1, 3, 5, 7] } }) },
    entitlements: {
      features: {
        list: async (q: { lookup_key: string }) => ({
          data: features.filter((f) => f.lookup_key === q.lookup_key),
        }),
        create: async (body: { lookup_key: string }) => {
          calls.push(`feature:${body.lookup_key}`);
          const row = { id: id('feat'), lookup_key: body.lookup_key };
          features.push(row);
          return row;
        },
      },
      productFeatures: {
        list: async (productId: string) => ({
          data: [...(attached.get(productId) ?? [])].map((f) => ({
            entitlement_feature: { id: f },
          })),
        }),
        attach: async (productId: string, body: { entitlement_feature: string }) => {
          calls.push(`attach:${productId}`);
          attached.set(
            productId,
            (attached.get(productId) ?? new Set()).add(body.entitlement_feature),
          );
          return {};
        },
      },
    },
    products: {
      search: async (q: { query: string }) => {
        const key = /'([^']+)'$/.exec(q.query)?.[1];
        return { data: products.filter((p) => p.metadata.mercaria_plan === key) };
      },
      create: async (body: { metadata: Record<string, string> }) => {
        calls.push(`product:${body.metadata.mercaria_plan}`);
        const row = { id: id('prod'), metadata: body.metadata };
        products.push(row);
        return row;
      },
    },
    prices: {
      list: async (q: { lookup_keys: string[] }) => ({
        data: prices.filter((p) => q.lookup_keys.includes(p.lookup_key as string)),
      }),
      create: async (body: Record<string, unknown>) => {
        calls.push(`price:${String(body.lookup_key)}`);
        const row = {
          id: id('price'),
          active: true,
          currency: body.currency,
          unit_amount: body.unit_amount,
          recurring: {
            interval: (body.recurring as { interval: string }).interval,
            interval_count: 1,
          },
          product: body.product,
          lookup_key: body.lookup_key,
          tax_behavior: body.tax_behavior,
        };
        prices.push(row);
        return row;
      },
    },
  };
  return { client: client as unknown as CatalogueSyncClient, prices, calls };
}

const run = (client: CatalogueSyncClient, plans: CataloguePlan[], apply: boolean) =>
  syncMerchantPlanCatalogue(client, db, {
    merchantId: 'merch_fixture',
    livemode: false,
    apply,
    actor: 'test-actor',
    plans,
    includeSharedRows: false,
  });

describe('publishing the plan catalogue', () => {
  it('previews without writing, then creates, binds and activates, then converges', async () => {
    const orbit = fakeOrbit();
    const plans = [plan('alpha'), plan('beta', 999)];

    const preview = await run(orbit.client, plans, false);
    expect(orbit.calls).toEqual([]);
    expect(preview.actions).toContain(`create product alpha${RUN}@1`);
    expect(preview.versions.every((v) => v.status === 'would-activate')).toBe(true);
    expect(preview.dunningRetryScheduleDays).toEqual([1, 3, 5, 7]);
    expect(await listMerchantPlans(db, { planKey: `alpha${RUN}` })).toHaveLength(0);

    const applied = await run(orbit.client, plans, true);
    expect(orbit.calls.filter((c) => c.startsWith('product:'))).toHaveLength(2);
    expect(orbit.calls.filter((c) => c.startsWith('price:'))).toHaveLength(6);
    // One feature per capability, shared by both products.
    expect(orbit.calls.filter((c) => c.startsWith('feature:'))).toHaveLength(2);
    expect(orbit.prices.every((p) => p.tax_behavior === 'exclusive')).toBe(true);
    expect(applied.versions.map((v) => v.status)).toEqual(['active', 'active']);

    const [alpha] = await listMerchantPlans(db, { planKey: `alpha${RUN}` });
    expect(alpha).toMatchObject({
      status: 'active',
      trialDays: 0,
      gracePeriodDays: 16,
      tier: 'paid',
    });
    if (!alpha) throw new Error('alpha missing');
    const rows = await listMerchantPlanPrices(db, { planIds: [alpha.id], livemode: false });
    expect(rows.map((r) => [r.interval, r.unitPriceCurrency, r.unitPriceAmount]).sort()).toEqual(
      [
        ['annual', 'USD', 4990],
        ['monthly', 'EUR', 499],
        ['monthly', 'USD', 499],
      ].sort(),
    );
    const entitlements = await listPlanEntitlements(db, [alpha.id]);
    expect(entitlements.map((e) => [e.capabilityKey, e.limitValue]).sort()).toEqual(
      [
        ['advanced_demand_analytics', null],
        ['automation_rules', 5],
      ].sort(),
    );

    const before = orbit.calls.length;
    const again = await run(orbit.client, plans, true);
    expect(orbit.calls.length).toBe(before);
    expect(again.actions).toEqual([]);
  });

  it('refuses an Orbit price that drifted from the catalogue', async () => {
    const orbit = fakeOrbit();
    await run(orbit.client, [plan('gamma')], true);
    const monthly = orbit.prices.find((p) => String(p.lookup_key).includes('monthly_usd'));
    if (!monthly) throw new Error('no monthly price');
    monthly.unit_amount = '1';
    await expect(run(orbit.client, [plan('gamma')], false)).rejects.toThrow(CatalogueDrift);
  });

  it('refuses a published version whose catalogue entry changed', async () => {
    const orbit = fakeOrbit();
    await run(orbit.client, [plan('delta')], true);
    const changed = { ...plan('delta'), summary: 'a different promise' };
    await expect(run(orbit.client, [changed], false)).rejects.toThrow(/publish a new version/);
  });

  it('refuses another merchant or the other mode', async () => {
    await expect(
      run(fakeOrbit({ id: 'merch_other', livemode: false }).client, [plan('eps')], false),
    ).rejects.toThrow(/not merch_fixture/);
    await expect(
      run(fakeOrbit({ id: 'merch_fixture', livemode: true }).client, [plan('eps')], false),
    ).rejects.toThrow(/live/);
  });
});
