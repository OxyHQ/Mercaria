/**
 * The PUBLIC integration surface (#1017, `/public/v1`) over real HTTP against a
 * real database — the routes `@mercaria.co/sdk` codes against.
 *
 * ## What this file proves, and what it deliberately does not
 *
 * It drives the REAL `createApp()` chain — the CORS layer, `express.json()`, both
 * rate limiters, the router, the strict schemas, the service and the repositories
 * — and asserts the wire: status codes, the envelope, the contract's exact key
 * sets and the status semantics a consumer holding a persisted reference depends
 * on (410 `GONE` versus 404 `NOT_FOUND`).
 *
 * The PRIVACY census is the case that justifies the surface existing as its own
 * projection. The fixtures seed every private fact the storefront DTOs carry — a
 * connector `source` external id, a variant SKU and barcode, tags, vendor and
 * product type, a manual collection holding a DRAFT and an ARCHIVED member, an
 * automated collection's rule, SEO overrides and a store member's Oxy id — each
 * as a unique SENTINEL string, and then asserts two independent things about
 * every body this file received: (a) every object's key set EQUALS the
 * contract's, recursively, so an extra field fails whatever its value; and (b)
 * no sentinel appears ANYWHERE in the serialized text, so a private value that
 * escaped under an allowed key fails too. Either alone has a hole the other
 * closes.
 *
 * ## The auth STAND-IN
 *
 * `middleware/auth.js` is mocked with a header-driven `optionalAuth`
 * (`x-test-actor`), the `catalog-api-contract.realdb.test.ts` pattern: it stands
 * in for the network call to Oxy and nothing else. `oxyClient` carries a working
 * `auth()` because `createOxyRateLimit` calls it on every request (the limiter
 * itself is NOT mocked), a PREFIXING `getFileDownloadUrl` so every URL assertion
 * is also a check that the media hop happened, and a `getUserById` so a person
 * seller's Oxy identity resolves.
 *
 * ## Shared database
 *
 * Every fixture is namespaced by `RUN`, every list read is scoped to a store,
 * collection or search term only this file creates, and every count equality is
 * paired with a non-zero floor.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { MERCARIA_PUBLIC_API_BASE_PATH } from '@mercaria/shared-types';
import type { Database } from '../../db/postgres.js';
import { listingImages, listings } from '../../db/schema/catalog.js';
import { collectionRules, collections, listingCollections } from '../../db/schema/merchandising.js';
import { storeMembers, stores } from '../../db/schema/stores.js';
import { connections } from '../../db/schema/connectors.js';
import { favorites } from '../../db/schema/buyers.js';

const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();
/** One search token every searchable fixture title carries, and nothing else does. */
const TERM = `pubapi${RUN}`;
const VIEWER = `oxy-user-pubapi-viewer-${RUN}`;
const PERSON = `oxy-user-pubapi-person-${RUN}`;

/** Every private value, each unique to this run. None may reach a public body. */
const SENTINEL = {
  sku: `SKU-SENTINEL-${RUN}`,
  barcode: `BARCODE-SENTINEL-${RUN}`,
  externalId: `EXT-SENTINEL-${RUN}`,
  tag: `tag-sentinel-${RUN}`,
  vendor: `vendor-sentinel-${RUN}`,
  productType: `ptype-sentinel-${RUN}`,
  ruleValue: `rule-sentinel-${RUN}`,
  seoTitle: `seo-sentinel-${RUN}`,
  memberOxyId: `oxy-user-member-sentinel-${RUN}`,
  collectionHandle: `chandle-sentinel-${RUN}`,
  listingHandle: `lhandle-sentinel-${RUN}`,
} as const;

const mediaUrl = (fileId: string): string => `https://media.test.invalid/${fileId}`;

