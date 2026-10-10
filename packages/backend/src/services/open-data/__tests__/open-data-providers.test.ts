/**
 * Every provider against RECORDED responses (fixtures/, captured October 2026
 * from the live endpoints and trimmed), through the same normalization and
 * payload projection the ingestion pipeline applies.
 *
 * The last step matters as much as the parsing: a provider that emits a fact
 * the normalizer drops, or a payload over the 32 KB bound, would pass a
 * parser-only test and lose the data in production.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { CatalogRefreshMode, NormalizedSourceFact } from '@mercaria/shared-types';
import { canonicalizeNormalizedRecord } from '../../ingestion/normalization.js';
import { buildStoredPayload, normalizedFromStoredPayload, redactSourceObservation } from '../../ingestion/redact.js';
import type { OpenDataDownload, OpenDataHttp, OpenDataJsonResponse } from '../http.js';
import type { OpenDataCursor, OpenDataDemand, OpenDataItem, OpenDataPage, OpenDataProvider } from '../provider.js';
import { cheapSharkProvider } from '../providers/cheapshark.js';
import { gogProvider } from '../providers/gog.js';
import { mitecoFuelProvider } from '../providers/miteco-fuel.js';
import { OPEN_FACTS_DEMAND_ONLY, openFactsProviders } from '../providers/open-facts.js';
import { openPricesProvider } from '../providers/open-prices.js';
import { scryfallProvider } from '../providers/scryfall.js';
import { htmlText, shopifyStorefrontProvider, storeDomain } from '../providers/shopify-storefront.js';
import { searchRows, steamStoreProvider, STEAM_MAX_RESULTS } from '../providers/steam-store.js';
import { ygoprodeckProvider } from '../providers/ygoprodeck.js';
import { OpenDataConfigurationError } from '../provider.js';
import { tcgdexProvider } from '../providers/tcgdex.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = new Date('2025-10-10T08:00:00.000Z');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

/** A transport answering from a URL → body table; downloads from local paths. */
function fakeHttp(routes: {
  json?: (url: string) => { body: unknown; headers?: Record<string, string> } | null;
  text?: (url: string) => string | null;
  downloads?: Record<string, string>;
}): OpenDataHttp & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async getText(url): Promise<string | null> {
      requested.push(url);
      const answer = routes.text?.(url);
      if (answer === undefined) throw new Error(`unrouted ${url}`);
      return answer;
    },
    async getJson(url): Promise<OpenDataJsonResponse | null> {
      requested.push(url);
      const answer = routes.json?.(url);
      if (answer === undefined) throw new Error(`unrouted ${url}`);
      if (answer === null) return null;
      return { body: answer.body, headers: new Headers(answer.headers ?? {}) };
    },
    async download(url): Promise<OpenDataDownload> {
      requested.push(url);
      const path = routes.downloads?.[url];
      if (path === undefined) throw new Error(`unrouted download ${url}`);
      return { path, confirmedAt: NOW, lastModified: null, digest: `${'a'.repeat(32)}${path.length.toString(16).padStart(32, '0')}` };
    },
  };
}

async function page(
  provider: OpenDataProvider,
  http: OpenDataHttp,
  options: { accountRef?: string | null; territories?: string[]; mode?: CatalogRefreshMode; externalIds?: string[]; cursor?: OpenDataCursor | null; pageSize?: number; since?: Date | null; demand?: OpenDataDemand | null } = {},
): Promise<OpenDataPage> {
  return provider.fetchPage({
    cursor: options.cursor ?? null,
    pageSize: options.pageSize ?? 50,
    accountRef: options.accountRef ?? null,
    territories: options.territories ?? ['ES'],
    mode: options.mode ?? 'incremental',
    since: options.since ?? null,
    externalIds: options.externalIds ?? [],
    http,
    demand: options.demand ?? null,
    now: NOW,
  });
}

