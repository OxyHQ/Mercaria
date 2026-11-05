/**
 * The comparison catalogue's public projection — the branches a real database
 * in the test environment cannot reach (the outbound redirect is not mounted
 * there, and a native offer needs a whole store behind it), proven over the
 * product page's own row shape. Every output is parsed by the contract's own
 * schema, so a projection the wire would refuse fails here first.
 */

import { describe, expect, it } from 'vitest';
import {
  MercariaCatalogProductSchema,
  MercariaCatalogProductSummarySchema,
} from '@mercaria/contracts';
import type {
  CanonicalProductPage,
  ProductPageOfferRow,
  SearchProductResult,
} from '@mercaria/shared-types';
import {
  offerMoney,
  projectCatalogProduct,
  projectCatalogProductSummary,
} from '../catalog-products.projection.js';

const ORIGIN = 'https://mercaria.test/';
const resolveMedia = (fileId: string) => `https://media.test.invalid/${fileId}`;

function row(overrides: {
  id: string;
  variantId: string;
  kind: 'native' | 'external' | 'informational';
  outbound: ProductPageOfferRow['outbound'];
  seller: ProductPageOfferRow['seller'];
  price?: { amount: number; currency: string };
  source?: ProductPageOfferRow['source'];
}): ProductPageOfferRow {
  return {
    offer: {
      id: overrides.id,
      kind: overrides.kind,
      canonicalVariantId: overrides.variantId,
      price: overrides.price,
      availability: 'in_stock',
      condition: { key: 'used_good', mappingState: 'declared' },
      freshness: { level: 'current', observedAt: '2026-09-01T10:00:00.000Z' },
      destinationUrl: 'https://shop.example/secret-path?aff=1',
      sellerSku: 'PRIVATE-SKU',
    },
    seller: overrides.seller,
    outbound: overrides.outbound,
    ...(overrides.source === undefined ? {} : { source: overrides.source }),
  } as unknown as ProductPageOfferRow;
}

function page(rows: ProductPageOfferRow[], available = true): CanonicalProductPage {
  return {
    product: {
      id: 'cp-1',
      slug: 'phone x',
      name: 'Phone X',
      description: '  ',
      images: [
        { id: 'i2', fileId: 'file-b', position: 2, alt: 'Back' },
        { id: 'i1', fileId: 'file-a', position: 1, alt: '' },
        { id: 'i3', sourceUrl: 'https://supplier.example/hotlink.jpg', position: 0 },
      ],
    },
    variants: [
      { id: 'v-1', name: '128 GB', isDefault: true, options: [] },
      { id: 'v-2', isDefault: false, options: [] },
    ],
    offers: available
      ? { available: true, rows, groups: [], highlights: [], excludedCount: 3 }
      : { available: false, reason: 'comparison_withheld' },
    officialChannels: [],
    authorizedResellers: [],
  } as unknown as CanonicalProductPage;
}

