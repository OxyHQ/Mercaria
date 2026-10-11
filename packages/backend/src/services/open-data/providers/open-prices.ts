/**
 * OPEN PRICES (Open Food Facts) — crowd-sourced shelf and receipt prices.
 *
 * Every price is a person's photographed proof that a product (by GTIN) cost
 * an amount at a shop (an OpenStreetMap place) on a date. Mercaria reads the
 * daily dumps — `prices.jsonl.gz` and `locations.jsonl.gz`, ~23 MB together —
 * rather than paging the API, because a dump is the provider's own preferred
 * bulk route and one download serves every chain's source.
 *
 * ## One source per retail chain
 *
 * A source's account ref names the CHAIN (`mercadona`, `lidl`, `carrefour`),
 * the fold of the shop's OSM `brand` (or its name when it has none). Each
 * source is bound to that chain's merchant, so an offer is attributed to the
 * retailer whose shelf the price was on — never to a marketplace seller minted
 * from free text anybody can edit on OSM.
 *
 * ## One record per (chain, GTIN): the LATEST sighting inside the window
 *
 * Several people photograph one product in several of a chain's shops. The
 * record is the most recent sighting no older than {@link OPEN_PRICES_WINDOW_DAYS},
 * and the rest of what was seen is kept as FACTS: how many sightings, in how
 * many shops and cities, and the lowest and highest price among them. A pair
 * whose newest sighting falls out of the window is simply not emitted, so a
 * complete pass retires it by omission — an old price is not a current offer.
 *
 * `sourceUpdatedAt` is the SIGHTING date, not the dump's: the framework's
 * monotonic guard and price history then follow when the price was actually
 * observed on a shelf.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import {
  OpenDataSchemaError,
  type OpenDataItem,
  type OpenDataPage,
  type OpenDataPageContext,
  type OpenDataProvider,
} from '../provider.js';
import {
  asDate,
  asNumber,
  asObject,
  asText,
  decimalMoney,
  FactCollector,
  gtinDigits,
  subFeedKey,
} from '../read.js';

export const OPEN_PRICES_PROVIDER = 'open_prices';

const PRICES_DUMP_URL = 'https://prices.openfoodfacts.org/data/prices.jsonl.gz';
const LOCATIONS_DUMP_URL = 'https://prices.openfoodfacts.org/data/locations.jsonl.gz';

/** How old the newest sighting of a (chain, GTIN) may be and still be an offer. */
export const OPEN_PRICES_WINDOW_DAYS = 365;

/** The dumps are regenerated daily; re-asking more often than this buys nothing. */
const DUMP_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** One shop, as the locations dump describes it. */
export interface OpenPricesLocation {
  readonly id: number;
  readonly chain: string;
  readonly chainName: string;
  readonly countryCode: string | undefined;
  readonly city: string | undefined;
  readonly postcode: string | undefined;
  readonly osmType: string | undefined;
  readonly osmId: number | undefined;
  readonly shopType: string | undefined;
  readonly logoUrl: string | undefined;
}

/** One aggregated (chain, GTIN) — what a page is cut from. */
interface ChainProductAggregate {
  readonly gtin: string;
  latest: PriceSighting;
  sightings: number;
  readonly shops: Set<number>;
  readonly cities: Set<string>;
  minAmount: number;
  maxAmount: number;
  readonly currency: string;
}

interface PriceSighting {
  readonly id: number;
  readonly locationId: number;
  readonly date: Date;
  readonly createdAt: Date | undefined;
  readonly amount: number;
  readonly currency: string;
  readonly row: Readonly<Record<string, unknown>>;
}

interface Aggregation {
  readonly digest: string;
  readonly chainName: string;
  readonly products: readonly ChainProductAggregate[];
  readonly locations: ReadonlyMap<number, OpenPricesLocation>;
}

/**
 * Aggregations of the current dump, per (digest, chain, territories).
 *
 * A pass spans several dispatcher ticks and each page would otherwise re-read
 * 300k lines to cut fifty. Bounded, and keyed on the dump's DIGEST, so a new
 * dump can never be served from an old aggregation.
 */
const aggregations = new Map<string, Aggregation>();
const MAX_CACHED_AGGREGATIONS = 8;

export const openPricesProvider: OpenDataProvider = {
  slug: OPEN_PRICES_PROVIDER,
  name: 'Open Prices',
  homepage: 'https://prices.openfoodfacts.org',
  role: 'prices',
  kind: 'feed',
  licence: 'odbl_1_0',
  attribution: 'Precios de Open Prices (Open Food Facts), bajo licencia ODbL',
  accountRefMeaning: 'the retail chain, as the fold of its OpenStreetMap brand (e.g. "mercadona")',
  accountRefRequired: true,
  refreshModes: ['full_snapshot', 'incremental'],
  minRequestIntervalMs: 1_000,
  fetchPage: fetchOpenPricesPage,
};

