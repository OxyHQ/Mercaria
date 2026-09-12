import { describe, expect, it } from 'vitest';
import { MercariaResponseError, type MercariaError } from '../src/index';
import {
  collectionWire,
  pageWire,
  personSellerWire,
  productSummaryWire,
  productWire,
  storeWire,
} from './fixtures';
import { fakeClient, ok, rejection } from './helpers';

type Wire = Record<string, unknown>;

/** Deep-set a path like `price.currency` or `purchaseOptions.0.ref`. */
function withField(wire: Wire, path: string, value: unknown): Wire {
  const copy = structuredClone(wire);
  const keys = path.split('.');
  let cursor: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  const last = keys[keys.length - 1] as string;
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
  return copy;
}

function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => allKeys(entry, into));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      allKeys(entry, into);
    }
  }
  return into;
}

describe('successful parses', () => {
  it('parses a product detail into exactly the contract shape', async () => {
    const { client } = fakeClient(() => ok(productWire()));
    expect(await client.products.get('prod_1')).toEqual(productWire());
  });

  it('parses a person seller, a viewer and nullable pieces', async () => {
    const wire = { ...productWire(), seller: personSellerWire(), viewer: { saved: true }, primaryImage: null, compareAtPrice: null, priceRange: null };
    const { client } = fakeClient(() => ok(wire));
    const product = await client.products.get('prod_1');
    expect(product.seller).toEqual(personSellerWire());
    expect(product.viewer).toEqual({ saved: true });
  });

  it('parses a sold one-off product as a successful read', async () => {
    const wire = { ...productWire(), availability: 'sold' };
    const { client } = fakeClient(() => ok(wire));
    expect((await client.products.get('prod_1')).availability).toBe('sold');
  });

  it('parses a store and a collection', async () => {
    const { client } = fakeClient(({ url }) => (url.includes('/collections/') ? ok(collectionWire()) : ok(storeWire())));
    expect(await client.stores.get('store_1')).toEqual(storeWire());
    expect(await client.collections.get('col_1')).toEqual(collectionWire());
  });

  it('returns frozen refs', async () => {
    const { client } = fakeClient(() => ok(productWire()));
    const product = await client.products.get('prod_1');
    expect(Object.isFrozen(product.ref)).toBe(true);
    expect(Object.isFrozen(product.purchaseOptions[0]?.ref)).toBe(true);
  });
});

describe('leaked fields never survive', () => {
  const LEAKS = {
    sku: 'SKU-123',
    barcode: '0123456789012',
    source: { connector: 'woocommerce', externalId: 'wc_9' },
    supplierId: 'sup_1',
    wholesaleCost: { amount: 1000, currency: 'EUR' },
    memberIds: ['p1', 'p2'],
    rules: [{ field: 'price' }],
    fileId: 'oxy_file_1',
  };

  it('strips extra keys at every level of a product', async () => {
    const wire = productWire() as Wire & { purchaseOptions: Wire[]; images: Wire[] };
    Object.assign(wire, LEAKS);
    Object.assign(wire.purchaseOptions[0] as Wire, { sku: 'VAR-SKU', barcode: '1', supplierRef: 'x' });
    Object.assign(wire.ref as Wire, { storeId: 'store_1', handle: 'h' });
    Object.assign(wire.price as Wire, { fx: 1.2 });
    Object.assign(wire.seller as Wire, { email: 'owner@example.com', stripeAccountId: 'acct_1' });
    Object.assign(wire.images[0] as Wire, { fileId: 'oxy_file_1' });
    Object.assign(wire.condition as Wire, { evidence: ['photo'] });

    const { client } = fakeClient(() => ok(wire));
    const product = await client.products.get('prod_1');
    const keys = allKeys(product);
    for (const leaked of ['sku', 'barcode', 'source', 'supplierId', 'wholesaleCost', 'memberIds', 'rules', 'fileId', 'supplierRef', 'storeId', 'fx', 'email', 'stripeAccountId', 'evidence']) {
      expect(keys.has(leaked), leaked).toBe(false);
    }
    expect(product).toEqual(productWire());
  });

  it('strips extra keys from pages, stores and collections', async () => {
    const summary = { ...productSummaryWire(), ...LEAKS };
    const store = { ...storeWire(), ownerOxyUserId: 'oxy_1', stripeAccountId: 'acct', ...LEAKS };
    const collection = { ...collectionWire(), ...LEAKS, automated: true };
    const { client } = fakeClient(({ url }) => {
      if (url.includes('/stores/store_1/products')) return ok({ ...pageWire([summary], null), total: 99, offset: 0 });
      if (url.includes('/collections/')) return ok(collection);
      return ok(store);
    });
    const page = await client.stores.products('store_1');
    expect(page).toEqual(pageWire([productSummaryWire()], null));
    expect(await client.stores.get('store_1')).toEqual(storeWire());
    expect(await client.collections.get('col_1')).toEqual(collectionWire());
  });
});

