/**
 * The checkout conversion report (#89 `advanced_demand_analytics`) against a
 * real server: what counts as a checkout, the cohort floor at its boundary, the
 * projection carrying no buyer field, and the route's two gates — `stats:read`
 * and the plan.
 *
 * Every fixture is scoped to stores this file mints, so the shared database's
 * other orders can never reach an assertion: each read is keyed by store id.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import {
  ANALYTICS_MERCHANT_MIN_COHORT,
  STORE_ROLE_PERMISSIONS,
  type OrderStatus,
  type StoreAccountRole,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { stores } from '../../db/schema/stores.js';
import { orders } from '../../db/schema/orders.js';
import { insertOrder, nextOrderNumber, type NewOrder } from '../../db/orders/orderRepository.js';
import {
  countCheckoutsByBucket,
  countListingCheckouts,
  countStoreCheckouts,
} from '../../db/orders/conversionReportRepository.js';
import { entitleStoreForTest } from '../entitlements/__tests__/entitle-store.js';
import {
  getConversionTrendReport,
  getListingConversionReport,
} from '../conversion-report.service.js';
import conversionReportRouter from '../../routes/admin/conversion-report.js';

let db: Database;
const RUN = uuidv7().slice(-12);
const CURRENCY = 'EUR' as const;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      oxyAccountId: 'oxy-account-fixture',
      handle: `conversion-${RUN}-${label}-${uuidv7().slice(-6)}`,
      name: `Conversion ${label}`,
      description: '',
      brandColor: '#101010',
      defaultCurrency: CURRENCY,
    })
    .returning();
  if (!row) throw new Error('store insert returned no row');
  return row.id;
}

function dual(amount: number) {
  return {
    shop: { amount, currency: CURRENCY },
    presentment: { amount, currency: CURRENCY },
  } as const;
}

type Outcome = 'paid' | 'refunded' | 'abandoned' | 'open';

const OUTCOMES: Record<Outcome, { status: OrderStatus; paymentStatus: NewOrder['paymentStatus'] }> =
  {
    paid: { status: 'paid', paymentStatus: 'paid' },
    refunded: { status: 'refunded', paymentStatus: 'refunded' },
    abandoned: { status: 'cancelled', paymentStatus: 'unpaid' },
    open: { status: 'pending_payment', paymentStatus: 'unpaid' },
  };

/**
 * One order on `storeId` created at `createdAt`, holding one line per listing.
 * `channel` and `imported` make the orders the report must NOT count.
 */
