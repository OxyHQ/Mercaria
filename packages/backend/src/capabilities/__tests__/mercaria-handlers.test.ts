import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogInvocationContext } from '@oxy.so/mcp';

const mocks = vi.hoisted(() => ({
  getBuyerOrders: vi.fn(),
  getOrderForBuyer: vi.fn(),
  getOrderForStore: vi.fn(),
  getStoreOrders: vi.fn(),
  processRefund: vi.fn(),
  runCanonicalSearch: vi.fn(),
}));

vi.mock('../../config/index.js', () => ({
  config: { canonicalRollout: { search: 'on' } },
}));

vi.mock('../../services/order.service.js', () => ({
  getBuyerOrders: mocks.getBuyerOrders,
  getOrderForBuyer: mocks.getOrderForBuyer,
  getOrderForStore: mocks.getOrderForStore,
  getStoreOrders: mocks.getStoreOrders,
}));

vi.mock('../../services/refund.service.js', () => ({
  process: mocks.processRefund,
}));

vi.mock('../../services/search/canonical-search.service.js', () => ({
  runCanonicalSearch: mocks.runCanonicalSearch,
}));

import { executeMercariaCatalogTool, MERCARIA_MCP_HANDLERS } from '../mercaria.handlers.js';
import { MERCARIA_CAPABILITY_CATALOG } from '../mercaria.catalog.js';

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('Mercaria catalog handlers', () => {
  it('projects OAuth active B into buyer data and retains origin A for actor attribution', async () => {
    const principal = {
      subject: 'requester',
      clientId: 'fixture-client',
      accountId: 'origin-A',
      activeAccountId: 'active-B',
      connection: null,
      scopes: ['orders.read'],
      resource: MERCARIA_CAPABILITY_CATALOG.externalMcp!.resource,
    };
    function context(name: string): CatalogInvocationContext {
      const tool = MERCARIA_CAPABILITY_CATALOG.tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing fixture tool ${name}`);
      // Direct wrapper projection test; HTTP/token/domain authorization is
      // exercised separately in mercaria-active-account.realdb.test.ts.
      return {
        appId: MERCARIA_CAPABILITY_CATALOG.appId,
        tool,
        principal,
        request: {} as CatalogInvocationContext['request'],
      };
    }
    mocks.getBuyerOrders.mockResolvedValueOnce({ data: [], total: 0 });
    await MERCARIA_MCP_HANDLERS.listBuyerOrders({}, context('listBuyerOrders'));
    expect(mocks.getBuyerOrders).toHaveBeenCalledWith('active-B', { page: 1, limit: 20 });
    mocks.processRefund.mockResolvedValueOnce({ id: 'synthetic-audit', actor: 'origin-A' });
    const result = await MERCARIA_MCP_HANDLERS.refundStoreOrder(
      {
        idempotencyKey: 'synthetic-operation',
        storeId: 'fixture-store',
        orderId: 'fixture-order',
        maximumAmountMinor: 0,
        lineItems: [{ variantId: 'fixture-variant', quantity: 1 }],
      },
      context('refundStoreOrder'),
    );
    expect(result.structuredContent).toEqual({
      refund: { id: 'synthetic-audit', actor: 'origin-A' },
    });
    expect(mocks.processRefund.mock.calls[0][3]).toBe('origin-A');
  });

  it('binds buyer reads to the ticket effective account, not the executing agent', async () => {
    mocks.getBuyerOrders.mockResolvedValueOnce({ data: [{ id: 'order-1' }], total: 1 });

    await expect(
      executeMercariaCatalogTool(
        'listBuyerOrders',
        { page: 2, limit: 10 },
        'owner-account',
        'agent-account',
      ),
    ).resolves.toEqual({
      orders: [{ id: 'order-1' }],
      pagination: { page: 2, limit: 10, total: 1, pages: 1 },
    });
    expect(mocks.getBuyerOrders).toHaveBeenCalledWith('owner-account', { page: 2, limit: 10 });
  });

  it('records the real executing actor and passes the signed amount ceiling to refunds', async () => {
    mocks.processRefund.mockResolvedValueOnce({ id: 'refund-1' });

    await expect(
      executeMercariaCatalogTool(
        'refundStoreOrder',
        {
          idempotencyKey: 'run-1:step-1',
          storeId: 'store-1',
          orderId: 'order-1',
          maximumAmountMinor: 5_000,
          lineItems: [{ variantId: 'variant-1', quantity: 1, restock: true }],
        },
        'owner-account',
        'agent-account',
      ),
    ).resolves.toEqual({ refund: { id: 'refund-1' } });

    expect(mocks.processRefund).toHaveBeenCalledWith(
      'store-1',
      'order-1',
      {
        idempotencyKey: 'run-1:step-1',
        lineItems: [{ variantId: 'variant-1', quantity: 1, restock: true }],
      },
      'agent-account',
      { maximumPresentmentAmountMinor: 5_000 },
    );
  });
});
