/**
 * `@mercaria.co/sdk` against the REAL Mercaria backend (#1017) — the test that
 * makes route and DTO drift between the server and the published client fail a
 * build instead of a consumer.
 *
 * ## What is real, and what is not
 *
 * The server is the real `createApp()` chain on an ephemeral port over a real
 * database: CORS, both rate limiters, the router, the strict query schemas, the
 * service, the repositories and the projection. The client is the SDK built from
 * SOURCE (`@mercaria.co/sdk` resolves to `packages/sdk/src/index.ts` through the
 * backend's `tsconfig.json` `paths` and `vitest.config.ts` alias), created with
 * `createMercariaClient` and nothing else: every read below goes through the
 * SDK's query serialiser, its transport, its error mapping and its hand-written
 * PARSER. No response is fetched raw. A result reaching an assertion has
 * therefore already survived the SDK's fail-closed parse — a renamed route, a
 * renamed query parameter the strict schemas refuse, a missing or mistyped
 * field or a new enum value all reject before it gets here. The frozen refs the
 * parser mints are asserted as the positive control that it really ran.
 *
 * `public-api.realdb.test.ts` proves the WIRE with raw `fetch`; this file proves
 * the two halves AGREE. Both read one fixture world and one table of the
 * contract's key sets (`public-api-fixtures.ts`).
 *
 * ## The auth STAND-IN, and why it reads `Authorization`
 *
 * `middleware/auth.js` is mocked, standing in for the network call to Oxy and
 * nothing else — the same shape as the wire suite, with one difference that is
 * the point: this `optionalAuth` reads the `Authorization: Bearer` header, maps
 * a token it "verifies" to its Oxy user and reads any other token as anonymous
 * (the real middleware's rule). So `viewer.saved` coming back `true` is proof
 * the SDK called `getAccessToken` and FORWARDED the caller's authority in the
 * header the real verifier reads. `oxyClient` carries a pass-through `auth()`
 * because the (unmocked) rate limiter calls it on every request, a prefixing
 * `getFileDownloadUrl`, and `getUserById` for the person seller.
 *
 * ## Shared database
 *
 * Every fixture is namespaced by the world's run id and every list read is
 * scoped to a store, collection or search term only this file creates.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { uuidv7 } from '@oxy.so/db';
import {
  collectionRef,
  createMercariaClient,
  iterateMercariaPages,
  MERCARIA_PUBLIC_API_BASE_PATH,
  MercariaApiError,
  MercariaGoneError,
  MercariaNetworkError,
  MercariaNotFoundError,
  productRef,
  storeRef,
  variantRef,
  type MercariaClient,
  type MercariaCollection,
  type MercariaPage,
  type MercariaProduct,
  type MercariaProductSummary,
  type MercariaStore,
} from '@mercaria.co/sdk';
import type { Database } from '../../db/postgres.js';
import { checkShape, createPublicApiWorld, mediaUrl, type Shape } from './public-api-fixtures.js';

/** What the Oxy stand-in verifies, and every `Authorization` header it received. */
const oxy = vi.hoisted(() => ({
  /** Bearer token → Oxy user id. A token not in here does not verify. */
  verifiedTokens: new Map<string, string>(),
  authorizationHeaders: [] as (string | undefined)[],
}));

vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    auth:
      () =>
      (_req: express.Request, _res: express.Response, next: express.NextFunction): void => {
        next();
      },
    getFileDownloadUrl: (fileId: string) => `https://media.test.invalid/${fileId}`,
    getUserById: (id: string) =>
      Promise.resolve({
        id,
        username: `person${id.slice(-6)}`,
        name: { displayName: 'Pat Seller' },
        avatar: `avatar-${id}`,
      }),
  },
  authenticateToken: (_req: express.Request, res: express.Response): void => {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  },
  optionalAuth: (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
    const header = req.headers.authorization;
    oxy.authorizationHeaders.push(header);
    const token = /^Bearer (\S+)$/u.exec(header ?? '')?.[1];
    const userId = token === undefined ? undefined : oxy.verifiedTokens.get(token);
    if (userId !== undefined) {
      (req as unknown as { user: { id: string } }).user = { id: userId };
      (req as unknown as { userId: string }).userId = userId;
    }
    next();
  },
}));

const world = createPublicApiWorld();
const { RUN, TERM, VIEWER, PERSON, SENTINEL, ids, storeAHandle } = world;

