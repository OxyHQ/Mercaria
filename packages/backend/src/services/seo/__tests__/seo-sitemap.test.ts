/**
 * Sitemap membership and rendering (#75 §"Sitemaps and crawling").
 *
 * The load-bearing property is the FIRST one: **membership is the indexability
 * policy, called** — not a second predicate that happens to agree with it. Two
 * implementations would eventually disagree, and the symptom (a sitemap
 * advertising `noindex` pages) is invisible without a crawler to report it.
 * So the test drives rows through `sitemapEntriesFor` and asserts the kept set
 * is exactly the set `decideIndexability` accepts, over the same inputs.
 */

import { describe, expect, it } from 'vitest';
import type { SeoSitemapCandidateRow } from '../../../db/seo/seoRepository.js';
import { decideIndexability, MIN_DESCRIPTION_CHARACTERS } from '../indexability.js';
import {
  isSitemapCollection,
  renderSitemapIndex,
  renderUrlset,
  sitemapEntriesFor,
  sitemapPageCount,
  sitemapPagePath,
} from '../sitemap.js';

const ORIGIN = 'https://mercaria.co';
const LASTMOD = new Date('2026-08-01T10:00:00.000Z');

function productRow(overrides: Partial<SeoSitemapCandidateRow> = {}): SeoSitemapCandidateRow {
  return {
    id: 'prod-1',
    slug: 'iphone-16-pro',
    name: 'iPhone 16 Pro',
    status: 'active',
    categoryId: 'cat-phones',
    lastmod: LASTMOD,
    indexRightGranted: true,
    descriptionLength: MIN_DESCRIPTION_CHARACTERS,
    imageCount: 2,
    identifierCount: 1,
    catalogueEntryCount: 0,
    ...overrides,
  };
}

function brandRow(overrides: Partial<SeoSitemapCandidateRow> = {}): SeoSitemapCandidateRow {
  return {
    id: 'brand-1',
    slug: 'apple',
    name: 'Apple',
    status: 'active',
    categoryId: null,
    lastmod: LASTMOD,
    indexRightGranted: true,
    descriptionLength: 0,
    imageCount: 1,
    identifierCount: 0,
    catalogueEntryCount: 12,
    ...overrides,
  };
}

/**
 * The lever, as a parameter.
 *
 * `sitemapEntriesFor` takes the permission rather than reading `config`, which
 * is what lets one file drive every lever state — `config/index.ts` FREEZES at
 * module load, so an on-state and an off-state cannot otherwise share a
 * process (the `guest-rollout.test.ts` note).
 */
const INDEXING_ON = () => true;
const INDEXING_OFF = () => false;
const CANARY = (categories: readonly string[]) => (categoryId: string | null) =>
  categoryId !== null && categories.includes(categoryId);