vi.mock('../../middleware/auth.js', () => {
  const actorOf = (req: express.Request): string | undefined => {
    const raw = req.headers['x-test-actor'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === undefined || value === '' ? undefined : value;
  };
  return {
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
    authenticateToken: (
      _req: express.Request,
      res: express.Response,
    ): void => {
      res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
    },
    optionalAuth: (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
      const actor = actorOf(req);
      if (actor !== undefined) {
        (req as unknown as { user: { id: string } }).user = { id: actor };
        (req as unknown as { userId: string }).userId = actor;
      }
      next();
    },
  };
});

/* -------------------------------------------------------------------------- */
/* The contract's key sets, and the recursive allow-list assertion            */
/* -------------------------------------------------------------------------- */

type Shape =
  | 'productSummary'
  | 'product'
  | 'store'
  | 'collection'
  | 'page:productSummary'
  | 'page:collection';

const KEYS = {
  money: ['amount', 'currency'],
  image: ['alt', 'url'],
  productRef: ['id', 'kind'],
  variantRef: ['kind', 'productId', 'variantId'],
  storeRef: ['id', 'kind'],
  collectionRef: ['id', 'kind'],
  condition: ['group', 'key'],
  priceRange: ['max', 'min'],
  sellerStore: ['handle', 'kind', 'logoUrl', 'name', 'store'],
  sellerPerson: ['avatarUrl', 'displayName', 'isVerified', 'kind', 'oxyUserId', 'username'],
  purchaseOption: ['availability', 'compareAtPrice', 'price', 'ref', 'title'],
  viewer: ['saved'],
  summary: [
    'availability',
    'compareAtPrice',
    'condition',
    'price',
    'priceRange',
    'primaryImage',
    'ref',
    'seller',
    'title',
    'url',
  ],
  productExtra: ['description', 'images', 'purchaseOptions', 'updatedAt', 'viewer'],
  store: [
    'brandColor',
    'coverImageUrl',
    'description',
    'handle',
    'logoUrl',
    'name',
    'rating',
    'ref',
    'reviewCount',
    'url',
  ],
  collection: ['description', 'image', 'ref', 'store', 'title', 'url'],
  page: ['items', 'nextCursor'],
} as const;

function keysOf(value: unknown, where: string): string[] {
  expect(value, `${where} is not an object`).toBeTypeOf('object');
  expect(value, `${where} is null`).not.toBeNull();
  expect(Array.isArray(value), `${where} is an array`).toBe(false);
  return Object.keys(value as object).sort();
}

function exactKeys(value: unknown, expected: readonly string[], where: string): Record<string, unknown> {
  expect(keysOf(value, where), `${where} key set`).toEqual([...expected].sort());
  return value as Record<string, unknown>;
}

function checkMoney(value: unknown, where: string): void {
  const money = exactKeys(value, KEYS.money, where);
  expect(Number.isSafeInteger(money['amount']), `${where}.amount`).toBe(true);
  expect(money['currency'], `${where}.currency`).toBeTypeOf('string');
}

function checkNullable(value: unknown, where: string, check: (v: unknown, w: string) => void): void {
  if (value !== null) check(value, where);
}

function checkImage(value: unknown, where: string): void {
  const image = exactKeys(value, KEYS.image, where);
  expect(String(image['url']), `${where}.url is absolute`).toMatch(/^https?:\/\//u);
  if (image['alt'] !== null) expect(image['alt']).toBeTypeOf('string');
}

function checkSummary(value: unknown, where: string, extra: readonly string[] = []): Record<string, unknown> {
  const item = exactKeys(value, [...KEYS.summary, ...extra], where);
  exactKeys(item['ref'], KEYS.productRef, `${where}.ref`);
  checkNullable(item['primaryImage'], `${where}.primaryImage`, checkImage);
  checkMoney(item['price'], `${where}.price`);
  checkNullable(item['compareAtPrice'], `${where}.compareAtPrice`, checkMoney);
  checkNullable(item['priceRange'], `${where}.priceRange`, (range, w) => {
    const r = exactKeys(range, KEYS.priceRange, w);
    checkMoney(r['min'], `${w}.min`);
    checkMoney(r['max'], `${w}.max`);
  });
  expect(['in_stock', 'out_of_stock', 'sold']).toContain(item['availability']);
  exactKeys(item['condition'], KEYS.condition, `${where}.condition`);
  const seller = item['seller'] as Record<string, unknown>;
  if (seller['kind'] === 'store') {
    exactKeys(seller, KEYS.sellerStore, `${where}.seller`);
    exactKeys(seller['store'], KEYS.storeRef, `${where}.seller.store`);
  } else {
    exactKeys(seller, KEYS.sellerPerson, `${where}.seller`);
  }
  expect(item['url']).toBeTypeOf('string');
  return item;
}

function checkProduct(value: unknown, where: string): Record<string, unknown> {
  const product = checkSummary(value, where, KEYS.productExtra);
  (product['images'] as unknown[]).forEach((image, i) => checkImage(image, `${where}.images[${i}]`));
  (product['purchaseOptions'] as unknown[]).forEach((option, i) => {
    const o = exactKeys(option, KEYS.purchaseOption, `${where}.purchaseOptions[${i}]`);
    exactKeys(o['ref'], KEYS.variantRef, `${where}.purchaseOptions[${i}].ref`);
    checkMoney(o['price'], `${where}.purchaseOptions[${i}].price`);
    checkNullable(o['compareAtPrice'], `${where}.purchaseOptions[${i}].compareAtPrice`, checkMoney);
    expect(['in_stock', 'out_of_stock']).toContain(o['availability']);
  });
  checkNullable(product['viewer'], `${where}.viewer`, (viewer, w) => exactKeys(viewer, KEYS.viewer, w));
  expect(Number.isNaN(Date.parse(String(product['updatedAt'])))).toBe(false);
  return product;
}

function checkStore(value: unknown, where: string): Record<string, unknown> {
  const store = exactKeys(value, KEYS.store, where);
  exactKeys(store['ref'], KEYS.storeRef, `${where}.ref`);
  return store;
}

function checkCollection(value: unknown, where: string): Record<string, unknown> {
  const collection = exactKeys(value, KEYS.collection, where);
  exactKeys(collection['ref'], KEYS.collectionRef, `${where}.ref`);
  exactKeys(collection['store'], KEYS.storeRef, `${where}.store`);
  checkNullable(collection['image'], `${where}.image`, checkImage);
  return collection;
}

function checkShape(data: unknown, shape: Shape, where: string): void {
  switch (shape) {
    case 'productSummary':
      checkSummary(data, where);
      return;
    case 'product':
      checkProduct(data, where);
      return;
    case 'store':
      checkStore(data, where);
      return;
    case 'collection':
      checkCollection(data, where);
      return;
    case 'page:productSummary':
    case 'page:collection': {
      const page = exactKeys(data, KEYS.page, where);
      expect(page['nextCursor'] === null || typeof page['nextCursor'] === 'string').toBe(true);
      (page['items'] as unknown[]).forEach((item, i) =>
        shape === 'page:productSummary'
          ? checkSummary(item, `${where}.items[${i}]`)
          : checkCollection(item, `${where}.items[${i}]`),
      );
      return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The harness                                                                */
/* -------------------------------------------------------------------------- */

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

/** Every body this file received, for the sentinel census at the end. */
const BODIES: string[] = [];
/** Every successful body with the shape it must have, checked as it arrives. */
let shapesChecked = 0;

let db: Database;
let closePostgres: () => Promise<void>;
let server: Server;
let base: string;
let webOrigin: string;

async function call(
  path: string,
  options: {
    readonly method?: string;
    readonly actor?: string;
    readonly headers?: Record<string, string>;
    readonly shape?: Shape;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.actor !== undefined) headers['x-test-actor'] = options.actor;
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers });
  const text = await response.text();
  BODIES.push(text);
  let body: Record<string, unknown> = {};
  if (text !== '' && (response.headers.get('content-type') ?? '').includes('application/json')) {
    body = JSON.parse(text) as Record<string, unknown>;
  }
  if (options.shape !== undefined && response.status === 200) {
    exactKeys(body, ['data', 'success'], `${path} envelope`);
    expect(body['success']).toBe(true);
    checkShape(body['data'], options.shape, path);
    shapesChecked += 1;
  }
  return { status: response.status, headers: response.headers, text, body };
}

const api = (path: string): string => `${MERCARIA_PUBLIC_API_BASE_PATH}${path}`;

function expectFailure(answer: Answer, status: number, code: string): void {
  expect(answer.status, answer.text).toBe(status);
  expect(answer.headers.get('content-type') ?? '').toContain('application/json');
  exactKeys(answer.body, ['error', 'message', 'success'], 'failure envelope');
  expect(answer.body['success']).toBe(false);
  expect(answer.body['error']).toBe(code);
  expect(answer.body['message']).toBeTypeOf('string');
}

function dataOf(answer: Answer): Record<string, unknown> {
  return answer.body['data'] as Record<string, unknown>;
}

function itemIds(answer: Answer): string[] {
  return ((dataOf(answer)['items'] ?? []) as { ref: { id: string } }[]).map((item) => item.ref.id);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const storeIds: string[] = [];
const listingIds: string[] = [];
const collectionIds: string[] = [];

const ids = {
  storeA: '',
  storeSuspended: '',
  storeClosed: '',
  inStock: '',
  outOfStock: '',
  sold: '',
  archived: '',
  restricted: '',
  draftNever: '',
  draftWasPublished: '',
  suspendedStoreProduct: '',
  person: '',
  extraActive: [] as string[],
  inStockVariants: [] as string[],
  manual: '',
  automated: '',
  unpublishedNever: '',
  unpublishedAfter: '',
  suspendedStoreCollection: '',
};
let storeAHandle = '';

async function insertStore(label: string, status: 'active' | 'suspended' | 'closed'): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      handle: `pubapi-${label}-${RUN}`,
      name: `Public API ${label} ${RUN}`,
      description: label === 'a' ? 'A store that sells things' : '',
      brandColor: '#123456',
      status,
      ...(label === 'a' ? { logoFileId: `logo-${RUN}`, coverFileId: `cover-${RUN}` } : {}),
    })
    .returning({ id: stores.id });
  if (!row) throw new Error('no store row');
  storeIds.push(row.id);
  return row.id;
}

interface ListingInput {
  readonly label: string;
  readonly status: 'draft' | 'active' | 'sold' | 'archived' | 'restricted';
  readonly publishedAt: Date | null;
  readonly storeId?: string;
  readonly oxyUserId?: string;
  readonly searchable?: boolean;
  readonly variants: readonly {
    title: string;
    price: number;
    compareAt?: number;
    tracked: boolean;
    available: number;
    sku?: string;
    barcode?: string;
  }[];
  readonly images?: readonly { fileId: string; alt?: string }[];
  readonly privateFacts?: { sourceConnectionId: string };
  readonly createdAt?: Date;
}

async function insertListing(input: ListingInput): Promise<{ id: string; variantIds: string[] }> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: input.storeId ? 'store' : 'user',
      storeId: input.storeId ?? null,
      oxyUserId: input.oxyUserId ?? null,
      title: `${input.label} ${input.searchable === false ? 'hidden' : TERM}`,
      description: `Description of ${input.label}`,
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: input.status,
      publishedAt: input.publishedAt,
      tags: [SENTINEL.tag],
      vendor: SENTINEL.vendor,
      productType: SENTINEL.productType,
      seoTitle: SENTINEL.seoTitle,
      handle: `${SENTINEL.listingHandle}-${input.label}`,
      ...(input.privateFacts
        ? {
            sourceConnectionId: input.privateFacts.sourceConnectionId,
            sourceProvider: 'shopify' as const,
            sourceExternalId: SENTINEL.externalId,
          }
        : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: listings.id });
  if (!row) throw new Error('no listing row');
  listingIds.push(row.id);

  const { insertVariants } = await import('../../db/catalog/variantRepository.js');
  const variants = await insertVariants(
    row.id,
    input.variants.map((variant, position) => ({
      title: variant.title,
      position,
      optionValues: [],
      priceAmount: variant.price,
      priceCurrency: 'EUR' as const,
      ...(variant.compareAt === undefined
        ? {}
        : { compareAtPriceAmount: variant.compareAt, compareAtPriceCurrency: 'EUR' as const }),
      inventoryTracked: variant.tracked,
      inventoryAvailable: variant.available,
      ...(variant.sku ? { sku: variant.sku } : {}),
      ...(variant.barcode ? { barcode: variant.barcode } : {}),
    })),
  );
  if (input.images && input.images.length > 0) {
    await db.insert(listingImages).values(
      input.images.map((image, position) => ({
        listingId: row.id,
        fileId: image.fileId,
        position,
        ...(image.alt ? { alt: image.alt } : {}),
      })),
    );
  }
  const { recomputeListingFacets } = await import('../../db/catalog/listingRepository.js');
  await recomputeListingFacets(row.id);
  return { id: row.id, variantIds: variants.map((v) => v.id) };
}