async function fetchOpenPricesPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const chain = subFeedKey(context.accountRef ?? '');
  const aggregation = await aggregate(context, chain);

  const cursorDigest = typeof context.cursor?.d === 'string' ? context.cursor.d : null;
  const cursorOffset = typeof context.cursor?.o === 'number' ? context.cursor.o : 0;
  // A dump republished mid-pass restarts the pass: offsets into a different
  // ordering would silently skip products, and every record already written
  // lands as `unchanged` on the second read.
  const offset = cursorDigest === aggregation.digest ? cursorOffset : 0;

  const slice = aggregation.products.slice(offset, offset + context.pageSize);
  const items = slice.map((product) => toItem(product, aggregation));
  const nextOffset = offset + slice.length;
  const done = nextOffset >= aggregation.products.length;

  return {
    items,
    next: done ? null : { d: aggregation.digest, o: nextOffset },
    // Every pass reads the whole dump, so its last page IS a complete
    // enumeration of what the chain had inside the window.
    complete: done,
  };
}

async function aggregate(context: OpenDataPageContext, chain: string): Promise<Aggregation> {
  const signal = context.signal;
  const [prices, locationsDump] = await Promise.all([
    context.http.download(PRICES_DUMP_URL, {
      maxAgeMs: DUMP_MAX_AGE_MS,
      minIntervalMs: openPricesProvider.minRequestIntervalMs,
      ...(signal ? { signal } : {}),
    }),
    context.http.download(LOCATIONS_DUMP_URL, {
      maxAgeMs: DUMP_MAX_AGE_MS,
      minIntervalMs: openPricesProvider.minRequestIntervalMs,
      ...(signal ? { signal } : {}),
    }),
  ]);

  const territories = [...context.territories].map((code) => code.toUpperCase()).sort();
  const key = `${prices.digest}|${locationsDump.digest}|${chain}|${territories.join(',')}`;
  const cached = aggregations.get(key);
  if (cached !== undefined) return cached;

  const allLocations = await readOpenPricesLocations(locationsDump.path);
  const locations = new Map<number, OpenPricesLocation>();
  for (const location of allLocations.values()) {
    if (location.chain !== chain) continue;
    if (
      territories.length > 0 &&
      (location.countryCode === undefined || !territories.includes(location.countryCode))
    )
      continue;
    locations.set(location.id, location);
  }

  const windowStart = context.now.getTime() - OPEN_PRICES_WINDOW_DAYS * DAY_MS;
  const byGtin = new Map<string, ChainProductAggregate>();
  for await (const row of readJsonLines(prices.path)) {
    const locationId = asNumber(row.location_id);
    if (locationId === undefined || !locations.has(locationId)) continue;
    // A CATEGORY price (loose fruit by the kilo) has no GTIN and therefore no
    // product identity a comparison could join on.
    if (
      asText(row.type) !== 'PRODUCT' ||
      (row.duplicate_of !== null && row.duplicate_of !== undefined)
    )
      continue;
    const gtin = gtinDigits(row.product_code);
    const date = asDate(row.date);
    const currency = asText(row.currency);
    const money = decimalMoney(row.price, currency);
    if (gtin === undefined || date === undefined || money === undefined) continue;
    if (date.getTime() < windowStart || date.getTime() > context.now.getTime() + DAY_MS) continue;

    const sighting: PriceSighting = {
      id: asNumber(row.id) ?? 0,
      locationId,
      date,
      createdAt: asDate(row.created),
      amount: money.amount,
      currency: money.currency,
      row,
    };
    const location = locations.get(locationId);
    const existing = byGtin.get(gtin);
    if (existing === undefined) {
      byGtin.set(gtin, {
        gtin,
        latest: sighting,
        sightings: 1,
        shops: new Set([locationId]),
        cities: new Set(location?.city === undefined ? [] : [location.city]),
        minAmount: money.amount,
        maxAmount: money.amount,
        currency: money.currency,
      });
      continue;
    }
    // Two currencies for one product in one chain is a data error at the
    // source; the first currency seen wins and the other sighting is ignored
    // rather than mixed into a min/max that would compare euros with zlotys.
    if (money.currency !== existing.currency) continue;
    existing.sightings += 1;
    existing.shops.add(locationId);
    if (location?.city !== undefined) existing.cities.add(location.city);
    existing.minAmount = Math.min(existing.minAmount, money.amount);
    existing.maxAmount = Math.max(existing.maxAmount, money.amount);
    if (isNewer(sighting, existing.latest)) existing.latest = sighting;
  }

  const chainName = [...locations.values()][0]?.chainName ?? chain;
  const aggregation: Aggregation = {
    digest: `${prices.digest.slice(0, 32)}${locationsDump.digest.slice(0, 32)}`,
    chainName,
    // Sorted by GTIN so a page boundary means the same thing on every read.
    products: [...byGtin.values()].sort((left, right) =>
      left.gtin < right.gtin ? -1 : left.gtin > right.gtin ? 1 : 0,
    ),
    locations,
  };
  aggregations.set(key, aggregation);
  while (aggregations.size > MAX_CACHED_AGGREGATIONS) {
    const oldest = aggregations.keys().next().value;
    if (oldest === undefined) break;
    aggregations.delete(oldest);
  }
  return aggregation;
}

