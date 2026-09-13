/**
 * The catalogue world the public integration surface (#1017) is proven against,
 * shared by the two suites that read it:
 *
 * - `public-api.realdb.test.ts` asserts the WIRE — status codes, envelopes and
 *   exact key sets — with raw `fetch`;
 * - `public-api-sdk-contract.realdb.test.ts` drives the same routes EXCLUSIVELY
 *   through `@mercaria.co/sdk`, so a route or DTO drift between the backend and
 *   the published client fails a build instead of a consumer.
 *
 * One world and ONE table of the contract's key sets rather than two copies of
 * each, so the two suites cannot quietly come to describe different catalogues
 * or different contracts. `checkShape` asserts a value's key set EQUALS the
 * contract's, recursively — on a wire body in one suite and on an SDK result in
 * the other.
 *
 * Every private fact the storefront DTOs carry — a connector `source` external
 * id, a variant SKU and barcode, tags, vendor and product type, a manual
 * collection holding a DRAFT and an ARCHIVED member, an automated collection's
 * rule, SEO overrides and a store member's Oxy id — is seeded as a SENTINEL
 * string unique to the run, for each suite's privacy census.
 *
 * ## Shared database
 *
 * Every fixture is namespaced by `run`, so a suite's list reads can be scoped to
 * a store, collection or search term only that suite created. The auth and
 * `oxyClient` stand-ins stay in each suite: `vi.mock` is hoisted per file.
 */

import { expect } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { Database } from '../../db/postgres.js';
import { listingImages, listings } from '../../db/schema/catalog.js';
import { collectionRules, collections, listingCollections } from '../../db/schema/merchandising.js';
import { storeMembers, stores } from '../../db/schema/stores.js';
import { connections } from '../../db/schema/connectors.js';
import { favorites } from '../../db/schema/buyers.js';

/* -------------------------------------------------------------------------- */
/* The contract's key sets, and the recursive allow-list assertion            */
/* -------------------------------------------------------------------------- */

export type Shape =
  | 'productSummary'
  | 'product'
  | 'store'
  | 'collection'
  | 'page:productSummary'
  | 'page:collection';

