/**
 * JSON-LD shape and VISIBLE-FACT PARITY (#75 validation rule 1).
 *
 * Two kinds of assertion, and the second is the one that matters:
 *
 *  1. **Shape** — the nodes carry the properties schema.org and Google's
 *     product-snippet guidance expect, and no property whose value Mercaria
 *     does not actually hold.
 *  2. **Parity** — every scalar LEAF in the emitted graph is walked back to
 *     the {@link SeoVisibleFacts} value it came from. A property invented
 *     anywhere in the emitter fails this even if nobody wrote a case for it,
 *     which is what makes it a gate rather than a checklist. It carries a
 *     mutation self-test: an emitter that invents a value must turn it red.
 *
 * The third property has no test of its own because it is a TYPE:
 * `SeoOfferCheckout`'s external branch has no `url`, so there is nothing an
 * emitter could put in `offers.url` for an offer whose checkout happens
 * elsewhere. What IS tested is that the emitted node reflects it.
 */

import { describe, expect, it } from 'vitest';
import type { SeoJsonLdValue, SeoVisibleFacts, SeoVisibleOffer } from '@mercaria/shared-types';
import {
  breadcrumbNode,
  formatSchemaPrice,
  organizationNode,
  productNode,
  webSiteNode,
} from '../structured-data.js';

const ORIGIN = 'https://mercaria.co';

const NATIVE_OFFER: SeoVisibleOffer = {
  offerId: 'offer-native',
  checkout: { kind: 'mercaria', url: '/p/iphone-16-pro?variant=cv-1' },
  price: { known: true, amount: 129_900, currency: 'EUR' },
  availability: { known: true, schema: 'https://schema.org/InStock' },
  sellerName: 'Acme Electronics',
  conditionKey: 'new',
};

const EXTERNAL_OFFER: SeoVisibleOffer = {
  offerId: 'offer-external',
  checkout: { kind: 'external', host: 'shop.example.com' },
  price: { known: true, amount: 139_900, currency: 'EUR' },
  availability: { known: true, schema: 'https://schema.org/InStock' },
  sellerName: 'Example Retail',
  conditionKey: 'new',
};