/** Newer by sighting date, then by when it was submitted, then by id. */
function isNewer(candidate: PriceSighting, current: PriceSighting): boolean {
  if (candidate.date.getTime() !== current.date.getTime()) return candidate.date > current.date;
  const left = candidate.createdAt?.getTime() ?? 0;
  const right = current.createdAt?.getTime() ?? 0;
  if (left !== right) return left > right;
  return candidate.id > current.id;
}

function toItem(product: ChainProductAggregate, aggregation: Aggregation): OpenDataItem {
  const row = product.latest.row;
  const location = aggregation.locations.get(product.latest.locationId);
  const discounted = row.price_is_discounted === true;
  const compareAt = discounted
    ? decimalMoney(row.price_without_discount, product.currency)
    : undefined;

  const facts = new FactCollector('open_prices')
    .add('sighting_date', product.latest.date.toISOString().slice(0, 10))
    .add('sightings', product.sightings)
    .add('shops_observed', product.shops.size)
    .add('cities_observed', [...product.cities].sort())
    .add('min_price', product.minAmount, `${product.currency} minor units`)
    .add('max_price', product.maxAmount, `${product.currency} minor units`)
    .add('window_days', OPEN_PRICES_WINDOW_DAYS)
    .flag('price_is_discounted', row.price_is_discounted)
    .text('discount_type', row.discount_type)
    .text('price_per', row.price_per)
    .number('receipt_quantity', row.receipt_quantity)
    .list('labels', row.labels_tags)
    .list('origins', row.origins_tags)
    .add('proof_attached', row.proof_id !== null && row.proof_id !== undefined)
    .text('shop_type', location?.shopType)
    .text(
      'shop_osm',
      location?.osmType !== undefined && location.osmId !== undefined
        ? `${location.osmType.toLowerCase()}/${String(location.osmId)}`
        : undefined,
    )
    .text('shop_postcode', location?.postcode)
    .text('chain_logo_url', location?.logoUrl)
    .add('price_id', product.latest.id)
    .toArray();

  const normalized: NormalizedSourceRecord = {
    // More than half of the dump's prices carry no product name — the name
    // lives on Open Food Facts. The GTIN stands in so the record is storable,
    // and identity is decided by the identifier, never by this title.
    title: asText(row.product_name) ?? product.gtin,
    identifiers: [{ scheme: 'gtin', value: product.gtin }],
    options: [],
    media: [],
    merchantHint: aggregation.chainName,
    ...(location?.city === undefined ? {} : { storefrontHint: location.city }),
    price: { amount: product.latest.amount, currency: product.currency },
    ...(compareAt === undefined || compareAt.amount <= product.latest.amount
      ? {}
      : { compareAtPrice: compareAt }),
    conditionLabel: 'new',
    ...(location?.countryCode === undefined ? {} : { country: location.countryCode }),
    ...(location?.city === undefined ? {} : { region: location.city }),
    sourceUrl: `https://prices.openfoodfacts.org/products/${product.gtin}`,
    sourceCreatedAt: product.latest.date.toISOString(),
    sourceUpdatedAt: product.latest.date.toISOString(),
    facts,
  };

  return {
    externalType: 'offer',
    externalId: product.gtin,
    normalized,
    sourceUpdatedAt: product.latest.date,
    raw: {
      priceId: product.latest.id,
      locationId: product.latest.locationId,
      date: asText(row.date),
      price: asText(row.price),
    },
  };
}

/** Every shop in the locations dump, keyed by Open Prices' own location id. */
export async function readOpenPricesLocations(
  path: string,
): Promise<Map<number, OpenPricesLocation>> {
  const result = new Map<number, OpenPricesLocation>();
  for await (const row of readJsonLines(path)) {
    const id = asNumber(row.id);
    if (id === undefined) continue;
    const chainName = asText(row.osm_brand) ?? asText(row.osm_name);
    if (chainName === undefined) continue;
    const countryCode = asText(row.osm_address_country_code)?.toUpperCase();
    result.set(id, {
      id,
      chain: subFeedKey(chainName),
      chainName,
      countryCode,
      city: asText(row.osm_address_city),
      postcode: asText(row.osm_address_postcode),
      osmType: asText(row.osm_type),
      osmId: asNumber(row.osm_id),
      shopType: asText(row.osm_tag_value),
      logoUrl: asText(row.osm_brand_logo_url),
    });
  }
  return result;
}

/** One JSON object per line of a gzipped dump. A malformed line is skipped. */
async function* readJsonLines(path: string): AsyncGenerator<Readonly<Record<string, unknown>>> {
  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let seen = 0;
  let parsed = 0;
  for await (const line of lines) {
    if (line.trim() === '') continue;
    seen += 1;
    try {
      const value = asObject(JSON.parse(line));
      if (value === undefined) continue;
      parsed += 1;
      yield value;
    } catch {
      continue;
    }
  }
  // A dump of lines none of which parse is a format change, not an empty
  // catalogue — and a complete pass over "nothing" would retire everything.
  if (seen > 0 && parsed === 0) {
    throw new OpenDataSchemaError(`${path} has ${String(seen)} lines and none is a JSON object.`);
  }
}