const VIEWER_TOKEN = `sdk-contract-viewer-token-${RUN}`;
const OTHER_TOKEN = `sdk-contract-other-token-${RUN}`;
const OTHER_USER = `oxy-user-sdk-contract-other-${RUN}`;

let db: Database;
let closePostgres: () => Promise<void>;
let server: Server;
let apiBaseUrl: string;
let webOrigin: string;

/** Anonymous. */
let mercaria: MercariaClient;
/** Carries `VIEWER`'s token, who saved the in-stock product. */
let asViewer: MercariaClient;
/** Carries another verified user's token, from an ASYNC getter. */
let asOther: MercariaClient;

/* -------------------------------------------------------------------------- */
/* Every SDK result, checked as it arrives and kept for the privacy census    */
/* -------------------------------------------------------------------------- */

const RESULTS: unknown[] = [];

/**
 * Record an SDK result: its key set must EQUAL the contract's, recursively
 * (`checkShape`), and it joins the census at the end of the file.
 */
function contract<T>(value: T, shape: Shape, where: string): T {
  checkShape(value, shape, where);
  RESULTS.push(value);
  return value;
}

const product = async (promise: Promise<MercariaProduct>, where: string) =>
  contract(await promise, 'product', where);
const store = async (promise: Promise<MercariaStore>, where: string) => contract(await promise, 'store', where);
const collection = async (promise: Promise<MercariaCollection>, where: string) =>
  contract(await promise, 'collection', where);
const productPage = async (promise: Promise<MercariaPage<MercariaProductSummary>>, where: string) =>
  contract(await promise, 'page:productSummary', where);
const collectionPage = async (promise: Promise<MercariaPage<MercariaCollection>>, where: string) =>
  contract(await promise, 'page:collection', where);

const refIds = (page: MercariaPage<{ ref: { id: string } }>): string[] => page.items.map((item) => item.ref.id);

