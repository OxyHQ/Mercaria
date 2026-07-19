/**
 * Unit tests for the Shopify provider's INVENTORY pull (`fetchInventory`, Admin API
 * `inventory_levels`) and FULFILLMENT push (`pushFulfillment`, the modern
 * fulfillment-orders → fulfillments flow). No network: an in-memory fake
 * {@link ShopifyTransport} routes by URL and records the requests the provider makes.
 */

import { describe, it, expect } from 'vitest';
import { createShopifyProvider } from '../index.js';
import type { ShopifyHttpResponse, ShopifyTransport } from '../http.js';
import type { ConnectorAuth } from '../../types.js';

interface RecordedCall {
  method: 'get' | 'post' | 'put' | 'del';
  url: string;
  body?: string;
}

/** A fake transport whose GET/POST responses are chosen by a URL-routing handler. */
function routingTransport(handler: (method: string, url: string) => ShopifyHttpResponse): {
  transport: ShopifyTransport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const transport: ShopifyTransport = {
    async get(url) {
      calls.push({ method: 'get', url });
      return handler('get', url);
    },
    async post(url, _headers, body) {
      calls.push({ method: 'post', url, body });
      return handler('post', url);
    },
    async put(url, _headers, body) {
      calls.push({ method: 'put', url, body });
      return handler('put', url);
    },
    async del(url) {
      calls.push({ method: 'del', url });
      return handler('del', url);
    },
  };
  return { transport, calls };
}

const AUTH: ConnectorAuth = { accessToken: 'shpat_test', shopDomain: 'acme.myshopify.com' };
const ok = (body: unknown): ShopifyHttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