export const KEYS = {
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

export function exactKeys(value: unknown, expected: readonly string[], where: string): Record<string, unknown> {
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

export function checkShape(data: unknown, shape: Shape, where: string): void {
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

/** The absolute URL the suites' `getFileDownloadUrl` stand-in turns a file id into. */
export const mediaUrl = (fileId: string): string => `https://media.test.invalid/${fileId}`;

export interface PublicApiWorldIds {
  storeA: string;
  storeSuspended: string;
  storeClosed: string;
  inStock: string;
  outOfStock: string;
  sold: string;
  archived: string;
  restricted: string;
  draftNever: string;
  draftWasPublished: string;
  suspendedStoreProduct: string;
  person: string;
  extraActive: string[];
  inStockVariants: string[];
  manual: string;
  automated: string;
  unpublishedNever: string;
  unpublishedAfter: string;
  suspendedStoreCollection: string;
}

/**
 * A fresh, run-namespaced world. The names are known synchronously (a suite
 * builds its assertions from them); the rows exist only after `seed`.
 */
export function createPublicApiWorld() {
  const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();
  /** One search token every searchable fixture title carries, and nothing else does. */
  const TERM = `pubapi${RUN}`;
  /** The Oxy user who saved the in-stock product. */
  const VIEWER = `oxy-user-pubapi-viewer-${RUN}`;
  /** The person seller. */
  const PERSON = `oxy-user-pubapi-person-${RUN}`;
  const storeAHandle = `pubapi-a-${RUN}`;

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

  const ids: PublicApiWorldIds = {
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
    extraActive: [],
    inStockVariants: [],
    manual: '',
    automated: '',
    unpublishedNever: '',
    unpublishedAfter: '',
    suspendedStoreCollection: '',
  };

  const storeIds: string[] = [];
  const listingIds: string[] = [];
  const collectionIds: string[] = [];

  async function insertStore(
    db: Database,
    label: string,
    status: 'active' | 'suspended' | 'closed',
  ): Promise<string> {
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

  async function insertListing(db: Database, input: ListingInput): Promise<{ id: string; variantIds: string[] }> {
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

  async function insertCollection(
    db: Database,
    input: {
      storeId: string;
      label: string;
      type: 'manual' | 'automated';
      isPublished: boolean;
      publishedAt: Date | null;
    },
  ): Promise<string> {
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

  /**
   * Seed the world. Store A holds 7 publicly live products (in-stock,
   * out-of-stock and five extras), one sold, and one each archived, restricted,
   * never-published draft and unpublished-after-publishing draft; a suspended
   * and a closed store; a person seller's live product; a manual collection
   * whose hand-picked members are out-of-stock, a draft, in-stock and an
   * archived listing (in that order); an automated collection; one collection
   * never published and one unpublished after publishing; and `VIEWER`'s saved
   * favourite on the in-stock product.
   */
  async function seed(db: Database): Promise<void> {
    ids.storeA = await insertStore(db, 'a', 'active');
    ids.storeSuspended = await insertStore(db, 'suspended', 'suspended');
    ids.storeClosed = await insertStore(db, 'closed', 'closed');
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
    const inStock = await insertListing(db, {
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
      await insertListing(db, {
        label: 'outofstock',
        status: 'active',
        publishedAt: published,
        storeId: ids.storeA,
        variants: [{ title: 'Only', price: 900, tracked: true, available: 0 }],
      })
    ).id;
    ids.sold = (
      await insertListing(db, {
        label: 'sold',
        status: 'sold',
        publishedAt: published,
        storeId: ids.storeA,
        variants: [{ title: 'Only', price: 700, tracked: true, available: 1 }],
      })
    ).id;
    ids.archived = (
      await insertListing(db, {
        label: 'archived',
        status: 'archived',
        publishedAt: published,
        storeId: ids.storeA,
        variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
      })
    ).id;
    ids.restricted = (
      await insertListing(db, {
        label: 'restricted',
        status: 'restricted',
        publishedAt: published,
        storeId: ids.storeA,
        variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
      })
    ).id;
    ids.draftNever = (
      await insertListing(db, {
        label: 'draftnever',
        status: 'draft',
        publishedAt: null,
        storeId: ids.storeA,
        variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
      })
    ).id;
    ids.draftWasPublished = (
      await insertListing(db, {
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
          await insertListing(db, {
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
      await insertListing(db, {
        label: 'suspendedstore',
        status: 'active',
        publishedAt: published,
        storeId: ids.storeSuspended,
        variants: [{ title: 'Only', price: 700, tracked: false, available: 0 }],
      })
    ).id;
    ids.person = (
      await insertListing(db, {
        label: 'person',
        status: 'active',
        publishedAt: published,
        oxyUserId: PERSON,
        variants: [{ title: 'Default Title', price: 4_200, tracked: false, available: 0 }],
      })
    ).id;

    ids.manual = await insertCollection(db, {
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
    ids.automated = await insertCollection(db, {
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
    ids.unpublishedNever = await insertCollection(db, {
      storeId: ids.storeA,
      label: 'never',
      type: 'manual',
      isPublished: false,
      publishedAt: null,
    });
    ids.unpublishedAfter = await insertCollection(db, {
      storeId: ids.storeA,
      label: 'after',
      type: 'manual',
      isPublished: false,
      publishedAt: published,
    });
    ids.suspendedStoreCollection = await insertCollection(db, {
      storeId: ids.storeSuspended,
      label: 'suspended',
      type: 'manual',
      isPublished: true,
      publishedAt: published,
    });

    await db.insert(favorites).values({ oxyUserId: VIEWER, listingId: ids.inStock });
  }

  /** Delete exactly the rows `seed` created, by the ids it recorded. */
  async function cleanup(db: Database): Promise<void> {
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
  }

  return { RUN, TERM, VIEWER, PERSON, storeAHandle, SENTINEL, ids, seed, cleanup };
}
