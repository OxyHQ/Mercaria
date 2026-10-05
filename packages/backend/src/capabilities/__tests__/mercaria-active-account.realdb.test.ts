import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from '@oxy.so/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Synthetic central authority only: real published MCP transport, product
// handlers, order services, store repositories and permission rules below.
const authority = vi.hoisted(() => ({ active: true }));
const refundExecution = vi.hoisted(() => vi.fn(() => {
  throw new Error('Financial effects must not execute in this read fixture');
}));
vi.mock('../../services/refund.service.js', () => ({ process: refundExecution }));
vi.mock('../../services/oxy-user.service.js', () => ({
  getProfiles: async () => new Map(),
}));
const ACCOUNT_A = 'i11-mcp-origin-A';
const ACCOUNT_B = 'i11-mcp-active-B';
vi.mock('@oxy.so/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxy.so/mcp')>();
  return {
    ...actual,
    createCatalogMcpHttpService: (options: Parameters<typeof actual.createCatalogMcpHttpService>[0]) => {
      const { getServiceToken, invalidateServiceToken, introspectionEndpoint, introspectToken, ...transport } = options;
      return actual.createCatalogMcpHttpService({
        ...transport,
        introspectToken: async () => {
          if (!authority.active) return null;
          const now = Math.floor(Date.now() / 1000);
          return {
            iss: options.authorizationServer, sub: 'fixture-requester',
            aud: options.catalog.audience, resource: options.catalog.externalMcp!.resource,
            client_id: 'fixture-client', jti: 'fixture-token', iat: now, exp: now + 60,
            account_id: ACCOUNT_A, scope: 'orders.read store.orders.read store.refunds.execute',
            connection: {
              connection_id: 'fixture-connection', origin_account_id: ACCOUNT_A, active_account_id: ACCOUNT_B,
              accounts: [ACCOUNT_A, ACCOUNT_B].map((account_id) => ({
                account_id, is_origin: account_id === ACCOUNT_A, linked_at: new Date().toISOString(),
              })),
            },
          };
        },
      });
    },
  };
});

import { closePostgres, connectPostgres, getDb } from '../../db/postgres.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { orders } from '../../db/schema/orders.js';
import { deleteStoreMember, insertStore, updateStoreMember } from '../../db/stores/storeRepository.js';
import { createMercariaMcpHttpService } from '../mercaria-mcp-http.js';
import { authorizeMercariaCatalogInvocation } from '../mercaria-domain-authority.js';
import { MERCARIA_CAPABILITY_CATALOG } from '../mercaria.catalog.js';

let server: Server | undefined;
let origin: string;
let storeA: string;
let storeB: string;
let orderA: string;
let orderB: string;
const orderIds: string[] = [];
const storeIds: string[] = [];
const unexpectedFetch = vi.fn(async () => { throw new Error('Unexpected outbound fetch in isolated fixture'); });

