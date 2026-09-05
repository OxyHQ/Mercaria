/**
 * The composed document (#75 §"Rendered metadata") and the head it renders to.
 *
 * The load-bearing assertion is the first one: **a page the policy refused
 * carries NO structured data.** Structured data is an indexing signal, and
 * attaching one to a thin, suppressed or duplicate page asks for exactly the
 * outcome the policy exists to prevent. It is asserted over every route rather
 * than over one, so a route type added later cannot slip past it.
 */

import { describe, expect, it } from 'vitest';
import type { PublicRouteId, SeoIndexability, SeoVisibleFacts } from '@mercaria/shared-types';
import { PUBLIC_ROUTE_IDS } from '@mercaria/shared-types';
import {
  composeDocument,
  composeTitle,
  MAX_DESCRIPTION_CHARACTERS,
  MAX_TITLE_CHARACTERS,
  SITE_NAME,
} from '../document.js';
import { escapeHtml, escapeJsonLd, renderSeoHead } from '../head.js';
import { catalogueEntityFacts, merchantPageFacts } from '../visible-facts.js';

const ORIGIN = 'https://mercaria.co';
const INDEXABLE: SeoIndexability = { outcome: 'indexable' };
const REFUSED: SeoIndexability = { outcome: 'refused', reason: 'thin_content' };

function facts(overrides: Partial<SeoVisibleFacts> = {}): SeoVisibleFacts {
  return {
    title: 'iPhone 16 Pro',
    entityName: 'iPhone 16 Pro',
    description: 'The 2026 flagship, in titanium, with the best camera Apple has shipped.',
    imageUrls: ['https://cdn.example/a.jpg'],
    breadcrumbs: [{ name: 'Home', path: '/' }],
    brandName: 'Apple',
    gtins: [],
    offers: [],
    variantNames: [],
    ...overrides,
  };
}

function compose(routeId: PublicRouteId, indexability: SeoIndexability, overrides = {}) {
  return composeDocument({
    routeId,
    facts: facts(overrides),
    canonicalUrl: `${ORIGIN}/p/iphone-16-pro`,
    origin: ORIGIN,
    indexability,
  });
}

