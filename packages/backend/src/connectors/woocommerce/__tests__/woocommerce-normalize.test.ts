/**
 * Unit tests for `normalizeWooCommerceProduct` — the PURE WooCommerce-JSON →
 * NormalizedProduct mapping. No network, no DB. Asserts: prices land in the shop's
 * NATIVE currency as integer minor units (decimal strings parsed without float
 * error), a simple product yields one option-less variant, a variable product's
 * embedded variations become variants with paired option values, sale prices map
 * to `compareAtPrice`, image URLs pass through verbatim, and stock/tracking map
 * from WooCommerce's `manage_stock`/`stock_quantity`.
 *
 * It also carries #220's structural refusal, which nothing else can measure: the
 * webhook path EXPANDS a payload before it reaches here, so with that expansion
 * in place the guard is unreachable end to end — and a guard whose removal fails
 * no test is a guard that gets tidied away. It exists for the day somebody
 * simplifies the expansion seam, so its test has to reach the pure function
 * directly.
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

/**
 * The same variable product exactly as a `product.updated` WEBHOOK delivers it:
 * `variations` as IDS, no variation objects, and the parent carrying the LOWEST
 * variation price with an empty `regular_price` — which is what WooCommerce
 * itself publishes for a variable parent.
 */
const unexpandedVariableProduct = {
  ...variableProduct,
  price: '1000.00',
  regular_price: '',
  sale_price: '',
  manage_stock: false,
  stock_quantity: null,
  variations: [3001, 3002],
  expandedVariations: undefined,
};

describe('normalizeWooCommerceProduct — #220, an incomplete payload is REFUSED', () => {
  it('refuses a payload declaring variations it does not carry', () => {
    // The measured shape from the issue: this used to produce ONE variant at
    // 1000.00 (the cheapest variation's price), with `optionValues: []` and
    // `available: 0`, beside an option axis declaring two values — and
    // `importProduct` could not add the missing variants afterwards, so the
    // listing stayed wrong until somebody deleted it.
    expect(() => normalizeWooCommerceProduct(unexpandedVariableProduct, 'USD')).toThrow(
      /declares 2 variations and carries none/,
    );
  });

  it('refuses an EXPANSION that came back empty, not only an absent one', () => {
    // `expandedVariations: []` is what a fetch that answered with nothing
    // produces. Reading it as "no variations" would collapse the product exactly
    // as an absent field does, so both spellings have to refuse.
    expect(() =>
      normalizeWooCommerceProduct(
        { ...unexpandedVariableProduct, expandedVariations: [] },
        'USD',
      ),
    ).toThrow(/declares 2 variations and carries none/);
  });

  it('ACCEPTS a product that declares no variations at all', () => {
    // The other side of the discriminant, and the reason the guard reads
    // `product.variations` rather than `type === 'variable'`: a product WooCommerce
    // publishes with an empty variation list is complete, and refusing it would
    // make a simple product unimportable.
    const product = normalizeWooCommerceProduct(simpleProduct, 'USD');
    expect(product.variants).toHaveLength(1);
  });

  it('ACCEPTS the same payload once its variations are expanded', () => {
    // The positive control on the refusal: if this threw too, the guard would be
    // refusing every variable product rather than the incomplete ones, and the
    // case above would pass for the wrong reason.
    const product = normalizeWooCommerceProduct(
      { ...unexpandedVariableProduct, expandedVariations: variableProduct.expandedVariations },
      'USD',
    );
    expect(product.variants).toHaveLength(2);
    expect(product.variants.map((variant) => variant.optionValues)).toEqual([
      [{ name: 'Size', value: 'S' }],
      [{ name: 'Size', value: 'M' }],
    ]);
  });
});

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

