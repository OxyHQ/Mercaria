/**
 * Unit tests for the WooCommerce ORDER mapping (platform → Mercaria). No network:
 * `normalizeWooCommerceOrder` is a pure map, and `fetchOrders` runs over an injected
 * fake transport. Asserts SINGLE-currency `DualMoney` (shop === presentment, no fx),
 * status mapping across the WooCommerce lifecycle, line/total money (pre-discount line
 * subtotals + order-level totals), customer + address mapping, and `X-WP-TotalPages`
 * pagination.
 */

import { describe, it, expect } from 'vitest';
import { createWooCommerceProvider, normalizeWooCommerceOrder } from '../index.js';
import type { WooCommerceHttpResponse, WooCommerceTransport } from '../http.js';
import type { ConnectorCredentials } from '../../types.js';

/** A WooCommerce order in EUR with one variable line + a full billing/shipping split. */
function wooOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 727,
    number: '727',
    status: 'processing',
    currency: 'EUR',
    date_created_gmt: '2026-07-15T10:00:00',
    date_modified_gmt: '2026-07-15T11:00:00',
    total: '43.00',
    total_tax: '3.00',
    shipping_total: '5.00',
    discount_total: '5.00',
    customer_id: 12,
    billing: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      phone: '+441234',
      address_1: '1 Analytical Way',
      city: 'London',
      state: 'Greater London',
      postcode: 'EC1',
      country: 'GB',
    },
    shipping: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      address_1: '2 Difference St',
      address_2: 'Apt 4',
      city: 'London',
      state: 'Greater London',
      postcode: 'EC2',
      country: 'GB',
    },
    line_items: [
      {
        id: 1,
        name: 'Classic Tee',
        product_id: 111,
        variation_id: 999,
        quantity: 2,
        subtotal: '40.00',
        total: '38.00',
        sku: 'TEE-M',
        meta_data: [
          { display_key: 'Size', display_value: 'M' },
          // Internal meta (leading `_`) must NOT leak into the variant title.
          { display_key: '_reduced_stock', display_value: '2' },
        ],
      },
    ],
    refunds: [],
    ...overrides,
  };
}

describe('normalizeWooCommerceOrder — single-currency DualMoney', () => {
  it('maps money as shop === presentment (no fx) in the order currency', () => {
    const order = normalizeWooCommerceOrder(wooOrder(), 'USD');

    expect(order.externalId).toBe('727');
    expect(order.externalNumber).toBe('727');
    expect(order.shopCurrency).toBe('EUR');
    expect(order.presentmentCurrency).toBe('EUR');
    // Single-currency → no fx-rate snapshot.
    expect(order.fxRate).toBeUndefined();

    // Line: unit = pre-discount subtotal / qty (4000/2 = 2000); lineTotal = unit * qty.
    const line = order.lines[0];
    expect(line.title).toBe('Classic Tee');
    expect(line.variantTitle).toBe('M');
    expect(line.quantity).toBe(2);
    expect(line.unitPrice.shop).toEqual({ amount: 2000, currency: 'EUR' });
    expect(line.lineTotal.shop).toEqual({ amount: 4000, currency: 'EUR' });
    // shop === presentment is the SAME Money (collapsed, like Shopify same-currency).
    expect(line.unitPrice.presentment).toBe(line.unitPrice.shop);
    expect(line.externalProductId).toBe('111');
    expect(line.externalVariantId).toBe('999');
    expect(line.sku).toBe('TEE-M');

    // Order totals: subtotal = Σ line totals; the rest are the order-level fields.
    expect(order.totals.subtotal.shop).toEqual({ amount: 4000, currency: 'EUR' });
    expect(order.totals.discountTotal.shop).toEqual({ amount: 500, currency: 'EUR' });
    expect(order.totals.tax.shop).toEqual({ amount: 300, currency: 'EUR' });
    expect(order.totals.shipping.shop).toEqual({ amount: 500, currency: 'EUR' });
    expect(order.totals.grandTotal.shop).toEqual({ amount: 4300, currency: 'EUR' });
    expect(order.totals.grandTotal.presentment).toBe(order.totals.grandTotal.shop);
  });

  it('maps the customer + shipping address (shipping preferred, GMT timestamps as UTC)', () => {
    const order = normalizeWooCommerceOrder(wooOrder(), 'USD');

    expect(order.customer).toEqual({ externalId: '12', email: 'ada@example.com', name: 'Ada Lovelace' });
    expect(order.shippingAddress).toEqual({
      recipientName: 'Ada Lovelace',
      line1: '2 Difference St',
      line2: 'Apt 4',
      city: 'London',
      region: 'Greater London',
      postalCode: 'EC2',
      country: 'GB',
    });
    expect(order.createdAt).toEqual(new Date('2026-07-15T10:00:00Z'));
    expect(order.externalUpdatedAt).toEqual(new Date('2026-07-15T11:00:00Z'));
  });

  it('falls back to billing when shipping has no street line', () => {
    const order = normalizeWooCommerceOrder(wooOrder({ shipping: {} }), 'USD');
    expect(order.shippingAddress?.line1).toBe('1 Analytical Way');
    expect(order.shippingAddress?.postalCode).toBe('EC1');
  });

  it('falls back to the shop currency when the order currency is unsupported', () => {
    const order = normalizeWooCommerceOrder(wooOrder({ currency: 'ZZZ' }), 'USD');
    expect(order.shopCurrency).toBe('USD');
    expect(order.totals.grandTotal.shop.currency).toBe('USD');
  });

  it('throws on an order with no line items', () => {
    expect(() => normalizeWooCommerceOrder(wooOrder({ line_items: [] }), 'USD')).toThrow();
  });
});