describe('projectCatalogProduct', () => {
  const rows = [
    row({
      id: 'o-native',
      variantId: 'v-1',
      kind: 'native',
      price: { amount: 49_900, currency: 'EUR' },
      outbound: { kind: 'native_checkout', listingId: 'listing-1', productVariantId: 'pv-1' },
      seller: { kind: 'native_store', storeId: 'store-1', name: 'Shop One', handle: 'shop-one' },
    }),
    row({
      id: 'o-external',
      variantId: 'v-2',
      kind: 'external',
      price: { amount: 52_000, currency: 'EUR' },
      outbound: {
        kind: 'outbound',
        redirectPath: '/out/mgo_abc.def',
        destinationHost: 'shop.example',
        rel: 'sponsored nofollow noopener',
      },
      seller: {
        kind: 'merchant',
        merchantId: 'm-1',
        name: 'Retailer',
        slug: 'retailer',
        storefront: { id: 's-1', name: 'Retailer web', slug: 'web', domain: 'shop.example' },
        marketplaceSeller: false,
      },
    }),
    row({
      id: 'o-shelf',
      variantId: 'v-1',
      kind: 'informational',
      price: { amount: 100, currency: 'ZZZ' },
      outbound: { kind: 'unavailable', reason: 'no_destination' },
      seller: { kind: 'unknown' },
      source: {
        name: 'Open Prices',
        homepage: 'https://prices.openfoodfacts.org',
        licence: 'odbl_1_0',
        licenceLabel: 'ODbL 1.0',
      } as ProductPageOfferRow['source'],
    }),
    row({
      id: 'o-hidden-variant',
      variantId: 'v-suppressed',
      kind: 'external',
      outbound: { kind: 'unavailable', reason: 'no_destination' },
      seller: { kind: 'unknown' },
    }),
  ];
  const gtins = new Map([['v-1', ['00012345678905']]]);
  const product = projectCatalogProduct(page(rows), gtins, resolveMedia, ORIGIN);

  it('is a body the contract accepts, in ranked order, without an offer for a hidden configuration', () => {
    expect(MercariaCatalogProductSchema.parse(product)).toEqual(product);
    expect(product.offers?.map((offer) => offer.id)).toEqual(['o-native', 'o-external', 'o-shelf']);
  });

  it('copies each row’s action: checkout by variant ref, the redirect path, or nothing', () => {
    const [native, external, shelf] = product.offers ?? [];
    expect(native?.action).toEqual({
      kind: 'mercaria_checkout',
      purchaseOption: { kind: 'variant', productId: 'listing-1', variantId: 'pv-1' },
      url: 'https://mercaria.test/products/listing-1',
    });
    expect(native?.seller).toEqual({
      kind: 'store',
      store: { kind: 'store', id: 'store-1' },
      handle: 'shop-one',
      name: 'Shop One',
    });
    expect(external?.action).toEqual({
      kind: 'outbound',
      path: '/out/mgo_abc.def',
      destinationHost: 'shop.example',
      rel: 'sponsored nofollow noopener',
    });
    expect(external?.seller).toEqual({
      kind: 'merchant',
      name: 'Retailer',
      domain: 'shop.example',
    });
    expect(shelf?.action).toEqual({ kind: 'none', destinationHost: null });
    expect(shelf?.source).toEqual({
      name: 'Open Prices',
      homepage: 'https://prices.openfoodfacts.org',
      licenceLabel: 'ODbL 1.0',
    });
  });

  it('serves native prices, null for an unmodelled currency, and the condition with its group', () => {
    const [native, , shelf] = product.offers ?? [];
    expect(native?.price).toEqual({ amount: 49_900, currency: 'EUR' });
    expect(shelf?.price).toBeNull();
    expect(native?.condition).toEqual({ key: 'used_good', group: 'used' });
    expect(native?.observedAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('publishes only Mercaria-held images, ordered, and never a destination, SKU or excluded count', () => {
    expect(product.images.map((image) => image.url)).toEqual([
      'https://media.test.invalid/file-a',
      'https://media.test.invalid/file-b',
    ]);
    expect(product.images[0]?.alt).toBeNull();
    expect(product.description).toBeNull();
    expect(product.url).toBe('https://mercaria.test/p/phone%20x');
    expect(product.variants).toEqual([
      { id: 'v-1', name: '128 GB', gtins: ['00012345678905'] },
      { id: 'v-2', name: null, gtins: [] },
    ]);
    const text = JSON.stringify(product);
    for (const secret of ['secret-path', 'PRIVATE-SKU', 'hotlink', 'excludedCount']) {
      expect(text).not.toContain(secret);
    }
  });

  it('says null — never an empty list — while comparison is withheld', () => {
    expect(projectCatalogProduct(page([], false), gtins, resolveMedia, ORIGIN).offers).toBeNull();
  });
});

describe('projectCatalogProductSummary', () => {
  it('summarises a search result, with no offers as null rather than a zero price', () => {
    const base = {
      kind: 'product',
      canonicalProductId: 'cp-1',
      slug: 'phone-x',
      name: 'Phone X',
      image: { fileId: 'file-a' },
      matchStages: ['exact_name'],
      relevance: 1,
      conditionGroups: [],
    } as unknown as SearchProductResult;
    const priced = projectCatalogProductSummary(
      {
        ...base,
        offerSummary: {
          canonicalProductId: 'cp-1',
          currentOfferCount: 3,
          availability: 'in_stock',
          lowestPrice: { amount: 1_999, currency: 'EUR' },
          warningOfferCount: 0,
        },
      },
      resolveMedia,
      ORIGIN,
    );
    expect(MercariaCatalogProductSummarySchema.parse(priced)).toEqual(priced);
    expect(priced).toEqual({
      ref: { kind: 'catalog_product', id: 'cp-1' },
      name: 'Phone X',
      image: { url: 'https://media.test.invalid/file-a', alt: null },
      url: 'https://mercaria.test/p/phone-x',
      offers: {
        count: 3,
        availability: 'in_stock',
        lowestPrice: { amount: 1_999, currency: 'EUR' },
      },
    });
    expect(projectCatalogProductSummary(base, resolveMedia, ORIGIN).offers).toBeNull();
  });
});

describe('offerMoney', () => {
  it('states a modelled currency and refuses to state any other', () => {
    expect(offerMoney({ amount: 5, currency: 'JPY' })).toEqual({ amount: 5, currency: 'JPY' });
    expect(offerMoney({ amount: 5, currency: 'ZZZ' })).toBeNull();
    expect(offerMoney(undefined)).toBeNull();
  });
});