async function insertCollection(input: {
  storeId: string;
  label: string;
  type: 'manual' | 'automated';
  isPublished: boolean;
  publishedAt: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(collections)
    .values({
      storeId: input.storeId,
      title: `Collection ${input.label}`,
      handle: `${SENTINEL.collectionHandle}-${input.label}`,
      type: input.type,
      description: input.label === 'manual' ? 'Hand picked' : null,
      imageFileId: input.label === 'manual' ? `collection-image-${RUN}` : null,
      sortOrder: 'manual',
      seoTitle: SENTINEL.seoTitle,
      isPublished: input.isPublished,
      publishedAt: input.publishedAt,
    })
    .returning({ id: collections.id });
  if (!row) throw new Error('no collection row');
  collectionIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres();
  closePostgres = postgres.closePostgres;
  const { config } = await import('../../config/index.js');
  webOrigin = config.web.origin.replace(/\/+$/u, '');

  ids.storeA = await insertStore('a', 'active');
  ids.storeSuspended = await insertStore('suspended', 'suspended');
  ids.storeClosed = await insertStore('closed', 'closed');
  storeAHandle = `pubapi-a-${RUN}`;
  await db.insert(storeMembers).values({
    storeId: ids.storeA,
    oxyUserId: SENTINEL.memberOxyId,
    role: 'owner',
    permissions: [],
    joinedAt: new Date(),
  });
  const [connection] = await db
    .insert(connections)
    .values({ storeId: ids.storeA, provider: 'shopify', mode: 'pull', connectedAt: new Date() })
    .returning({ id: connections.id });
  if (!connection) throw new Error('no connection row');

  const published = new Date(Date.now() - 60_000);
  const inStock = await insertListing({
    label: 'instock',
    status: 'active',
    publishedAt: published,
    storeId: ids.storeA,
    variants: [
      { title: 'Small', price: 1_500, compareAt: 2_000, tracked: true, available: 3, sku: SENTINEL.sku, barcode: SENTINEL.barcode },
      { title: 'Large', price: 2_500, tracked: true, available: 0 },
    ],
    images: [
      { fileId: `img-first-${RUN}`, alt: 'The front' },
      { fileId: `img-second-${RUN}` },
    ],
    privateFacts: { sourceConnectionId: connection.id },
  });
  ids.inStock = inStock.id;
  ids.inStockVariants = inStock.variantIds;
  ids.outOfStock = (
    await insertListing({
      label: 'outofstock',
      status: 'active',
      publishedAt: published,
      storeId: ids.storeA,
      variants: [{ title: 'Only', price: 900, tracked: true, available: 0 }],
    })
  ).id;
  ids.sold = (
    await insertListing({
      label: 'sold',
      status: 'sold',
      publishedAt: published,
      storeId: ids.storeA,
      variants: [{ title: 'Only', price: 700, tracked: true, available: 1 }],
    })
  ).id;
  ids.archived = (
    await insertListing({
      label: 'archived',
      status: 'archived',
      publishedAt: published,
      storeId: ids.storeA,
      variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
    })
  ).id;
  ids.restricted = (
    await insertListing({
      label: 'restricted',
      status: 'restricted',
      publishedAt: published,
      storeId: ids.storeA,
      variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
    })
  ).id;
  ids.draftNever = (
    await insertListing({
      label: 'draftnever',
      status: 'draft',
      publishedAt: null,
      storeId: ids.storeA,
      variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
    })
  ).id;
  ids.draftWasPublished = (
    await insertListing({
      label: 'draftwaspublished',
      status: 'draft',
      publishedAt: published,
      storeId: ids.storeA,
      variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
    })
  ).id;
  for (let i = 0; i < 5; i += 1) {
    ids.extraActive.push(
      (
        await insertListing({
          label: `extra${i}`,
          status: 'active',
          publishedAt: new Date(published.getTime() - (i + 1) * 1_000),
          storeId: ids.storeA,
          variants: [{ title: 'Only', price: 1_000 + i, tracked: false, available: 0 }],
        })
      ).id,
    );
  }
  ids.suspendedStoreProduct = (
    await insertListing({
      label: 'suspendedstore',
      status: 'active',
      publishedAt: published,
      storeId: ids.storeSuspended,
      variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
    })
  ).id;
  ids.person = (
    await insertListing({
      label: 'person',
      status: 'active',
      publishedAt: published,
      oxyUserId: PERSON,
      variants: [{ title: 'Default Title', price: 4_200, tracked: false, available: 0 }],
    })
  ).id;

  ids.manual = await insertCollection({
    storeId: ids.storeA,
    label: 'manual',
    type: 'manual',
    isPublished: true,
    publishedAt: published,
  });
  // Hand-picked order: out-of-stock FIRST, then in-stock, then two members that
  // must never be served — a draft and an archived listing.
  await db.insert(listingCollections).values([
    { collectionId: ids.manual, listingId: ids.outOfStock, position: 0 },
    { collectionId: ids.manual, listingId: ids.draftNever, position: 1 },
    { collectionId: ids.manual, listingId: ids.inStock, position: 2 },
    { collectionId: ids.manual, listingId: ids.archived, position: 3 },
  ]);
  ids.automated = await insertCollection({
    storeId: ids.storeA,
    label: 'automated',
    type: 'automated',
    isPublished: true,
    publishedAt: published,
  });
  await db.insert(collectionRules).values({
    collectionId: ids.automated,
    field: 'tag',
    operator: 'equals',
    value: SENTINEL.ruleValue,
    position: 0,
  });
  ids.unpublishedNever = await insertCollection({
    storeId: ids.storeA,
    label: 'never',
    type: 'manual',
    isPublished: false,
    publishedAt: null,
  });
  ids.unpublishedAfter = await insertCollection({
    storeId: ids.storeA,
    label: 'after',
    type: 'manual',
    isPublished: false,
    publishedAt: published,
  });
  ids.suspendedStoreCollection = await insertCollection({
    storeId: ids.storeSuspended,
    label: 'suspended',
    type: 'manual',
    isPublished: true,
    publishedAt: published,
  });

  await db.insert(favorites).values({ oxyUserId: VIEWER, listingId: ids.inStock });

  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (collectionIds.length > 0) {
    await db.delete(collections).where(inArray(collections.id, collectionIds));
  }
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  if (storeIds.length > 0) {
    await db.delete(connections).where(inArray(connections.storeId, storeIds));
    const { deleteTestStores } = await import('../../db/__tests__/store-teardown.js');
    await deleteTestStores(db, storeIds);
  }
  await closePostgres();
}, 300_000);

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

