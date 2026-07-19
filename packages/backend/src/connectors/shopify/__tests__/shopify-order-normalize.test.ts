/**
 * Unit tests for the Shopify ORDER mapping (platform → Mercaria). No network:
 * `normalizeShopifyOrder` is a pure map, and `fetchOrders` runs over an injected
 * fake transport. Asserts dual-currency `DualMoney` (shop + presentment from the
 * money `*_set` fields), status mapping, the fx-rate snapshot, address/customer
 * mapping, and the `page_info` pagination + `status=any` first-page filter.
 */

import { describe, it, expect } from 'vitest';
import { createShopifyProvider, normalizeShopifyOrder } from '../index.js';
import type { ShopifyHttpResponse, ShopifyTransport } from '../http.js';
import type { ConnectorCredentials } from '../../types.js';

/** A Shopify order with presentment (EUR) differing from the shop currency (USD). */
function dualCurrencyOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    name: '#1001',
    created_at: '2026-07-15T10:00:00Z',
    updated_at: '2026-07-15T11:00:00Z',
    currency: 'USD',
    presentment_currency: 'EUR',
    financial_status: 'paid',
    fulfillment_status: null,
    subtotal_price: '40.00',
    total_tax: '4.00',
    total_discounts: '5.00',
    total_price: '39.00',
    subtotal_price_set: {
      shop_money: { amount: '40.00', currency_code: 'USD' },
      presentment_money: { amount: '36.00', currency_code: 'EUR' },
    },
    total_tax_set: {
      shop_money: { amount: '4.00' },
      presentment_money: { amount: '3.60' },
    },
    total_discounts_set: {
      shop_money: { amount: '5.00' },
      presentment_money: { amount: '4.50' },
    },
    total_shipping_price_set: {
      shop_money: { amount: '0.00' },
      presentment_money: { amount: '0.00' },
    },
    total_price_set: {
      shop_money: { amount: '39.00' },
      presentment_money: { amount: '35.10' },
    },
    customer: { id: 7, email: 'buyer@example.com', first_name: 'Ada', last_name: 'Lovelace' },
    line_items: [
      {
        id: 1,
        product_id: 111,
        variant_id: 999,
        title: 'Classic Tee',
        variant_title: 'M / Black',
        sku: 'TEE-M',
        quantity: 2,
        price: '20.00',
        price_set: {
          shop_money: { amount: '20.00' },
          presentment_money: { amount: '18.00' },
        },
      },
    ],
    shipping_address: {
      name: 'Ada Lovelace',
      address1: '1 Analytical Way',
      city: 'London',
      province: 'England',
      zip: 'EC1',
      country_code: 'GB',
      phone: '+44 20 7946 0000',
    },
    ...overrides,
  };
}

describe('normalizeShopifyOrder — dual-currency mapping', () => {
  it('maps shop + presentment money from the *_set fields', () => {
    const order = normalizeShopifyOrder(dualCurrencyOrder(), 'USD');

    expect(order.externalId).toBe('1001');
    expect(order.externalNumber).toBe('#1001');
    expect(order.shopCurrency).toBe('USD');
    expect(order.presentmentCurrency).toBe('EUR');

    expect(order.totals.subtotal).toEqual({
      shop: { amount: 4000, currency: 'USD' },
      presentment: { amount: 3600, currency: 'EUR' },
    });
    expect(order.totals.tax.presentment).toEqual({ amount: 360, currency: 'EUR' });
    expect(order.totals.grandTotal).toEqual({
      shop: { amount: 3900, currency: 'USD' },
      presentment: { amount: 3510, currency: 'EUR' },
    });
  });

  it('maps line items with dual unit + line totals and external ids', () => {
    const order = normalizeShopifyOrder(dualCurrencyOrder(), 'USD');
    expect(order.lines).toHaveLength(1);
    const line = order.lines[0];
    expect(line.title).toBe('Classic Tee');
    expect(line.variantTitle).toBe('M / Black');
    expect(line.quantity).toBe(2);
    expect(line.unitPrice).toEqual({
      shop: { amount: 2000, currency: 'USD' },
      presentment: { amount: 1800, currency: 'EUR' },
    });
    expect(line.lineTotal).toEqual({
      shop: { amount: 4000, currency: 'USD' },
      presentment: { amount: 3600, currency: 'EUR' },
    });
    expect(line.externalProductId).toBe('111');
    expect(line.externalVariantId).toBe('999');
    expect(line.sku).toBe('TEE-M');
  });

  it('captures the shop→presentment fx rate, customer and shipping address', () => {
    const order = normalizeShopifyOrder(dualCurrencyOrder(), 'USD');
    expect(order.fxRate).toEqual({
      from: 'USD',
      to: 'EUR',
      rate: 0.9, // 35.10 / 39.00
      asOf: '2026-07-15T11:00:00Z',
    });
    expect(order.customer).toEqual({
      externalId: '7',
      email: 'buyer@example.com',
      name: 'Ada Lovelace',
    });
    expect(order.shippingAddress).toMatchObject({
      recipientName: 'Ada Lovelace',
      line1: '1 Analytical Way',
      city: 'London',
      region: 'England',
      postalCode: 'EC1',
      country: 'GB',
    });
  });

  it('maps the paid → paid status (unfulfilled)', () => {
    const order = normalizeShopifyOrder(dualCurrencyOrder(), 'USD');
    expect(order.status).toBe('paid');
    expect(order.paymentStatus).toBe('paid');
  });
});