async function order(
  storeId: string,
  input: {
    listings: readonly { id: string; title?: string; quantity?: number }[];
    outcome: Outcome;
    createdAt: Date;
    channel?: 'storefront' | 'pos' | 'draft';
    imported?: boolean;
  },
): Promise<string> {
  const { status, paymentStatus } = OUTCOMES[input.outcome];
  const created = await insertOrder({
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${uuidv7()}`,
    sellerType: 'store',
    commercialRole: 'connected_marketplace',
    storeId,
    sourceChannel: input.channel ?? 'storefront',
    shippingAddress: {
      recipientName: 'Buyer',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
    shippingMethod: 'standard',
    shippingLabel: 'Standard shipping',
    shippingCost: dual(0),
    totals: {
      subtotal: dual(1000),
      discountTotal: dual(0),
      shipping: dual(0),
      tax: dual(0),
      grandTotal: dual(1000),
    },
    status,
    paymentStatus,
    ...(paymentStatus === 'paid' || paymentStatus === 'refunded'
      ? { paymentPaidAt: input.createdAt }
      : {}),
    checkoutGroupId: uuidv7(),
    items: input.listings.map((listing) => ({
      listingId: listing.id,
      variantId: uuidv7(),
      title: listing.title ?? `Listing ${listing.id.slice(-4)}`,
      variantTitle: 'Default Title',
      optionValues: [],
      unitPrice: dual(1000),
      quantity: listing.quantity ?? 1,
      lineTotal: dual(1000 * (listing.quantity ?? 1)),
    })),
    statusHistory: [{ status, at: input.createdAt, actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
  });
  await db
    .update(orders)
    .set({
      createdAt: input.createdAt,
      ...(input.imported ? { sourceProvider: 'shopify' as const } : {}),
    })
    .where(eq(orders.id, created.id));
  return created.id;
}

/** `n` orders of one outcome on one listing, a day apart starting at `start`. */
async function orders_(
  storeId: string,
  listing: { id: string; title?: string; quantity?: number },
  outcome: Outcome,
  n: number,
  start: Date,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await order(storeId, {
      listings: [listing],
      outcome,
      createdAt: new Date(start.getTime() + i * 3_600_000),
    });
  }
}

const IN_WINDOW = new Date('2026-10-05T10:00:00.000Z'); // a Monday
const WINDOW = { from: '2026-10-05', to: '2026-10-18' } as const;

describe('what counts as a checkout', () => {
  it('counts native storefront checkouts only, partitions them, and keeps stores apart', async () => {
    const storeId = await mintStore('counts');
    const other = await mintStore('counts-other');
    const listing = { id: uuidv7(), title: 'Wool scarf', quantity: 2 };

    await orders_(storeId, listing, 'paid', 3, IN_WINDOW);
    await orders_(storeId, listing, 'refunded', 1, IN_WINDOW);
    await orders_(storeId, listing, 'abandoned', 2, IN_WINDOW);
    await orders_(storeId, listing, 'open', 1, IN_WINDOW);
    // Not buyer checkouts on Mercaria: a register sale, a converted draft and
    // a connector import — and an order outside the window, and one on
    // another store.
    await order(storeId, {
      listings: [listing],
      outcome: 'paid',
      createdAt: IN_WINDOW,
      channel: 'pos',
    });
    await order(storeId, {
      listings: [listing],
      outcome: 'paid',
      createdAt: IN_WINDOW,
      channel: 'draft',
    });
    await order(storeId, {
      listings: [listing],
      outcome: 'paid',
      createdAt: IN_WINDOW,
      imported: true,
    });
    await order(storeId, {
      listings: [listing],
      outcome: 'paid',
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
    });
    await order(other, { listings: [listing], outcome: 'paid', createdAt: IN_WINDOW });

    const range = {
      from: new Date('2026-10-05T00:00:00.000Z'),
      to: new Date('2026-10-19T00:00:00.000Z'),
    };
    const totals = await countStoreCheckouts(storeId, range);
    // Refunded counts as converted: the purchase happened.
    expect(totals).toEqual({ started: 7, paid: 4, abandoned: 2, unitsSold: 8 });

    const perListing = await countListingCheckouts(storeId, range);
    expect(perListing).toEqual([
      {
        listingId: listing.id,
        title: 'Wool scarf',
        started: 7,
        paid: 4,
        abandoned: 2,
        unitsSold: 8,
      },
    ]);

    const daily = await countCheckoutsByBucket(storeId, range, 'day');
    expect(daily).toEqual([
      { bucketStart: '2026-10-05', started: 7, paid: 4, abandoned: 2, unitsSold: 8 },
    ]);
  });

  it('counts one checkout per order in the store total, and once for every listing on it', async () => {
    const storeId = await mintStore('multi');
    const a = { id: uuidv7() };
    const b = { id: uuidv7() };
    await order(storeId, { listings: [a, b], outcome: 'paid', createdAt: IN_WINDOW });
    await order(storeId, { listings: [a], outcome: 'open', createdAt: IN_WINDOW });

    const range = {
      from: new Date('2026-10-05T00:00:00.000Z'),
      to: new Date('2026-10-06T00:00:00.000Z'),
    };
    expect(await countStoreCheckouts(storeId, range)).toEqual({
      started: 2,
      paid: 1,
      abandoned: 0,
      unitsSold: 2,
    });
    const byListing = new Map(
      (await countListingCheckouts(storeId, range)).map((r) => [r.listingId, r]),
    );
    expect(byListing.get(a.id)?.started).toBe(2);
    expect(byListing.get(b.id)?.started).toBe(1);
  });

  it('buckets ISO weeks from Monday in UTC', async () => {
    const storeId = await mintStore('weeks');
    const listing = { id: uuidv7() };
    // Sunday 23:30 UTC belongs to the week of Monday the 5th; Monday 00:30 to the 12th.
    await order(storeId, {
      listings: [listing],
      outcome: 'paid',
      createdAt: new Date('2026-10-11T23:30:00.000Z'),
    });
    await order(storeId, {
      listings: [listing],
      outcome: 'paid',
      createdAt: new Date('2026-10-12T00:30:00.000Z'),
    });
    const range = {
      from: new Date('2026-10-05T00:00:00.000Z'),
      to: new Date('2026-10-19T00:00:00.000Z'),
    };
    const weekly = await countCheckoutsByBucket(storeId, range, 'week');
    expect(weekly.map((row) => [row.bucketStart, row.started])).toEqual([
      ['2026-10-05', 1],
      ['2026-10-12', 1],
    ]);
  });
});

describe('the cohort floor, at its boundary', () => {
  it('suppresses a listing one checkout below the floor and publishes one at it', async () => {
    const storeId = await mintStore('floor');
    const atFloor = { id: uuidv7(), title: 'At the floor' };
    const below = { id: uuidv7(), title: 'Below the floor' };
    const strong = { id: uuidv7(), title: 'Strong converter' };
    const floor = ANALYTICS_MERCHANT_MIN_COHORT;

    // At the floor: half paid. Below: every one paid (would top the "best"
    // list if it leaked). Strong: 12 checkouts, 11 paid.
    await orders_(storeId, atFloor, 'paid', floor / 2, IN_WINDOW);
    await orders_(storeId, atFloor, 'abandoned', floor / 2, IN_WINDOW);
    await orders_(storeId, below, 'paid', floor - 1, IN_WINDOW);
    await orders_(storeId, strong, 'paid', 11, IN_WINDOW);
    await orders_(storeId, strong, 'open', 1, IN_WINDOW);

    const report = await getListingConversionReport({ storeId, window: WINDOW });
    expect(report.minimumCohort).toBe(floor);
    expect(report.listings.map((row) => row.listingId)).toEqual([strong.id, atFloor.id]);
    expect(report.suppressedListingCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain(below.id);
    expect(JSON.stringify(report)).not.toContain('Below the floor');

    const at = report.listings.find((row) => row.listingId === atFloor.id);
    expect(at?.figures).toEqual({
      aboveThreshold: true,
      checkoutsStarted: floor,
      paidCheckouts: floor / 2,
      openCheckouts: 0,
      abandonedCheckouts: floor / 2,
      unitsSold: floor / 2,
      conversionRate: 0.5,
    });
    expect(report.bestConverting.map((row) => row.listingId)).toEqual([strong.id, atFloor.id]);
    // Never a repeat of a best one — with two published rows, both are "best".
    expect(report.worstConverting).toEqual([]);
    expect(report.totals.checkoutsStarted).toBe(floor + floor - 1 + 12);
  });

  it('suppresses a whole store, trend bucket and comparison below the floor', async () => {
    const storeId = await mintStore('quiet');
    const listing = { id: uuidv7() };
    await orders_(storeId, listing, 'paid', ANALYTICS_MERCHANT_MIN_COHORT - 1, IN_WINDOW);

    const listingsReport = await getListingConversionReport({ storeId, window: WINDOW });
    expect(listingsReport.totals).toEqual({
      aboveThreshold: false,
      checkoutsStarted: 0,
      paidCheckouts: 0,
      openCheckouts: 0,
      abandonedCheckouts: 0,
      unitsSold: 0,
      conversionRate: null,
    });
    expect(listingsReport.listings).toEqual([]);

    const trend = await getConversionTrendReport({ storeId, window: WINDOW, interval: 'day' });
    expect(trend.buckets).toHaveLength(14);
    expect(trend.buckets.every((bucket) => !bucket.figures.aboveThreshold)).toBe(true);
    expect(trend.current.aboveThreshold).toBe(false);
    expect(trend.change).toBeNull();
  });

  it('compares a published window with the published one before it', async () => {
    const storeId = await mintStore('compare');
    const listing = { id: uuidv7() };
    // Previous window (Sep 21 – Oct 4): 10 checkouts, 5 paid.
    await orders_(storeId, listing, 'paid', 5, new Date('2026-09-22T10:00:00.000Z'));
    await orders_(storeId, listing, 'abandoned', 5, new Date('2026-09-22T10:00:00.000Z'));
    // Current window: 20 checkouts, 15 paid.
    await orders_(storeId, listing, 'paid', 15, IN_WINDOW);
    await orders_(storeId, listing, 'open', 5, IN_WINDOW);

    const trend = await getConversionTrendReport({ storeId, window: WINDOW, interval: 'week' });
    expect(trend.previousWindow).toEqual({ from: '2026-09-21', to: '2026-10-04' });
    expect(trend.buckets.map((bucket) => bucket.bucketStart)).toEqual(['2026-10-05', '2026-10-12']);
    expect(trend.buckets[0]?.figures.checkoutsStarted).toBe(20);
    expect(trend.buckets[1]?.figures.aboveThreshold).toBe(false);
    expect(trend.previous.checkoutsStarted).toBe(10);
    expect(trend.change?.checkoutsStarted).toBeCloseTo(1);
    expect(trend.change?.paidCheckouts).toBeCloseTo(2);
    expect(trend.change?.conversionRate).toBeCloseTo(0.25);
  });
});

/**
 * Every key a report may carry. The projection is the enforcement: a key not
 * here fails, so a buyer field cannot be added without editing this list in
 * plain sight.
 */
const ALLOWED_KEYS = new Set([
  'storeId',
  'window',
  'from',
  'to',
  'minimumCohort',
  'totals',
  'listings',
  'suppressedListingCount',
  'bestConverting',
  'worstConverting',
  'listingId',
  'title',
  'figures',
  'aboveThreshold',
  'checkoutsStarted',
  'paidCheckouts',
  'openCheckouts',
  'abandonedCheckouts',
  'unitsSold',
  'conversionRate',
  'interval',
  'buckets',
  'bucketStart',
  'current',
  'previousWindow',
  'previous',
  'change',
]);

const IDENTITY_KEY =
  /buyer|guest|customer|email|phone|address|oxyUser|checkoutGroup|orderId|origin|session|pseudonym|contact/i;

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

describe('the projection carries no buyer field', () => {
  it('every key of both reports is on the allow-list, and none names an identity', async () => {
    const storeId = await mintStore('projection');
    const listing = { id: uuidv7(), title: 'Projected' };
    await orders_(storeId, listing, 'paid', 12, IN_WINDOW);
    await orders_(storeId, listing, 'refunded', 1, IN_WINDOW);

    const listingsReport = await getListingConversionReport({ storeId, window: WINDOW });
    const trend = await getConversionTrendReport({ storeId, window: WINDOW, interval: 'day' });
    const keys = new Set([...keysOf(listingsReport), ...keysOf(trend)]);
    // Vacuity floor: a report that came back empty would pass trivially.
    expect(keys.size).toBeGreaterThanOrEqual(20);
    for (const key of keys) {
      expect(ALLOWED_KEYS.has(key), `${key} is not on the report allow-list`).toBe(true);
      expect(IDENTITY_KEY.test(key), `${key} names a buyer identity`).toBe(false);
    }
    // And the detector detects.
    expect(IDENTITY_KEY.test('buyerOxyUserId')).toBe(true);
    expect(IDENTITY_KEY.test('checkoutGroupId')).toBe(true);
  });

  it('rests on a premise: every role that reads stats also reads the orders behind them', () => {
    // Why differencing across reports is not defended further: whoever can read
    // these figures can list every underlying order already.
    for (const role of Object.keys(STORE_ROLE_PERMISSIONS) as StoreAccountRole[]) {
      const permissions = STORE_ROLE_PERMISSIONS[role];
      if (permissions.includes('stats:read')) {
        expect(permissions, `${role} reads stats but not orders`).toContain('orders:read');
      }
    }
  });
});

describe('the route: stats:read, then the plan', () => {
  let server: Server;
  let baseUrl: string;
  let entitled: string;
  let unentitled: string;

  beforeAll(async () => {
    entitled = await mintStore('route-entitled');
    unentitled = await mintStore('route-unentitled');
    await entitleStoreForTest(db, { storeId: entitled, capability: 'advanced_demand_analytics' });
    const listing = { id: uuidv7(), title: '=HYPERLINK("x")' };
    await orders_(entitled, listing, 'paid', 11, IN_WINDOW);

    const app = express();
    app.use((req, _res, next) => {
      const role = (req.headers['x-role'] as StoreAccountRole | undefined) ?? 'owner';
      req.store = { id: req.headers['x-store'] as string } as unknown as typeof req.store;
      req.storeAccess = { role, permissions: [...STORE_ROLE_PERMISSIONS[role]] };
      next();
    });
    app.use('/', conversionReportRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function get(path: string, store: string, role: StoreAccountRole = 'owner') {
    return fetch(`${baseUrl}${path}`, { headers: { 'x-store': store, 'x-role': role } });
  }

  const query = `from=${WINDOW.from}&to=${WINDOW.to}`;

  it('refuses a member without stats:read before anything about the plan', async () => {
    const res = await get(`/listings?${query}`, unentitled, 'developer');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('FORBIDDEN');
  });

  it('refuses a store whose plan lacks the tool, on every route', async () => {
    for (const path of ['/listings', '/trend', '/export']) {
      const res = await get(`${path}?${query}`, unentitled, 'owner');
      expect(res.status, path).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error, path).toBe('PLAN_CAPABILITY_REQUIRED');
    }
  });

  it('answers an entitled store, for a viewer too (stats:read is enough)', async () => {
    const res = await get(`/listings?${query}`, entitled, 'viewer');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { listings: unknown[]; totals: { paidCheckouts: number } };
    };
    expect(body.data.listings).toHaveLength(1);
    expect(body.data.totals.paidCheckouts).toBe(11);

    const trend = await get(`/trend?${query}&interval=week`, entitled);
    expect(trend.status).toBe(200);
  });

  it('refuses a malformed window or interval with a 400', async () => {
    expect((await get('/listings?from=2026-10-18&to=2026-10-05', entitled)).status).toBe(400);
    expect((await get('/listings?from=2026-02-31', entitled)).status).toBe(400);
    expect((await get('/listings?from=2026-01-01&to=2026-10-05', entitled)).status).toBe(400);
    expect((await get(`/trend?${query}&interval=hour`, entitled)).status).toBe(400);
    expect((await get(`/export?${query}&report=orders`, entitled)).status).toBe(400);
  });

  it('exports what the screen shows as CSV, with formula cells defused', async () => {
    const res = await get(`/export?${query}&report=listings`, entitled);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines[0]).toContain('"checkouts_started"');
    expect(lines).toHaveLength(3);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).not.toMatch(/buyer|email|address/i);

    const trend = await get(`/export?${query}&report=trend&interval=day`, entitled);
    const trendLines = (await trend.text()).trim().split('\n');
    // Header, 14 days, both period totals.
    expect(trendLines).toHaveLength(17);
    expect(trendLines.join('\n')).toContain(
      `suppressed_below_${String(ANALYTICS_MERCHANT_MIN_COHORT)}`,
    );
  });
});