/** Run an item through the pipeline's own normalization and payload projection. */
function stored(item: OpenDataItem) {
  const canonical = canonicalizeNormalizedRecord(item.normalized);
  expect(canonical, `${item.externalId} has no title after normalization`).not.toBeNull();
  if (canonical === null) throw new Error('unreachable');
  const redacted = redactSourceObservation(canonical, item.raw);
  expect(redacted, `${item.externalId} exceeds the stored payload bound`).not.toBeNull();
  // Every fact the provider emitted survives normalization: a dropped fact is
  // data lost for good, because the raw payload is discarded.
  expect(canonical.facts?.length ?? 0).toBe(item.normalized.facts?.length ?? 0);
  // A RE-ADVANCE (ADR 0014 D4) rebuilds the record from the stored payload;
  // it must project back to the very same payload, or the re-advanced offer
  // would differ from the one a fresh page would have written.
  const payload = redacted?.payload ?? {};
  const reread = normalizedFromStoredPayload(payload);
  expect(reread, `${item.externalId} payload does not read back`).not.toBeNull();
  if (reread !== null) expect(buildStoredPayload(reread)).toEqual(payload);
  return { canonical, payload };
}

function fact(facts: readonly NormalizedSourceFact[] | undefined, key: string): NormalizedSourceFact['value'] | undefined {
  return facts?.find((entry) => entry.key === key)?.value;
}