/**
 * #221's trigger, in the pure function where it originates.
 *
 * WooCommerce's `*_gmt` fields carry no zone, so the connector appends `Z`.
 * Appending it to a value that already carries one produced an INVALID `Date`,
 * which none of these assertions could distinguish from a real one — it only
 * announced itself two layers down, where drizzle threw mapping it to a
 * `timestamptz` parameter and failed that product's whole import.
 *
 * **Omitting the field is the LAST resort, not the first.** `buildSource`
 * writes `sourceExternalUpdatedAt: … ?? null`, so a field the normalizer
 * declines to read does not merely go missing from one sync — it ERASES the
 * stored freshness on every sync, and the newer-than comparison the column
 * exists for has nothing left to compare against. A zoned value is therefore
 * READ at its own offset, and only genuinely unreadable text is omitted.
 */
describe('normalizeWooCommerceProduct — provider timestamps (#221)', () => {
  it('reads a zone-less `date_modified_gmt` as UTC', () => {
    const product = normalizeWooCommerceProduct(
      { ...simpleProduct, date_modified_gmt: '2026-01-02T03:04:05' },
      'USD',
    );

    expect(product.externalUpdatedAt).toEqual(new Date('2026-01-02T03:04:05Z'));
  });

  it('READS a value that already carries a zone, at that zone', () => {
    // NOT omitted. `+02:00` names an unambiguous instant, and discarding it
    // would null the column on every later sync — the erasure the module header
    // describes. A zone inside a field named `_gmt` means a plugin or a proxy
    // rewrote the response, and the instant is still exactly stated.
    const product = normalizeWooCommerceProduct(
      { ...simpleProduct, date_modified_gmt: '2026-01-02T03:04:05+02:00' },
      'USD',
    );

    expect(product.externalUpdatedAt).toEqual(new Date('2026-01-02T01:04:05Z'));
  });

  it('READS an explicit `Z` without appending a second one', () => {
    const product = normalizeWooCommerceProduct(
      { ...simpleProduct, date_modified_gmt: '2026-01-02T03:04:05Z' },
      'USD',
    );

    expect(product.externalUpdatedAt).toEqual(new Date('2026-01-02T03:04:05Z'));
  });

  it('reads a bare DATE as UTC midnight', () => {
    // `2026-01-02` ends in `-02`, which a naive `/[+-]\d{2}$/` zone test reads as
    // a `-02` offset — the reason `ZONED_TIMESTAMP` is anchored to a preceding
    // `HH:MM`. Worth stating plainly: this assertion does NOT discriminate the
    // anchoring, because ECMAScript parses a date-only ISO string as UTC either
    // way, so both classifications land here. What it pins is the BEHAVIOUR —
    // that a bare date survives at all rather than being omitted — and the
    // discrimination is pinned by the zoned cases above, where a misclassified
    // value produces `…+02:00Z` and no date at all.
    const product = normalizeWooCommerceProduct(
      { ...simpleProduct, date_modified_gmt: '2026-01-02' },
      'USD',
    );

    expect(product.externalId).toBe('111');
    expect(product.externalUpdatedAt).toEqual(new Date('2026-01-02T00:00:00Z'));
  });

  it('OMITS `externalUpdatedAt` for text that is not a timestamp at all', () => {
    const product = normalizeWooCommerceProduct(
      { ...simpleProduct, date_modified_gmt: '0000-00-00 00:00:00' },
      'USD',
    );

    // The product still imports — one unreadable timestamp must not cost it.
    expect(product.externalId).toBe('111');
    expect(product.variants).toHaveLength(1);
    expect(product.externalUpdatedAt).toBeUndefined();
  });

  it('falls back to `date_created_gmt` when the product was never modified', () => {
    // The positive control on the fallback: without it, an unreadable
    // `date_modified_gmt` and a missing one would be indistinguishable, and the
    // omission case above would pass against a normalizer that had stopped
    // reading either field.
    const product = normalizeWooCommerceProduct(
      { ...simpleProduct, date_modified_gmt: null, date_created_gmt: '2026-01-02T03:04:05' },
      'USD',
    );

    expect(product.externalUpdatedAt).toEqual(new Date('2026-01-02T03:04:05Z'));
  });
});