function facts(overrides: Partial<SeoVisibleFacts> = {}): SeoVisibleFacts {
  return {
    title: 'iPhone 16 Pro',
    entityName: 'iPhone 16 Pro',
    description: 'The 2026 flagship, in titanium.',
    imageUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    breadcrumbs: [
      { name: 'Home', path: '/' },
      { name: 'iPhone 16 Pro', path: '/p/iphone-16-pro' },
    ],
    brandName: 'Apple',
    gtins: ['00190199000000'],
    mpn: 'A3102',
    rating: { value: 4.6, count: 231 },
    offers: [NATIVE_OFFER, EXTERNAL_OFFER],
    offerCurrency: 'EUR',
    variantNames: ['256 GB, Black Titanium'],
    ...overrides,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Parity                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Every value the page displays, as strings, plus the derived forms an emitter
 * legitimately produces from them.
 *
 * A price is a decimal string built from minor units, a rating is a number, a
 * path becomes an absolute URL — each is a FORMATTING of a visible fact, and
 * the derivation is stated here so the walk below can recognise it.
 */
function visibleValues(input: SeoVisibleFacts, canonicalUrl: string): Set<string> {
  const values = new Set<string>();
  const add = (value: string | number | undefined): void => {
    if (value === undefined) return;
    values.add(String(value));
  };

  add(input.entityName);
  add(input.description);
  add(input.brandName);
  add(input.mpn);
  add(canonicalUrl);
  for (const url of input.imageUrls) add(url);
  for (const gtin of input.gtins) add(gtin);
  for (const name of input.variantNames) add(name);
  for (const crumb of input.breadcrumbs) {
    add(crumb.name);
    add(new URL(crumb.path, ORIGIN).toString());
  }
  if (input.rating) {
    add(input.rating.value);
    add(input.rating.count);
  }

  const priced: number[] = [];
  for (const offer of input.offers) {
    add(offer.sellerName);
    if (offer.checkout.kind === 'mercaria') add(offer.checkout.url);
    else add(`https://${offer.checkout.host}`);
    if (offer.availability.known) add(offer.availability.schema);
    if (offer.price.known && input.offerCurrency !== undefined) {
      add(formatSchemaPrice(offer.price.amount, input.offerCurrency));
      add(input.offerCurrency);
      priced.push(offer.price.amount);
    }
  }
  if (priced.length > 0 && input.offerCurrency !== undefined) {
    add(formatSchemaPrice(Math.min(...priced), input.offerCurrency));
    add(formatSchemaPrice(Math.max(...priced), input.offerCurrency));
    add(priced.length);
  }
  return values;
}

/**
 * The vocabulary an emitter contributes — schema.org type names, property
 * names, the context, and the ordinals a `BreadcrumbList` needs.
 *
 * Everything NOT in here and not in {@link visibleValues} is a fact the emitter
 * invented, which is exactly what parity forbids.
 */
const VOCABULARY = new Set<string>([
  'https://schema.org',
  'Product',
  'Offer',
  'AggregateOffer',
  'Organization',
  'OnlineStore',
  'Brand',
  'AggregateRating',
  'BreadcrumbList',
  'ListItem',
  'PropertyValue',
  'WebSite',
  'Configuration',
  'https://schema.org/NewCondition',
  'https://schema.org/RefurbishedCondition',
  'https://schema.org/UsedCondition',
  'https://schema.org/DamagedCondition',
]);

/** Walk a JSON-LD value and collect every scalar leaf that is not a key. */
function leaves(value: SeoJsonLdValue, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) leaves(entry, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) leaves(entry, into);
    return into;
  }
  into.push(String(value));
  return into;
}

