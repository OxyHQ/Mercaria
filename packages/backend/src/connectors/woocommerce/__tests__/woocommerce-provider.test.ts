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
import type { ConnectorAuth, ConnectorCredentials, NormalizedProduct, NormalizedVariant } from '../../types.js';
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
    async post(url, headers) {
      calls.push({ url, headers });
      return handler(url);
    },
    async del(url, headers) {
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

/** The variants of a normalized product, or a failure naming the gap instead. */
function variantsOf(product: NormalizedProduct): NormalizedVariant[] {
  if (product.variants.enumeration === 'incomplete') {
    throw new Error(`expected a COMPLETE variant set; got the gap ${product.variants.gap.kind}`);
  }
  return product.variants.variants;
}

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
            variations: [3001],
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
    expect(variantsOf(products[0])).toHaveLength(1);
    expect(variantsOf(products[0])[0].price).toEqual({ amount: 1999, currency: 'USD' });
    // Variable product got its variation from the variations endpoint.
    expect(products[1].externalId).toBe('222');
    expect(variantsOf(products[1])).toHaveLength(1);
    expect(variantsOf(products[1])[0].optionValues).toEqual([{ name: 'Size', value: 'S' }]);
    expect(variantsOf(products[1])[0].price).toEqual({ amount: 1000, currency: 'USD' });

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

/**
 * #259 cases 5 and 6 — where a paged read is allowed to conclude it FINISHED.
 *
 * These live here rather than in the contract suite because they need a 200 with
 * a chosen HEADER, and a `ContractWorld` fault answers `'{}'` with the status it
 * was given: it can express "the platform fell over" and cannot express "the
 * platform answered perfectly well and published no page count", which is the
 * whole of case 5.
 */
describe('woocommerce pagination completeness (#259)', () => {
  /** A full page of `count` distinct simple products. */
  function fullPage(count: number): unknown[] {
    return Array.from({ length: count }, (_, i) => ({
      id: 1000 + i,
      name: `Product ${i}`,
      slug: `product-${i}`,
      type: 'simple',
      price: '1.00',
      regular_price: '1.00',
      sale_price: '',
      attributes: [],
      images: [],
      categories: [],
    }));
  }

  // The catalogue-wide half of #259, and the one that costs a merchant their
  // shop: `runBackfill` ends its page loop when `nextCursor` goes away and then
  // reaches `archiveUnseenSourcedListings`, which soft-archives every listing the
  // enumeration failed to mention. A WordPress site behind a caching plugin that
  // strips response headers publishes no `X-WP-TotalPages` at all.
  it.each([
    ['absent', {}],
    ['empty', { 'x-wp-totalpages': '' }],
    ['not a number', { 'x-wp-totalpages': 'lots' }],
    ['fractional', { 'x-wp-totalpages': '2.5' }],
    ['zero', { 'x-wp-totalpages': '0' }],
  ])('case 5: a FULL page whose header is %s keeps paging', async (_label, headers) => {
    const { transport } = routingTransport(() => ok(fullPage(100), headers as Record<string, string>));
    const provider = createWooCommerceProvider(transport);

    const page = await provider.fetchProducts(CREDS);

    expect(page.products).toHaveLength(100);
    expect(page.nextCursor).toBe('2');
  });

  it('case 5: an EMPTY page ends the enumeration when no header ever arrives', async () => {
    const { transport } = routingTransport((url) =>
      url.includes('page=2') ? ok([]) : ok(fullPage(100)),
    );
    const provider = createWooCommerceProvider(transport);

    expect((await provider.fetchProducts(CREDS)).nextCursor).toBe('2');
    const second = await provider.fetchProducts(CREDS, '2');
    expect(second.products).toHaveLength(0);
    expect(second.nextCursor).toBeUndefined();
  });

  it('case 5: a SHORT page is NOT taken as the end either', async () => {
    // `per_page` is a REQUEST. A site free to serve fewer (a `rest_post_per_page`
    // filter, a hardened host) makes EVERY page short, so reading a short page as
    // the end stops a 5,000-product catalogue after its first ten products —
    // with a complete-LOOKING seen-set behind it. One extra request settles it.
    const { transport } = routingTransport((url) =>
      url.includes('page=2') ? ok([]) : ok(fullPage(10)),
    );
    const provider = createWooCommerceProvider(transport);

    expect((await provider.fetchProducts(CREDS)).nextCursor).toBe('2');
  });

  it('a USABLE header is still honoured, with no extra request — the control', async () => {
    // Without this the rule above would be indistinguishable from one that never
    // believes a site, which would put an extra request on every enumeration.
    const { transport, calls } = routingTransport(() =>
      ok(fullPage(100), { 'x-wp-totalpages': '1' }),
    );
    const provider = createWooCommerceProvider(transport);

    expect((await provider.fetchProducts(CREDS)).nextCursor).toBeUndefined();
    expect(calls.filter((call) => call.url.includes('/products?'))).toHaveLength(1);
  });

  it('REFUSES rather than paging forever when a site answers full pages with no header', async () => {
    // The bound on the loop. Driving it a thousand pages would measure patience,
    // so the last admissible page is asked for directly.
    const { transport } = routingTransport(() => ok(fullPage(100)));
    const provider = createWooCommerceProvider(transport);

    await expect(provider.fetchProducts(CREDS, '1000')).rejects.toThrow(
      /without proving a complete enumeration/,
    );
  });

  it('case 6: a LATER-page failure propagates instead of ending the enumeration', async () => {
    // The failure has to reach `runBackfill`'s catch: a page that 500s must fail
    // the run, because the alternative — treating it as the end — hands delete
    // reconciliation everything page 2 would have listed.
    const { transport } = routingTransport((url) =>
      url.includes('page=2')
        ? { status: 500, headers: {}, body: '{}' }
        : ok(fullPage(100), { 'x-wp-totalpages': '3' }),
    );
    const provider = createWooCommerceProvider(transport);

    expect((await provider.fetchProducts(CREDS)).nextCursor).toBe('2');
    await expect(provider.fetchProducts(CREDS, '2')).rejects.toThrow(/HTTP 500/);
  });

  it('a VARIATIONS page with no header keeps paging, and the declared set is decisive', async () => {
    // The variations endpoint pages exactly as the products one does; what makes
    // a variable product cost no extra request is the parent's own id list,
    // which settles the question before pagination has to.
    const { transport, calls } = routingTransport((url) => {
      if (url.includes('/variations')) {
        return url.includes('page=2')
          ? ok([])
          : ok(
              Array.from({ length: 100 }, (_, i) => ({
                id: 3000 + i,
                price: '1.00',
                regular_price: '1.00',
                sale_price: '',
                manage_stock: true,
                stock_quantity: 1,
                attributes: [{ name: 'Size', option: `S${i}` }],
              })),
            );
      }
      return ok(
        [
          {
            id: 222,
            name: 'Tee',
            slug: 'tee',
            type: 'variable',
            attributes: [{ name: 'Size', variation: true, options: ['S0'] }],
            images: [],
            categories: [],
            variations: [],
          },
        ],
        { 'x-wp-totalpages': '1' },
      );
    });
    const provider = createWooCommerceProvider(transport);

    const { products } = await provider.fetchProducts(CREDS);

    expect(variantsOf(products[0])).toHaveLength(100);
    expect(calls.filter((call) => call.url.includes('/variations'))).toHaveLength(2);
  });

  it('a variations read that misses a DECLARED id is reported as a gap, not imported', async () => {
    const { transport } = routingTransport((url) => {
      if (url.includes('/variations')) {
        return ok(
          [
            {
              id: 3001,
              price: '1.00',
              regular_price: '1.00',
              sale_price: '',
              manage_stock: true,
              stock_quantity: 1,
              attributes: [{ name: 'Size', option: 'S' }],
            },
          ],
          { 'x-wp-totalpages': '1' },
        );
      }
      return ok(
        [
          {
            id: 222,
            name: 'Tee',
            slug: 'tee',
            type: 'variable',
            attributes: [{ name: 'Size', variation: true, options: ['S', 'M'] }],
            images: [],
            categories: [],
            variations: [3001, 3002],
          },
        ],
        { 'x-wp-totalpages': '1' },
      );
    });
    const provider = createWooCommerceProvider(transport);

    const { products } = await provider.fetchProducts(CREDS);

    expect(products[0].variants).toEqual({
      enumeration: 'incomplete',
      gap: { kind: 'declared_not_fetched', missingIds: ['3002'] },
    });
  });
});

describe('woocommerce provider registry', () => {
  it('resolves the woocommerce provider as an api_key strategy', () => {
    expect(isImplementedProvider('woocommerce')).toBe(true);
    const provider = getConnectorProvider('woocommerce');
    expect(provider.id).toBe('woocommerce');
    expect(provider.credentialStrategy).toBe('api_key');
  });

  it('reports a per-connection webhook secret strategy', () => {
    expect(getConnectorProvider('woocommerce').webhookSecretStrategy).toBe('per_connection');
  });

  it('throws for the OAuth + PUSH methods WooCommerce does not support', async () => {
    const provider = getConnectorProvider('woocommerce');
    // OAuth connect (api_key strategy) — buildAuthorizeUrl is sync (throws), exchangeCode rejects.
    expect(() => provider.buildAuthorizeUrl({ shopDomain: 'x', redirectUri: 'y', state: 's', scopes: [] })).toThrow();
    await expect(provider.exchangeCode({ shopDomain: 'x', code: 'c', redirectUri: 'y' })).rejects.toThrow();
    // Outbound push (owned by the WordPress plugin's push_in path, not this connector).
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
    await expect(provider.pushFulfillment(AUTH, { externalOrderId: '1' })).rejects.toThrow();
  });
});
