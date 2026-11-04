/**
 * The comparison catalogue on the PUBLIC surface (`/public/v1/catalog/*`) over
 * real HTTP against a real database — what Clarity and agents read canonical
 * products and their offers through.
 *
 * It drives the real `createApp()` chain, with `public-api.realdb.test.ts`'s
 * auth stand-in, and asserts the wire: the contract's exact key sets, the status
 * semantics a consumer holding a persisted `catalog_product` ref depends on
 * (merged answers as its winner, suppressed is 410, a draft is 404), the
 * redirect-only outbound action, a price in an unmodelled currency served as
 * `null`, GTINs per configuration, and a cursor that refuses to resume another
 * list.
 *
 * The last block reads the same answers through `@mercaria.co/sdk` (from
 * source, as `public-api-sdk-contract.realdb.test.ts` does), so the SDK's
 * parser is proven against the bodies this server actually sends.
 *
 * Every fixture is namespaced by `RUN`; every search is for a token only this
 * file writes.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { MERCARIA_PUBLIC_API_BASE_PATH } from '@mercaria/contracts';
import {
  catalogProductRef,
  createMercariaClient,
  MercariaGoneError,
  MercariaNotFoundError,
} from '@mercaria.co/sdk';
import type { Database } from '../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants, storefronts } from '../../db/schema/merchants.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { offers } from '../../db/schema/offers.js';
import { insertOffer } from '../../db/offers/offerRepository.js';
import { insertIdentifierAssertion } from '../../db/canonical/productIdentifierRepository.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';
import { exactKeys } from './public-api-fixtures.js';

vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    middleware: {
      auth:
        () =>
        (_req: express.Request, _res: express.Response, next: express.NextFunction): void => {
          next();
        },
    },
    assets: { publicUrl: (fileId: string) => `https://media.test.invalid/${fileId}` },
  },
  authenticateToken: (_req: express.Request, res: express.Response): void => {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  },
  optionalAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

const RUN = uuidv7().replace(/-/gu, '').slice(-12);
/** One token only this file's product names carry. */
const TOKEN = `zcat${RUN}`;
/** A GTIN-13 only this file asserts, and its canonical 14-digit form. */
const GTIN13 = `84${RUN.replace(/\D/gu, '7').padEnd(11, '7').slice(0, 11)}`;

const KEYS = {
  summary: ['image', 'name', 'offers', 'ref', 'url'],
  offerSummary: ['availability', 'count', 'lowestPrice'],
  product: ['description', 'image', 'images', 'name', 'offers', 'ref', 'url', 'variants'],
  variant: ['gtins', 'id', 'name'],
  offer: [
    'action',
    'availability',
    'condition',
    'id',
    'kind',
    'observedAt',
    'price',
    'seller',
    'source',
    'variantId',
  ],
  ref: ['id', 'kind'],
  money: ['amount', 'currency'],
  sellerMerchant: ['domain', 'kind', 'name'],
  actionOutbound: ['destinationHost', 'kind', 'path', 'rel'],
  actionNone: ['destinationHost', 'kind'],
} as const;

let db: Database;
let redirectEnabled = false;
let closePostgres: () => Promise<void>;
let server: Server;
let base: string;

const productIds: string[] = [];
const variantIds: string[] = [];
const merchantIds: string[] = [];
const storefrontIds: string[] = [];
const sourceIds: string[] = [];

const ids = {
  active: '',
  activeVariants: [] as string[],
  suppressed: '',
  draft: '',
  winner: '',
  merged: '',
};

function digest(): string {
  return uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64);
}

function gtinCheckDigit(body: string): string {
  const sum = [...body]
    .reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}

const GTIN = `${GTIN13.slice(0, 12)}${gtinCheckDigit(GTIN13.slice(0, 12))}`;
const GTIN14 = GTIN.padStart(14, '0');

