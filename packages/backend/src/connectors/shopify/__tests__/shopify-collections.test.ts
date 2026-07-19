/**
 * Unit tests for the Shopify provider's COLLECTION-membership enrichment during
 * `fetchProducts`. Shopify's REST `products.json` omits collection membership, so
 * the provider builds a per-run product→collection index (custom collections via
 * `collects.json`, smart collections via each smart collection's product list) and
 * stamps each product's `collectionRefs`. No network: an in-memory routing fake
 * {@link ShopifyTransport} serves the responses and records every request, so the
 * "fetched once, no N+1" property is asserted directly.
 */

import { describe, it, expect } from 'vitest';
import { createShopifyProvider } from '../index.js';
import type { ShopifyHttpResponse, ShopifyTransport } from '../http.js';
import type { ConnectorCredentials } from '../../types.js';

interface RecordedCall {
  method: 'get' | 'post' | 'put' | 'del';
  url: string;
}

/** A routing fake transport: GET responses are chosen by URL, and every call is recorded. */
function routingTransport(routes: (url: string) => ShopifyHttpResponse): {
  transport: ShopifyTransport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const notFound: ShopifyHttpResponse = { status: 404, headers: {}, body: '{}' };
  const transport: ShopifyTransport = {
    async get(url) {
      calls.push({ method: 'get', url });
      return routes(url);
    },
    async post(url) {
      calls.push({ method: 'post', url });
      return notFound;
    },
    async put(url) {
      calls.push({ method: 'put', url });
      return notFound;
    },
    async del(url) {
      calls.push({ method: 'del', url });
      return notFound;
    },
  };
  return { transport, calls };
}

const CREDS: ConnectorCredentials = {
  accessToken: 'shpat_test',
  shopDomain: 'acme.myshopify.com',
  shopCurrency: 'USD',
};

const ok = (body: unknown): ShopifyHttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

/** Two single-variant products. */
const PRODUCTS = [
  {
    id: 111,
    title: 'Alpha',
    options: [{ name: 'Title', values: ['Default Title'] }],
    images: [],
    variants: [{ id: 9001, price: '10.00', option1: 'Default Title' }],
  },
  {
    id: 222,
    title: 'Beta',
    options: [{ name: 'Title', values: ['Default Title'] }],
    images: [],
    variants: [{ id: 9002, price: '20.00', option1: 'Default Title' }],
  },
];

describe('shopify fetchProducts — collectionRefs from collects (custom collections)', () => {
  it('populates collectionRefs from collects and fetches the joins ONCE (no per-product N+1)', async () => {
    const { transport, calls } = routingTransport((url) => {
      if (url.includes('/products.json')) return ok({ products: PRODUCTS });
      if (url.includes('/collects.json')) {
        return ok({
          collects: [
            { product_id: 111, collection_id: 501 },
            { product_id: 111, collection_id: 502 },
            { product_id: 222, collection_id: 501 },
          ],
        });
      }
      if (url.includes('/smart_collections.json')) return ok({ smart_collections: [] });
      return { status: 404, headers: {}, body: '{}' };
    });
    const provider = createShopifyProvider(transport);

    const { products } = await provider.fetchProducts(CREDS);

    // Membership is indexed by product id and emitted as external collection ids.
    expect(products.find((p) => p.externalId === '111')?.collectionRefs).toEqual(['501', '502']);
    expect(products.find((p) => p.externalId === '222')?.collectionRefs).toEqual(['501']);

    // collects.json is fetched EXACTLY ONCE for the whole page — never once per product.
    const collectsCalls = calls.filter((c) => c.url.includes('/collects.json'));
    expect(collectsCalls).toHaveLength(1);
    // No per-product collection lookups leaked in.
    expect(calls.some((c) => c.url.includes('/products/111')) || calls.some((c) => c.url.includes('/products/222'))).toBe(false);
  });

  it('leaves collectionRefs unset for a product with no membership', async () => {
    const { transport } = routingTransport((url) => {
      if (url.includes('/products.json')) return ok({ products: PRODUCTS });
      if (url.includes('/collects.json')) return ok({ collects: [{ product_id: 111, collection_id: 501 }] });
      if (url.includes('/smart_collections.json')) return ok({ smart_collections: [] });
      return { status: 404, headers: {}, body: '{}' };
    });
    const provider = createShopifyProvider(transport);

    const { products } = await provider.fetchProducts(CREDS);

    expect(products.find((p) => p.externalId === '111')?.collectionRefs).toEqual(['501']);
    expect(products.find((p) => p.externalId === '222')?.collectionRefs).toBeUndefined();
  });
});

describe('shopify fetchProducts — collectionRefs from smart collections', () => {
  it('adds smart-collection membership via each smart collection product list', async () => {
    const { transport } = routingTransport((url) => {
      if (url.includes('/products.json') && !url.includes('/collections/')) return ok({ products: PRODUCTS });
      if (url.includes('/collects.json')) return ok({ collects: [] });
      if (url.includes('/smart_collections.json')) return ok({ smart_collections: [{ id: 700 }] });
      if (url.includes('/collections/700/products.json')) return ok({ products: [{ id: 222 }] });
      return { status: 404, headers: {}, body: '{}' };
    });
    const provider = createShopifyProvider(transport);

    const { products } = await provider.fetchProducts(CREDS);

    expect(products.find((p) => p.externalId === '111')?.collectionRefs).toBeUndefined();
    expect(products.find((p) => p.externalId === '222')?.collectionRefs).toEqual(['700']);
  });
});

describe('shopify fetchProducts — collection index reused across pages of a run', () => {
  it('builds the index only on the first page and reuses it on later pages', async () => {
    const { transport, calls } = routingTransport((url) => {
      if (url.includes('/products.json')) return ok({ products: PRODUCTS });
      if (url.includes('/collects.json')) return ok({ collects: [{ product_id: 111, collection_id: 501 }] });
      if (url.includes('/smart_collections.json')) return ok({ smart_collections: [] });
      return { status: 404, headers: {}, body: '{}' };
    });
    const provider = createShopifyProvider(transport);

    await provider.fetchProducts(CREDS); // first page (no cursor) → builds the index
    await provider.fetchProducts(CREDS, 'page-2'); // later page → reuses it

    // collects/smart_collections fetched exactly once across BOTH pages.
    expect(calls.filter((c) => c.url.includes('/collects.json'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/smart_collections.json'))).toHaveLength(1);
  });
});