describe('a non-indexable document carries NO structured data', () => {
  it('holds for every public route', () => {
    let checked = 0;
    for (const routeId of PUBLIC_ROUTE_IDS) {
      const document = compose(routeId, REFUSED);
      expect(document.structuredData, `${routeId} emitted structured data while noindex`).toEqual(
        [],
      );
      expect(document.indexable).toBe(false);
      expect(document.robots).toBe('noindex,follow');
      checked += 1;
    }
    expect(checked).toBe(PUBLIC_ROUTE_IDS.length);
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it('and the head it renders carries no ld+json block', () => {
    const head = renderSeoHead(compose('canonical_product', REFUSED));
    expect(head).not.toContain('application/ld+json');
    expect(head).toContain('<meta name="robots" content="noindex,follow">');
  });
});

describe('which schema.org type each route emits', () => {
  const expected: Record<PublicRouteId, readonly string[]> = {
    home: ['WebSite', 'BreadcrumbList'],
    canonical_product: ['Product', 'BreadcrumbList'],
    legacy_listing: ['Product', 'BreadcrumbList'],
    brand: ['Brand', 'BreadcrumbList'],
    merchant: ['Organization', 'BreadcrumbList'],
    native_store: ['OnlineStore', 'BreadcrumbList'],
    product_family: ['BreadcrumbList'],
    seller: ['BreadcrumbList'],
    category_browse: ['BreadcrumbList'],
    // The same as its per-category sibling, and deliberately NOT `WebSite`:
    // that node says "this is the site", which is the home page's claim and is
    // emitted once. A hub that repeated it would give a crawler two answers to
    // one question.
    category_index: ['BreadcrumbList'],
    native_store_legacy: ['BreadcrumbList'],
  };

  it('is a closed decision with no default', () => {
    for (const routeId of PUBLIC_ROUTE_IDS) {
      const document = compose(routeId, INDEXABLE);
      expect(
        document.structuredData.map((node) => node['@type']),
        routeId,
      ).toEqual(expected[routeId]);
    }
  });
});

describe('the title', () => {
  it('suffixes the site name when it fits', () => {
    expect(composeTitle('iPhone 16 Pro')).toBe(`iPhone 16 Pro — ${SITE_NAME}`);
  });

  it('drops the SUFFIX rather than the name when it does not', () => {
    // Every result on this domain says Mercaria; what a shopper scanning
    // results needs is what the page is about.
    const long = 'A very long product name that runs past the limit a search engine will show';
    const title = composeTitle(long);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARACTERS);
    expect(title).not.toContain(SITE_NAME);
    expect(title.startsWith('A very long product name')).toBe(true);
  });

  it('collapses whitespace and falls back to the site name', () => {
    expect(composeTitle('  iPhone\n16  Pro ')).toBe(`iPhone 16 Pro — ${SITE_NAME}`);
    expect(composeTitle('   ')).toBe(SITE_NAME);
  });
});

describe('the description', () => {
  it('is absent when the page has nothing to summarise', () => {
    const base = facts();
    const { description: _dropped, ...rest } = base;
    const document = composeDocument({
      routeId: 'canonical_product',
      facts: rest as SeoVisibleFacts,
      canonicalUrl: `${ORIGIN}/p/x`,
      origin: ORIGIN,
      indexability: INDEXABLE,
    });
    expect(document.description).toBeUndefined();
    expect(renderSeoHead(document)).not.toContain('name="description"');
  });

  it('is clamped on a word boundary', () => {
    const document = compose('canonical_product', INDEXABLE, {
      description: `${'word '.repeat(80)}end`,
    });
    expect((document.description ?? '').length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARACTERS);
    expect(document.description).toMatch(/…$/u);
    expect(document.description).not.toMatch(/wor…$/u);
  });
});

describe('sharing metadata', () => {
  it('is a product on the two product routes and a website elsewhere', () => {
    expect(compose('canonical_product', INDEXABLE).sharing.type).toBe('product');
    expect(compose('legacy_listing', INDEXABLE).sharing.type).toBe('product');
    expect(compose('native_store', INDEXABLE).sharing.type).toBe('website');
    expect(compose('home', INDEXABLE).sharing.type).toBe('website');
  });

  it('downgrades the twitter card when the page shows no image', () => {
    const withImage = renderSeoHead(compose('canonical_product', INDEXABLE));
    expect(withImage).toContain('content="summary_large_image"');
    const without = renderSeoHead(compose('canonical_product', INDEXABLE, { imageUrls: [] }));
    expect(without).toContain('content="summary"');
    expect(without).not.toContain('og:image');
  });
});

describe('locale alternates', () => {
  it('are EMPTY, because Mercaria publishes one locale and no localized route', () => {
    // #75 rendered-metadata rule 3 asks for alternates "when real localized
    // content exists". Emitting a self-referential alternate for a locale
    // nobody translated is the failure that rule is written against.
    for (const routeId of PUBLIC_ROUTE_IDS) {
      expect(compose(routeId, INDEXABLE).localeAlternates).toEqual([]);
    }
    expect(renderSeoHead(compose('canonical_product', INDEXABLE))).not.toContain('hreflang');
  });
});

describe('the rendered head', () => {
  it('carries exactly one title, description, robots and canonical link', () => {
    const head = renderSeoHead(compose('canonical_product', INDEXABLE));
    const count = (pattern: RegExp): number => (head.match(pattern) ?? []).length;
    expect(count(/<title>/gu)).toBe(1);
    expect(count(/name="description"/gu)).toBe(1);
    expect(count(/name="robots"/gu)).toBe(1);
    expect(count(/rel="canonical"/gu)).toBe(1);
  });

  it('contains no script other than the structured-data blocks', () => {
    const head = renderSeoHead(compose('canonical_product', INDEXABLE));
    const scripts = head.match(/<script[^>]*>/gu) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain('type="application/ld+json"');
  });

  it('is stable in order across two renders of one document', () => {
    const document = compose('canonical_product', INDEXABLE);
    expect(renderSeoHead(document)).toBe(renderSeoHead(document));
  });
});

describe('escaping', () => {
  it('escapes an attribute value that would close the tag', () => {
    expect(escapeHtml('" onload="alert(1)')).toBe('&quot; onload=&quot;alert(1)');
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('a hostile product name cannot break out of the head', () => {
    const head = renderSeoHead(
      compose('canonical_product', INDEXABLE, {
        title: '"><script>alert(1)</script>',
        entityName: '"><script>alert(1)</script>',
        description: '</title><script>alert(2)</script>',
      }),
    );
    expect(head).not.toContain('<script>alert(1)</script>');
    expect(head).not.toContain('<script>alert(2)</script>');
    expect(head).toContain('&lt;script&gt;');
  });

  it('neutralises `<` inside JSON-LD rather than escaping the JSON', () => {
    // A description containing `</script>` would otherwise close the block and
    // turn the rest of the payload into markup.
    const serialized = escapeJsonLd({ name: 'a</script><img src=x onerror=alert(1)>' });
    // `<` is the only character an HTML parser can start a tag with, so it is
    // the only one neutralised — `>` stays, and the JSON stays valid.
    expect(serialized).not.toContain('<');
    expect(serialized).toContain('\\u003c/script>');
    expect(JSON.parse(serialized)).toEqual({ name: 'a</script><img src=x onerror=alert(1)>' });
  });

  it('a hostile description cannot escape the ld+json block', () => {
    const head = renderSeoHead(
      compose('canonical_product', INDEXABLE, {
        description: 'nice phone</script><script>alert(1)</script>',
      }),
    );
    const scripts = head.match(/<script[^>]*>/gu) ?? [];
    for (const tag of scripts) expect(tag).toContain('application/ld+json');
    expect(head).not.toContain('<script>alert(1)</script>');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* The merchant page (#73 landed; the registry gate forced the flip)          */
/* ────────────────────────────────────────────────────────────────────────── */

describe('a merchant page', () => {
  const facts = merchantPageFacts({
    slug: 'acme-electronics',
    name: 'Acme Electronics',
    description: 'A long-standing electronics retailer selling across the EU.',
    rating: 4.4,
    ratingCount: 87,
  });

  it('shows a name, a description and a trail — and no image', () => {
    // A `Merchant` row carries no logo, so there is nothing to show. #55's
    // verified relationships are what put a mark on a page.
    expect(facts.entityName).toBe('Acme Electronics');
    expect(facts.imageUrls).toEqual([]);
    expect(facts.breadcrumbs).toEqual([
      { name: 'Home', path: '/' },
      { name: 'Acme Electronics', path: '/merchants/acme-electronics' },
    ]);
  });

  it('carries NO offers — a shopper buys on the product page', () => {
    expect(facts.offers).toEqual([]);
    expect(facts.offerCurrency).toBeUndefined();
  });

  it('emits an Organization node and no Product', () => {
    const document = composeDocument({
      routeId: 'merchant',
      facts,
      canonicalUrl: `${ORIGIN}/merchants/acme-electronics`,
      origin: ORIGIN,
      indexability: INDEXABLE,
    });
    const types = document.structuredData.map((node) => node['@type']);
    expect(types).toEqual(['Organization', 'BreadcrumbList']);
    const organization = document.structuredData[0] ?? {};
    expect(organization.name).toBe('Acme Electronics');
    expect(organization.url).toBe(`${ORIGIN}/merchants/acme-electronics`);
    expect(organization.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.4,
      reviewCount: 87,
    });
    expect(organization.offers).toBeUndefined();
    expect(document.sharing.type).toBe('website');
  });

  it('omits a rating nobody has given', () => {
    const unrated = merchantPageFacts({
      slug: 'new-shop',
      name: 'New Shop',
      description: null,
      rating: 0,
      ratingCount: 0,
    });
    expect(unrated.rating).toBeUndefined();
    expect(unrated.description).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Brand and family pages (#72's screens, served by #256)                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe('a brand page', () => {
  const facts = catalogueEntityFacts({
    routeId: 'brand',
    slug: 'apple',
    name: 'Apple',
    description: 'Consumer electronics designed in California.',
    logoFileId: 'file-apple-logo',
  });

  it('shows its mark, its name and a trail to itself', () => {
    expect(facts.entityName).toBe('Apple');
    expect(facts.imageUrls).toHaveLength(1);
    expect(facts.breadcrumbs).toEqual([
      { name: 'Home', path: '/' },
      { name: 'Apple', path: '/brands/apple' },
    ]);
  });

  it('carries no offers and no identifiers — it is not about acquiring a thing', () => {
    expect(facts.offers).toEqual([]);
    expect(facts.gtins).toEqual([]);
    expect(facts.offerCurrency).toBeUndefined();
  });

  it('emits a Brand node', () => {
    const document = composeDocument({
      routeId: 'brand',
      facts,
      canonicalUrl: `${ORIGIN}/brands/apple`,
      origin: ORIGIN,
      indexability: INDEXABLE,
    });
    expect(document.structuredData.map((node) => node['@type'])).toEqual([
      'Brand',
      'BreadcrumbList',
    ]);
    const brand = document.structuredData[0] ?? {};
    expect(brand.name).toBe('Apple');
    expect(brand.url).toBe(`${ORIGIN}/brands/apple`);
    expect(brand.offers).toBeUndefined();
  });
});

describe('a product-family page', () => {
  const facts = catalogueEntityFacts({
    routeId: 'product_family',
    slug: 'iphone',
    name: 'iPhone',
    description: undefined,
    logoFileId: undefined,
  });

  it('has no mark of its own and says so by omission', () => {
    expect(facts.imageUrls).toEqual([]);
    expect(facts.description).toBeUndefined();
    expect(facts.breadcrumbs[1]).toEqual({ name: 'iPhone', path: '/families/iphone' });
  });

  it('emits only a breadcrumb trail — schema.org has no honest node for a line', () => {
    const document = composeDocument({
      routeId: 'product_family',
      facts,
      canonicalUrl: `${ORIGIN}/families/iphone`,
      origin: ORIGIN,
      indexability: INDEXABLE,
    });
    expect(document.structuredData.map((node) => node['@type'])).toEqual(['BreadcrumbList']);
  });

  it('carries NO structured data at all when the policy refuses it', () => {
    const document = composeDocument({
      routeId: 'product_family',
      facts,
      canonicalUrl: `${ORIGIN}/families/iphone`,
      origin: ORIGIN,
      indexability: { outcome: 'refused', reason: 'thin_content' },
    });
    expect(document.structuredData).toEqual([]);
    expect(document.robots).toBe('noindex,follow');
  });
});