async function mintProduct(
  label: string,
  status: 'active' | 'suppressed' | 'draft' = 'active',
  variantCount = 1,
): Promise<{ productId: string; variantIds: string[] }> {
  const name = `Catalog ${label} ${TOKEN}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name,
      normalizedName: name.toLowerCase(),
      slug: `catalog-${label}-${RUN}`,
      status,
      searchTokens: ['catalog', label, TOKEN],
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');
  productIds.push(product.id);
  const minted: string[] = [];
  for (let index = 0; index < variantCount; index += 1) {
    const [variant] = await db
      .insert(canonicalVariants)
      .values({ productId: product.id, name: `Config ${index + 1}`, signature: digest() })
      .returning({ id: canonicalVariants.id });
    if (!variant) throw new Error('the canonical variant was not written');
    variantIds.push(variant.id);
    minted.push(variant.id);
  }
  return { productId: product.id, variantIds: minted };
}

async function mintMerchant(label: string): Promise<{ merchantId: string; storefrontId: string }> {
  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Retailer ${label} ${RUN}`, slug: `retailer-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('the merchant was not written');
  merchantIds.push(merchant.id);
  const [storefront] = await db
    .insert(storefronts)
    .values({
      merchantId: merchant.id,
      name: `Shop ${label} ${RUN}`,
      slug: `shop-${label}-${RUN}`,
      channelKind: 'web',
      domain: `${label}-${RUN}.example.test`.toLowerCase(),
    })
    .returning({ id: storefronts.id });
  if (!storefront) throw new Error('the storefront was not written');
  storefrontIds.push(storefront.id);
  return { merchantId: merchant.id, storefrontId: storefront.id };
}

async function seedExternalOffer(input: {
  label: string;
  variantId: string;
  merchantId: string;
  storefrontId: string;
  priceMinor: number;
  currency: string;
}): Promise<string> {
  const [source] = await db
    .insert(catalogSources)
    .values({
      name: `Source ${input.label} ${RUN}`,
      kind: 'feed',
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (!source) throw new Error('the catalog source was not written');
  sourceIds.push(source.id);
  const now = new Date();
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `ext-${input.label}-${RUN}`,
      contentHash: digest(),
      observedAt: now,
      payload: { price: input.priceMinor },
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('the source record was not written');
  const row = await insertOffer(db, {
    kind: 'external',
    status: 'active',
    canonicalVariantId: input.variantId,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    sourceRecordId: record.id,
    provider: `catalog-${input.label}-${RUN}`.toLowerCase().slice(0, 64),
    externalOfferId: `ext-${input.label}-${RUN}`,
    destinationUrl: `https://${input.label}-${RUN}.example.test/item`.toLowerCase(),
    priceAmount: input.priceMinor,
    priceCurrency: input.currency,
    availability: 'in_stock',
    condition: 'new',
    conditionMappingState: 'declared',
    customerEligibility: 'anyone',
    country: 'ES',
    observedAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    lastConfirmedAt: now,
    staleAt: new Date(now.getTime() + 3_600_000),
  });
  return row.id;
}

interface Answer {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

async function call(path: string): Promise<Answer> {
  const response = await fetch(`${base}${MERCARIA_PUBLIC_API_BASE_PATH}${path}`);
  const text = await response.text();
  const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  return { status: response.status, text, body };
}

function errorCode(answer: Answer): unknown {
  return (answer.body.error as { code?: unknown } | undefined)?.code;
}

beforeAll(async () => {
  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres();
  closePostgres = postgres.closePostgres;
  const { config } = await import('../../config/index.js');
  redirectEnabled = config.affiliateOutbound.redirectEnabled;

  const active = await mintProduct('alpha', 'active', 2);
  ids.active = active.productId;
  ids.activeVariants = active.variantIds;
  const [gtinVariant, otherVariant] = active.variantIds;
  await insertIdentifierAssertion(db, {
    variantId: gtinVariant,
    scheme: 'ean',
    rawValue: GTIN,
    normalizedValue: GTIN,
    canonicalScheme: 'gtin',
    canonicalValue: GTIN14,
  });
  const retailer = await mintMerchant('retailer');
  await seedExternalOffer({
    label: 'eur',
    variantId: gtinVariant,
    merchantId: retailer.merchantId,
    storefrontId: retailer.storefrontId,
    priceMinor: 1_999,
    currency: 'EUR',
  });
  await seedExternalOffer({
    label: 'unmodelled',
    variantId: otherVariant,
    merchantId: retailer.merchantId,
    storefrontId: retailer.storefrontId,
    // FEWER minor units than the EUR offer: the fetch orders by raw minor
    // units across currencies, and a lowest price taken as "the first priced
    // offer" would state this incomparable one (as null) instead of 19.99 EUR.
    priceMinor: 500,
    currency: 'ZZZ',
  });

  ids.suppressed = (await mintProduct('withdrawn', 'suppressed')).productId;
  ids.draft = (await mintProduct('provisional', 'draft')).productId;
  ids.winner = (await mintProduct('winner')).productId;
  ids.merged = (await mintProduct('loser')).productId;
  await db
    .update(canonicalProducts)
    .set({ status: 'merged', mergedIntoId: ids.winner })
    .where(eq(canonicalProducts.id, ids.merged));

  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db) {
    const some = (list: readonly string[]) => (list.length === 0 ? ['__none__'] : [...list]);
    await db.delete(offers).where(inArray(offers.canonicalVariantId, some(variantIds)));
    await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, some(sourceIds)));
    await db.delete(catalogSources).where(inArray(catalogSources.id, some(sourceIds)));
    await db.delete(storefronts).where(inArray(storefronts.id, some(storefrontIds)));
    await db
      .update(canonicalProducts)
      .set({ status: 'active', mergedIntoId: null })
      .where(inArray(canonicalProducts.id, some(productIds)));
    await deleteTestCanonicalRows(db, { productIds, variantIds });
    await db.delete(merchants).where(inArray(merchants.id, some(merchantIds)));
  }
  await closePostgres?.();
}, 300_000);

