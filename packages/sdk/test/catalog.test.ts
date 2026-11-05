import { describe, expect, it } from 'vitest';
import {
  catalogProductRef,
  createMercariaClient,
  formatMercariaRef,
  MercariaBadRequestError,
  MercariaGoneError,
  MercariaResponseError,
  MercariaValidationError,
  parseMercariaRefString,
  productRef,
} from '../src/index';
import { fakeClient, failure, ok } from './helpers';

const API = 'https://api.mercaria.co/public/v1';

function summaryWire(id = 'cp_1'): Record<string, unknown> {
  return {
    ref: { kind: 'catalog_product', id },
    name: 'Phone X',
    image: null,
    url: 'https://mercaria.co/p/phone-x',
    offers: { count: 2, availability: 'in_stock', lowestPrice: { amount: 1_999, currency: 'EUR' } },
  };
}

function productWire(id = 'cp_1'): Record<string, unknown> {
  return {
    ref: { kind: 'catalog_product', id },
    name: 'Phone X',
    image: null,
    url: 'https://mercaria.co/p/phone-x',
    description: null,
    images: [],
    variants: [{ id: 'v_1', name: '128 GB', gtins: ['00012345678905'] }],
    offers: [
      {
        id: 'o_1',
        kind: 'external',
        variantId: 'v_1',
        seller: { kind: 'merchant', name: 'Retailer', domain: 'shop.example' },
        price: { amount: 1_999, currency: 'EUR' },
        availability: 'in_stock',
        condition: null,
        observedAt: '2026-09-01T10:00:00.000Z',
        action: {
          kind: 'outbound',
          path: '/out/mgo_abc.def',
          destinationHost: 'shop.example',
          rel: 'sponsored nofollow noopener',
        },
        source: null,
      },
    ],
  };
}

describe('catalog', () => {
  it('searches with a trimmed, required query and an optional market, and reads by id or ref', async () => {
    const { client, requests } = fakeClient(({ url }) =>
      url.includes('/catalog/products?')
        ? ok({ items: [summaryWire()], nextCursor: null })
        : ok(productWire()),
    );

    const page = await client.catalog.search({ query: '  phone x  ', market: 'ES', limit: 5 });
    expect(page.items[0]?.ref).toEqual({ kind: 'catalog_product', id: 'cp_1' });
    await client.catalog.get('cp_1');
    await client.catalog.resolveRef(catalogProductRef('cp_1'));

    expect(requests.map((request) => request.url)).toEqual([
      `${API}/catalog/products?limit=5&market=ES&q=phone%20x`,
      `${API}/catalog/products/cp_1`,
      `${API}/catalog/products/cp_1`,
    ]);
  });

  it('refuses before sending: a blank query, a market that is not a country, another kind of ref', async () => {
    const { client, requests } = fakeClient(() => ok(productWire()));
    await expect(client.catalog.search({ query: '   ' })).rejects.toBeInstanceOf(
      MercariaBadRequestError,
    );
    await expect(client.catalog.search({ query: 'x', market: 'spain' })).rejects.toBeInstanceOf(
      MercariaBadRequestError,
    );
    await expect(
      client.catalog.get(productRef('cp_1') as unknown as string),
    ).rejects.toBeInstanceOf(MercariaValidationError);
    expect(requests).toEqual([]);
  });

  it('parses an offer naming a variant the product does not have as malformed', async () => {
    const wire = productWire();
    const [offer] = wire.offers as { variantId: string }[];
    if (offer) offer.variantId = 'v_elsewhere';
    const { client } = fakeClient(() => ok(wire));
    await expect(client.catalog.get('cp_1')).rejects.toBeInstanceOf(MercariaResponseError);
  });

  it('maps a withdrawn product to gone', async () => {
    const { client } = fakeClient(() => failure(410, 'gone'));
    await expect(client.catalog.get('cp_1')).rejects.toBeInstanceOf(MercariaGoneError);
  });
});

describe('links.offer', () => {
  const links = createMercariaClient({ apiBaseUrl: 'https://api.example.test/' }).links;

  it('puts an outbound path on the client’s API origin, a native offer on its page, and nothing on none', () => {
    const offer = (productWire().offers as { action: unknown }[])[0] as never;
    expect(links.offer(offer)).toBe('https://api.example.test/out/mgo_abc.def');
    expect(
      links.offer({
        kind: 'mercaria_checkout',
        purchaseOption: { kind: 'variant', productId: 'p', variantId: 'v' },
        url: 'https://mercaria.co/products/p',
      }),
    ).toBe('https://mercaria.co/products/p');
    expect(links.offer({ kind: 'none', destinationHost: null })).toBeNull();
  });

  it('refuses a path that is not a Mercaria redirect', () => {
    expect(() =>
      links.offer({
        kind: 'outbound',
        path: '//evil.example/out/x',
        destinationHost: 'evil.example',
        rel: 'nofollow',
      }),
    ).toThrow(MercariaValidationError);
  });
});

describe('catalog product refs', () => {
  it('round-trips through the string form', () => {
    const ref = catalogProductRef('cp/1');
    expect(formatMercariaRef(ref)).toBe('mercaria:catalog_product:cp%2F1');
    expect(parseMercariaRefString('mercaria:catalog_product:cp%2F1')).toEqual(ref);
  });
});
