/**
 * Unit tests for `normalizeShopifyProduct` — the PURE Shopify-JSON → NormalizedProduct
 * mapping. No network, no DB. Asserts: prices land in the shop's NATIVE currency
 * as integer minor units (string decimals parsed without float error), image URLs
 * pass through verbatim (Mercaria's media chokepoint keeps absolute URLs), the
 * single-variant "Title / Default Title" placeholder is stripped, and multi-option
 * variants pair option names with `option1..3`.
 */

import { describe, it, expect } from 'vitest';
import { normalizeShopifyProduct } from '../index.js';

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
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0].optionValues).toEqual([]);

    // Native currency, integer minor units, exact decimal parse (19.99 → 1999).
    expect(product.variants[0].price).toEqual({ amount: 1999, currency: 'USD' });
    expect(product.variants[0].compareAtPrice).toEqual({ amount: 2499, currency: 'USD' });
    expect(product.variants[0].sku).toBe('COF-1KG');
    expect(product.variants[0].barcode).toBe('0123456789012');
    expect(product.variants[0].inventory).toEqual({ tracked: true, available: 42 });
  });

  it('passes absolute image URLs through verbatim (no re-upload)', () => {
    const product = normalizeShopifyProduct(singleVariantProduct, 'USD');
    expect(product.imageUrls).toEqual([
      'https://cdn.shopify.com/s/files/1/coffee-a.jpg',
      'https://cdn.shopify.com/s/files/1/coffee-b.jpg',
    ]);
  });

  it('prices in the shop currency, not FAIR', () => {
    const product = normalizeShopifyProduct(singleVariantProduct, 'EUR');
    expect(product.variants[0].price.currency).toBe('EUR');
    expect(product.variants[0].price.amount).toBe(1999);
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

    expect(product.variants[0].optionValues).toEqual([
      { name: 'Size', value: 'S' },
      { name: 'Color', value: 'Black' },
    ]);
    expect(product.variants[0].price).toEqual({ amount: 100000, currency: 'GBP' });
    expect(product.variants[0].inventory).toEqual({ tracked: true, available: 5 });

    // "1000.5" → 100050 minor units; untracked; negative stock clamped to 0.
    expect(product.variants[1].price).toEqual({ amount: 100050, currency: 'GBP' });
    expect(product.variants[1].inventory).toEqual({ tracked: false, available: 0 });
  });

  it('rounds sub-cent precision half-up and rejects malformed prices', () => {
    const rounded = normalizeShopifyProduct(
      { ...singleVariantProduct, variants: [{ ...singleVariantProduct.variants[0], price: '19.999' }] },
      'USD',
    );
    expect(rounded.variants[0].price.amount).toBe(2000);

    expect(() =>
      normalizeShopifyProduct(
        { ...singleVariantProduct, variants: [{ ...singleVariantProduct.variants[0], price: 'not-a-price' }] },
        'USD',
      ),
    ).toThrow();
  });
});