describe('GET /public/v1/catalog/products/{id}', () => {
  it('serves identity, configurations with their GTINs, and every offer in the contract’s shape', async () => {
    const answer = await call(`/catalog/products/${ids.active}`);
    expect(answer.status, answer.text).toBe(200);
    const product = exactKeys(answer.body, KEYS.product, 'product');
    expect(exactKeys(product.ref, KEYS.ref, 'ref')).toEqual({
      kind: 'catalog_product',
      id: ids.active,
    });
    expect(product.url).toMatch(new RegExp(`/p/catalog-alpha-${RUN}$`, 'u'));

    const variants = (product.variants as unknown[]).map((variant, index) =>
      exactKeys(variant, KEYS.variant, `variants[${index}]`),
    );
    expect(variants.map((variant) => variant.id).sort()).toEqual([...ids.activeVariants].sort());
    const withGtin = variants.find((variant) => variant.id === ids.activeVariants[0]);
    expect(withGtin?.gtins).toEqual([GTIN14]);

    const served = (product.offers as unknown[]).map((offer, index) =>
      exactKeys(offer, KEYS.offer, `offers[${index}]`),
    );
    expect(served.length).toBe(2);
    for (const offer of served) {
      expect(offer.kind).toBe('external');
      const seller = exactKeys(offer.seller, KEYS.sellerMerchant, 'seller');
      expect(seller.domain).toBe(`retailer-${RUN}.example.test`.toLowerCase());
      // The page's own outbound decision, copied: a redirect path when the
      // redirect is mounted, otherwise nothing to follow — with the host disclosed.
      if (redirectEnabled) {
        const action = exactKeys(offer.action, KEYS.actionOutbound, 'action');
        expect(action.path).toMatch(/^\/out\/[A-Za-z0-9_.~-]+$/u);
      } else {
        const action = exactKeys(offer.action, KEYS.actionNone, 'action');
        expect(action).toEqual({
          kind: 'none',
          destinationHost:
            `${offer.variantId === ids.activeVariants[0] ? 'eur' : 'unmodelled'}-${RUN}.example.test`.toLowerCase(),
        });
      }
      // The redirect path, never the retailer's own URL.
      expect(JSON.stringify(offer)).not.toContain('/item');
      expect(offer.condition).toEqual({ key: 'new', group: 'new' });
    }
    const eur = served.find((offer) => offer.variantId === ids.activeVariants[0]);
    expect(exactKeys(eur?.price, KEYS.money, 'price')).toEqual({ amount: 1_999, currency: 'EUR' });
    const unmodelled = served.find((offer) => offer.variantId === ids.activeVariants[1]);
    expect(unmodelled?.price).toBeNull();
  });

  it('answers a merged product as the product it merged into', async () => {
    const answer = await call(`/catalog/products/${ids.merged}`);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.ref).toEqual({ kind: 'catalog_product', id: ids.winner });
  });

  it('is 410 for a withdrawn product and 404 for a draft or an unknown id', async () => {
    const withdrawn = await call(`/catalog/products/${ids.suppressed}`);
    expect(withdrawn.status, withdrawn.text).toBe(410);
    expect(errorCode(withdrawn)).toBe('gone');
    expect(withdrawn.text).not.toContain('withdrawn');

    for (const id of [ids.draft, `missing-${RUN}`]) {
      const answer = await call(`/catalog/products/${id}`);
      expect(answer.status, answer.text).toBe(404);
      expect(errorCode(answer)).toBe('not_found');
    }
  });
});