/** The rejection of an SDK call that must fail. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the SDK call to reject');
}

function expectGone(error: unknown): void {
  expect(error).toBeInstanceOf(MercariaGoneError);
  expect(error).not.toBeInstanceOf(MercariaNotFoundError);
  expect(error).toMatchObject({ code: 'GONE', status: 410 });
}

function expectNotFound(error: unknown): void {
  expect(error).toBeInstanceOf(MercariaNotFoundError);
  expect(error).not.toBeInstanceOf(MercariaGoneError);
  expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres();
  closePostgres = postgres.closePostgres;
  const { config } = await import('../../config/index.js');
  webOrigin = config.web.origin;

  await world.seed(db);
  oxy.verifiedTokens.set(VIEWER_TOKEN, VIEWER);
  oxy.verifiedTokens.set(OTHER_TOKEN, OTHER_USER);

  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  apiBaseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  mercaria = createMercariaClient({ apiBaseUrl, webBaseUrl: webOrigin });
  asViewer = createMercariaClient({ apiBaseUrl, webBaseUrl: webOrigin, getAccessToken: () => VIEWER_TOKEN });
  asOther = createMercariaClient({
    apiBaseUrl,
    webBaseUrl: webOrigin,
    getAccessToken: () => Promise.resolve(OTHER_TOKEN),
  });
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await world.cleanup(db);
  await closePostgres();
}, 300_000);

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

describe('products.search', () => {
  it('parses a search page and serves exactly the publicly live products', async () => {
    const page = await productPage(mercaria.products.search({ query: TERM, limit: 50, locale: 'en' }), 'search');
    const live = [ids.inStock, ids.outOfStock, ...ids.extraActive, ids.person];
    expect(page.items.length).toBeGreaterThan(0);
    expect(new Set(refIds(page))).toEqual(new Set(live));
    expect(page.nextCursor).toBeNull();
    // The positive control that the SDK's parser, not the wire body, produced
    // this: the parser mints every ref as a fresh FROZEN object.
    expect(Object.isFrozen(page.items[0]?.ref)).toBe(true);
  });

  it('walks every page of a store-scoped search by nextCursor, with no duplicate and no gap', async () => {
    const pages: MercariaPage<MercariaProductSummary>[] = [];
    for await (const page of iterateMercariaPages((cursor) =>
      mercaria.products.search({ store: storeRef(ids.storeA), limit: 3, cursor }),
    )) {
      pages.push(contract(page, 'page:productSummary', `search page ${pages.length}`));
      expect(pages.length).toBeLessThan(10);
    }
    const seen = pages.flatMap(refIds);
    // 2 fixtures + 5 extras active in store A: pages of 3, 3, 1.
    expect(pages.length).toBe(3);
    expect(seen.length).toBeGreaterThanOrEqual(7);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set([ids.inStock, ids.outOfStock, ...ids.extraActive]));
  });

  it('sends filters and sort under the names the server accepts', async () => {
    const byPrice = await productPage(
      mercaria.products.search({ store: ids.storeA, sort: 'price_asc', limit: 50 }),
      'search price_asc',
    );
    const prices = byPrice.items.map((item) => item.price.amount);
    expect(prices.length).toBeGreaterThanOrEqual(7);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));

    const inStock = await productPage(
      mercaria.products.search({ store: ids.storeA, inStock: true, limit: 50 }),
      'search inStock',
    );
    expect(refIds(inStock)).toContain(ids.inStock);
    expect(refIds(inStock)).not.toContain(ids.outOfStock);

    const inCollection = await productPage(
      mercaria.products.search({ collection: collectionRef(ids.manual), limit: 50 }),
      'search collection',
    );
    expect(new Set(refIds(inCollection))).toEqual(new Set([ids.inStock, ids.outOfStock]));
  });

  it('rejects a store or collection filter that is gone or missing, never an empty page', async () => {
    expectGone(await rejectionOf(mercaria.products.search({ store: ids.storeSuspended })));
    expectGone(await rejectionOf(mercaria.products.search({ collection: ids.unpublishedAfter })));
    expectNotFound(await rejectionOf(mercaria.products.search({ collection: ids.unpublishedNever })));
  });
});

describe('products.get, resolveRef and resolveVariant', () => {
  it('parses a live store product with every contract fact', async () => {
    const detail = await product(mercaria.products.get(ids.inStock), 'product');
    expect(detail.ref).toEqual({ kind: 'product', id: ids.inStock });
    expect(Object.isFrozen(detail.ref)).toBe(true);
    expect(detail.availability).toBe('in_stock');
    expect(detail.price).toEqual({ amount: 1_500, currency: 'EUR' });
    expect(detail.compareAtPrice).toEqual({ amount: 2_000, currency: 'EUR' });
    expect(detail.priceRange).toEqual({
      min: { amount: 1_500, currency: 'EUR' },
      max: { amount: 2_500, currency: 'EUR' },
    });
    expect(detail.condition).toEqual({ key: 'used_good', group: 'used' });
    expect(detail.images).toEqual([
      { url: mediaUrl(`img-first-${RUN}`), alt: 'The front' },
      { url: mediaUrl(`img-second-${RUN}`), alt: null },
    ]);
    expect(detail.purchaseOptions.map((option) => [option.ref.variantId, option.title, option.availability])).toEqual([
      [ids.inStockVariants[0], 'Small', 'in_stock'],
      [ids.inStockVariants[1], 'Large', 'out_of_stock'],
    ]);
    expect(detail.seller).toEqual({
      kind: 'store',
      store: { kind: 'store', id: ids.storeA },
      handle: storeAHandle,
      name: `Public API a ${RUN}`,
      logoUrl: mediaUrl(`logo-${RUN}`),
    });
    expect(detail.description).toBe('Description of instock');
    expect(detail.viewer).toBeNull();
  });

  it('hydrates a persisted product ref to the same product', async () => {
    const byId = await product(mercaria.products.get(ids.inStock), 'get');
    const byRef = await product(mercaria.products.resolveRef(productRef(ids.inStock)), 'resolveRef');
    expect(byRef).toEqual(byId);
  });

  it('hydrates a persisted variant ref to its product and purchase option', async () => {
    const resolved = await mercaria.products.resolveVariant(variantRef(ids.inStock, ids.inStockVariants[1] ?? ''));
    contract(resolved.product, 'product', 'resolveVariant.product');
    expect(resolved.product.ref.id).toBe(ids.inStock);
    expect(resolved.option.ref).toEqual({ kind: 'variant', productId: ids.inStock, variantId: ids.inStockVariants[1] });
    expect(resolved.option.title).toBe('Large');
    expect(resolved.option).toEqual(resolved.product.purchaseOptions[1]);

    // A variant the live product does not have: the SDK says so itself, after a
    // successful read (no HTTP status to report).
    const missing = await rejectionOf(mercaria.products.resolveVariant(variantRef(ids.inStock, uuidv7())));
    expect(missing).toBeInstanceOf(MercariaNotFoundError);
    expect(missing).toMatchObject({ status: null });
  });

  it('parses a person seller', async () => {
    const detail = await product(mercaria.products.get(productRef(ids.person)), 'person product');
    expect(detail.seller).toEqual({
      kind: 'person',
      oxyUserId: PERSON,
      displayName: 'Pat Seller',
      username: `person${PERSON.slice(-6)}`,
      avatarUrl: mediaUrl(`avatar-${PERSON}`),
      isVerified: false,
    });
  });
});

describe('not found, gone, sold and unreachable are distinguishable', () => {
  it('a product that never existed is MercariaNotFoundError', async () => {
    expectNotFound(await rejectionOf(mercaria.products.get(uuidv7())));
    expectNotFound(await rejectionOf(mercaria.products.get('not-an-id')));
    expectNotFound(await rejectionOf(mercaria.products.get(ids.draftNever)));
  });

  it('an archived, restricted, unpublished or suspended-store product is MercariaGoneError', async () => {
    for (const id of [ids.archived, ids.restricted, ids.draftWasPublished, ids.suspendedStoreProduct]) {
      const error = await rejectionOf(mercaria.products.resolveRef(productRef(id)));
      expectGone(error);
      expect(JSON.stringify(error)).not.toContain(id);
    }
  });

  it('a sold one-off product is a successful read with availability sold', async () => {
    const sold = await product(mercaria.products.get(ids.sold), 'sold product');
    expect(sold.availability).toBe('sold');
    expect(sold.purchaseOptions.map((option) => option.availability)).toEqual(['out_of_stock']);
  });

  it('a base URL nothing listens on is MercariaNetworkError, never a verdict about the entity', async () => {
    const closedPort = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const unreachable = createMercariaClient({ apiBaseUrl: `http://127.0.0.1:${String(closedPort)}` });
    const error = await rejectionOf(unreachable.products.get(ids.inStock));
    expect(error).toBeInstanceOf(MercariaNetworkError);
    expect(error).not.toBeInstanceOf(MercariaNotFoundError);
    expect(error).not.toBeInstanceOf(MercariaGoneError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: null, retryable: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Stores and collections                                                     */
