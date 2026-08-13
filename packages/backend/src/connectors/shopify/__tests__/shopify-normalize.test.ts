/**
 * Unit tests for `normalizeShopifyProduct` — the PURE Shopify-JSON → NormalizedProduct
 * mapping. No network, no DB. Asserts: prices land in the shop's NATIVE currency
 * as integer minor units (string decimals parsed without float error), image URLs
 * pass through verbatim (Mercaria's media chokepoint keeps absolute URLs), the
 * single-variant "Title / Default Title" placeholder is stripped, and multi-option
 * variants pair option names with `option1..3`.
 */

import { describe, it, expect } from 'vitest';
import type { CurrencyCode } from '@mercaria/shared-types';
import { normalizeShopifyProduct } from '../index.js';
import type { NormalizedVariant } from '../../types.js';

/** The variants `raw` normalizes to, or a failure naming the gap it produced. */
function variantsOf(raw: unknown, currency: CurrencyCode = 'USD'): NormalizedVariant[] {
  const set = normalizeShopifyProduct(raw, currency).variants;
  if (set.enumeration === 'incomplete') {
    throw new Error(`expected a COMPLETE variant set; got the gap ${set.gap.kind}`);
  }
  return set.variants;
}

/** A Shopify single-variant product (the "Title / Default Title" placeholder). */
const singleVariantProduct = {
  id: 111,
  title: 'Roasted Coffee 1kg',
  body_html: '<p>Whole bean</p>',
  vendor: 'Acme Roasters',
  product_type: 'Coffee',
  handle: 'roasted-coffee-1kg',
  updated_at: '2026-07-10T12:00:00Z',
  options: [{ name: 'Title', values: ['Default Title'] }],
  images: [
    { src: 'https://cdn.shopify.com/s/files/1/coffee-a.jpg' },
    { src: 'https://cdn.shopify.com/s/files/1/coffee-b.jpg' },
  ],
  variants: [
    {
      id: 9001,
      price: '19.99',
      compare_at_price: '24.99',
      sku: 'COF-1KG',
      barcode: '0123456789012',
      inventory_quantity: 42,
      inventory_management: 'shopify',
      option1: 'Default Title',
      option2: null,
      option3: null,
    },
  ],
};

/** A Shopify product with real Size/Color options and two variants. */
const multiVariantProduct = {
  id: '222',
  title: 'Classic Tee',
  body_html: null,
  vendor: '',
  product_type: '',
  handle: 'classic-tee',
  updated_at: '2026-07-11T08:30:00Z',
  options: [
    { name: 'Size', values: ['S', 'M'] },
    { name: 'Color', values: ['Black'] },
  ],
  images: [{ src: 'https://cdn.shopify.com/s/files/1/tee.jpg' }],
  variants: [
    {
      id: 1,
      price: '1000.00',
      compare_at_price: null,
      sku: 'TEE-S-BLK',
      inventory_quantity: 5,
      inventory_management: 'shopify',
      option1: 'S',
      option2: 'Black',
      option3: null,
    },
    {
      id: 2,
      price: '1000.5',
      compare_at_price: null,
      inventory_quantity: -3,
      inventory_management: null,
      option1: 'M',
      option2: 'Black',
      option3: null,
    },
  ],
};