describe('shopify fetchInventory — inventory_levels', () => {
  it('sums an item across locations and clamps negatives to zero', async () => {
    const { transport, calls } = routingTransport(() =>
      ok({
        inventory_levels: [
          { inventory_item_id: 111, location_id: 1, available: 3 },
          { inventory_item_id: 111, location_id: 2, available: 2 },
          { inventory_item_id: 222, location_id: 1, available: -4 },
          { inventory_item_id: 333, location_id: 1, available: 5 },
        ],
      }),
    );
    const provider = createShopifyProvider(transport);

    const levels = await provider.fetchInventory(AUTH, { inventoryItemIds: ['111', '222', '333'] });

    // 111 summed across two locations (3+2); 222 oversold → clamped to 0; 333 = 5.
    expect(levels).toEqual([
      { externalInventoryItemId: '111', available: 5 },
      { externalInventoryItemId: '222', available: 0 },
      { externalInventoryItemId: '333', available: 5 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('get');
    expect(calls[0].url).toContain('/inventory_levels.json');
  });

  it('batches ids past the 50-per-request cap into multiple calls', async () => {
    const { transport, calls } = routingTransport(() => ok({ inventory_levels: [] }));
    const provider = createShopifyProvider(transport);

    const ids = Array.from({ length: 51 }, (_, i) => String(i + 1));
    await provider.fetchInventory(AUTH, { inventoryItemIds: ids });

    // 51 ids → two batches (50 + 1).
    expect(calls).toHaveLength(2);
  });

  it('is a no-op (no request) for an empty id list', async () => {
    const { transport, calls } = routingTransport(() => ok({ inventory_levels: [] }));
    const provider = createShopifyProvider(transport);

    const levels = await provider.fetchInventory(AUTH, { inventoryItemIds: [] });

    expect(levels).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws on a non-2xx inventory response', async () => {
    const { transport } = routingTransport(() => ({ status: 429, headers: {}, body: '{}' }));
    const provider = createShopifyProvider(transport);
    await expect(provider.fetchInventory(AUTH, { inventoryItemIds: ['1'] })).rejects.toThrow(/inventory levels/i);
  });
});

describe('shopify pushFulfillment — line-level fulfillment orders → fulfillments', () => {
  function handler(fulfillmentOrders: unknown): (method: string, url: string) => ShopifyHttpResponse {
    return (method, url) => {
      if (method === 'get' && url.includes('/fulfillment_orders.json')) {
        return ok({ fulfillment_orders: fulfillmentOrders });
      }
      if (method === 'post' && url.includes('/fulfillments.json')) {
        return ok({ fulfillment: { id: 90001, status: 'success' } });
      }
      return { status: 404, headers: {}, body: '{}' };
    };
  }

  /** Extract the parsed `fulfillment` bodies from every POST the provider made. */
  function fulfillmentBodies(calls: RecordedCall[]): Record<string, unknown>[] {
    return calls
      .filter((c) => c.method === 'post')
      .map((c) => (JSON.parse(c.body ?? '{}') as { fulfillment: Record<string, unknown> }).fulfillment);
  }

  it('fulfills each OPEN fulfillment order at line level with the full tracking info', async () => {
    const { transport, calls } = routingTransport(
      handler([
        {
          id: 5001,
          status: 'open',
          line_items: [
            { id: 11, fulfillable_quantity: 2, variant_id: 1 },
            { id: 12, fulfillable_quantity: 1, variant_id: 2 },
          ],
        },
        { id: 5002, status: 'closed', line_items: [{ id: 13, fulfillable_quantity: 4, variant_id: 3 }] },
        { id: 5003, status: 'in_progress', line_items: [{ id: 14, fulfillable_quantity: 3, variant_id: 4 }] },
      ]),
    );
    const provider = createShopifyProvider(transport);

    await provider.pushFulfillment(AUTH, {
      externalOrderId: '1001',
      trackingNumber: 'TRK123',
      trackingUrl: 'https://track.example.com/TRK123',
      trackingCompany: 'Moovo',
    });

    // One GET (fulfillment orders) + one POST per OPEN fulfillment order (5001, 5003).
    const bodies = fulfillmentBodies(calls);
    expect(bodies).toHaveLength(2);
    expect(calls[0].url).toContain('/orders/1001/fulfillment_orders.json');
    // Explicit fulfillment_order_line_items with each line's full fulfillable quantity.
    expect(bodies[0].line_items_by_fulfillment_order).toEqual([
      {
        fulfillment_order_id: 5001,
        fulfillment_order_line_items: [
          { id: 11, quantity: 2 },
          { id: 12, quantity: 1 },
        ],
      },
    ]);
    expect(bodies[1].line_items_by_fulfillment_order).toEqual([
      { fulfillment_order_id: 5003, fulfillment_order_line_items: [{ id: 14, quantity: 3 }] },
    ]);
    expect(bodies[0].tracking_info).toEqual({
      number: 'TRK123',
      url: 'https://track.example.com/TRK123',
      company: 'Moovo',
    });
    expect(bodies[0].notify_customer).toBe(true);
  });

  it('omits tracking_info entirely when no tracking is present', async () => {
    const { transport, calls } = routingTransport(
      handler([{ id: 5001, status: 'open', line_items: [{ id: 11, fulfillable_quantity: 1, variant_id: 1 }] }]),
    );
    const provider = createShopifyProvider(transport);

    await provider.pushFulfillment(AUTH, { externalOrderId: '1001' });

    expect(fulfillmentBodies(calls)[0].tracking_info).toBeUndefined();
  });

  it('is idempotent — skips lines with nothing left to fulfill (fulfillable_quantity 0)', async () => {
    const { transport, calls } = routingTransport(
      handler([
        {
          id: 5001,
          status: 'open',
          line_items: [
            { id: 11, fulfillable_quantity: 0, variant_id: 1 }, // already fulfilled
            { id: 12, fulfillable_quantity: 2, variant_id: 2 },
          ],
        },
      ]),
    );
    const provider = createShopifyProvider(transport);

    await provider.pushFulfillment(AUTH, { externalOrderId: '1001', trackingNumber: 'TRK' });

    const bodies = fulfillmentBodies(calls);
    expect(bodies).toHaveLength(1);
    // Only line 12 is shipped; the already-fulfilled line 11 is not re-fulfilled.
    expect(bodies[0].line_items_by_fulfillment_order).toEqual([
      { fulfillment_order_id: 5001, fulfillment_order_line_items: [{ id: 12, quantity: 2 }] },
    ]);
  });

  it('is a no-op (no POST) when every open fulfillment order is fully fulfilled', async () => {
    const { transport, calls } = routingTransport(
      handler([{ id: 5001, status: 'open', line_items: [{ id: 11, fulfillable_quantity: 0, variant_id: 1 }] }]),
    );
    const provider = createShopifyProvider(transport);

    await provider.pushFulfillment(AUTH, { externalOrderId: '1001', trackingNumber: 'TRK' });

    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0);
  });

  it('is a no-op when the order has no open fulfillment orders (already fulfilled)', async () => {
    const { transport, calls } = routingTransport(
      handler([{ id: 5001, status: 'closed', line_items: [{ id: 11, fulfillable_quantity: 3, variant_id: 1 }] }]),
    );
    const provider = createShopifyProvider(transport);

    await provider.pushFulfillment(AUTH, { externalOrderId: '1001', trackingNumber: 'TRK' });

    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0);
  });

  it('PARTIAL: fulfills only the requested lines, matched to Shopify line items by variant id', async () => {
    const { transport, calls } = routingTransport(
      handler([
        {
          id: 5001,
          status: 'open',
          line_items: [
            { id: 11, fulfillable_quantity: 5, variant_id: 1 },
            { id: 12, fulfillable_quantity: 5, variant_id: 2 },
          ],
        },
      ]),
    );
    const provider = createShopifyProvider(transport);

    await provider.pushFulfillment(AUTH, {
      externalOrderId: '1001',
      lines: [{ externalVariantId: '1', quantity: 2 }],
    });

    const bodies = fulfillmentBodies(calls);
    expect(bodies).toHaveLength(1);
    // Only variant 1 (line item 11) is fulfilled, at the requested quantity; variant 2 untouched.
    expect(bodies[0].line_items_by_fulfillment_order).toEqual([
      { fulfillment_order_id: 5001, fulfillment_order_line_items: [{ id: 11, quantity: 2 }] },
    ]);
  });

  it('PARTIAL: caps the requested quantity at what is still fulfillable', async () => {
    const { transport, calls } = routingTransport(
      handler([{ id: 5001, status: 'open', line_items: [{ id: 11, fulfillable_quantity: 1, variant_id: 1 }] }]),
    );
    const provider = createShopifyProvider(transport);

    await provider.pushFulfillment(AUTH, {
      externalOrderId: '1001',
      lines: [{ externalVariantId: '1', quantity: 5 }], // more than remains
    });

    const bodies = fulfillmentBodies(calls);
    expect(bodies[0].line_items_by_fulfillment_order).toEqual([
      { fulfillment_order_id: 5001, fulfillment_order_line_items: [{ id: 11, quantity: 1 }] },
    ]);
  });

  it('PARTIAL: no POST when no requested variant matches an open line', async () => {
    const { transport, calls } = routingTransport(
      handler([{ id: 5001, status: 'open', line_items: [{ id: 11, fulfillable_quantity: 5, variant_id: 1 }] }]),
    );
    const provider = createShopifyProvider(transport);

    await provider.pushFulfillment(AUTH, {
      externalOrderId: '1001',
      lines: [{ externalVariantId: '999', quantity: 1 }],
    });

    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0);
  });

  it('throws when the fulfillment-orders lookup fails', async () => {
    const { transport } = routingTransport(() => ({ status: 404, headers: {}, body: '{}' }));
    const provider = createShopifyProvider(transport);
    await expect(
      provider.pushFulfillment(AUTH, { externalOrderId: '1001' }),
    ).rejects.toThrow(/fulfillment orders lookup/i);
  });
});