describe('membership IS indexability', () => {
  it('keeps a row the policy accepts', () => {
    const entries = sitemapEntriesFor('products', [productRow()], ORIGIN, INDEXING_ON);
    expect(entries).toEqual([
      { loc: 'https://mercaria.co/p/iphone-16-pro', lastmod: LASTMOD.toISOString() },
    ]);
  });

  const refusals: readonly [string, Partial<SeoSitemapCandidateRow>][] = [
    ['merged', { status: 'merged' }],
    ['suppressed', { status: 'suppressed' }],
    ['draft', { status: 'draft' }],
    ['discontinued', { status: 'discontinued' }],
    ['a source that withholds the index right', { indexRightGranted: false }],
    ['thin content', { descriptionLength: 0, imageCount: 0, identifierCount: 0 }],
  ];

  it.each(refusals)('drops a row the policy refuses: %s', (_label, overrides) => {
    expect(sitemapEntriesFor('products', [productRow(overrides)], ORIGIN, INDEXING_ON)).toEqual([]);
  });

  it('agrees with the policy row by row, over a mixed batch', () => {
    const rows = [
      productRow({ id: 'a', slug: 'a' }),
      productRow({ id: 'b', slug: 'b', status: 'merged' }),
      productRow({ id: 'c', slug: 'c', indexRightGranted: false }),
      productRow({ id: 'd', slug: 'd' }),
      productRow({ id: 'e', slug: 'e', descriptionLength: 0, imageCount: 0, identifierCount: 0 }),
    ];
    const kept = sitemapEntriesFor('products', rows, ORIGIN, INDEXING_ON).map((entry) => entry.loc);

    // The same question, asked of the policy directly.
    const expected = rows
      .filter(
        (row) =>
          decideIndexability({
            routeAvailability: 'live',
            indexingPermitted: true,
            identity: row.status === 'merged' ? 'merged' : 'canonical',
            moderation: row.status === 'active' || row.status === 'merged' ? 'clear' : 'suppressed',
            sourceIndexRight: row.indexRightGranted ? 'granted' : 'withheld',
            content:
              row.descriptionLength >= MIN_DESCRIPTION_CHARACTERS ||
              (row.imageCount > 0 && row.identifierCount > 0)
                ? 'sufficient'
                : 'thin',
            offerInformation: 'historical',
            locale: 'complete',
            filterUniqueness: 'not_a_filter_page',
          }).outcome === 'indexable',
      )
      .map((row) => `https://mercaria.co/p/${row.slug}`);

    expect(kept).toEqual(expected);
    expect(kept.length).toBe(2);
  });
});

describe('a catalogue page is judged by its catalogue', () => {
  it('keeps a MERCHANT with a catalogue and no description of its own', () => {
    // #73 shipped `/merchants/:handle`, so this collection now emits URLs and
    // the content rule is exercised against a live route rather than argued
    // about in the abstract.
    expect(sitemapEntriesFor('merchants', [brandRow({ slug: 'acme' })], ORIGIN, INDEXING_ON)).toEqual([
      { loc: 'https://mercaria.co/merchants/acme', lastmod: LASTMOD.toISOString() },
    ]);
  });

  it('drops a merchant whose catalogue is too small to be its own result', () => {
    // One entry duplicates that entry's own page; two is a list.
    expect(
      sitemapEntriesFor(
        'merchants',
        [brandRow({ slug: 'solo', catalogueEntryCount: 1 })],
        ORIGIN,
        INDEXING_ON,
      ),
    ).toEqual([]);
  });

  it('keeps a BRAND with a catalogue and no description of its own', () => {
    // #72 shipped `/brands/:handle`, so this collection now emits URLs too —
    // the merchants precedent above, for a brand page whose content is its
    // product list rather than a description of its own.
    expect(sitemapEntriesFor('brands', [brandRow()], ORIGIN, INDEXING_ON)).toEqual([
      { loc: 'https://mercaria.co/brands/apple', lastmod: LASTMOD.toISOString() },
    ]);
  });

  it('refuses a brand with one product, and accepts one with two', () => {
    // Through `sitemapEntriesFor` directly now the route is live — the
    // 'drops a merchant whose catalogue is too small' precedent above.
    expect(
      sitemapEntriesFor(
        'brands',
        [brandRow({ slug: 'solo', catalogueEntryCount: 1 })],
        ORIGIN,
        INDEXING_ON,
      ),
    ).toEqual([]);
    expect(sitemapEntriesFor('brands', [brandRow({ catalogueEntryCount: 2 })], ORIGIN, INDEXING_ON)).toEqual([
      { loc: 'https://mercaria.co/brands/apple', lastmod: LASTMOD.toISOString() },
    ]);
  });
});

describe('a route with no screen contributes NOTHING', () => {
  it('categories are empty while the page is still planned', () => {
    // The registry's `availability` reaching the sitemap: a URL advertised
    // before its screen ships is a crawl target that answers "This screen does
    // not exist". #73 landed and `merchants` emits (above), #72 landed and
    // `brands` emits too (above) — `categories` is the one still `planned`,
    // and `seo-routes.test.ts` is what forces its own flip rather than leaving
    // that page unindexable in silence.
    expect(sitemapEntriesFor('categories', [brandRow({ slug: 'phones' })], ORIGIN, INDEXING_ON)).toEqual([]);
  });
});

