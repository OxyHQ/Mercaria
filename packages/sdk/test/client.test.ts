import { describe, expect, it } from 'vitest';
import {
  collectionRef,
  createMercariaClient,
  iterateMercariaPages,
  MercariaNotFoundError,
  MercariaResponseError,
  MercariaValidationError,
  productRef,
  storeRef,
  variantRef,
} from '../src/index';
import { collectionWire, pageWire, productSummaryWire, productWire, storeWire } from './fixtures';
import { fakeClient, ok, rejection } from './helpers';

const API = 'https://api.mercaria.co/public/v1';

describe('request URLs', () => {
  it('uses the production API by default and the documented route for every read', async () => {
    const { client, requests } = fakeClient(({ url }) => {
      if (url.includes('/collections/col_1/products') || url.includes('/stores/store_1/products')) {
        return ok(pageWire([]));
      }
      if (url.includes('/stores/store_1/collections')) return ok(pageWire([]));
      if (url.includes('/collections/')) return ok(collectionWire());
      if (url.includes('/stores/')) return ok(storeWire());
      if (url.endsWith('/products') || url.includes('/products?')) return ok(pageWire([]));
      return ok(productWire());
    });

    await client.products.get('prod_1');
    await client.products.search();
    await client.stores.get('store_1');
    await client.stores.lookup({ handle: 'night-city-games' });
    await client.stores.products('store_1');
    await client.stores.collections('store_1');
    await client.collections.get('col_1');
    await client.collections.products('col_1');

    expect(requests.map((request) => request.url)).toEqual([
      `${API}/products/prod_1`,
      `${API}/products`,
      `${API}/stores/store_1`,
      `${API}/stores/lookup?handle=night-city-games`,
      `${API}/stores/store_1/products`,
      `${API}/stores/store_1/collections`,
      `${API}/collections/col_1`,
      `${API}/collections/col_1/products`,
    ]);
    for (const { init } of requests) {
      expect(init.method).toBe('GET');
      expect(init.headers.Accept).toBe('application/json');
      expect(init.credentials).toBe('omit');
    }
  });

  it('serialises the query deterministically: sorted keys, undefined omitted, booleans as words', async () => {
    const { client, requests } = fakeClient(() => ok(pageWire([])));

    await client.products.search({
      sort: 'price_asc',
      query: 'red shoes & socks',
      limit: 10,
      inStock: false,
      store: storeRef('store 1'),
      collection: 'col/1',
      cursor: 'abc==',
      locale: 'pt-BR',
    });
    await client.products.search({
      locale: 'pt-BR',
      cursor: 'abc==',
      collection: collectionRef('col/1'),
      store: 'store 1',
      inStock: false,
      limit: 10,
      query: 'red shoes & socks',
      sort: 'price_asc',
    });
    await client.products.search({ query: undefined, inStock: true, sort: undefined });

    const expected =
      `${API}/products?collectionId=col%2F1&cursor=abc%3D%3D&limit=10&locale=pt-BR` +
      '&q=red%20shoes%20%26%20socks&sort=price_asc&storeId=store%201';
    expect(requests[0]?.url).toBe(expected);
    expect(requests[1]?.url).toBe(expected);
    expect(requests[2]?.url).toBe(`${API}/products?inStock=true`);
  });

  it('never sends inStock=false, which filters nothing server-side', async () => {
    const { client, requests } = fakeClient(() => ok(pageWire([])));
    await client.products.search({ inStock: false });
    await client.products.search({});
    await client.stores.products('store_1', { inStock: false });
    expect(requests.map((request) => request.url)).toEqual([
      `${API}/products`,
      `${API}/products`,
      `${API}/stores/store_1/products`,
    ]);
  });

  it('percent-encodes ids in the path', async () => {
    const { client, requests } = fakeClient(({ url }) =>
      url.includes('/stores/') ? ok(storeWire('a/b?c#d')) : ok(productWire('a/b?c#d')),
    );
    await client.products.get('a/b?c#d');
    await client.stores.get(storeRef('a/b?c#d'));
    expect(requests[0]?.url).toBe(`${API}/products/a%2Fb%3Fc%23d`);
    expect(requests[1]?.url).toBe(`${API}/stores/a%2Fb%3Fc%23d`);
  });

  it('honours a custom API base URL, trailing slashes trimmed', async () => {
    const { client, requests } = fakeClient(() => ok(productWire()), {
      apiBaseUrl: 'http://localhost:3001//',
    });
    await client.products.get('prod_1');
    expect(requests[0]?.url).toBe('http://localhost:3001/public/v1/products/prod_1');
  });

  it('sends extra non-auth headers and refuses to let them carry authorization', async () => {
    const { client, requests } = fakeClient(() => ok(productWire()), { headers: { 'X-Request-Id': 'r1' } });
    await client.products.get('prod_1');
    expect(requests[0]?.init.headers).toEqual({ 'X-Request-Id': 'r1', Accept: 'application/json' });

    expect(() => createMercariaClient({ headers: { authorization: 'Bearer x' } })).toThrow(TypeError);
    expect(() => createMercariaClient({ headers: { AUTHORIZATION: 'Bearer x' } })).toThrow(TypeError);
    expect(() => createMercariaClient({ headers: { Accept: 'text/html' } })).toThrow(TypeError);
  });

  it('rejects invalid client options at creation', () => {
    expect(() => createMercariaClient({ apiBaseUrl: 'ftp://x' })).toThrow(TypeError);
    expect(() => createMercariaClient({ apiBaseUrl: 'https://x/?a=1' })).toThrow(TypeError);
    expect(() => createMercariaClient({ webBaseUrl: 'mercaria.co' })).toThrow(TypeError);
    expect(() => createMercariaClient({ timeoutMs: 0 })).toThrow(TypeError);
    expect(() => createMercariaClient({ locale: 'not a locale' })).toThrow(TypeError);
  });
});