describe('normalizeWooCommerceOrder — status mapping', () => {
  const cases: [string, string, string][] = [
    ['completed', 'shipped', 'paid'],
    ['processing', 'paid', 'paid'],
    ['on-hold', 'pending_payment', 'unpaid'],
    ['pending', 'pending_payment', 'unpaid'],
    ['refunded', 'refunded', 'refunded'],
    ['cancelled', 'cancelled', 'unpaid'],
    ['failed', 'pending_payment', 'failed'],
  ];

  it.each(cases)('maps %s → %s / %s', (wooStatus, status, paymentStatus) => {
    const order = normalizeWooCommerceOrder(wooOrder({ status: wooStatus }), 'EUR');
    expect(order.status).toBe(status);
    expect(order.paymentStatus).toBe(paymentStatus);
  });

  it('maps a processing/completed order carrying refunds → partially_refunded / paid', () => {
    const refunded = wooOrder({ status: 'completed', refunds: [{ total: '-10.00' }] });
    const order = normalizeWooCommerceOrder(refunded, 'EUR');
    expect(order.status).toBe('partially_refunded');
    expect(order.paymentStatus).toBe('paid');
  });
});

// --- fetchOrders (paging over the injected transport) -----------------------

const CREDS: ConnectorCredentials = {
  accessToken: 'ck_test:cs_test',
  shopDomain: 'https://shop.example.com',
  shopCurrency: 'USD',
};

const ok = (body: unknown, headers: Record<string, string> = {}): WooCommerceHttpResponse => ({
  status: 200,
  headers,
  body: JSON.stringify(body),
});

/** A GET-only fake transport whose response is chosen by a URL handler. */
function getTransport(handler: (url: string) => WooCommerceHttpResponse): {
  transport: WooCommerceTransport;
  urls: string[];
} {
  const urls: string[] = [];
  const transport: WooCommerceTransport = {
    async get(url) {
      urls.push(url);
      return handler(url);
    },
    post: () => Promise.reject(new Error('unexpected post')),
    del: () => Promise.reject(new Error('unexpected del')),
  };
  return { transport, urls };
}

describe('woocommerce fetchOrders', () => {
  it('maps a page of orders and reports the next page cursor from X-WP-TotalPages', async () => {
    const { transport, urls } = getTransport(() => ok([wooOrder()], { 'x-wp-totalpages': '2' }));
    const provider = createWooCommerceProvider(transport);

    const first = await provider.fetchOrders(CREDS);
    expect(first.orders).toHaveLength(1);
    expect(first.orders[0].externalId).toBe('727');
    expect(first.nextCursor).toBe('2');
    expect(urls[0]).toContain('/wp-json/wc/v3/orders?');
    expect(urls[0]).toContain('per_page=100');
    expect(urls[0]).toContain('page=1');
  });

  it('stops paginating on the last page (no next cursor)', async () => {
    const { transport } = getTransport(() => ok([wooOrder()], { 'x-wp-totalpages': '1' }));
    const provider = createWooCommerceProvider(transport);
    const { nextCursor } = await provider.fetchOrders(CREDS);
    expect(nextCursor).toBeUndefined();
  });
});