describe('GET /public/v1/products', () => {
  it('searches by term and serves only publicly live products — never a suspended store’s', async () => {
    const answer = await call(api(`/products?q=${TERM}&limit=50`), { shape: 'page:productSummary' });
    expect(answer.status, answer.text).toBe(200);
    const found = itemIds(answer);
    const live = [ids.inStock, ids.outOfStock, ...ids.extraActive, ids.person];
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set(live));
    for (const hidden of [
      ids.sold,
      ids.archived,
      ids.restricted,
      ids.draftNever,
      ids.draftWasPublished,
      ids.suspendedStoreProduct,
    ]) {
      expect(found).not.toContain(hidden);
    }
    expect(dataOf(answer)['nextCursor']).toBeNull();
  });

  it('paginates a store-scoped list across pages with an opaque cursor: no duplicate, no gap', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `/products?storeId=${ids.storeA}&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const answer = await call(api(query), { shape: 'page:productSummary' });
      expect(answer.status, answer.text).toBe(200);
      seen.push(...itemIds(answer));
      cursor = dataOf(answer)['nextCursor'] as string | null;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);
    // 2 fixtures + 5 extras active in store A: three pages of 3, 3, 1.
    expect(pages).toBe(3);
    expect(seen.length).toBeGreaterThanOrEqual(7);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set([ids.inStock, ids.outOfStock, ...ids.extraActive]));
  });

  it('is deterministic — the same request mints the same cursor', async () => {
    const first = await call(api(`/products?storeId=${ids.storeA}&limit=2`));
    const second = await call(api(`/products?storeId=${ids.storeA}&limit=2`));
    expect(dataOf(first)['nextCursor']).toBeTypeOf('string');
    expect(dataOf(first)['nextCursor']).toBe(dataOf(second)['nextCursor']);
    expect(itemIds(first)).toEqual(itemIds(second));
  });

  it('orders by price when asked', async () => {
    const answer = await call(api(`/products?storeId=${ids.storeA}&sort=price_asc&limit=50`), {
      shape: 'page:productSummary',
    });
    const prices = ((dataOf(answer)['items'] as { price: { amount: number } }[]) ?? []).map(
      (item) => item.price.amount,
    );
    expect(prices.length).toBeGreaterThanOrEqual(7);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('filters to in-stock products with inStock=true', async () => {
    const answer = await call(api(`/products?storeId=${ids.storeA}&inStock=true&limit=50`), {
      shape: 'page:productSummary',
    });
    const found = itemIds(answer);
    expect(found).toContain(ids.inStock);
    expect(found).not.toContain(ids.outOfStock);
  });

  it('refuses a cursor minted under different filters, and a malformed one', async () => {
    const first = await call(api(`/products?storeId=${ids.storeA}&limit=2`));
    const cursor = dataOf(first)['nextCursor'] as string;
    expect(cursor).toBeTypeOf('string');
    expectFailure(
      await call(api(`/products?storeId=${ids.storeA}&limit=2&sort=price_desc&cursor=${cursor}`)),
      400,
      'VALIDATION_ERROR',
    );
    expectFailure(
      await call(api(`/stores/${ids.storeA}/products?limit=2&cursor=${cursor}`)),
      400,
      'VALIDATION_ERROR',
    );
    expectFailure(await call(api('/products?cursor=not-a-cursor')), 400, 'VALIDATION_ERROR');
    expectFailure(await call(api('/products?cursor=%7B%7D')), 400, 'VALIDATION_ERROR');
  });

  it('answers every malformed query with a JSON VALIDATION_ERROR envelope', async () => {
    for (const query of [
      '?sort=relevance',
      '?sort=trending',
      '?limit=0',
      `?limit=51`,
      '?limit=1e1',
      '?inStock=yes',
      '?unknown=1',
      `?q=${'x'.repeat(201)}`,
      '?q=%20%20',
      '?q=a&q=b',
    ]) {
      expectFailure(await call(api(`/products${query}`)), 400, 'VALIDATION_ERROR');
    }
  });

  it('gates a store or collection filter before searching: 410 and 404, never an empty page', async () => {
    expectFailure(await call(api(`/products?storeId=${ids.storeSuspended}`)), 410, 'GONE');
    expectFailure(await call(api(`/products?collectionId=${ids.unpublishedNever}`)), 404, 'NOT_FOUND');
    expectFailure(await call(api(`/products?collectionId=${ids.unpublishedAfter}`)), 410, 'GONE');
  });
});

describe('GET /public/v1/products/:id', () => {
  it('projects a live store product field by field', async () => {
    const answer = await call(api(`/products/${ids.inStock}`), { shape: 'product' });
    expect(answer.status, answer.text).toBe(200);
    const product = dataOf(answer);
    expect(product['ref']).toEqual({ kind: 'product', id: ids.inStock });
    expect(product['availability']).toBe('in_stock');
    expect(product['price']).toEqual({ amount: 1_500, currency: 'EUR' });
    expect(product['compareAtPrice']).toEqual({ amount: 2_000, currency: 'EUR' });
    expect(product['priceRange']).toEqual({
      min: { amount: 1_500, currency: 'EUR' },
      max: { amount: 2_500, currency: 'EUR' },
    });
    expect(product['condition']).toEqual({ key: 'used_good', group: 'used' });
    expect(product['primaryImage']).toEqual({ url: mediaUrl(`img-first-${RUN}`), alt: 'The front' });
    expect(product['images']).toEqual([
      { url: mediaUrl(`img-first-${RUN}`), alt: 'The front' },
      { url: mediaUrl(`img-second-${RUN}`), alt: null },
    ]);
    expect(product['purchaseOptions']).toEqual([
      {
        ref: { kind: 'variant', productId: ids.inStock, variantId: ids.inStockVariants[0] },
        title: 'Small',
        price: { amount: 1_500, currency: 'EUR' },
        compareAtPrice: { amount: 2_000, currency: 'EUR' },
        availability: 'in_stock',
      },
      {
        ref: { kind: 'variant', productId: ids.inStock, variantId: ids.inStockVariants[1] },
        title: 'Large',
        price: { amount: 2_500, currency: 'EUR' },
        compareAtPrice: null,
        availability: 'out_of_stock',
      },
    ]);
    expect(product['seller']).toEqual({
      kind: 'store',
      store: { kind: 'store', id: ids.storeA },
      handle: storeAHandle,
      name: `Public API a ${RUN}`,
      logoUrl: mediaUrl(`logo-${RUN}`),
    });
    expect(product['url']).toBe(`${webOrigin}/products/${ids.inStock}`);
    expect(product['description']).toBe('Description of instock');
    expect(product['viewer']).toBeNull();
  });

  it('reports out_of_stock and sold, and flattens a single-price range to null', async () => {
    const out = dataOf(await call(api(`/products/${ids.outOfStock}`), { shape: 'product' }));
    expect(out['availability']).toBe('out_of_stock');
    expect(out['priceRange']).toBeNull();
    expect(out['primaryImage']).toBeNull();
    expect(out['compareAtPrice']).toBeNull();

    const sold = await call(api(`/products/${ids.sold}`), { shape: 'product' });
    expect(sold.status).toBe(200);
    expect(dataOf(sold)['availability']).toBe('sold');
    // A sold item is never buyable, whatever its variant's counter says.
    expect(
      (dataOf(sold)['purchaseOptions'] as { availability: string }[]).map((o) => o.availability),
    ).toEqual(['out_of_stock']);
  });

  it('projects a person seller from their Oxy identity', async () => {
    const answer = await call(api(`/products/${ids.person}`), { shape: 'product' });
    expect(answer.status, answer.text).toBe(200);
    expect(dataOf(answer)['seller']).toEqual({
      kind: 'person',
      oxyUserId: PERSON,
      displayName: 'Pat Seller',
      username: `person${PERSON.slice(-6)}`,
      avatarUrl: mediaUrl(`avatar-${PERSON}`),
      isVerified: false,
    });
  });

  it('separates GONE from NOT_FOUND exactly as the contract states', async () => {
    const gone = [ids.archived, ids.restricted, ids.draftWasPublished, ids.suspendedStoreProduct];
    for (const id of gone) {
      const answer = await call(api(`/products/${id}`));
      expectFailure(answer, 410, 'GONE');
      // A 410 carries no entity data and does not say why.
      expect(answer.text).not.toContain(id);
      expect(answer.text.toLowerCase()).not.toMatch(/archiv|restrict|moderat|suspend|draft/u);
    }
    expectFailure(await call(api(`/products/${ids.draftNever}`)), 404, 'NOT_FOUND');
    expectFailure(await call(api(`/products/${uuidv7()}`)), 404, 'NOT_FOUND');
    expectFailure(await call(api('/products/not-an-id')), 404, 'NOT_FOUND');
  });

  it('forwards the caller’s authority: viewer is null anonymously and { saved } for a session', async () => {
    const saver = await call(api(`/products/${ids.inStock}`), { actor: VIEWER, shape: 'product' });
    expect(dataOf(saver)['viewer']).toEqual({ saved: true });
    const other = await call(api(`/products/${ids.inStock}`), {
      actor: `oxy-user-pubapi-other-${RUN}`,
      shape: 'product',
    });
    expect(dataOf(other)['viewer']).toEqual({ saved: false });
    const anonymous = await call(api(`/products/${ids.inStock}`), { shape: 'product' });
    expect(dataOf(anonymous)['viewer']).toBeNull();
    expect(anonymous.headers.get('vary') ?? '').toMatch(/authorization/iu);
  });
});

/* -------------------------------------------------------------------------- */
/* Stores and collections                                                     */
/* -------------------------------------------------------------------------- */

describe('stores', () => {
  it('serves a live store by id and by handle, identically', async () => {
    const byId = await call(api(`/stores/${ids.storeA}`), { shape: 'store' });
    expect(byId.status, byId.text).toBe(200);
    expect(dataOf(byId)).toEqual({
      ref: { kind: 'store', id: ids.storeA },
      handle: storeAHandle,
      name: `Public API a ${RUN}`,
      description: 'A store that sells things',
      logoUrl: mediaUrl(`logo-${RUN}`),
      coverImageUrl: mediaUrl(`cover-${RUN}`),
      brandColor: '#123456',
      rating: null,
      reviewCount: 0,
      url: `${webOrigin}/stores/${storeAHandle}`,
    });
    const byHandle = await call(api(`/stores/lookup?handle=${storeAHandle}`), { shape: 'store' });
    expect(dataOf(byHandle)).toEqual(dataOf(byId));
  });

  it('answers 410 for a suspended or closed store, 404 for one that never existed', async () => {
    expectFailure(await call(api(`/stores/${ids.storeSuspended}`)), 410, 'GONE');
    expectFailure(await call(api(`/stores/${ids.storeClosed}`)), 410, 'GONE');
    expectFailure(await call(api(`/stores/lookup?handle=pubapi-closed-${RUN}`)), 410, 'GONE');
    expectFailure(await call(api(`/stores/${uuidv7()}`)), 404, 'NOT_FOUND');
    expectFailure(await call(api('/stores/nope')), 404, 'NOT_FOUND');
    expectFailure(await call(api(`/stores/lookup?handle=nobody-${RUN}`)), 404, 'NOT_FOUND');
    expectFailure(await call(api('/stores/lookup')), 400, 'VALIDATION_ERROR');
  });

  it('paginates a store’s products and refuses a closed store’s', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `/stores/${ids.storeA}/products?limit=4${cursor ? `&cursor=${cursor}` : ''}`;
      const answer = await call(api(query), { shape: 'page:productSummary' });
      expect(answer.status, answer.text).toBe(200);
      seen.push(...itemIds(answer));
      cursor = dataOf(answer)['nextCursor'] as string | null;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(2);
    expect(seen.length).toBeGreaterThanOrEqual(7);
    expect(new Set(seen)).toEqual(new Set([ids.inStock, ids.outOfStock, ...ids.extraActive]));
    expectFailure(await call(api(`/stores/${ids.storeClosed}/products`)), 410, 'GONE');
  });

  it('lists only PUBLISHED collections', async () => {
    const answer = await call(api(`/stores/${ids.storeA}/collections?limit=1`), {
      shape: 'page:collection',
    });
    expect(answer.status, answer.text).toBe(200);
    const first = itemIds(answer);
    const cursor = dataOf(answer)['nextCursor'] as string;
    expect(cursor).toBeTypeOf('string');
    const second = await call(api(`/stores/${ids.storeA}/collections?limit=1&cursor=${cursor}`), {
      shape: 'page:collection',
    });
    const all = [...first, ...itemIds(second)];
    expect(dataOf(second)['nextCursor']).toBeNull();
    expect(new Set(all)).toEqual(new Set([ids.manual, ids.automated]));
    expectFailure(await call(api(`/stores/${ids.storeSuspended}/collections`)), 410, 'GONE');
  });
});

describe('collections', () => {
  it('serves a published collection, with its deep link', async () => {
    const answer = await call(api(`/collections/${ids.manual}`), { shape: 'collection' });
    expect(answer.status, answer.text).toBe(200);
    expect(dataOf(answer)).toEqual({
      ref: { kind: 'collection', id: ids.manual },
      store: { kind: 'store', id: ids.storeA },
      title: 'Collection manual',
      description: 'Hand picked',
      image: { url: mediaUrl(`collection-image-${RUN}`), alt: null },
      url: `${webOrigin}/stores/${storeAHandle}?collection=${ids.manual}`,
    });
  });

  it('serves its ACTIVE products in its own manual order', async () => {
    const answer = await call(api(`/collections/${ids.manual}/products`), {
      shape: 'page:productSummary',
    });
    expect(answer.status, answer.text).toBe(200);
    expect(itemIds(answer)).toEqual([ids.outOfStock, ids.inStock]);
  });

  it('answers 404 for never published, 410 after unpublishing or with the store gone', async () => {
    expectFailure(await call(api(`/collections/${ids.unpublishedNever}`)), 404, 'NOT_FOUND');
    expectFailure(await call(api(`/collections/${ids.unpublishedAfter}`)), 410, 'GONE');
    expectFailure(await call(api(`/collections/${ids.unpublishedAfter}/products`)), 410, 'GONE');
    expectFailure(await call(api(`/collections/${ids.suspendedStoreCollection}`)), 410, 'GONE');
    expectFailure(await call(api(`/collections/${uuidv7()}`)), 404, 'NOT_FOUND');
    expectFailure(await call(api('/collections/bad-id/products')), 404, 'NOT_FOUND');
  });
});

/* -------------------------------------------------------------------------- */
/* The envelope at the edges, and CORS                                        */
/* -------------------------------------------------------------------------- */

describe('the envelope at the edges', () => {
  it('answers an unmatched path, and a non-GET method, with a JSON UNKNOWN_ROUTE, never NOT_FOUND', async () => {
    expectFailure(await call(api('/x')), 404, 'UNKNOWN_ROUTE');
    expectFailure(await call(MERCARIA_PUBLIC_API_BASE_PATH), 404, 'UNKNOWN_ROUTE');
    expectFailure(await call(api('/products'), { method: 'POST' }), 404, 'UNKNOWN_ROUTE');
    expectFailure(await call(api(`/products/${ids.inStock}`), { method: 'DELETE' }), 404, 'UNKNOWN_ROUTE');
  });

  it('answers a body that will not parse with a JSON envelope, not the global 500 body', async () => {
    const response = await fetch(`${base}${api('/products')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const text = await response.text();
    BODIES.push(text);
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ success: false, error: 'VALIDATION_ERROR' });
  });

  it('keeps the allowance in lib/allowed-origins.ts on the contract’s base path', async () => {
    const { PUBLIC_READ_CORS_BASE_PATH } = await import('../../lib/allowed-origins.js');
    expect(PUBLIC_READ_CORS_BASE_PATH).toBe(MERCARIA_PUBLIC_API_BASE_PATH);
  });
});