describe('malformed DTOs fail closed', () => {
  async function malformedProduct(wire: Wire): Promise<MercariaError> {
    const { client } = fakeClient(() => ok(wire));
    const error = (await rejection(client.products.get('prod_1'))) as MercariaError;
    expect(error).toBeInstanceOf(MercariaResponseError);
    expect(error.code).toBe('MALFORMED_RESPONSE');
    return error;
  }

  it.each([
    ['missing title', 'title', undefined],
    ['numeric title', 'title', 7],
    ['ref of the wrong kind', 'ref', { kind: 'store', id: 'prod_1' }],
    ['empty ref id', 'ref.id', ''],
    ['unknown availability', 'availability', 'preorder'],
    ['unknown currency', 'price.currency', 'DOGE'],
    ['fractional amount', 'price.amount', 19.99],
    ['negative amount', 'price.amount', -1],
    ['unsafe amount', 'price.amount', 1e300],
    ['string amount', 'price.amount', '2999'],
    ['unknown condition key', 'condition.key', 'mint'],
    ['condition group not matching its key', 'condition.group', 'new'],
    ['unknown seller kind', 'seller.kind', 'company'],
    ['javascript: image URL', 'primaryImage.url', 'javascript:alert(1)'],
    ['relative product URL', 'url', '/products/prod_1'],
    ['missing viewer', 'viewer', undefined],
    ['viewer.saved not boolean', 'viewer', { saved: 'yes' }],
    ['non-ISO updatedAt', 'updatedAt', 'yesterday'],
    ['images not an array', 'images', {}],
    ['sold purchase option', 'purchaseOptions.0.availability', 'sold'],
    ['option of another product', 'purchaseOptions.0.ref.productId', 'prod_other'],
    ['missing compareAtPrice (null required)', 'compareAtPrice', undefined],
  ])('%s', async (_name, path, value) => {
    const error = await malformedProduct(withField(productWire(), path, value));
    expect(error.message).toContain(`data.${path.split('.')[0]}`);
  });

  it.each([
    ['bad brand colour', 'brandColor', 'red; background:url(x)'],
    ['rating above 5', 'rating', 6],
    ['negative review count', 'reviewCount', -2],
    ['empty handle', 'handle', ''],
    ['logo with a data: URL', 'logoUrl', 'data:image/png;base64,AAAA'],
  ])('store: %s', async (_name, path, value) => {
    const { client } = fakeClient(() => ok(withField(storeWire(), path, value)));
    expect(await rejection(client.stores.get('store_1'))).toBeInstanceOf(MercariaResponseError);
  });

  it('collection: store ref of the wrong kind', async () => {
    const { client } = fakeClient(() => ok(withField(collectionWire(), 'store', { kind: 'product', id: 'x' })));
    expect(await rejection(client.collections.get('col_1'))).toBeInstanceOf(MercariaResponseError);
  });

  it('fails the WHOLE page when one row is malformed, naming the row', async () => {
    const rows = [productSummaryWire('p1'), withField(productSummaryWire('p2'), 'price.currency', 'XXX'), productSummaryWire('p3')];
    const { client } = fakeClient(() => ok(pageWire(rows, 'next')));
    const error = (await rejection(client.products.search({ query: 'x' }))) as MercariaError;
    expect(error).toBeInstanceOf(MercariaResponseError);
    expect(error.message).toContain('data.items[1].price.currency');
  });

  it.each([
    ['missing items', { nextCursor: null }],
    ['missing nextCursor', { items: [] }],
    ['empty nextCursor', { items: [], nextCursor: '' }],
    ['numeric nextCursor', { items: [], nextCursor: 2 }],
  ])('page: %s', async (_name, data) => {
    const { client } = fakeClient(() => ok(data));
    expect(await rejection(client.collections.products('col_1'))).toBeInstanceOf(MercariaResponseError);
  });
});