describe('Open Prices', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-prices-'));
  const locations = [
    { id: 1, osm_brand: 'Mercadona', osm_name: 'Mercadona', osm_address_country_code: 'ES', osm_address_city: 'Madrid', osm_type: 'NODE', osm_id: 11, osm_tag_value: 'supermarket' },
    { id: 2, osm_brand: 'Mercadona', osm_name: 'Mercadona', osm_address_country_code: 'ES', osm_address_city: 'Valencia', osm_type: 'WAY', osm_id: 22, osm_tag_value: 'supermarket' },
    { id: 3, osm_brand: 'Mercadona', osm_name: 'Mercadona', osm_address_country_code: 'PT', osm_address_city: 'Porto', osm_type: 'NODE', osm_id: 33 },
    { id: 4, osm_brand: 'Lidl', osm_name: 'Lidl', osm_address_country_code: 'ES', osm_address_city: 'Madrid', osm_type: 'NODE', osm_id: 44 },
  ];
  const base = { type: 'PRODUCT', currency: 'EUR', duplicate_of: null, created: '2025-09-01T10:00:00Z' };
  const prices = [
    { ...base, id: 10, location_id: 1, product_code: '8480000160164', product_name: 'Tomate triturado', price: '0.850', date: '2025-09-01', proof_id: 5 },
    { ...base, id: 11, location_id: 2, product_code: '8480000160164', product_name: null, price: '0.890', date: '2025-10-01', proof_id: null, price_is_discounted: true, price_without_discount: '1.050', discount_type: 'QUANTITY' },
    { ...base, id: 12, location_id: 1, product_code: '8480000160164', price: '0.700', date: '2023-01-01' },
    { ...base, id: 13, location_id: 3, product_code: '8480000160164', price: '0.100', date: '2025-10-02' },
    { ...base, id: 14, location_id: 4, product_code: '4056489000000', price: '1.000', date: '2025-10-02' },
    { ...base, id: 15, location_id: 1, product_code: null, type: 'CATEGORY', category_tag: 'en:apples', price: '2.000', date: '2025-10-02' },
    { ...base, id: 16, location_id: 1, product_code: '8410000000000', price: '3.100', date: '2025-08-15', duplicate_of: 3 },
    { ...base, id: 17, location_id: 1, product_code: '8410000000017', price: '2.500', date: '2025-08-15' },
  ];
  const pricesPath = join(directory, 'prices.jsonl.gz');
  const locationsPath = join(directory, 'locations.jsonl.gz');
  writeFileSync(pricesPath, gzipSync(`${prices.map((row) => JSON.stringify(row)).join('\n')}\nnot json\n`));
  writeFileSync(locationsPath, gzipSync(locations.map((row) => JSON.stringify(row)).join('\n')));
  const http = fakeHttp({
    downloads: {
      'https://prices.openfoodfacts.org/data/prices.jsonl.gz': pricesPath,
      'https://prices.openfoodfacts.org/data/locations.jsonl.gz': locationsPath,
    },
  });

  it('emits one offer per (chain, GTIN): the latest in-window sighting, in-territory only', async () => {
    const result = await page(openPricesProvider, http, { accountRef: 'Mercadona' });
    expect(result.items.map((item) => item.externalId)).toEqual(['8410000000017', '8480000160164']);
    expect(result.complete).toBe(true);
    expect(result.next).toBeNull();

    const tomato = result.items.find((item) => item.externalId === '8480000160164');
    if (tomato === undefined) throw new Error('missing');
    const { canonical } = stored(tomato);
    // The Valencia sighting is the newest; the 2024 one is out of the window
    // and the Porto one out of the territory.
    expect(canonical.price).toEqual({ amount: 89, currency: 'EUR' });
    expect(canonical.compareAtPrice).toEqual({ amount: 105, currency: 'EUR' });
    expect(canonical.merchantHint).toBe('Mercadona');
    expect(canonical.country).toBe('ES');
    expect(canonical.identifiers).toEqual([{ scheme: 'gtin', value: '8480000160164' }]);
    // The newest sighting had no name: the GTIN stands in, identity is the identifier.
    expect(canonical.title).toBe('8480000160164');
    expect(tomato.sourceUpdatedAt?.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    expect(fact(canonical.facts, 'open_prices.sightings')).toBe(2);
    expect(fact(canonical.facts, 'open_prices.shops_observed')).toBe(2);
    expect(fact(canonical.facts, 'open_prices.cities_observed')).toEqual(['Madrid', 'Valencia']);
    expect(fact(canonical.facts, 'open_prices.min_price')).toBe(85);
    expect(fact(canonical.facts, 'open_prices.max_price')).toBe(89);
    expect(fact(canonical.facts, 'open_prices.discount_type')).toBe('QUANTITY');
    expect(fact(canonical.facts, 'open_prices.shop_osm')).toBe('way/22');
  });

  it('pages a chain deterministically and finishes complete only on the last page', async () => {
    const first = await page(openPricesProvider, http, { accountRef: 'mercadona', pageSize: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.complete).toBe(false);
    expect(first.next).not.toBeNull();
    const second = await page(openPricesProvider, http, { accountRef: 'mercadona', pageSize: 1, cursor: first.next });
    expect(second.items.map((item) => item.externalId)).toEqual(['8480000160164']);
    expect(second.complete).toBe(true);
  });

  it('restarts a pass whose cursor names a different dump', async () => {
    const result = await page(openPricesProvider, http, { accountRef: 'mercadona', pageSize: 1, cursor: { d: 'stale', o: 1 } });
    expect(result.items.map((item) => item.externalId)).toEqual(['8410000000017']);
  });

  it('cuts a different chain from the same dumps', async () => {
    const result = await page(openPricesProvider, http, { accountRef: 'lidl' });
    expect(result.items.map((item) => item.externalId)).toEqual(['4056489000000']);
  });
});

describe('the Open Facts family', () => {
  const food = openFactsProviders.find((provider) => provider.slug === 'open_food_facts');
  if (food === undefined) throw new Error('open_food_facts is not in the family');

  it('extracts the catalogue and every nutrition fact from a product document', async () => {
    const http = fakeHttp({ json: () => ({ body: fixture('open-food-facts-product.json') }) });
    const result = await page(food, http, { mode: 'targeted', externalIds: ['8480000160164'] });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    if (item === undefined) throw new Error('missing');
    expect(item.externalType).toBe('product');
    const { canonical, payload } = stored(item);
    expect(canonical.title).toBe('Tomate triturado');
    expect(canonical.brandHint).toBe('Hacendado');
    expect(canonical.identifiers).toEqual([{ scheme: 'gtin', value: '8480000160164' }]);
    expect(canonical.media[0]).toMatch(/^https:\/\/images\.openfoodfacts\.org\//u);
    expect(fact(canonical.facts, 'openfacts.nutriscore_grade')).toBe('b');
    expect(fact(canonical.facts, 'openfacts.nova_group')).toBe(4);
    expect(fact(canonical.facts, 'openfacts.product_quantity')).toBe(400);
    expect(canonical.facts?.find((entry) => entry.key === 'openfacts.nutrition.energy_kcal_100g')).toEqual({
      key: 'openfacts.nutrition.energy_kcal_100g',
      value: 29,
      unit: 'kcal',
    });
    expect(fact(canonical.facts, 'openfacts.nutrition.sugars_100g')).toBe(4.7);
    expect(fact(canonical.facts, 'openfacts.labels')).toContain('en:organic');
    expect(fact(canonical.facts, 'openfacts.stores')).toEqual(['Mercadona']);
    expect(payload.facts).toEqual(canonical.facts);
    expect(http.requested[0]).toContain('world.openfoodfacts.org/api/v2/product/8480000160164.json?fields=');
  });

  it('reports a product the database no longer has as a removal', async () => {
    const http = fakeHttp({ json: () => null });
    const result = await page(food, http, { mode: 'targeted', externalIds: ['8480000160164'] });
    expect(result.items).toEqual([]);
    expect(result.removed).toEqual([{ externalType: 'product', externalId: '8480000160164' }]);
  });

  it('walks the country search newest-first and stops at the watermark', async () => {
    const product = (fixture('open-food-facts-product.json') as { product: Record<string, unknown> }).product;
    const older = { ...product, code: '8410000000017', last_modified_t: 1_600_000_000 };
    const http = fakeHttp({ json: () => ({ body: { count: 500, products: [product, older] } }) });
    const result = await page(food, http, { mode: 'query_driven', since: new Date('2025-01-01T00:00:00Z') });
    expect(result.items.map((item) => item.externalId)).toEqual(['8480000160164']);
    expect(result.next).toBeNull();
    expect(result.complete).toBe(false);
    expect(http.requested[0]).toContain('countries_tags=en%3Aspain');
  });

  it('fetches the catalogue\'s demanded GTINs first, then hands over to the search', async () => {
    const product = (fixture('open-food-facts-product.json') as { product: Record<string, unknown> }).product;
    const asked: (string | null)[] = [];
    const demand: OpenDataDemand = {
      gtins: async (after) => {
        asked.push(after);
        return after === null ? ['8480000160164', '4056489000000'] : [];
      },
    };
    const http = fakeHttp({
      // The second demanded GTIN is unknown to the database: absent, not removed.
      json: (url) => (url.includes('8480000160164') ? { body: { status: 1, product } } : null),
    });
    const first = await page(food, http, { mode: 'query_driven', demand });
    expect(first.items.map((item) => item.externalId)).toEqual(['8480000160164']);
    expect(first.removed).toBeUndefined();
    expect(first.next).toEqual({ w: '4056489000000' });

    const handover = await page(food, http, { mode: 'query_driven', demand, cursor: first.next });
    expect(handover.items).toEqual([]);
    expect(handover.next).toEqual({ p: 1 });
    expect(asked).toEqual([null, '4056489000000']);
  });

  it('reads the demand alone, and never searches, for a demand-only source', async () => {
    const product = (fixture('open-food-facts-product.json') as { product: Record<string, unknown> }).product;
    const demand: OpenDataDemand = {
      gtins: async (after) => (after === null ? ['8480000160164'] : []),
    };
    const http = fakeHttp({ json: (url) => (url.includes('/product/') ? { body: { status: 1, product } } : null) });
    const options = { mode: 'query_driven' as const, demand, accountRef: OPEN_FACTS_DEMAND_ONLY };
    const first = await page(food, http, options);
    expect(first.items.map((item) => item.externalId)).toEqual(['8480000160164']);
    const last = await page(food, http, { ...options, cursor: first.next });
    expect(last.items).toEqual([]);
    expect(last.next).toBeNull();
    // Nothing demanded at all: a pass with no request.
    const idle = await page(food, http, { ...options, demand: { gtins: async () => [] } });
    expect(idle.next).toBeNull();
    expect(http.requested.some((url) => url.includes('/search'))).toBe(false);
  });

  it('goes straight to the search when nothing is demanded', async () => {
    const product = (fixture('open-food-facts-product.json') as { product: Record<string, unknown> }).product;
    const http = fakeHttp({ json: () => ({ body: { count: 1, products: [product] } }) });
    const result = await page(food, http, { mode: 'query_driven', demand: { gtins: async () => [] } });
    expect(result.items.map((item) => item.externalId)).toEqual(['8480000160164']);
    expect(http.requested[0]).toContain('/api/v2/search?');
  });

  it('is four providers with four hosts', () => {
    expect(openFactsProviders.map((provider) => provider.slug)).toEqual([
      'open_food_facts',
      'open_products_facts',
      'open_beauty_facts',
      'open_pet_food_facts',
    ]);
  });
});

describe('MITECO fuel prices', () => {
  const directory = mkdtempSync(join(tmpdir(), 'miteco-'));
  const listPath = join(directory, 'list.json');
  writeFileSync(listPath, `\uFEFF${readFileSync(join(FIXTURES, 'miteco-stations.json'), 'utf8')}`);
  const http = fakeHttp({
    downloads: {
      'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/': listPath,
    },
  });

  it('emits one offer per fuel per PUBLIC station of the brand, keeping the exact price', async () => {
    const result = await page(mitecoFuelProvider, http, { accountRef: 'REPSOL' });
    expect(result.complete).toBe(true);
    expect(result.items.length).toBeGreaterThan(2);
    for (const item of result.items) {
      expect(item.normalized.merchantHint).toBe('REPSOL');
      expect(fact(item.normalized.facts, 'miteco.station_id')).not.toBeUndefined();
    }
    // The restricted-sale station was relabelled REPSOL in the fixture and
    // must still be absent.
    const stations = new Set(result.items.map((item) => item.externalId.split(':')[0]));
    expect(stations.size).toBe(2);

    const gasoleo = result.items.find((item) => item.externalId === '3118:gasoleo_a');
    if (gasoleo === undefined) throw new Error('missing');
    const { canonical } = stored(gasoleo);
    expect(canonical.title).toBe('Gasóleo A');
    expect(canonical.price).toEqual({ amount: 199, currency: 'EUR' });
    expect(canonical.facts?.find((entry) => entry.key === 'miteco.price_exact')).toEqual({
      key: 'miteco.price_exact',
      value: 1.985,
      unit: 'EUR/l',
    });
    expect(fact(canonical.facts, 'miteco.latitude')).toBeCloseTo(40.526722);
    expect(canonical.region).toBe('MADRID');
    expect(gasoleo.sourceUpdatedAt?.toISOString()).toBe('2025-08-10T02:03:28.000Z');
  });
});

describe('CheapShark', () => {
  const http = fakeHttp({
    json: (url) =>
      url.includes('/stores')
        ? { body: fixture('cheapshark-stores.json') }
        : { body: fixture('cheapshark-deals.json'), headers: { 'x-total-page-count': '3' } },
  });

  it('reads a store deal with its ratings and a redirect link', async () => {
    const result = await page(cheapSharkProvider, http, { accountRef: '1' });
    expect(result.items).toHaveLength(2);
    expect(result.next).toEqual({ p: 1 });
    const item = result.items[0];
    if (item === undefined) throw new Error('missing');
    const { canonical } = stored(item);
    expect(canonical.merchantHint).toBe('Steam');
    expect(canonical.price?.currency).toBe('USD');
    expect(canonical.sourceUrl).toMatch(/^https:\/\/www\.cheapshark\.com\/redirect\?dealID=/u);
    expect(fact(canonical.facts, 'cheapshark.steam_app_id')).toBeDefined();
  });

  it('refuses a store id CheapShark does not list as active', async () => {
    await expect(page(cheapSharkProvider, http, { accountRef: '4' })).rejects.toThrow(/no active store/u);
    await expect(page(cheapSharkProvider, http, { accountRef: 'steam' })).rejects.toThrow(/not a CheapShark store id/u);
  });
});

describe('GOG', () => {
  it('reads EUR prices for Spain and walks every product type', async () => {
    const http = fakeHttp({ json: () => ({ body: fixture('gog-catalog.json') }) });
    const result = await page(gogProvider, http, { cursor: { t: 0, p: 5000 } });
    expect(result.next).toEqual({ t: 1, p: 1 });
    const item = result.items[0];
    if (item === undefined) throw new Error('missing');
    const { canonical } = stored(item);
    expect(canonical.price?.currency).toBe('EUR');
    expect(canonical.country).toBe('ES');
    expect(fact(canonical.facts, 'gog.developers')).toBeDefined();
    expect(http.requested[0]).toContain('currencyCode=EUR');
  });
});

describe('Scryfall', () => {
  it('emits one offer per priced finish with a Finish option', async () => {
    const http = fakeHttp({ json: () => ({ body: fixture('scryfall-search.json') }) });
    const result = await page(scryfallProvider, http);
    expect(result.next).toEqual({ p: 2 });
    const foil = result.items.find((item) => item.externalId.endsWith(':foil'));
    if (foil === undefined) throw new Error('missing foil');
    const { canonical } = stored(foil);
    expect(canonical.options).toEqual([{ name: 'Finish', value: 'Foil' }]);
    expect(canonical.merchantHint).toBe('Cardmarket');
    expect(fact(canonical.facts, 'scryfall.price_basis')).toBe('cardmarket_trend');
    expect(fact(canonical.facts, 'scryfall.rarity')).toBeDefined();
  });
});

describe('TCGdex', () => {
  it('reads a Spanish card with Cardmarket prices per finish', async () => {
    const http = fakeHttp({
      json: (url) => (url.includes('/cards?') ? { body: [{ id: 'swsh3-136' }] } : { body: fixture('tcgdex-card.json') }),
    });
    const result = await page(tcgdexProvider, http, { pageSize: 10 });
    expect(result.next).toBeNull();
    expect(result.items.map((item) => item.externalId)).toEqual(['swsh3-136:normal', 'swsh3-136:holo']);
    const { canonical } = stored(result.items[0] as OpenDataItem);
    expect(canonical.title).toBe('Furret — Oscuridad Incandescente #136');
    expect(canonical.price).toEqual({ amount: 6, currency: 'EUR' });
    expect(fact(canonical.facts, 'tcgdex.hp')).toBe(110);
    expect(fact(canonical.facts, 'tcgdex.attacks')).toEqual(['Buen Rollito', 'Coletazo']);
  });

  it('refuses a language it does not read', async () => {
    const http = fakeHttp({ json: () => ({ body: [] }) });
    await expect(page(tcgdexProvider, http, { accountRef: 'xx' })).rejects.toThrow(/not a TCGdex language/u);
  });
});

describe('Shopify storefronts (the shops on shop.app)', () => {
  const meta = fixture('shopify-meta.json');
  const products = fixture('shopify-products.json') as { products: unknown[] };
  const ROBOTS = 'User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\n';

  function store(robots: string | null = ROBOTS) {
    return fakeHttp({
      text: (url) => (url.endsWith('/robots.txt') ? robots : null),
      json: (url) => {
        if (url.endsWith('/meta.json')) return { body: meta };
        if (url.includes('/products.json')) return { body: products };
        return null;
      },
    });
  }

  it('is an extraction provider, one source per store domain', () => {
    expect(shopifyStorefrontProvider.extraction).toBe(true);
    expect(shopifyStorefrontProvider.accountRefRequired).toBe(true);
    expect(storeDomain('https://PompeiiBrand.com/collections/all')).toBe('pompeiibrand.com');
    expect(() => storeDomain('not a domain')).toThrow(OpenDataConfigurationError);
  });

  it('reads robots, then the store, then one record per variant grouped by product', async () => {
    const http = store();
    const result = await page(shopifyStorefrontProvider, http, { accountRef: 'pompeiibrand.com', pageSize: 250 });
    expect(http.requested.slice(0, 3)).toEqual([
      'https://pompeiibrand.com/robots.txt',
      'https://pompeiibrand.com/meta.json',
      'https://pompeiibrand.com/products.json?limit=250&page=1',
    ]);
    expect(result.items).toHaveLength(2);
    const [first, second] = result.items;
    expect(first?.externalType).toBe('offer');
    expect(first?.normalized.productGroupKey).toBe('15632690119004');
    expect(second?.normalized.productGroupKey).toBe('15632690119004');
    expect(first?.normalized.title).toBe('VEGA FLORENTIK BORDEAUX');
    expect(first?.normalized.options).toEqual([{ name: 'Size', value: '40' }]);
    expect(first?.normalized.price).toEqual({ amount: 17_900, currency: 'EUR' });
    expect(first?.normalized.availability).toBe('in_stock');
    expect(first?.normalized.merchantHint).toBe('Pompeii');
    expect(first?.normalized.brandHint).toBe('Pompeii');
    expect(first?.normalized.sourceUrl).toBe(`https://pompeiibrand.com/products/vega-florentik-bordeaux?variant=${first?.externalId ?? ''}`);
    expect(first?.normalized.description).toContain('Fabricados a mano en Portugal');
    expect(first?.normalized.description).not.toContain('<');
    expect(second?.normalized.availability).toBe('out_of_stock');
    expect(second?.normalized.compareAtPrice).toEqual({ amount: 19_900, currency: 'EUR' });
    const facts = Object.fromEntries((first?.normalized.facts ?? []).map((fact) => [fact.key, fact.value]));
    expect(facts['shopify.store_country']).toBe('ES');
    expect(facts['shopify.product_type']).toBe('SHOE');
    expect(facts['shopify.tags']).toEqual(['mocasines', 'piel']);
    // A short page is the last one.
    expect(result.next).toBeNull();
  });

  it('carries the store facts in the cursor instead of re-reading them', async () => {
    const http = store();
    const result = await page(shopifyStorefrontProvider, http, { accountRef: 'pompeiibrand.com', pageSize: 1 });
    expect(result.next).toEqual({ p: 2, c: 'EUR', n: 'Pompeii', k: 'ES' });
    const again = store();
    await page(shopifyStorefrontProvider, again, { accountRef: 'pompeiibrand.com', pageSize: 1, cursor: result.next });
    expect(again.requested).toEqual(['https://pompeiibrand.com/products.json?limit=1&page=2']);
  });

  it('reads nothing a store\'s robots.txt disallows', async () => {
    const http = store('User-agent: *\nDisallow: /products.json\n');
    await expect(page(shopifyStorefrontProvider, http, { accountRef: 'pompeiibrand.com' })).rejects.toThrow(OpenDataConfigurationError);
    expect(http.requested).toEqual(['https://pompeiibrand.com/robots.txt']);
  });

  it('turns body_html into text', () => {
    expect(htmlText('<p>Hola&nbsp;<b>mundo</b></p><p>A &amp; B</p>')).toBe('Hola mundo\nA & B');
    expect(htmlText('<p> </p>')).toBeUndefined();
  });
});

describe('YGOPRODeck', () => {
  it('reads one Cardmarket-priced record per card, keyed by the card, with the other markets as facts', async () => {
    const body = fixture('ygoprodeck-cardinfo.json');
    const http = fakeHttp({ json: () => ({ body }) });
    const result = await page(ygoprodeckProvider, http, { pageSize: 2 });
    expect(http.requested[0]).toBe('https://db.ygoprodeck.com/api/v7/cardinfo.php?num=2&offset=0&misc=yes');
    expect(result.items.map((item) => item.externalId)).toEqual(['17494901', '21831848']);
    const [first] = result.items;
    expect(first?.normalized.productGroupKey).toBe('17494901');
    expect(first?.normalized.price).toEqual({ amount: 6, currency: 'EUR' });
    expect(first?.normalized.merchantHint).toBe('Cardmarket');
    // Their images may not be hotlinked.
    expect(first?.normalized.media).toEqual([]);
    const facts = Object.fromEntries((first?.normalized.facts ?? []).map((fact) => [fact.key, fact]));
    expect(facts['ygoprodeck.formats']?.value).toContain('TCG');
    expect(facts['ygoprodeck.tcgplayer_price']?.unit).toBe('USD');
    expect(result.next).toEqual({ o: 5002 });
  });
});

describe('Steam store search', () => {
  const body = fixture('steam-search.json') as { results_html: string; total_count: number };

  it('reads each row of the search fragment', () => {
    const rows = searchRows(body.results_html);
    expect(rows).toHaveLength(3);
    const [first] = rows;
    expect(first?.appId).toBe('632360');
    expect(first?.title).toBe('Risk of Rain 2');
    expect(first?.priceFinalMinor).toBe(824);
    expect(first?.originalPrice).toBe('24,99€');
    expect(first?.discountPercent).toBe(67);
    expect(first?.url).toBe('https://store.steampowered.com/app/632360/Risk_of_Rain_2/');
  });

  it('checks robots first, then reads games keyed by app id, with the pre-discount price as compare-at', async () => {
    const http = fakeHttp({
      text: (url) => (url.endsWith('/robots.txt') ? 'User-Agent: *\nDisallow: /share/\n' : null),
      json: () => ({ body }),
    });
    const result = await page(steamStoreProvider, http, { pageSize: 100 });
    expect(http.requested[0]).toBe('https://store.steampowered.com/robots.txt');
    expect(http.requested[1]).toContain('cc=es');
    expect(http.requested[1]).toContain('category1=998');
    const [first] = result.items;
    expect(first?.normalized.productGroupKey).toBe('632360');
    expect(first?.normalized.price).toEqual({ amount: 824, currency: 'EUR' });
    expect(first?.normalized.compareAtPrice).toEqual({ amount: 2499, currency: 'EUR' });
    expect(result.next).toEqual({ s: 3 });
  });

  it('stops at the pass depth, and refuses when robots.txt disallows the search', async () => {
    const http = fakeHttp({ json: () => ({ body }) });
    const last = await page(steamStoreProvider, http, { pageSize: 100, cursor: { s: STEAM_MAX_RESULTS - 3 } });
    expect(last.next).toBeNull();
    const refused = fakeHttp({ text: () => 'User-agent: *\nDisallow: /search/\n', json: () => ({ body }) });
    await expect(page(steamStoreProvider, refused, {})).rejects.toThrow(OpenDataConfigurationError);
  });
});