/* -------------------------------------------------------------------------- */

describe('stores', () => {
  it('parses a store by id, by ref and by handle, identically', async () => {
    const byId = await store(mercaria.stores.get(ids.storeA), 'store');
    expect(byId).toEqual({
      ref: { kind: 'store', id: ids.storeA },
      handle: storeAHandle,
      name: `Public API a ${RUN}`,
      description: 'A store that sells things',
      logoUrl: mediaUrl(`logo-${RUN}`),
      coverImageUrl: mediaUrl(`cover-${RUN}`),
      brandColor: '#123456',
      rating: null,
      reviewCount: 0,
      url: byId.url,
    });
    expect(await store(mercaria.stores.resolveRef(storeRef(ids.storeA)), 'store resolveRef')).toEqual(byId);
    expect(await store(mercaria.stores.lookup({ handle: storeAHandle }), 'store lookup')).toEqual(byId);
  });

  it('a suspended or closed store is MercariaGoneError; one that never existed is MercariaNotFoundError', async () => {
    expectGone(await rejectionOf(mercaria.stores.get(ids.storeSuspended)));
    expectGone(await rejectionOf(mercaria.stores.resolveRef(storeRef(ids.storeClosed))));
    expectGone(await rejectionOf(mercaria.stores.lookup({ handle: `pubapi-closed-${RUN}` })));
    expectGone(await rejectionOf(mercaria.stores.products(ids.storeClosed)));
    expectGone(await rejectionOf(mercaria.stores.collections(ids.storeSuspended)));
    expectNotFound(await rejectionOf(mercaria.stores.get(uuidv7())));
    expectNotFound(await rejectionOf(mercaria.stores.lookup({ handle: `nobody-${RUN}` })));
  });

  it('walks a store’s products by nextCursor', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await productPage(mercaria.stores.products(storeRef(ids.storeA), { limit: 4, cursor }), `store products ${pages}`);
      seen.push(...refIds(page));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(2);
    expect(seen.length).toBeGreaterThanOrEqual(7);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set([ids.inStock, ids.outOfStock, ...ids.extraActive]));
  });

  it('walks a store’s published collections by nextCursor', async () => {
    const first = await collectionPage(mercaria.stores.collections(ids.storeA, { limit: 1 }), 'collections 0');
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await collectionPage(
      mercaria.stores.collections(storeRef(ids.storeA), { limit: 1, cursor: first.nextCursor ?? '' }),
      'collections 1',
    );
    expect(second.nextCursor).toBeNull();
    expect(new Set([...refIds(first), ...refIds(second)])).toEqual(new Set([ids.manual, ids.automated]));
  });
});