describe('GET /public/v1/catalog/products', () => {
  it('finds catalog products by words, never a withdrawn or draft one, in the summary shape', async () => {
    const answer = await call(`/catalog/products?q=${TOKEN}&limit=50`);
    expect(answer.status, answer.text).toBe(200);
    const page = exactKeys(answer.body, ['items', 'nextCursor'], 'page');
    const items = (page.items as unknown[]).map((item, index) =>
      exactKeys(item, KEYS.summary, `items[${index}]`),
    );
    const found = items.map((item) => (item.ref as { id: string }).id);
    expect(found).toContain(ids.active);
    expect(found).not.toContain(ids.suppressed);
    expect(found).not.toContain(ids.draft);
    expect(found).not.toContain(ids.merged);

    const active = items.find((item) => (item.ref as { id: string }).id === ids.active);
    const summary = exactKeys(active?.offers, KEYS.offerSummary, 'offers');
    expect(summary.count).toBeGreaterThanOrEqual(1);
    expect(summary.lowestPrice).toEqual({ amount: 1_999, currency: 'EUR' });
  });

  it('answers a GTIN by exact identifier', async () => {
    const answer = await call(`/catalog/products?q=${GTIN}`);
    expect(answer.status, answer.text).toBe(200);
    const items = answer.body.items as { ref: { id: string } }[];
    expect(items[0]?.ref.id).toBe(ids.active);
  });

  it('pages with its own cursor and refuses one from another list or other filters', async () => {
    const first = await call(`/catalog/products?q=${TOKEN}&limit=1`);
    expect(first.status, first.text).toBe(200);
    const cursor = first.body.nextCursor;
    expect(typeof cursor).toBe('string');
    expect((cursor as string).length).toBeLessThanOrEqual(512);

    const second = await call(
      `/catalog/products?q=${TOKEN}&limit=1&cursor=${encodeURIComponent(cursor as string)}`,
    );
    expect(second.status, second.text).toBe(200);
    const firstIds = (first.body.items as { ref: { id: string } }[]).map((item) => item.ref.id);
    const secondIds = (second.body.items as { ref: { id: string } }[]).map((item) => item.ref.id);
    expect(secondIds.length).toBe(1);
    expect(secondIds).not.toEqual(firstIds);

    const otherFilters = await call(
      `/catalog/products?q=${TOKEN}&market=ES&cursor=${encodeURIComponent(cursor as string)}`,
    );
    expect(otherFilters.status, otherFilters.text).toBe(400);
    expect(errorCode(otherFilters)).toBe('bad_request');

    const listing = await call(`/products?q=${TOKEN}&limit=1`);
    expect(listing.status, listing.text).toBe(200);
    const foreign = await call(
      `/catalog/products?q=${TOKEN}&cursor=${encodeURIComponent(
        Buffer.from(
          JSON.stringify({ v: 1, k: 'products', f: 'x'.repeat(22), o: 1 }),
          'utf8',
        ).toString('base64url'),
      )}`,
    );
    expect(foreign.status, foreign.text).toBe(400);
  });

  it('requires a query and refuses a market that is not a country code', async () => {
    const missing = await call('/catalog/products');
    expect(missing.status, missing.text).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'bad_request', details: { field: 'q' } });

    const market = await call(`/catalog/products?q=${TOKEN}&market=spain`);
    expect(market.status, market.text).toBe(400);
    expect(market.body.error).toMatchObject({ code: 'bad_request', details: { field: 'market' } });
  });
});

describe('@mercaria.co/sdk against this server', () => {
  const client = () => createMercariaClient({ apiBaseUrl: base });

  it('parses a search page and a detail read, by id and by ref, to the server’s own bodies', async () => {
    const sdk = client();
    const page = await sdk.catalog.search({ query: TOKEN, limit: 50 });
    expect(page.items.map((item) => item.ref.id)).toContain(ids.active);

    const raw = await call(`/catalog/products/${ids.active}`);
    const byId = await sdk.catalog.get(ids.active);
    const byRef = await sdk.catalog.resolveRef(catalogProductRef(ids.active));
    expect(byId).toEqual(raw.body);
    expect(byRef).toEqual(byId);
    for (const offer of byId.offers ?? []) {
      // The backend compiles `strict: false`, like Clarity: the offer it was
      // handed is accepted as it is.
      const link = sdk.links.offer(offer);
      if (offer.action.kind === 'outbound') expect(link).toBe(`${base}${offer.action.path}`);
      else if (offer.action.kind === 'none') expect(link).toBeNull();
    }
  });

  it('tells a withdrawn product (gone) from one that never existed (not found)', async () => {
    const sdk = client();
    await expect(sdk.catalog.get(ids.suppressed)).rejects.toBeInstanceOf(MercariaGoneError);
    await expect(sdk.catalog.get(ids.draft)).rejects.toBeInstanceOf(MercariaNotFoundError);
  });
});