describe('client-side validation sends no request', () => {
  const { client, requests } = fakeClient();

  it.each([
    ['empty product id', () => client.products.get('')],
    ['blank product id', () => client.products.get('   ')],
    ['dot-dot product id', () => client.products.get('..')],
    ['dot product id', () => client.stores.get('.')],
    ['wrong ref kind', () => client.products.get(storeRef('s') as never)],
    ['a ref with extra keys', () => client.products.get({ kind: 'product', id: 'p', title: 'x' } as never)],
    ['resolveRef given an id', () => client.products.resolveRef('prod_1' as never)],
    ['resolveVariant given a product ref', () => client.products.resolveVariant(productRef('p') as never)],
    ['limit 0', () => client.products.search({ limit: 0 })],
    ['limit 51', () => client.products.search({ limit: 51 })],
    ['fractional limit', () => client.stores.collections('s', { limit: 1.5 })],
    ['empty cursor', () => client.collections.products('c', { cursor: '' })],
    ['unknown sort', () => client.products.search({ sort: 'cheapest' as never })],
    ['relevance without query', () => client.products.search({ sort: 'relevance' })],
    ['relevance with a blank query', () => client.stores.products('s', { sort: 'relevance', query: '  ' })],
    ['bad locale', () => client.products.search({ locale: 'x y' })],
    ['non-boolean inStock', () => client.stores.products('s', { inStock: 'yes' as never })],
    ['empty handle', () => client.stores.lookup({ handle: '' })],
    ['empty store filter', () => client.products.search({ store: '' })],
  ])('%s', async (_name, call) => {
    const error = await rejection(call());
    expect(error).toBeInstanceOf(MercariaValidationError);
    expect((error as MercariaValidationError).status).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('accepts relevance with a query and trims the query', async () => {
    const recorded = fakeClient(() => ok(pageWire([])));
    await recorded.client.products.search({ query: '  shoes ', sort: 'relevance' });
    expect(recorded.requests[0]?.url).toBe(`${API}/products?q=shoes&sort=relevance`);
  });
});

describe('auth injection', () => {
  it('calls the getter before EVERY request and sends a bearer token only when one is returned', async () => {
    const tokens: Array<string | null | undefined> = ['tok_1', null, 'tok_2', undefined, ''];
    let calls = 0;
    const { client, requests } = fakeClient(() => ok(productWire()), {
      getAccessToken: async () => tokens[calls++],
    });

    for (let index = 0; index < tokens.length; index += 1) await client.products.get('prod_1');

    expect(calls).toBe(5);
    expect(requests.map((request) => request.init.headers.Authorization)).toEqual([
      'Bearer tok_1',
      undefined,
      'Bearer tok_2',
      undefined,
      undefined,
    ]);
  });

  it('supports a synchronous getter', async () => {
    const { client, requests } = fakeClient(() => ok(productWire()), { getAccessToken: () => 'sync' });
    await client.products.get('prod_1');
    expect(requests[0]?.init.headers.Authorization).toBe('Bearer sync');
  });

  it('is anonymous with no getter at all', async () => {
    const { client, requests } = fakeClient(() => ok(productWire()));
    await client.products.get('prod_1');
    expect(requests[0]?.init.headers).not.toHaveProperty('Authorization');
  });

  it('passes a getter failure through unchanged and sends nothing', async () => {
    const failure = new Error('session refresh failed');
    const { client, requests } = fakeClient(() => ok(productWire()), {
      getAccessToken: async () => {
        throw failure;
      },
    });
    expect(await rejection(client.products.get('prod_1'))).toBe(failure);
    expect(requests).toHaveLength(0);
  });

  it('refuses a getter that returns a non-string', async () => {
    const { client } = fakeClient(() => ok(productWire()), { getAccessToken: (() => 42) as never });
    expect(await rejection(client.products.get('prod_1'))).toBeInstanceOf(TypeError);
  });
});

describe('locale context', () => {
  it('applies the client default to the list reads that take one, and lets each call override it', async () => {
    const { client, requests } = fakeClient(({ url }) => (url.includes('/products/') ? ok(productWire()) : ok(pageWire([]))), {
      locale: 'es',
    });
    await client.products.search({ query: 'x' });
    await client.products.search({ query: 'x', locale: 'fr-CA' });
    await client.stores.products('store_1');
    await client.stores.products('store_1', { locale: 'de' });
    await client.collections.products('col_1');

    expect(requests.map((request) => request.url)).toEqual([
      `${API}/products?locale=es&q=x`,
      `${API}/products?locale=fr-CA&q=x`,
      `${API}/stores/store_1/products?locale=es`,
      `${API}/stores/store_1/products?locale=de`,
      // The collection products read has no locale parameter on the wire.
      `${API}/collections/col_1/products`,
    ]);
  });

  it('sends NO query parameter on a detail read, whatever the client default', async () => {
    // The server answers 400 to any query parameter it does not name on a
    // detail route, so a default locale leaking onto one would break every
    // hydration for every client that set one.
    const { client, requests } = fakeClient(({ url }) => {
      if (url.includes('/stores/')) return ok(storeWire());
      if (url.includes('/collections/')) return ok(collectionWire());
      return ok(productWire());
    }, { locale: 'es' });
    await client.products.get('prod_1');
    await client.products.resolveRef(productRef('prod_1'));
    await client.products.resolveVariant(variantRef('prod_1', 'var_ps5'));
    await client.products.get('prod_1', { locale: 'fr' } as never);
    await client.stores.get('store_1');
    await client.collections.get('col_1');
    await client.stores.lookup({ handle: 'h', locale: 'fr' } as never);
    expect(requests.map((request) => request.url)).toEqual([
      `${API}/products/prod_1`,
      `${API}/products/prod_1`,
      `${API}/products/prod_1`,
      `${API}/products/prod_1`,
      `${API}/stores/store_1`,
      `${API}/collections/col_1`,
      `${API}/stores/lookup?handle=h`,
    ]);
  });
});

describe('pagination', () => {
  it('passes the cursor through verbatim and returns nextCursor', async () => {
    const { client, requests } = fakeClient(({ url }) =>
      url.includes('cursor=') ? ok(pageWire([productSummaryWire('p3')], null)) : ok(pageWire([productSummaryWire('p1'), productSummaryWire('p2')], 'opaque+/=')),
    );
    const first = await client.stores.products('store_1', { limit: 2 });
    expect(first.items.map((item) => item.ref.id)).toEqual(['p1', 'p2']);
    expect(first.nextCursor).toBe('opaque+/=');

    const second = await client.stores.products('store_1', { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(requests[1]?.url).toBe(`${API}/stores/store_1/products?cursor=opaque%2B%2F%3D&limit=2`);
    expect(second.nextCursor).toBeNull();
  });

  it('iterates pages until nextCursor is null', async () => {
    const pages: Record<string, unknown> = {
      start: pageWire([collectionWire('c1')], 'k2'),
      k2: pageWire([collectionWire('c2')], 'k3'),
      k3: pageWire([collectionWire('c3')], null),
    };
    const { client } = fakeClient(({ url }) => ok(pages[/cursor=([^&]+)/.exec(url)?.[1] ?? 'start']));
    const seen: string[] = [];
    for await (const page of iterateMercariaPages((cursor) => client.stores.collections('store_1', { cursor }))) {
      seen.push(...page.items.map((item) => item.ref.id));
    }
    expect(seen).toEqual(['c1', 'c2', 'c3']);
  });

  it('stops a cursor that does not advance', async () => {
    const { client } = fakeClient(() => ok(pageWire([], 'same')));
    const pages = iterateMercariaPages((cursor) => client.collections.products('col_1', { cursor }));
    const error = await rejection(
      (async () => {
        for await (const page of pages) void page;
      })(),
    );
    expect(error).toBeInstanceOf(MercariaResponseError);
  });
});

describe('refs and variants', () => {
  it('resolves refs through the same reads', async () => {
    const { client, requests } = fakeClient(({ url }) => {
      if (url.includes('/stores/')) return ok(storeWire());
      if (url.includes('/collections/')) return ok(collectionWire());
      return ok(productWire());
    });
    const product = await client.products.resolveRef(productRef('prod_1'));
    const store = await client.stores.resolveRef(storeRef('store_1'));
    const collection = await client.collections.resolveRef(collectionRef('col_1'));
    expect(product.ref).toEqual({ kind: 'product', id: 'prod_1' });
    expect(store.ref).toEqual({ kind: 'store', id: 'store_1' });
    expect(collection.ref).toEqual({ kind: 'collection', id: 'col_1' });
    expect(requests).toHaveLength(3);
  });

  it('resolves a variant to its product and option', async () => {
    const { client, requests } = fakeClient(() => ok(productWire('prod_1')));
    const { product, option } = await client.products.resolveVariant(variantRef('prod_1', 'var_xbox'));
    expect(requests[0]?.url).toBe(`${API}/products/prod_1`);
    expect(product.ref.id).toBe('prod_1');
    expect(option.title).toBe('Xbox');
    expect(option.availability).toBe('out_of_stock');
  });

  it('reports a variant the product no longer has as not found', async () => {
    const { client } = fakeClient(() => ok(productWire('prod_1')));
    const error = await rejection(client.products.resolveVariant(variantRef('prod_1', 'var_gone')));
    expect(error).toBeInstanceOf(MercariaNotFoundError);
    expect((error as MercariaNotFoundError).status).toBeNull();
  });

  it('parses a store looked up by handle', async () => {
    const { client } = fakeClient(() => ok(storeWire('store_9', 'renamed')));
    const store = await client.stores.lookup({ handle: 'renamed' });
    expect(store.ref).toEqual({ kind: 'store', id: 'store_9' });
  });
});

describe('the global fetch', () => {
  it('is resolved lazily, at request time', async () => {
    const original = globalThis.fetch;
    const client = createMercariaClient();
    const seen: string[] = [];
    globalThis.fetch = (async (input: string) => {
      seen.push(input);
      return new Response(JSON.stringify({ success: true, data: productWire() }), { status: 200 });
    }) as typeof fetch;
    try {
      await client.products.get('prod_1');
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual([`${API}/products/prod_1`]);
  });

  it('accepts the platform fetch type directly', () => {
    // A compile-time assertion as much as a runtime one: `typeof fetch` must be
    // assignable to the `fetch` option under strictFunctionTypes.
    expect(() => createMercariaClient({ fetch: globalThis.fetch })).not.toThrow();
  });
});