describe('the indexing lever', () => {
  it('empties every collection when indexing is off', () => {
    expect(sitemapEntriesFor('products', [productRow()], ORIGIN, INDEXING_OFF)).toEqual([]);
  });

  it('under `canary`, keeps only the named categories', () => {
    const canary = CANARY(['cat-phones']);
    expect(sitemapEntriesFor('products', [productRow()], ORIGIN, canary).length).toBe(1);
    expect(
      sitemapEntriesFor('products', [productRow({ categoryId: 'cat-shoes' })], ORIGIN, canary),
    ).toEqual([]);
    // An uncategorised product is REFUSED — a canary that leaked the objects it
    // could not classify is not a canary.
    expect(
      sitemapEntriesFor('products', [productRow({ categoryId: null })], ORIGIN, canary),
    ).toEqual([]);
  });

  it('under `canary` with an empty list, keeps nothing', () => {
    expect(sitemapEntriesFor('products', [productRow()], ORIGIN, CANARY([]))).toEqual([]);
  });
});

describe('lastmod', () => {
  it('is omitted rather than invented when nothing dateable is known', () => {
    const [entry] = sitemapEntriesFor('products', [productRow({ lastmod: null })], ORIGIN, INDEXING_ON);
    expect(entry?.lastmod).toBeUndefined();
    expect(renderUrlset([entry ?? { loc: '' }])).not.toContain('<lastmod>');
  });
});

describe('rendering', () => {
  it('renders a urlset a parser accepts', () => {
    const xml = renderUrlset([{ loc: 'https://mercaria.co/p/a', lastmod: LASTMOD.toISOString() }]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<url><loc>https://mercaria.co/p/a</loc><lastmod>2026-08-01T10:00:00.000Z</lastmod></url>');
    expect(xml.endsWith('</urlset>')).toBe(true);
  });

  it('renders an empty urlset rather than nothing', () => {
    expect(renderUrlset([])).toContain('<urlset');
    expect(renderUrlset([])).toContain('</urlset>');
  });

  it('escapes a loc that carries markup characters', () => {
    const xml = renderUrlset([{ loc: 'https://mercaria.co/p/a&b<c' }]);
    expect(xml).toContain('https://mercaria.co/p/a&amp;b&lt;c');
    expect(xml).not.toContain('a&b<c');
  });

  it('renders a sitemap index', () => {
    const xml = renderSitemapIndex([
      {
        collection: 'products',
        page: 1,
        loc: 'https://mercaria.co/sitemaps/products/1.xml',
        lastmod: LASTMOD.toISOString(),
      },
    ]);
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://mercaria.co/sitemaps/products/1.xml</loc>');
  });
});

describe('paging', () => {
  it('gives a non-empty collection at least one page and an empty one none', () => {
    expect(sitemapPageCount(0, 100)).toBe(0);
    expect(sitemapPageCount(1, 100)).toBe(1);
    expect(sitemapPageCount(100, 100)).toBe(1);
    expect(sitemapPageCount(101, 100)).toBe(2);
  });

  it('addresses a page at one stable path', () => {
    expect(sitemapPagePath('products', 7)).toBe('/sitemaps/products/7.xml');
  });

  it('recognises exactly the four collections', () => {
    expect(isSitemapCollection('products')).toBe(true);
    expect(isSitemapCollection('brands')).toBe(true);
    expect(isSitemapCollection('merchants')).toBe(true);
    expect(isSitemapCollection('categories')).toBe(true);
    expect(isSitemapCollection('families')).toBe(false);
    expect(isSitemapCollection('../../etc/passwd')).toBe(false);
  });
});
