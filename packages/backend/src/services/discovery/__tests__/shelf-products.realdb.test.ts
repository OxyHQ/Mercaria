/**
 * A discovery shelf shows the CATALOGUE after a Mercaria store's listings
 * (`shelf-products.service.ts`, `db/discovery/catalogShelfRepository.ts`).
 *
 * Every shelf used to read `listings` alone, so the catalogue's products —
 * all but the handful a Mercaria store sells — never appeared on the home,
 * explore, category or deals pages. Pinned here against a real server:
 *
 * - which catalogue products a shelf admits (imaged, priced by a CURRENT offer,
 *   not sold natively) and which it does not, each excluded case its own row;
 * - the `new` and `on-sale` orderings, and that `on-sale` reads the CHEAPEST
 *   offer's discount, never another seller's;
 * - the card: `catalogSlug`, the lowest current price, the compare-at only of
 *   the offer the card is priced at;
 * - paging across the catalogue.
 *
 * Scoped to one category minted per run: the database is shared, and every
 * shelf query here is scoped to that category.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { declaredOfferCondition } from '../../condition/condition-mapping.service.js';
import { categories, listings, productVariants } from '../../../db/schema/catalog.js';
import { stores } from '../../../db/schema/stores.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { merchants } from '../../../db/schema/merchants.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import {
  canonicalImages,
  canonicalProducts,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { insertCategory } from '../../../db/taxonomy/taxonomyRepository.js';
import { findCatalogProductIdsBySignal } from '../../../db/discovery/catalogShelfRepository.js';
import { findShelfProducts, toCatalogProductSummaries } from '../shelf-products.service.js';

let db: Database;
const RUN = `shf${uuidv7().replace(/-/g, '').slice(-8)}`;
const FUTURE = () => new Date(Date.now() + 7 * 86_400_000);
const PAST = () => new Date(Date.now() - 86_400_000);

const created = {
  offers: [] as string[],
  variants: [] as string[],
  products: [] as string[],
  listings: [] as string[],
  stores: [] as string[],
  merchants: [] as string[],
  sources: [] as string[],
  sourceRecords: [] as string[],
  categories: [] as string[],
};
const fx = { categoryId: '', merchantId: '', otherMerchantId: '', sourceRecordId: '' };

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

function signature(): string {
  return uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
}

/** An Oxy-shaped file id (`isOxyFileId`): a UUID. */
function oxyFileId(): string {
  return uuidv7();
}

