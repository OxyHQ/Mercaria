/**
 * Unit tests for the Shopify provider's PRODUCT PUSH mapping (Mercaria → Shopify).
 * No network: an in-memory fake {@link ShopifyTransport} records the request the
 * provider makes. Asserts the create (POST) vs update (PUT) routing, native prices
 * formatted back to decimal strings, option values paired to `option1..3`, the
 * publish status, images, and that the returned Shopify id is surfaced as the
 * mapping.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createShopifyProvider } from '../index.js';
import type { ShopifyHttpResponse, ShopifyTransport } from '../http.js';
import type { ConnectorAuth, PushProduct } from '../../types.js';

interface RecordedCall {
  method: 'get' | 'post' | 'put' | 'del';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fake transport that records calls and returns a canned response. */
function fakeTransport(response: ShopifyHttpResponse): {
  transport: ShopifyTransport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const transport: ShopifyTransport = {
    async get(url, headers) {
      calls.push({ method: 'get', url, headers });
      return response;
    },
    async post(url, headers, body) {
      calls.push({ method: 'post', url, headers, body });
      return response;
    },
    async put(url, headers, body) {
      calls.push({ method: 'put', url, headers, body });
      return response;
    },
    async del(url, headers) {
      calls.push({ method: 'del', url, headers });
      return response;
    },
  };
  return { transport, calls };
}

const AUTH: ConnectorAuth = { accessToken: 'shpat_test', shopDomain: 'acme.myshopify.com' };

/** A two-variant push product with real Size/Color options. */
function pushProduct(overrides: Partial<PushProduct> = {}): PushProduct {
  return {
    title: 'Classic Tee',
    description: '<p>Soft</p>',
    status: 'active',
    handle: 'classic-tee',
    vendor: 'Acme',
    productType: 'Shirts',
    options: [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Color', values: ['Black'] },
    ],
    imageUrls: ['https://cdn.example.com/a.jpg'],
    variants: [
      {
        optionValues: [
          { name: 'Size', value: 'S' },
          { name: 'Color', value: 'Black' },
        ],
        price: { amount: 1999, currency: 'USD' },
        sku: 'TEE-S',
        inventory: { tracked: true, available: 5 },
      },
      {
        optionValues: [
          { name: 'Size', value: 'M' },
          { name: 'Color', value: 'Black' },
        ],
        price: { amount: 2500, currency: 'USD' },
        compareAtPrice: { amount: 3000, currency: 'USD' },
        inventory: { tracked: false, available: 0 },
      },
    ],
    ...overrides,
  };
}

const OK_CREATE: ShopifyHttpResponse = {
  status: 201,
  headers: {},
  body: JSON.stringify({ product: { id: 555 } }),
};

let created: ReturnType<typeof fakeTransport>;

beforeEach(() => {
  created = fakeTransport(OK_CREATE);
});

describe('shopify pushProduct — CREATE (no externalId)', () => {
  it('POSTs to products.json and maps the whole product', async () => {
    const provider = createShopifyProvider(created.transport);
    const result = await provider.pushProduct(AUTH, pushProduct());

    expect(result).toEqual({ externalId: '555' });
    expect(created.calls).toHaveLength(1);
    const call = created.calls[0];
    expect(call.method).toBe('post');
    expect(call.url).toBe('https://acme.myshopify.com/admin/api/2024-10/products.json');
    expect(call.headers['X-Shopify-Access-Token']).toBe('shpat_test');

    const sent = JSON.parse(call.body ?? '{}').product;
    expect(sent.title).toBe('Classic Tee');
    expect(sent.body_html).toBe('<p>Soft</p>');
    expect(sent.status).toBe('active');
    expect(sent.handle).toBe('classic-tee');
    expect(sent.vendor).toBe('Acme');
    expect(sent.product_type).toBe('Shirts');
    expect(sent.options).toEqual([
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Color', values: ['Black'] },
    ]);
    expect(sent.images).toEqual([{ src: 'https://cdn.example.com/a.jpg' }]);
  });

  it('formats native prices to decimals and pairs option values to option1..3', async () => {
    const provider = createShopifyProvider(created.transport);
    await provider.pushProduct(AUTH, pushProduct());

    const sent = JSON.parse(created.calls[0].body ?? '{}').product;
    expect(sent.variants[0]).toMatchObject({
      price: '19.99',
      sku: 'TEE-S',
      inventory_management: 'shopify',
      inventory_quantity: 5,
      option1: 'S',
      option2: 'Black',
    });
    // Untracked variant → inventory_management null; compare-at maps to decimals.
    expect(sent.variants[1]).toMatchObject({
      price: '25.00',
      compare_at_price: '30.00',
      inventory_management: null,
      option1: 'M',
      option2: 'Black',
    });
  });
});

describe('shopify pushProduct — UPDATE (with externalId)', () => {
  it('PUTs to the mapped product id and keeps that id in the result', async () => {
    const transport = fakeTransport({
      status: 200,
      headers: {},
      body: JSON.stringify({ product: { id: 555 } }),
    });
    const provider = createShopifyProvider(transport.transport);
    const result = await provider.pushProduct(AUTH, pushProduct({ externalId: '555', status: 'draft' }));

    expect(result).toEqual({ externalId: '555' });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].method).toBe('put');
    expect(transport.calls[0].url).toBe(
      'https://acme.myshopify.com/admin/api/2024-10/products/555.json',
    );
    expect(JSON.parse(transport.calls[0].body ?? '{}').product.status).toBe('draft');
  });
});

describe('shopify pushProduct — errors', () => {
  it('throws on a non-2xx response', async () => {
    const transport = fakeTransport({ status: 422, headers: {}, body: '{"errors":"bad"}' });
    const provider = createShopifyProvider(transport.transport);
    await expect(provider.pushProduct(AUTH, pushProduct())).rejects.toThrow(/product create/i);
  });
});