describe('collections', () => {
  it('parses a published collection by id and by ref', async () => {
    const byId = await collection(mercaria.collections.get(ids.manual), 'collection');
    expect(byId).toEqual({
      ref: { kind: 'collection', id: ids.manual },
      store: { kind: 'store', id: ids.storeA },
      title: 'Collection manual',
      description: 'Hand picked',
      image: { url: mediaUrl(`collection-image-${RUN}`), alt: null },
      url: byId.url,
    });
    expect(await collection(mercaria.collections.resolveRef(collectionRef(ids.manual)), 'collection resolveRef')).toEqual(
      byId,
    );
    await collection(mercaria.collections.get(collectionRef(ids.automated)), 'automated collection');
  });

  it('parses a collection’s ACTIVE products in its own order', async () => {
    const page = await productPage(mercaria.collections.products(collectionRef(ids.manual)), 'collection products');
    expect(refIds(page)).toEqual([ids.outOfStock, ids.inStock]);
  });

  it('a never-published collection is MercariaNotFoundError; an unpublished or store-gone one is MercariaGoneError', async () => {
    expectNotFound(await rejectionOf(mercaria.collections.get(ids.unpublishedNever)));
    expectGone(await rejectionOf(mercaria.collections.resolveRef(collectionRef(ids.unpublishedAfter))));
    expectGone(await rejectionOf(mercaria.collections.products(ids.unpublishedAfter)));
    expectGone(await rejectionOf(mercaria.collections.get(ids.suspendedStoreCollection)));
    expectNotFound(await rejectionOf(mercaria.collections.get(uuidv7())));
  });
});

/* -------------------------------------------------------------------------- */
/* Authority, links and the route table                                        */
/* -------------------------------------------------------------------------- */

describe('getAccessToken forwards the caller’s authority', () => {
  it('viewer is { saved: true } for the user who saved it, { saved: false } for another, null anonymously', async () => {
    oxy.authorizationHeaders.length = 0;

    const saver = await product(asViewer.products.get(ids.inStock), 'as viewer');
    expect(saver.viewer).toEqual({ saved: true });
    expect(oxy.authorizationHeaders).toEqual([`Bearer ${VIEWER_TOKEN}`]);

    const other = await product(asOther.products.resolveRef(productRef(ids.inStock)), 'as other');
    expect(other.viewer).toEqual({ saved: false });

    const anonymous = await product(mercaria.products.get(ids.inStock), 'anonymous');
    expect(anonymous.viewer).toBeNull();

    // A getter with no session sends no header at all; a token Oxy does not
    // verify reads as anonymous.
    const signedOut = createMercariaClient({ apiBaseUrl, webBaseUrl: webOrigin, getAccessToken: () => null });
    expect((await product(signedOut.products.get(ids.inStock), 'signed out')).viewer).toBeNull();
    const unverified = createMercariaClient({
      apiBaseUrl,
      webBaseUrl: webOrigin,
      getAccessToken: () => `not-a-verified-token-${RUN}`,
    });
    expect((await product(unverified.products.get(ids.inStock), 'unverified')).viewer).toBeNull();

    expect(oxy.authorizationHeaders).toEqual([
      `Bearer ${VIEWER_TOKEN}`,
      `Bearer ${OTHER_TOKEN}`,
      undefined,
      undefined,
      `Bearer not-a-verified-token-${RUN}`,
    ]);
  });
});