describe('normalizeShopifyOrder — status + currency edge cases', () => {
  it('maps a fulfilled paid order to shipped', () => {
    const order = normalizeShopifyOrder(
      dualCurrencyOrder({ fulfillment_status: 'fulfilled' }),
      'USD',
    );
    expect(order.status).toBe('shipped');
  });

  it('maps refunded/voided orders', () => {
    expect(normalizeShopifyOrder(dualCurrencyOrder({ financial_status: 'refunded' }), 'USD').status).toBe('refunded');
    expect(normalizeShopifyOrder(dualCurrencyOrder({ financial_status: 'voided' }), 'USD').status).toBe('cancelled');
    expect(
      normalizeShopifyOrder(dualCurrencyOrder({ financial_status: 'pending' }), 'USD').paymentStatus,
    ).toBe('unpaid');
  });

  it('falls back both money sides to the shop currency when presentment is unsupported', () => {
    // JPY is not a supported Mercaria currency → presentment collapses to shop.
    const order = normalizeShopifyOrder(dualCurrencyOrder({ presentment_currency: 'JPY' }), 'USD');
    expect(order.presentmentCurrency).toBe('USD');
    expect(order.totals.grandTotal.presentment).toEqual(order.totals.grandTotal.shop);
    expect(order.fxRate).toBeUndefined();
  });

  it('is byte-identical on both sides when shop == presentment', () => {
    const order = normalizeShopifyOrder(dualCurrencyOrder({ presentment_currency: 'USD' }), 'USD');
    expect(order.totals.subtotal.presentment).toEqual({ amount: 4000, currency: 'USD' });
    expect(order.fxRate).toBeUndefined();
  });
});

describe('shopify fetchOrders — pagination', () => {
  const CREDS: ConnectorCredentials = {
    accessToken: 'shpat_test',
    shopDomain: 'acme.myshopify.com',
    shopCurrency: 'USD',
  };

  function pageResponse(orders: unknown[], nextCursor?: string): ShopifyHttpResponse {
    const headers: Record<string, string | undefined> = {};
    if (nextCursor) {
      headers.link = `<https://acme.myshopify.com/admin/api/2024-10/orders.json?page_info=${nextCursor}>; rel="next"`;
    }
    return { status: 200, headers, body: JSON.stringify({ orders }) };
  }

  it('sends status=any on the first page and normalizes orders + next cursor', async () => {
    const urls: string[] = [];
    const transport: ShopifyTransport = {
      async get(url) {
        urls.push(url);
        return pageResponse([dualCurrencyOrder()], 'CURSOR2');
      },
      async post() {
        throw new Error('unused');
      },
      async put() {
        throw new Error('unused');
      },
      async del() {
        throw new Error('unused');
      },
    };
    const provider = createShopifyProvider(transport);
    const page = await provider.fetchOrders(CREDS);

    expect(page.orders).toHaveLength(1);
    expect(page.orders[0].externalId).toBe('1001');
    expect(page.nextCursor).toBe('CURSOR2');
    expect(urls[0]).toContain('status=any');
    expect(urls[0]).not.toContain('page_info');
  });

  it('sends only the cursor (no status filter) on subsequent pages', async () => {
    const urls: string[] = [];
    const transport: ShopifyTransport = {
      async get(url) {
        urls.push(url);
        return pageResponse([dualCurrencyOrder()]);
      },
      async post() {
        throw new Error('unused');
      },
      async put() {
        throw new Error('unused');
      },
      async del() {
        throw new Error('unused');
      },
    };
    const provider = createShopifyProvider(transport);
    const page = await provider.fetchOrders(CREDS, 'CURSOR2');

    expect(page.nextCursor).toBeUndefined();
    expect(urls[0]).toContain('page_info=CURSOR2');
    expect(urls[0]).not.toContain('status=any');
  });
});