describe('CORS', () => {
  const FOREIGN = 'https://mention.earth';

  it('lets a foreign origin read the public surface, credential-less', async () => {
    const answer = await call(api(`/products/${ids.inStock}`), { headers: { origin: FOREIGN } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('access-control-allow-origin')).toBe('*');
    expect(answer.headers.get('access-control-allow-credentials')).toBeNull();

    const preflight = await call(api('/products'), {
      method: 'OPTIONS',
      headers: {
        origin: FOREIGN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    expect(preflight.headers.get('access-control-allow-headers') ?? '').toMatch(/authorization/iu);
    // A preflight for a write is answered with the read-only method list, which
    // the browser then refuses.
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET,HEAD,OPTIONS');
  });

  it('still refuses that foreign origin everywhere else, and leaves the allow-list credentialed', async () => {
    const refused = await call('/categories', { headers: { origin: FOREIGN } });
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();

    const own = await call('/categories', { headers: { origin: 'https://mercaria.co' } });
    expect(own.headers.get('access-control-allow-origin')).toBe('https://mercaria.co');
    expect(own.headers.get('access-control-allow-credentials')).toBe('true');

    const { isAllowedBrowserOrigin, isPublicReadCorsRequest } = await import(
      '../../lib/allowed-origins.js'
    );
    // The guest CSRF gate reads this, and it is unchanged.
    expect(isAllowedBrowserOrigin(FOREIGN)).toBe(false);
    expect(isPublicReadCorsRequest('GET', '/public/v1/products')).toBe(true);
    expect(isPublicReadCorsRequest('POST', '/public/v1/products')).toBe(false);
    expect(isPublicReadCorsRequest('GET', '/public/v10/products')).toBe(false);
    expect(isPublicReadCorsRequest('GET', '/listings')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The privacy census — LAST, over every body the file received               */
/* -------------------------------------------------------------------------- */

describe('the privacy census', () => {
  it('drives every public route once more, so the census covers each', async () => {
    for (const [path, shape] of [
      [`/products?q=${TERM}&limit=50`, 'page:productSummary'],
      [`/products/${ids.inStock}`, 'product'],
      [`/products/${ids.person}`, 'product'],
      [`/stores/lookup?handle=${storeAHandle}`, 'store'],
      [`/stores/${ids.storeA}`, 'store'],
      [`/stores/${ids.storeA}/products?limit=50`, 'page:productSummary'],
      [`/stores/${ids.storeA}/collections`, 'page:collection'],
      [`/collections/${ids.manual}`, 'collection'],
      [`/collections/${ids.automated}`, 'collection'],
      [`/collections/${ids.manual}/products`, 'page:productSummary'],
    ] as const) {
      const answer = await call(api(path), { shape, actor: VIEWER });
      expect(answer.status, `${path}: ${answer.text}`).toBe(200);
    }
  });

  it('no private sentinel appears anywhere in any serialized public response', () => {
    // Floors, so a census over nothing cannot pass.
    expect(BODIES.length).toBeGreaterThanOrEqual(60);
    expect(shapesChecked).toBeGreaterThanOrEqual(25);
    const privateValues = [
      ...Object.values(SENTINEL),
      // The non-active manual members — ids a `Collection.productIds` would carry.
      ids.draftNever,
      ids.archived,
    ];
    const everything = BODIES.join('\n');
    // The positive control: the census is reading real bodies that do carry
    // this file's public facts.
    expect(everything).toContain(ids.inStock);
    expect(everything).toContain(TERM);
    for (const value of privateValues) {
      const offending = BODIES.filter((body) => body.includes(value));
      expect(offending, `private value ${value} reached a public body`).toEqual([]);
    }
  });
});