describe('links agree with the url the server serves', () => {
  it('links.product, links.store and links.collection rebuild every hydrated url', async () => {
    let checked = 0;

    const detail = await product(mercaria.products.get(ids.inStock), 'links product');
    expect(mercaria.links.product(detail.ref)).toBe(detail.url);
    expect(mercaria.links.product(detail)).toBe(detail.url);
    expect(mercaria.links.product(ids.inStock)).toBe(detail.url);
    checked += 1;

    const person = await product(mercaria.products.get(ids.person), 'links person product');
    expect(mercaria.links.product(person.ref)).toBe(person.url);
    checked += 1;

    const page = await productPage(mercaria.stores.products(ids.storeA, { limit: 50 }), 'links store products');
    const storeA = await store(mercaria.stores.get(ids.storeA), 'links store');
    expect(mercaria.links.store(storeA)).toBe(storeA.url);
    expect(mercaria.links.store(storeA.handle)).toBe(storeA.url);
    checked += 1;
    for (const summary of page.items) {
      expect(mercaria.links.product(summary.ref)).toBe(summary.url);
      // A store seller carries the CURRENT handle, so it links the storefront.
      if (summary.seller.kind === 'store') expect(mercaria.links.store(summary.seller)).toBe(storeA.url);
      checked += 1;
    }

    const collections = await collectionPage(mercaria.stores.collections(ids.storeA, { limit: 50 }), 'links collections');
    for (const item of collections.items) {
      const owner = await store(mercaria.stores.resolveRef(item.store), 'links collection store');
      expect(mercaria.links.collection(item.ref, owner)).toBe(item.url);
      expect(mercaria.links.collection(item, owner.handle)).toBe(item.url);
      checked += 1;
    }
    const manual = await collection(mercaria.collections.get(ids.manual), 'links manual collection');
    expect(mercaria.links.collection(manual, storeA)).toBe(manual.url);
    checked += 1;

    // Floors, so a loop over nothing cannot pass: 2 products, the store, 7
    // summaries, 2 listed collections and the manual one.
    expect(checked).toBeGreaterThanOrEqual(13);
    // And the rule is the server's, not an echo of whatever `webBaseUrl` held.
    expect(detail.url.startsWith(webOrigin.replace(/\/+$/u, ''))).toBe(true);
  });
});

describe('a route the server does not serve', () => {
  it('is a MercariaApiError carrying UNKNOWN_ROUTE, never MercariaNotFoundError', async () => {
    // Route drift, simulated at the one seam the SDK exposes for it: a `fetch`
    // that sends the SDK's own request to a path the public router does not
    // have. The response still goes through the SDK's transport and error
    // mapping.
    let drifted = 0;
    const drifting = createMercariaClient({
      apiBaseUrl,
      webBaseUrl: webOrigin,
      fetch: (url, init) => {
        drifted += 1;
        return fetch(url.replace(`${MERCARIA_PUBLIC_API_BASE_PATH}/products/`, `${MERCARIA_PUBLIC_API_BASE_PATH}/items/`), init);
      },
    });
    const error = await rejectionOf(drifting.products.get(ids.inStock));
    expect(drifted).toBe(1);
    expect(error).toBeInstanceOf(MercariaApiError);
    expect(error).not.toBeInstanceOf(MercariaNotFoundError);
    expect(error).not.toBeInstanceOf(MercariaGoneError);
    expect(error).toMatchObject({ code: 'UNKNOWN_ROUTE', status: 404 });
  });
});

/* -------------------------------------------------------------------------- */
/* The privacy census — LAST, over every SDK result this file received        */
/* -------------------------------------------------------------------------- */

describe('the privacy census', () => {
  it('no private sentinel appears in any SDK result', () => {
    // Floor, so a census over nothing cannot pass: 37 results, read off this
    // file's own run when it was written, covering every public route.
    expect(RESULTS.length).toBeGreaterThanOrEqual(37);
    const everything = RESULTS.map((result) => JSON.stringify(result));
    // The positive control: the census is reading real results that do carry
    // this file's public facts.
    expect(everything.join('\n')).toContain(ids.inStock);
    expect(everything.join('\n')).toContain(TERM);
    const privateValues = [
      ...Object.values(SENTINEL),
      // The non-active manual members — ids a `Collection.productIds` would carry.
      ids.draftNever,
      ids.archived,
    ];
    for (const value of privateValues) {
      const offending = everything.filter((serialized) => serialized.includes(value));
      expect(offending, `private value ${value} reached an SDK result`).toEqual([]);
    }
  });
});