async function seedOrder(account: string): Promise<string> {
  const money = { shopAmount: 0, shopCurrency: 'FAIR', presentmentAmount: 0, presentmentCurrency: 'FAIR' } as const;
  const [row] = await getDb().insert(orders).values({
    orderNumber: `I11-${uuidv7()}`, sellerType: 'user', sellerOxyUserId: 'i11-mcp-seller',
    buyerOxyUserId: account,
    shippingAddressRecipientName: 'Fixture', shippingAddressLine1: 'Fixture street',
    shippingAddressCity: 'Valencia', shippingAddressPostalCode: '46004', shippingAddressCountry: 'ES',
    shippingMethod: 'standard', shippingLabel: 'Fixture',
    shippingCostShopAmount: money.shopAmount, shippingCostShopCurrency: money.shopCurrency,
    shippingCostPresentmentAmount: money.presentmentAmount, shippingCostPresentmentCurrency: money.presentmentCurrency,
    totalsSubtotalShopAmount: 0, totalsSubtotalShopCurrency: 'FAIR', totalsSubtotalPresentmentAmount: 0, totalsSubtotalPresentmentCurrency: 'FAIR',
    totalsDiscountTotalShopAmount: 0, totalsDiscountTotalShopCurrency: 'FAIR', totalsDiscountTotalPresentmentAmount: 0, totalsDiscountTotalPresentmentCurrency: 'FAIR',
    totalsShippingShopAmount: 0, totalsShippingShopCurrency: 'FAIR', totalsShippingPresentmentAmount: 0, totalsShippingPresentmentCurrency: 'FAIR',
    totalsTaxShopAmount: 0, totalsTaxShopCurrency: 'FAIR', totalsTaxPresentmentAmount: 0, totalsTaxPresentmentCurrency: 'FAIR',
    totalsGrandTotalShopAmount: 0, totalsGrandTotalShopCurrency: 'FAIR', totalsGrandTotalPresentmentAmount: 0, totalsGrandTotalPresentmentCurrency: 'FAIR',
  }).returning({ id: orders.id });
  orderIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', unexpectedFetch);
  await connectPostgres();
  for (const account of [ACCOUNT_A, ACCOUNT_B]) {
    const store = await insertStore({
      handle: `i11-mcp-${uuidv7()}`, name: 'Fixture store', description: '', brandColor: '#123456', defaultCurrency: 'FAIR',
    }, [{ oxyUserId: account, role: 'staff', permissions: ['refunds:write'] }]);
    storeIds.push(store.id);
  }
  [storeA, storeB] = storeIds;
  orderA = await seedOrder(ACCOUNT_A);
  orderB = await seedOrder(ACCOUNT_B);
  const service = createMercariaMcpHttpService();
  server = createServer((req, res) => { void service.handleMcp(req, res); });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (orderIds.length) await getDb().delete(orders).where(inArray(orders.id, orderIds));
  if (storeIds.length) await deleteTestStores(getDb(), storeIds);
  await closePostgres();
  vi.unstubAllGlobals();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(`${origin}/mcp`, {
      method: 'POST', headers: {
        host: new URL(MERCARIA_CAPABILITY_CATALOG.externalMcp!.resource).host,
        authorization: 'Bearer fixture-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  });
}

describe('Mercaria OAuth origin A → active B with real domain authority', () => {
  it('lists B buyer orders through the canonical service, never origin A orders', async () => {
    const result = await call('listBuyerOrders');
    expect(result.status).toBe(200);
    expect(result.body.result.isError).not.toBe(true);
    expect(result.body.result.structuredContent.orders.map((order: { id: string }) => order.id)).toEqual([orderB]);
  });

  it('reads B buyer order but refuses an A order, retaining both persisted rows', async () => {
    expect((await call('readBuyerOrder', { orderId: orderB })).body.result.structuredContent.order.id).toBe(orderB);
    expect((await call('readBuyerOrder', { orderId: orderA })).body.result.isError).toBe(true);
    expect(await getDb().select().from(orders).where(inArray(orders.id, orderIds))).toHaveLength(2);
  });

  it('uses B live store membership and cannot borrow origin A membership', async () => {
    expect((await call('listStoreOrders', { storeId: storeB })).body.result.isError).not.toBe(true);
    expect((await call('listStoreOrders', { storeId: storeA })).body.result.isError).toBe(true);
  });

  it('denies the next call after permission removal and then membership revocation', async () => {
    // Every valid role includes orders:read. An empty explicit grant list
    // cannot revoke that role default. Check the removable refunds permission
    // via the real domain authorizer only; never execute a financial handler.
    expect(await authorizeMercariaCatalogInvocation('refundStoreOrder', { storeId: storeB }, ACCOUNT_B)).toEqual({ allowed: true });
    await updateStoreMember(storeB, ACCOUNT_B, { permissions: [] });
    expect(await authorizeMercariaCatalogInvocation('refundStoreOrder', { storeId: storeB }, ACCOUNT_B)).toEqual({ allowed: false, reason: 'missing_store_permission:refunds:write' });
    expect(refundExecution).not.toHaveBeenCalled();
    expect((await call('listStoreOrders', { storeId: storeB })).body.result.isError).not.toBe(true);
    await deleteStoreMember(storeB, ACCOUNT_B);
    expect((await call('listStoreOrders', { storeId: storeB })).body.result.isError).toBe(true);
  });

  it('refuses central revocation and never exposes the internal financial tool', async () => {
    authority.active = false;
    expect((await call('listBuyerOrders')).status).toBe(401);
    authority.active = true;
    const result = await call('refundStoreOrder', {
      storeId: storeA, orderId: orderA, idempotencyKey: 'fixture-refund', maximumAmountMinor: 0,
      lineItems: [{ variantId: uuidv7(), quantity: 1 }],
    });
    expect(result.body.result?.isError ?? Boolean(result.body.error)).toBe(true);
    expect(refundExecution).not.toHaveBeenCalled();
    expect(await getDb().select().from(orders).where(eq(orders.id, orderA))).toHaveLength(1);
  });
});