async function product(
  label: string,
  options: { image?: boolean; createdAt?: Date; categoryId?: string | null } = {},
): Promise<{ productId: string; variantId: string; slug: string }> {
  const name = `Zyshelf ${RUN} ${label}`;
  const slug = `zyshelf-${RUN}-${label}`;
  const [row] = await db
    .insert(canonicalProducts)
    .values({
      name,
      normalizedName: name.toLowerCase(),
      slug,
      searchTokens: [],
      status: 'active',
      categoryId: options.categoryId === undefined ? fx.categoryId : options.categoryId,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning({ id: canonicalProducts.id });
  if (!row) throw new Error('product insert returned no row');
  created.products.push(row.id);
  const [variant] = await db
    .insert(canonicalVariants)
    .values({ productId: row.id, signature: signature() })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('variant insert returned no row');
  created.variants.push(variant.id);
  if (options.image !== false) {
    await db.insert(canonicalImages).values({
      productId: row.id,
      fileId: oxyFileId(),
      sourceRecordId: fx.sourceRecordId,
      kind: 'image',
      status: 'active',
      position: 0,
    });
  }
  return { productId: row.id, variantId: variant.id, slug };
}

async function offer(input: {
  variantId: string;
  price: number;
  compareAt?: number;
  staleAt?: Date;
  /** A second seller of the same product (one active offer per seller and variant). */
  otherMerchant?: boolean;
}): Promise<void> {
  const [row] = await db
    .insert(offers)
    .values({
      kind: 'external',
      status: 'active',
      canonicalVariantId: input.variantId,
      merchantId: input.otherMerchant ? fx.otherMerchantId : fx.merchantId,
      sourceRecordId: fx.sourceRecordId,
      destinationUrl: 'https://example.test/product',
      provider: 'zyshelf-feed',
      externalOfferId: `offer-${uuidv7()}`,
      ...declaredOfferCondition('new'),
      priceAmount: input.price,
      priceCurrency: 'EUR',
      ...(input.compareAt === undefined
        ? {}
        : { compareAtPriceAmount: input.compareAt, compareAtPriceCurrency: 'EUR' }),
      observedAt: new Date(),
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      staleAt: input.staleAt ?? FUTURE(),
    })
    .returning({ id: offers.id });
  if (!row) throw new Error('offer insert returned no row');
  created.offers.push(row.id);
}

const ids = {
  newest: '',
  newestSlug: '',
  onSale: '',
  onSaleSlug: '',
  pricierSale: '',
  imageless: '',
  stale: '',
  native: '',
  uncategorized: '',
  suppressed: '',
};
let suppressedCategoryId = '';

beforeAll(async () => {
  db = await connectPostgres();

  const category = await insertCategory(
    { key: `zyshelf-${RUN}`, name: `Zyshelf ${RUN}`, slug: `zyshelf-${RUN}` },
    db,
  );
  fx.categoryId = category.id;
  created.categories.push(category.id);

  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Zyshelf merchant ${RUN}`, slug: `zyshelf-merchant-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('merchant insert returned no row');
  fx.merchantId = merchant.id;
  created.merchants.push(merchant.id);
  const [other] = await db
    .insert(merchants)
    .values({ name: `Zyshelf other ${RUN}`, slug: `zyshelf-other-${RUN}` })
    .returning({ id: merchants.id });
  if (!other) throw new Error('merchant insert returned no row');
  fx.otherMerchantId = other.id;
  created.merchants.push(other.id);

  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `zyshelf-source-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (!source) throw new Error('source insert returned no row');
  created.sources.push(source.id);
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `ext-${RUN}`,
      observedAt: new Date(),
      contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      payload: {},
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('record insert returned no row');
  fx.sourceRecordId = record.id;
  created.sourceRecords.push(record.id);

  const day = 86_400_000;
  // The newest: two current offers, the cheaper NOT discounted.
  const newest = await product('newest', { createdAt: new Date(Date.now() - 1 * day) });
  ids.newest = newest.productId;
  ids.newestSlug = newest.slug;
  await offer({ variantId: newest.variantId, price: 1_000 });
  await offer({ variantId: newest.variantId, price: 5_000, compareAt: 9_000, otherMerchant: true });

  // On sale: its CHEAPEST offer is discounted (50%).
  const onSale = await product('on-sale', { createdAt: new Date(Date.now() - 2 * day) });
  ids.onSale = onSale.productId;
  ids.onSaleSlug = onSale.slug;
  await offer({ variantId: onSale.variantId, price: 2_000, compareAt: 4_000 });
  await offer({ variantId: onSale.variantId, price: 3_000, otherMerchant: true });

  // A shallower sale (20%): after the deeper one on the on-sale shelf.
  const pricierSale = await product('pricier-sale', { createdAt: new Date(Date.now() - 3 * day) });
  ids.pricierSale = pricierSale.productId;
  await offer({ variantId: pricierSale.variantId, price: 8_000, compareAt: 10_000 });

  // Excluded: no image.
  const imageless = await product('imageless', { image: false });
  ids.imageless = imageless.productId;
  await offer({ variantId: imageless.variantId, price: 1_500 });

  // Excluded: its only offer went stale.
  const stale = await product('stale');
  ids.stale = stale.productId;
  await offer({ variantId: stale.variantId, price: 1_500, staleAt: PAST() });

  // The whole-marketplace scopes: an UNFILED product is shown, one filed under
  // a suppressed category is not.
  const uncategorized = await product('uncategorized', { categoryId: null });
  ids.uncategorized = uncategorized.productId;
  await offer({ variantId: uncategorized.variantId, price: 1_500 });
  const suppressedCategory = await insertCategory(
    {
      key: `zyshelf-hidden-${RUN}`,
      name: `Zyshelf hidden ${RUN}`,
      slug: `zyshelf-hidden-${RUN}`,
      lifecycle: 'suppressed',
    },
    db,
  );
  suppressedCategoryId = suppressedCategory.id;
  created.categories.push(suppressedCategory.id);
  const suppressed = await product('suppressed', { categoryId: suppressedCategory.id });
  ids.suppressed = suppressed.productId;
  await offer({ variantId: suppressed.variantId, price: 1_500 });

  // Excluded: a Mercaria store sells it (an active native offer) — it is on the
  // shelf as that store's listing, not twice.
  const native = await product('native');
  ids.native = native.productId;
  await offer({ variantId: native.variantId, price: 1_500 });
  const [store] = await db
    .insert(stores)
    .values({
      oxyAccountId: `oxy-account-${RUN}`,
      handle: `zyshelf-store-${RUN}`,
      name: `Zyshelf store ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  if (!store) throw new Error('store insert returned no row');
  created.stores.push(store.id);
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId: store.id,
      title: `Zyshelf ${RUN} native`,
      description: 'a native listing under test',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'draft',
    })
    .returning({ id: listings.id });
  if (!listing) throw new Error('listing insert returned no row');
  created.listings.push(listing.id);
  const [nativeVariant] = await db
    .insert(productVariants)
    .values({
      listingId: listing.id,
      title: 'Default Title',
      priceAmount: 1_200,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 5,
    })
    .returning({ id: productVariants.id });
  if (!nativeVariant) throw new Error('native variant insert returned no row');
  const [nativeOffer] = await db
    .insert(offers)
    .values({
      kind: 'native',
      status: 'active',
      canonicalVariantId: native.variantId,
      listingId: listing.id,
      productVariantId: nativeVariant.id,
      ...declaredOfferCondition('new'),
      priceAmount: 1_200,
      priceCurrency: 'EUR',
      observedAt: new Date(),
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      staleAt: FUTURE(),
    })
    .returning({ id: offers.id });
  if (!nativeOffer) throw new Error('native offer insert returned no row');
  created.offers.push(nativeOffer.id);
}, 120_000);