describe('PARITY: every emitted leaf is a fact the page displays', () => {
  it('holds for a full product page', () => {
    const input = facts();
    const canonicalUrl = 'https://mercaria.co/p/iphone-16-pro';
    const visible = visibleValues(input, canonicalUrl);
    const node = productNode(input, canonicalUrl);

    const emitted = leaves(node);
    expect(emitted.length, 'the walk found no leaves').toBeGreaterThan(15);

    for (const leaf of emitted) {
      const ok = visible.has(leaf) || VOCABULARY.has(leaf) || /^\d+$/u.test(leaf);
      expect(ok, `'${leaf}' is emitted but is not a fact the page displays`).toBe(true);
    }
  });

  it('the parity walk actually detects — the mutation self-test', () => {
    const input = facts();
    const canonicalUrl = 'https://mercaria.co/p/iphone-16-pro';
    const visible = visibleValues(input, canonicalUrl);
    // What an emitter inventing a fact would look like: a value present in the
    // graph and in neither the page nor the vocabulary.
    const mutated = { ...productNode(input, canonicalUrl), award: 'Best phone 2026' };
    const offending = leaves(mutated).filter(
      (leaf) => !visible.has(leaf) && !VOCABULARY.has(leaf) && !/^\d+$/u.test(leaf),
    );
    expect(offending).toEqual(['Best phone 2026']);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Where checkout happens                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe('an external offer is never marked purchasable on Mercaria', () => {
  it('carries no `url` and names its own host instead', () => {
    const node = productNode(facts({ offers: [EXTERNAL_OFFER] }), ORIGIN);
    const offer = node.offers as Record<string, SeoJsonLdValue>;
    expect(offer['@type']).toBe('Offer');
    expect(offer.url).toBeUndefined();
    expect(offer.availableAtOrFrom).toEqual({
      '@type': 'Organization',
      url: 'https://shop.example.com',
    });
  });

  it('a native offer DOES carry the Mercaria address', () => {
    const node = productNode(facts({ offers: [NATIVE_OFFER] }), ORIGIN);
    const offer = node.offers as Record<string, SeoJsonLdValue>;
    expect(offer.url).toBe('/p/iphone-16-pro?variant=cv-1');
    expect(offer.availableAtOrFrom).toBeUndefined();
  });

  it('no offer node in a mixed page carries a Mercaria url it should not', () => {
    const node = productNode(facts(), ORIGIN);
    const aggregate = node.offers as Record<string, SeoJsonLdValue>;
    const rows = aggregate.offers as Record<string, SeoJsonLdValue>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.url).toBe('/p/iphone-16-pro?variant=cv-1');
    expect(rows[1]?.url).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Unknown emits nothing                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

describe('unknown emits NOTHING', () => {
  it('an unpriced offer carries no price and is out of the aggregate bounds', () => {
    const unpriced: SeoVisibleOffer = {
      offerId: 'offer-unpriced',
      checkout: { kind: 'external', host: 'shop.example.com' },
      price: { known: false },
      availability: { known: true, schema: 'https://schema.org/InStock' },
    };
    const node = productNode(facts({ offers: [NATIVE_OFFER, unpriced] }), ORIGIN);
    const aggregate = node.offers as Record<string, SeoJsonLdValue>;
    const rows = aggregate.offers as Record<string, SeoJsonLdValue>[];

    expect(rows[1]?.price).toBeUndefined();
    expect(rows[1]?.priceCurrency).toBeUndefined();
    // One priced offer, so the bounds are that one and the count is one.
    expect(aggregate.lowPrice).toBe('1299.00');
    expect(aggregate.highPrice).toBe('1299.00');
    expect(aggregate.offerCount).toBe(1);
  });

  it('an aggregate with NO priced offer carries no bounds at all', () => {
    const unpriced: SeoVisibleOffer = {
      offerId: 'a',
      checkout: { kind: 'external', host: 'a.example' },
      price: { known: false },
      availability: { known: false },
    };
    const node = productNode(
      facts({ offers: [unpriced, { ...unpriced, offerId: 'b' }] }),
      ORIGIN,
    );
    const aggregate = node.offers as Record<string, SeoJsonLdValue>;
    expect(aggregate.lowPrice).toBeUndefined();
    expect(aggregate.highPrice).toBeUndefined();
    expect(aggregate.offerCount).toBeUndefined();
    expect(aggregate.priceCurrency).toBe('EUR');
  });

  it('an offer whose stock nobody published carries no availability', () => {
    const node = productNode(
      facts({ offers: [{ ...NATIVE_OFFER, availability: { known: false } }] }),
      ORIGIN,
    );
    const offer = node.offers as Record<string, SeoJsonLdValue>;
    expect(offer.availability).toBeUndefined();
  });

  it('a page with no offers emits no `offers` property', () => {
    const node = productNode(facts({ offers: [], offerCurrency: undefined }), ORIGIN);
    expect(node.offers).toBeUndefined();
  });

  it('a rating with a zero count is not emitted', () => {
    const node = productNode(facts({ rating: { value: 0, count: 0 } }), ORIGIN);
    expect(node.aggregateRating).toBeUndefined();
  });

  it('an absent brand, mpn or identifier emits nothing', () => {
    const base = facts();
    const { brandName: _b, mpn: _m, description: _d, ...rest } = base;
    const node = productNode({ ...(rest as SeoVisibleFacts), gtins: [] }, ORIGIN);
    expect(node.brand).toBeUndefined();
    expect(node.mpn).toBeUndefined();
    expect(node.gtin).toBeUndefined();
    expect(node.description).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Shape                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

describe('the Product node', () => {
  it('carries the properties a product snippet is built from', () => {
    const node = productNode(facts(), 'https://mercaria.co/p/iphone-16-pro');
    expect(node['@context']).toBe('https://schema.org');
    expect(node['@type']).toBe('Product');
    expect(node.name).toBe('iPhone 16 Pro');
    expect(node.url).toBe('https://mercaria.co/p/iphone-16-pro');
    expect(node.image).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
    expect(node.brand).toEqual({ '@type': 'Brand', name: 'Apple' });
    expect(node.gtin).toEqual(['00190199000000']);
    expect(node.mpn).toBe('A3102');
    expect(node.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.6,
      reviewCount: 231,
    });
  });

  it('maps every condition key to a schema.org value', () => {
    const conditions: Record<string, string> = {
      new: 'https://schema.org/NewCondition',
      open_box: 'https://schema.org/NewCondition',
      refurbished_manufacturer: 'https://schema.org/RefurbishedCondition',
      refurbished_seller: 'https://schema.org/RefurbishedCondition',
      used_like_new: 'https://schema.org/UsedCondition',
      used_good: 'https://schema.org/UsedCondition',
      used_fair: 'https://schema.org/UsedCondition',
      used_poor: 'https://schema.org/UsedCondition',
      for_parts: 'https://schema.org/DamagedCondition',
    };
    for (const [key, expected] of Object.entries(conditions)) {
      const node = productNode(
        facts({ offers: [{ ...NATIVE_OFFER, conditionKey: key }] }),
        ORIGIN,
      );
      const offer = node.offers as Record<string, SeoJsonLdValue>;
      expect(offer.itemCondition, key).toBe(expected);
    }
  });

  it('emits no condition for a key schema.org cannot express', () => {
    const node = productNode(
      facts({ offers: [{ ...NATIVE_OFFER, conditionKey: 'unknown' }] }),
      ORIGIN,
    );
    const offer = node.offers as Record<string, SeoJsonLdValue>;
    expect(offer.itemCondition).toBeUndefined();
  });
});

describe('price formatting', () => {
  it('formats through the currency’s own precision', () => {
    expect(formatSchemaPrice(129_900, 'EUR')).toBe('1299.00');
    expect(formatSchemaPrice(5, 'EUR')).toBe('0.05');
    expect(formatSchemaPrice(0, 'EUR')).toBe('0.00');
    // JPY has no minor unit.
    expect(formatSchemaPrice(1200, 'JPY')).toBe('1200');
    // FAIR has eight, and a float division would lose them.
    expect(formatSchemaPrice(100_000_001, 'FAIR')).toBe('1.00000001');
  });
});

describe('the Organization nodes', () => {
  it('emits a Brand, an Organization and an OnlineStore from one builder', () => {
    const input = facts({ imageUrls: ['https://cdn.example/logo.png'] });
    expect(organizationNode('Brand', input, ORIGIN)['@type']).toBe('Brand');
    expect(organizationNode('Organization', input, ORIGIN)['@type']).toBe('Organization');
    const store = organizationNode('OnlineStore', input, ORIGIN);
    expect(store['@type']).toBe('OnlineStore');
    expect(store.logo).toBe('https://cdn.example/logo.png');
  });

  it('emits no logo when the page shows no image', () => {
    expect(organizationNode('Brand', facts({ imageUrls: [] }), ORIGIN).logo).toBeUndefined();
  });
});

describe('the BreadcrumbList', () => {
  it('numbers the trail from one and absolutizes each item', () => {
    expect(breadcrumbNode(facts(), ORIGIN)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://mercaria.co/' },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'iPhone 16 Pro',
          item: 'https://mercaria.co/p/iphone-16-pro',
        },
      ],
    });
  });

  it('emits nothing when the page renders no trail', () => {
    expect(breadcrumbNode(facts({ breadcrumbs: [] }), ORIGIN)).toBeUndefined();
  });
});

describe('the WebSite node', () => {
  it('names the site and its root', () => {
    expect(webSiteNode('Mercaria', ORIGIN)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Mercaria',
      url: 'https://mercaria.co/',
    });
  });
});
