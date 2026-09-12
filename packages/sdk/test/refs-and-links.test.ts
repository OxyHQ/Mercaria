import { describe, expect, it } from 'vitest';
import {
  collectionRef,
  createMercariaClient,
  formatMercariaRef,
  isMercariaRef,
  MercariaValidationError,
  parseMercariaRef,
  parseMercariaRefString,
  productRef,
  storeRef,
  variantRef,
  type MercariaRef,
} from '../src/index';
import { collectionWire, productWire, storeWire, WEB } from './fixtures';
import { fakeClient, ok } from './helpers';

describe('ref constructors', () => {
  it('build frozen refs with exactly the contract keys', () => {
    const refs = [productRef('p'), variantRef('p', 'v'), storeRef('s'), collectionRef('c')];
    expect(refs).toEqual([
      { kind: 'product', id: 'p' },
      { kind: 'variant', productId: 'p', variantId: 'v' },
      { kind: 'store', id: 's' },
      { kind: 'collection', id: 'c' },
    ]);
    for (const ref of refs) expect(Object.isFrozen(ref)).toBe(true);
  });

  it.each([
    () => productRef(''),
    () => productRef('  '),
    () => variantRef('p', ''),
    () => variantRef('', 'v'),
    () => storeRef(undefined as never),
    () => collectionRef(12 as never),
  ])('reject an empty or non-string id (%#)', (build) => {
    expect(build).toThrow(MercariaValidationError);
  });
});

describe('parseMercariaRef — untrusted input, strict', () => {
  it('returns a fresh frozen copy of a valid ref', () => {
    const stored = JSON.parse('{"kind":"variant","productId":"p","variantId":"v"}');
    const parsed = parseMercariaRef(stored);
    expect(parsed).toEqual(stored);
    expect(parsed).not.toBe(stored);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseMercariaRef(Object.freeze({ kind: 'store', id: 's' }))).toEqual({ kind: 'store', id: 's' });
    expect(parseMercariaRef(Object.assign(Object.create(null), { kind: 'product', id: 'p' }))).toEqual({ kind: 'product', id: 'p' });
  });

  it.each([
    ['null', null],
    ['a string', 'mercaria:product:p'],
    ['an array', ['product', 'p']],
    ['unknown kind', { kind: 'listing', id: 'p' }],
    ['missing kind', { id: 'p' }],
    ['extra key', { kind: 'product', id: 'p', title: 'snapshot' }],
    ['extra price snapshot', { kind: 'product', id: 'p', price: { amount: 1, currency: 'EUR' } }],
    ['product ref with variant keys', { kind: 'product', productId: 'p', variantId: 'v' }],
    ['variant missing variantId', { kind: 'variant', productId: 'p' }],
    ['numeric id', { kind: 'store', id: 42 }],
    ['empty id', { kind: 'collection', id: '' }],
    ['blank id', { kind: 'collection', id: '   ' }],
    ['class instance', new (class { kind = 'product'; id = 'p'; })()],
  ])('rejects %s', (_name, value) => {
    expect(parseMercariaRef(value)).toBeNull();
    expect(isMercariaRef(value)).toBe(false);
  });

  it('accepts what the constructors build', () => {
    for (const ref of [productRef('p'), variantRef('p', 'v'), storeRef('s'), collectionRef('c')]) {
      expect(isMercariaRef(ref)).toBe(true);
    }
  });
});

describe('the string form', () => {
  const cases: Array<[MercariaRef, string]> = [
    [productRef('prod_1'), 'mercaria:product:prod_1'],
    [variantRef('prod_1', 'var_1'), 'mercaria:variant:prod_1:var_1'],
    [storeRef('store_1'), 'mercaria:store:store_1'],
    [collectionRef('col_1'), 'mercaria:collection:col_1'],
    [productRef('a:b/c d%e'), 'mercaria:product:a%3Ab%2Fc%20d%25e'],
    [variantRef('p:1', 'v:2'), 'mercaria:variant:p%3A1:v%3A2'],
    [storeRef('ünï'), 'mercaria:store:%C3%BCn%C3%AF'],
  ];

  it.each(cases)('round-trips %o', (ref, text) => {
    expect(formatMercariaRef(ref)).toBe(text);
    expect(parseMercariaRefString(text)).toEqual(ref);
    expect(Object.isFrozen(parseMercariaRefString(text))).toBe(true);
  });

  it.each([
    'mercaria:product:',
    'mercaria:product',
    'mercaria:product:a:b',
    'mercaria:variant:p',
    'mercaria:variant:p:v:x',
    'mercaria:listing:p',
    'other:product:p',
    'MERCARIA:product:p',
    'mercaria:product:%E0%A4%A',
    'mercaria:product:a%62c',
    'mercaria:product:%20',
    '',
  ])('rejects %j', (text) => {
    expect(parseMercariaRefString(text)).toBeNull();
  });

  it('rejects non-strings and refuses to format a malformed ref', () => {
    expect(parseMercariaRefString(42)).toBeNull();
    expect(() => formatMercariaRef({ kind: 'product', id: '' } as MercariaRef)).toThrow(MercariaValidationError);
  });
});

describe('links — identical to the server rules', () => {
  const links = createMercariaClient().links;

  it('builds a product link from an id, a ref, or a DTO', async () => {
    const expected = `${WEB}/products/${encodeURIComponent('prod 1/ü')}`;
    expect(links.product('prod 1/ü')).toBe(expected);
    expect(links.product(productRef('prod 1/ü'))).toBe(expected);
    const { client } = fakeClient(() => ok(productWire('prod 1/ü')));
    const product = await client.products.get('prod 1/ü');
    expect(links.product(product)).toBe(expected);
    expect(links.product(product)).toBe(product.url);
  });

  it('builds a store link from a handle or anything carrying one', async () => {
    const { client } = fakeClient(() => ok(storeWire('store_1', 'café & co')));
    const store = await client.stores.get('store_1');
    expect(links.store('café & co')).toBe(`${WEB}/stores/${encodeURIComponent('café & co')}`);
    expect(links.store(store)).toBe(store.url);
  });

  it('builds a collection link from the collection and its store handle', async () => {
    const { client } = fakeClient(({ url }) =>
      url.includes('/collections/') ? ok(collectionWire('col/1', 'my shop')) : ok(storeWire('store_1', 'my shop')),
    );
    const collection = await client.collections.get('col/1');
    const store = await client.stores.get('store_1');
    const expected = `${WEB}/stores/${encodeURIComponent('my shop')}?collection=${encodeURIComponent('col/1')}`;
    expect(links.collection(collection, store)).toBe(expected);
    expect(links.collection(collectionRef('col/1'), 'my shop')).toBe(expected);
    expect(links.collection('col/1', { handle: 'my shop' })).toBe(expected);
    expect(links.collection(collection, store)).toBe(collection.url);
  });

  it('uses a custom web base URL', () => {
    const custom = createMercariaClient({ webBaseUrl: 'https://staging.mercaria.co/' }).links;
    expect(custom.product('p')).toBe('https://staging.mercaria.co/products/p');
  });

  it.each([
    () => links.product(''),
    () => links.product(storeRef('s') as never),
    () => links.store(''),
    () => links.store(storeRef('s') as never),
    () => links.collection(productRef('p') as never, 'shop'),
    () => links.collection('c', ''),
  ])('refuses input it cannot link (%#)', (build) => {
    expect(build).toThrow(MercariaValidationError);
  });
});