describe('normalizeShopifyProduct', () => {
  it('maps a single-variant product, stripping the Title/Default-Title placeholder', () => {
    const product = normalizeShopifyProduct(singleVariantProduct, 'USD');

    expect(product.externalId).toBe('111');
    expect(product.externalUpdatedAt).toEqual(new Date('2026-07-10T12:00:00Z'));
    expect(product.title).toBe('Roasted Coffee 1kg');
    expect(product.description).toBe('<p>Whole bean</p>');
    expect(product.vendor).toBe('Acme Roasters');
    expect(product.productType).toBe('Coffee');
    expect(product.handle).toBe('roasted-coffee-1kg');

    // Placeholder options are dropped → a single variant with no option values.
    expect(product.options).toEqual([]);
    const variants = variantsOf(singleVariantProduct);
    expect(variants).toHaveLength(1);
    expect(variants[0].optionValues).toEqual([]);

    // Native currency, integer minor units, exact decimal parse (19.99 → 1999).
    expect(variants[0].price).toEqual({ amount: 1999, currency: 'USD' });
    expect(variants[0].compareAtPrice).toEqual({ amount: 2499, currency: 'USD' });
    expect(variants[0].sku).toBe('COF-1KG');
    expect(variants[0].barcode).toBe('0123456789012');
    expect(variants[0].inventory).toEqual({ tracked: true, available: 42 });
  });

  it('passes absolute image URLs through verbatim (no re-upload)', () => {
    const product = normalizeShopifyProduct(singleVariantProduct, 'USD');
    expect(product.imageUrls).toEqual([
      'https://cdn.shopify.com/s/files/1/coffee-a.jpg',
      'https://cdn.shopify.com/s/files/1/coffee-b.jpg',
    ]);
  });

  it('prices in the shop currency, not FAIR', () => {
    const [variant] = variantsOf(singleVariantProduct, 'EUR');
    expect(variant.price.currency).toBe('EUR');
    expect(variant.price.amount).toBe(1999);
  });

  it('maps real options, pairs option1..3, clamps negative stock, honours tracking', () => {
    const product = normalizeShopifyProduct(multiVariantProduct, 'GBP');

    expect(product.externalId).toBe('222');
    expect(product.description).toBe('');
    expect(product.vendor).toBeUndefined();
    expect(product.productType).toBeUndefined();
    expect(product.options).toEqual([
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Color', values: ['Black'] },
    ]);

    const variants = variantsOf(multiVariantProduct, 'GBP');
    expect(variants[0].optionValues).toEqual([
      { name: 'Size', value: 'S' },
      { name: 'Color', value: 'Black' },
    ]);
    expect(variants[0].price).toEqual({ amount: 100000, currency: 'GBP' });
    expect(variants[0].inventory).toEqual({ tracked: true, available: 5 });

    // "1000.5" → 100050 minor units; untracked; negative stock clamped to 0.
    expect(variants[1].price).toEqual({ amount: 100050, currency: 'GBP' });
    expect(variants[1].inventory).toEqual({ tracked: false, available: 0 });
  });

  it('rounds sub-cent precision half-up and rejects malformed prices', () => {
    const rounded = variantsOf({
      ...singleVariantProduct,
      variants: [{ ...singleVariantProduct.variants[0], price: '19.999' }],
    });
    expect(rounded[0].price.amount).toBe(2000);

    expect(() =>
      normalizeShopifyProduct(
        { ...singleVariantProduct, variants: [{ ...singleVariantProduct.variants[0], price: 'not-a-price' }] },
        'USD',
      ),
    ).toThrow();
  });
});

/**
 * #221's timestamp refusal, on the Shopify side.
 *
 * Shopify publishes a full ISO-8601 instant, so the `Z`-appending trap that fired
 * on WooCommerce does not exist here — but the refusal does, because the failure
 * it prevents is a property of `new Date`, not of any one platform: unreadable
 * text yields an INVALID `Date` that behaves like a `Date` until drizzle maps it
 * to a `timestamptz` parameter and fails the whole product's import. A provider
 * that only guarded the platform it had been bitten by would leave the other
 * carrying the same defect.
 */
describe('normalizeShopifyProduct — provider timestamps (#221)', () => {
  it('reads a well-formed `updated_at`', () => {
    const product = normalizeShopifyProduct(singleVariantProduct, 'USD');
    expect(product.externalUpdatedAt).toEqual(new Date('2026-07-10T12:00:00Z'));
  });

  it('OMITS `externalUpdatedAt` for text that is not a timestamp', () => {
    const raw = { ...singleVariantProduct, updated_at: 'yesterday' };
    const product = normalizeShopifyProduct(raw, 'USD');

    // The product still imports — one unreadable timestamp must not cost it.
    // Read through `variantsOf` because #259 made `variants` a union: the
    // assertion is the same one, and it now also states that the enumeration is
    // COMPLETE, which is what "still imports" has meant since.
    expect(product.externalId).toBe('111');
    expect(variantsOf(raw)).toHaveLength(1);
    expect(product.externalUpdatedAt).toBeUndefined();
  });
});

describe('normalizeShopifyProduct — #259, the inline variant cap', () => {
  /** `count` distinct Shopify variants over one Size option. */
  function productWithVariants(count: number): unknown {
    return {
      ...multiVariantProduct,
      options: [{ name: 'Size', values: Array.from({ length: count }, (_, i) => `S${i}`) }],
      variants: Array.from({ length: count }, (_, i) => ({
        id: 90000 + i,
        price: '10.00',
        compare_at_price: null,
        sku: `SKU-${i}`,
        barcode: null,
        inventory_quantity: 1,
        inventory_management: 'shopify',
        option1: `S${i}`,
        option2: null,
        option3: null,
      })),
    };
  }

  it('reports a product AT the REST inline cap as an UNPROVEN enumeration', () => {
    // Shopify's `products` resource embeds at most 100 variants and this
    // connector reads no paged variant resource, so a product arriving with
    // exactly 100 may be carrying a PREFIX. Nothing else in the payload says so,
    // which is why the count itself has to be the signal: asserting completeness
    // here is how `convergeVariants` would unsell every variant past the
    // hundredth on the very next sync.
    const set = normalizeShopifyProduct(productWithVariants(100), 'USD').variants;
    expect(set.enumeration).toBe('incomplete');
    expect(set.enumeration === 'incomplete' && set.gap).toEqual({
      kind: 'pagination_unprovable',
      pagesRead: 1,
    });
  });

  it('reports a product BELOW the cap as complete — the positive control', () => {
    // Without this the case above would also pass on a provider that called
    // every product unprovable.
    expect(variantsOf(productWithVariants(99))).toHaveLength(99);
  });
});
