/**
 * Unit tests for the WooCommerce provider's network paths (`verifyConnection`,
 * `fetchProducts`) and the registry wiring. No network: an in-memory fake
 * {@link WooCommerceTransport} routes by URL and records the requests + headers the
 * provider makes. Asserts the credential pair is sent as HTTP Basic, the currency
 * lookup drives the shop identity, product paging follows `X-WP-TotalPages`, and a
 * variable product's variations are fetched and mapped.
 */

import { describe, it, expect } from 'vitest';
import { createWooCommerceProvider } from '../index.js';
import type { WooCommerceHttpResponse, WooCommerceTransport } from '../http.js';
import type { ConnectorAuth, ConnectorCredentials } from '../../types.js';
import { getConnectorProvider, isImplementedProvider } from '../../registry.js';

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

/** A fake transport whose GET responses are chosen by a URL-routing handler. */
function routingTransport(handler: (url: string) => WooCommerceHttpResponse): {
  transport: WooCommerceTransport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const transport: WooCommerceTransport = {
    async get(url, headers) {
      calls.push({ url, headers });
      return handler(url);
    },
  };
  return { transport, calls };
}

const AUTH: ConnectorAuth = {
  accessToken: 'ck_test:cs_test',
  shopDomain: 'https://shop.example.com',
};
const CREDS: ConnectorCredentials = { ...AUTH, shopCurrency: 'USD' };

const ok = (body: unknown, headers: Record<string, string> = {}): WooCommerceHttpResponse => ({
  status: 200,
  headers,
  body: JSON.stringify(body),
});

/** Expected HTTP Basic header for the `ck_test:cs_test` credential pair. */
const EXPECTED_BASIC = `Basic ${Buffer.from('ck_test:cs_test').toString('base64')}`;

describe('woocommerce verifyConnection', () => {
  it('reads the currency + sends the key/secret as HTTP Basic', async () => {
    const { transport, calls } = routingTransport((url) => {
      expect(url).toContain('/wp-json/wc/v3/data/currencies/current');
      return ok({ code: 'USD', name: 'US dollar', symbol: '$' });
    });
    const provider = createWooCommerceProvider(transport);

    const identity = await provider.verifyConnection(AUTH);

    expect(identity).toEqual({
      externalShopId: 'https://shop.example.com',
      shopDomain: 'https://shop.example.com',
      shopCurrency: 'USD',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe(EXPECTED_BASIC);
  });

  it('throws when the shop returns a non-2xx (bad credentials)', async () => {
    const { transport } = routingTransport(() => ({ status: 401, headers: {}, body: '{}' }));
    const provider = createWooCommerceProvider(transport);
    await expect(provider.verifyConnection(AUTH)).rejects.toThrow();
  });
});

describe('woocommerce fetchProducts', () => {
  it('maps a page, fetches variable-product variations, and reports no next page', async () => {
    const { transport, calls } = routingTransport((url) => {
      if (url.includes('/products/222/variations')) {
        return ok(
          [
            {
              id: 3001,
              price: '10.00',
              regular_price: '10.00',
              sale_price: '',
              sku: 'TEE-S',
              manage_stock: true,
              stock_quantity: 4,
              attributes: [{ name: 'Size', option: 'S' }],
            },
          ],
          { 'x-wp-totalpages': '1' },
        );
      }
      // The products page: one simple + one variable product.
      return ok(
        [
          {
            id: 111,
            name: 'Coffee',
            slug: 'coffee',
            type: 'simple',
            price: '19.99',
            regular_price: '19.99',
            sale_price: '',
            manage_stock: false,
            attributes: [],
            images: [],
            categories: [],
          },
          {
            id: 222,
            name: 'Tee',
            slug: 'tee',
            type: 'variable',
            attributes: [{ name: 'Size', variation: true, options: ['S'] }],
            images: [],
            categories: [],
          },
        ],
        { 'x-wp-totalpages': '1' },
      );
    });
    const provider = createWooCommerceProvider(transport);

    const { products, nextCursor } = await provider.fetchProducts(CREDS);

    expect(nextCursor).toBeUndefined();
    expect(products).toHaveLength(2);
    expect(products[0].externalId).toBe('111');
    expect(products[0].variants).toHaveLength(1);
    expect(products[0].variants[0].price).toEqual({ amount: 1999, currency: 'USD' });
    // Variable product got its variation from the variations endpoint.
    expect(products[1].externalId).toBe('222');
    expect(products[1].variants).toHaveLength(1);
    expect(products[1].variants[0].optionValues).toEqual([{ name: 'Size', value: 'S' }]);
    expect(products[1].variants[0].price).toEqual({ amount: 1000, currency: 'USD' });

    // The products list + one variations fetch (for the variable product only).
    const productListCalls = calls.filter((c) => c.url.includes('/products?'));
    const variationCalls = calls.filter((c) => c.url.includes('/variations'));
    expect(productListCalls).toHaveLength(1);
    expect(variationCalls).toHaveLength(1);
    expect(productListCalls[0].url).toContain('per_page=100');
    expect(productListCalls[0].headers.Authorization).toBe(EXPECTED_BASIC);
  });

  it('returns the next page cursor when more pages remain', async () => {
    const { transport } = routingTransport(() =>
      ok(
        [
          {
            id: 1,
            name: 'A',
            slug: 'a',
            type: 'simple',
            price: '1.00',
            regular_price: '1.00',
            sale_price: '',
            attributes: [],
            images: [],
            categories: [],
          },
        ],
        { 'x-wp-totalpages': '3' },
      ),
    );
    const provider = createWooCommerceProvider(transport);

    const first = await provider.fetchProducts(CREDS);
    expect(first.nextCursor).toBe('2');

    const second = await provider.fetchProducts(CREDS, '2');
    expect(second.nextCursor).toBe('3');
  });
});

describe('woocommerce provider registry', () => {
  it('resolves the woocommerce provider as an api_key strategy', () => {
    expect(isImplementedProvider('woocommerce')).toBe(true);
    const provider = getConnectorProvider('woocommerce');
    expect(provider.id).toBe('woocommerce');
    expect(provider.credentialStrategy).toBe('api_key');
  });

  it('throws for the push/OAuth methods outside the pull-only first cut', async () => {
    const provider = getConnectorProvider('woocommerce');
    expect(() => provider.buildAuthorizeUrl({ shopDomain: 'x', redirectUri: 'y', state: 's', scopes: [] })).toThrow();
    await expect(provider.fetchOrders(CREDS)).rejects.toThrow();
    await expect(
      provider.pushProduct(AUTH, {
        title: 'x',
        description: '',
        status: 'draft',
        options: [],
        imageUrls: [],
        variants: [],
      }),
    ).rejects.toThrow();
  });
});
