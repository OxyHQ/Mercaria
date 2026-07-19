/**
 * Unit tests for `normalizeWooCommerceProduct` — the PURE WooCommerce-JSON →
 * NormalizedProduct mapping. No network, no DB. Asserts: prices land in the shop's
 * NATIVE currency as integer minor units (decimal strings parsed without float
 * error), a simple product yields one option-less variant, a variable product's
 * embedded variations become variants with paired option values, sale prices map
 * to `compareAtPrice`, image URLs pass through verbatim, and stock/tracking map
 * from WooCommerce's `manage_stock`/`stock_quantity`.
 */

import { describe, it, expect } from 'vitest';
import { normalizeWooCommerceProduct } from '../index.js';

/** A WooCommerce simple product on sale (regular 24.99 → sale/effective 19.99). */
const simpleProduct = {
  id: 111,
  name: 'Roasted Coffee 1kg',
  slug: 'roasted-coffee-1kg',
  description: '<p>Whole bean</p>',
  type: 'simple',
  date_modified_gmt: '2026-07-10T12:00:00',
  sku: 'COF-1KG',
  price: '19.99',
  regular_price: '24.99',
  sale_price: '19.99',
  manage_stock: true,
  stock_quantity: 42,
  attributes: [{ name: 'Origin', variation: false, options: ['Colombia'] }],
  images: [
    { src: 'https://shop.example.com/wp-content/uploads/coffee-a.jpg' },
    { src: 'https://shop.example.com/wp-content/uploads/coffee-b.jpg' },
  ],
  categories: [{ id: 15 }, { id: 22 }],
};

/** A WooCommerce variable product with two variations over a Size option. */
const variableProduct = {
  id: '222',
  name: 'Classic Tee',
  slug: 'classic-tee',
  description: '',
  type: 'variable',
  date_modified_gmt: '2026-07-11T08:30:00',
  attributes: [
    { name: 'Size', variation: true, options: ['S', 'M'] },
    { name: 'Material', variation: false, options: ['Cotton'] },
  ],
  images: [{ src: 'https://shop.example.com/wp-content/uploads/tee.jpg' }],
  categories: [{ id: 7 }],
  expandedVariations: [
    {
      id: 3001,
      price: '1000.00',
      regular_price: '1000.00',
      sale_price: '',
      sku: 'TEE-S',
      manage_stock: true,
      stock_quantity: 5,
      attributes: [{ name: 'Size', option: 'S' }],
    },
    {
      id: 3002,
      price: '1000.5',
      regular_price: '1000.5',
      sale_price: '',
      manage_stock: false,
      stock_quantity: null,
      attributes: [{ name: 'Size', option: 'M' }],
    },
  ],
};

describe('normalizeWooCommerceProduct', () => {
  it('maps a simple product to a single option-less variant in the native currency', () => {
    const product = normalizeWooCommerceProduct(simpleProduct, 'USD');

    expect(product.externalId).toBe('111');
    expect(product.externalUpdatedAt).toEqual(new Date('2026-07-10T12:00:00Z'));
    expect(product.title).toBe('Roasted Coffee 1kg');
    expect(product.description).toBe('<p>Whole bean</p>');
    expect(product.handle).toBe('roasted-coffee-1kg');
    // A non-variation attribute is NOT a selectable option.
    expect(product.options).toEqual([]);
    expect(product.collectionRefs).toEqual(['15', '22']);

    expect(product.variants).toHaveLength(1);
    const variant = product.variants[0];
    expect(variant.optionValues).toEqual([]);
    // Native currency, integer minor units, exact decimal parse (19.99 → 1999).
    expect(variant.price).toEqual({ amount: 1999, currency: 'USD' });
    // On sale: compareAtPrice = regular (24.99 → 2499).
    expect(variant.compareAtPrice).toEqual({ amount: 2499, currency: 'USD' });
    expect(variant.sku).toBe('COF-1KG');
    expect(variant.externalVariantId).toBe('111');
    expect(variant.inventory).toEqual({ tracked: true, available: 42 });
  });

  it('passes absolute image URLs through verbatim (no re-upload)', () => {
    const product = normalizeWooCommerceProduct(simpleProduct, 'USD');
    expect(product.imageUrls).toEqual([
      'https://shop.example.com/wp-content/uploads/coffee-a.jpg',
      'https://shop.example.com/wp-content/uploads/coffee-b.jpg',
    ]);
  });

  it('prices in the shop currency, not FAIR', () => {
    const product = normalizeWooCommerceProduct(simpleProduct, 'EUR');
    expect(product.variants[0].price).toEqual({ amount: 1999, currency: 'EUR' });
  });

  it('maps a variable product: variations → variants with paired option values', () => {
    const product = normalizeWooCommerceProduct(variableProduct, 'GBP');

    expect(product.externalId).toBe('222');
    expect(product.description).toBe('');
    // Only the variation attribute becomes a selectable option.
    expect(product.options).toEqual([{ name: 'Size', values: ['S', 'M'] }]);
    expect(product.variants).toHaveLength(2);

    expect(product.variants[0].optionValues).toEqual([{ name: 'Size', value: 'S' }]);
    expect(product.variants[0].price).toEqual({ amount: 100000, currency: 'GBP' });
    expect(product.variants[0].compareAtPrice).toBeUndefined();
    expect(product.variants[0].sku).toBe('TEE-S');
    expect(product.variants[0].externalVariantId).toBe('3001');
    expect(product.variants[0].inventory).toEqual({ tracked: true, available: 5 });

    // "1000.5" → 100050 minor units; untracked variation → available 0.
    expect(product.variants[1].optionValues).toEqual([{ name: 'Size', value: 'M' }]);
    expect(product.variants[1].price).toEqual({ amount: 100050, currency: 'GBP' });
    expect(product.variants[1].inventory).toEqual({ tracked: false, available: 0 });
  });

  it('rounds sub-unit precision half-up and rejects malformed prices', () => {
    const rounded = normalizeWooCommerceProduct(
      { ...simpleProduct, price: '19.999', regular_price: '19.999', sale_price: '' },
      'USD',
    );
    expect(rounded.variants[0].price.amount).toBe(2000);

    expect(() =>
      normalizeWooCommerceProduct({ ...simpleProduct, price: 'not-a-price', sale_price: '' }, 'USD'),
    ).toThrow();
  });
});