afterAll(async () => {
  await db.delete(offers).where(inArray(offers.id, safeIds(created.offers)));
  await db
    .delete(productVariants)
    .where(inArray(productVariants.listingId, safeIds(created.listings)));
  await db.delete(listings).where(inArray(listings.id, safeIds(created.listings)));
  await deleteTestStores(db, safeIds(created.stores));
  await deleteTestCanonicalRows(db, { variantIds: created.variants, productIds: created.products });
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safeIds(created.sourceRecords)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(created.sources)));
  await db.delete(merchants).where(inArray(merchants.id, safeIds(created.merchants)));
  await db.delete(categories).where(inArray(categories.id, safeIds(created.categories)));
  await closePostgres();
});

describe('which catalogue products a shelf admits, and in what order', () => {
  it('new: imaged, currently priced, not sold natively — newest first', async () => {
    const page = await findCatalogProductIdsBySignal(
      {
        signal: 'new',
        categoryIds: [fx.categoryId],
        includeUncategorized: false,
        limit: 20,
        offset: 0,
      },
      db,
    );
    expect(page).toEqual([ids.newest, ids.onSale, ids.pricierSale]);
    for (const excluded of [ids.imageless, ids.stale, ids.native]) {
      expect(page).not.toContain(excluded);
    }
  });

  it("on-sale: the CHEAPEST offer's discount, deepest first", async () => {
    // `newest` has a discounted offer too, but not its cheapest: not on sale.
    const page = await findCatalogProductIdsBySignal(
      {
        signal: 'on-sale',
        categoryIds: [fx.categoryId],
        includeUncategorized: false,
        limit: 20,
        offset: 0,
      },
      db,
    );
    expect(page).toEqual([ids.onSale, ids.pricierSale]);
  });

  it('pages, and has nothing for the signals counted only for listings', async () => {
    const second = await findCatalogProductIdsBySignal(
      {
        signal: 'new',
        categoryIds: [fx.categoryId],
        includeUncategorized: false,
        limit: 1,
        offset: 1,
      },
      db,
    );
    expect(second).toEqual([ids.onSale]);
    expect(
      await findCatalogProductIdsBySignal(
        {
          signal: 'best-selling',
          categoryIds: [fx.categoryId],
          includeUncategorized: false,
          limit: 20,
          offset: 0,
        },
        db,
      ),
    ).toEqual([]);
  });
});

describe('the whole-marketplace scope', () => {
  it('admits an unfiled product and never one filed under a suppressed category', async () => {
    // The active taxonomy, as the home and explore's root pass it: our active
    // category, NOT the suppressed one.
    const page = await findCatalogProductIdsBySignal(
      {
        signal: 'new',
        categoryIds: [fx.categoryId],
        includeUncategorized: true,
        limit: 5_000,
        offset: 0,
      },
      db,
    );
    expect(page).toContain(ids.uncategorized);
    expect(page).toContain(ids.newest);
    expect(page).not.toContain(ids.suppressed);
    expect(suppressedCategoryId).not.toBe('');
  });
});

describe('the cards', () => {
  it('carry the product page, the lowest current price, and only that offer’s compare-at', async () => {
    const cards = await toCatalogProductSummaries([ids.newest, ids.onSale]);
    expect(cards.map((card) => card.catalogSlug)).toEqual([ids.newestSlug, ids.onSaleSlug]);
    const [newest, onSale] = cards;
    expect(newest?.price).toEqual({ amount: 1_000, currency: 'EUR' });
    // Its discounted offer is not the one it is priced at.
    expect(newest?.compareAtPrice).toBeUndefined();
    expect(onSale?.price).toEqual({ amount: 2_000, currency: 'EUR' });
    expect(onSale?.compareAtPrice).toEqual({ amount: 4_000, currency: 'EUR' });
    expect(newest?.imageFileId).toBeTruthy();
  });

  it('a shelf with no listing in the category is the catalogue, paged', async () => {
    const first = await findShelfProducts({
      signal: 'new',
      scope: { kind: 'categories', categoryIds: [fx.categoryId] },
      limit: 2,
      offset: 0,
    });
    expect(first.map((card) => card.id)).toEqual([ids.newest, ids.onSale]);
    const next = await findShelfProducts({
      signal: 'new',
      scope: { kind: 'categories', categoryIds: [fx.categoryId] },
      limit: 2,
      offset: 2,
    });
    expect(next.map((card) => card.id)).toEqual([ids.pricierSale]);
  });
});
