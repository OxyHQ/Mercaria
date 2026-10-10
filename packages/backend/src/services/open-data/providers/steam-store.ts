/**
 * STEAM STORE — the games on sale on Steam for a market, with that market's
 * price, read from the store's own search.
 *
 * Steam has no keyless catalogue API: `appdetails` answers one app at a time
 * (about 200 calls in five minutes), and the app list moved behind a key. The
 * store's search page loads its results as JSON-wrapped HTML fragments, one row
 * per item, carrying the app id, the title, the release date, the review summary,
 * the platforms and the price in the market's minor units. So this is an
 * EXTRACTION provider: it reads a page Steam serves to browsers, under a
 * `robots_respecting` policy, and checks `robots.txt` before every pass.
 *
 * ## Bounded on purpose
 *
 * The search lists ~180,000 games. A pass reads the first
 * {@link STEAM_MAX_RESULTS} in Steam's own relevance order — what people in that
 * market actually buy — rather than the whole store into a shared database.
 * Free games are skipped: a price of nothing compares with nothing.
 *
 * ## Identity
 *
 * The app id is the `productGroupKey` (ADR 0016); bundles and packages, which
 * are not one product, are skipped.
 */

import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import {
  OpenDataConfigurationError,
  OpenDataSchemaError,
  type OpenDataItem,
  type OpenDataPage,
  type OpenDataPageContext,
  type OpenDataProvider,
} from '../provider.js';
import { asNumber, asObject, asText, FactCollector, minorMoney } from '../read.js';
import { robotsAllows } from '../robots.js';

export const STEAM_STORE_PROVIDER = 'steam_store';

const ORIGIN = 'https://store.steampowered.com';
const SEARCH_PATH = '/search/results/';
/** Steam answers at most 100 rows a call. */
const PAGE_CAP = 100;
/** How deep one pass reads, in relevance order. */
export const STEAM_MAX_RESULTS = 10_000;
/** A browsing human's pace, well inside the store's tolerance. */
const INTERVAL_MS = 1_500;

/** Market → the store's currency there and its language. */
const MARKETS: Readonly<Record<string, { readonly currency: string; readonly language: string }>> =
  {
    ES: { currency: 'EUR', language: 'spanish' },
    PT: { currency: 'EUR', language: 'portuguese' },
    FR: { currency: 'EUR', language: 'french' },
    IT: { currency: 'EUR', language: 'italian' },
    DE: { currency: 'EUR', language: 'german' },
    GB: { currency: 'GBP', language: 'english' },
    US: { currency: 'USD', language: 'english' },
  };

export const steamStoreProvider: OpenDataProvider = {
  slug: STEAM_STORE_PROVIDER,
  name: 'Steam',
  homepage: 'https://store.steampowered.com',
  role: 'catalogue_and_prices',
  kind: 'marketplace_api',
  licence: 'provider_terms',
  attribution: 'Juegos y precios de la tienda de Steam',
  accountRefMeaning: null,
  accountRefRequired: false,
  extraction: true,
  refreshModes: ['incremental'],
  minRequestIntervalMs: INTERVAL_MS,
  fetchPage: fetchSteamPage,
};

async function fetchSteamPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const country = (context.territories[0] ?? 'ES').toUpperCase();
  const market = MARKETS[country];
  if (market === undefined)
    throw new OpenDataConfigurationError(`Steam market ${country} is not mapped to a currency.`);
  const start = typeof context.cursor?.s === 'number' ? context.cursor.s : 0;

  if (start === 0) {
    const robots = await context.http.getText(`${ORIGIN}/robots.txt`, {
      minIntervalMs: INTERVAL_MS,
      allowNotFound: true,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (!robotsAllows(robots, 'Mercaria', SEARCH_PATH)) {
      throw new OpenDataConfigurationError(
        `${ORIGIN}/robots.txt disallows ${SEARCH_PATH}; Steam is not read.`,
      );
    }
  }

  const count = Math.min(Math.max(context.pageSize, 1), PAGE_CAP);
  const params = new URLSearchParams({
    start: String(start),
    count: String(count),
    cc: country.toLowerCase(),
    l: market.language,
    infinite: '1',
    // Games only: no DLC, soundtracks, software or videos.
    category1: '998',
    json: '1',
  });
  const response = await context.http.getJson(`${ORIGIN}${SEARCH_PATH}?${params.toString()}`, {
    minIntervalMs: INTERVAL_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const body = asObject(response?.body);
  const html = asText(body?.results_html);
  if (body === undefined || html === undefined) {
    throw new OpenDataSchemaError('the search response has no `results_html`.');
  }

  const rows = searchRows(html);
  const items = rows
    .map((row) => toItem(row, { country, currency: market.currency }))
    .filter((item): item is OpenDataItem => item !== null);
  const total = asNumber(body.total_count) ?? 0;
  // Steam may answer more rows than asked for; the next page starts after
  // what it actually served.
  const nextStart = start + rows.length;
  const done = rows.length === 0 || nextStart >= Math.min(total, STEAM_MAX_RESULTS);
  return { items, next: done ? null : { s: nextStart }, complete: false };
}

/** One search result, as the row's attributes and inner fragments say. */
export interface SteamSearchRow {
  readonly appId: string | undefined;
  readonly url: string | undefined;
  readonly title: string | undefined;
  readonly released: string | undefined;
  readonly image: string | undefined;
  readonly priceFinalMinor: number | undefined;
  readonly originalPrice: string | undefined;
  readonly discountPercent: number | undefined;
  readonly review: string | undefined;
  readonly platforms: readonly string[];
  readonly tagIds: readonly number[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function firstGroup(pattern: RegExp, text: string): string | undefined {
  const value = pattern.exec(text)?.[1]?.trim();
  return value === undefined || value === '' ? undefined : decodeEntities(value);
}

/** Split the fragment into rows and read each. Pure, so the fixture tests it. */
export function searchRows(html: string): SteamSearchRow[] {
  const rows: SteamSearchRow[] = [];
  for (const match of html.matchAll(
    /<a href="([^"]+)"([^>]*?)class="search_result_row[\s\S]*?<\/a>/gu,
  )) {
    const [row, href, attributes] = match;
    const tagIds = firstGroup(/data-ds-tagids="\[([^\]]*)\]"/u, attributes ?? '');
    const price = firstGroup(/data-price-final="(\d+)"/u, row);
    const discount = firstGroup(/data-discount="(\d+)"/u, row);
    rows.push({
      appId: firstGroup(/data-ds-appid="(\d+)"/u, attributes ?? ''),
      url: href?.replace(/\?snr=[^"]*$/u, ''),
      title: firstGroup(/<span class="title">([\s\S]*?)<\/span>/u, row),
      released: firstGroup(/<div class="search_released[^"]*">([\s\S]*?)<\/div>/u, row),
      image: firstGroup(/<div class="search_capsule"><img src="([^"]+)"/u, row),
      priceFinalMinor: price === undefined ? undefined : Number(price),
      originalPrice: firstGroup(/<div class="discount_original_price">([^<]+)<\/div>/u, row),
      discountPercent: discount === undefined ? undefined : Number(discount),
      review: firstGroup(/data-tooltip-html="([^"]+)"/u, row)?.replace(/<br>[\s\S]*$/u, ''),
      platforms: [...row.matchAll(/platform_img (\w+)/gu)]
        .map((platform) => platform[1] ?? '')
        .filter((name) => name !== ''),
      tagIds: (tagIds ?? '')
        .split(',')
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isInteger(id) && id > 0),
    });
  }
  return rows;
}

/** `59,99€` → 5999. Steam formats with the market's decimal comma. */
function formattedMinor(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const digits = text.replace(/[^\d,.]/gu, '');
  const match = /^(\d+)(?:[.,](\d{2}))?$/u.exec(digits.replace(/[.,](?=\d{3}\b)/gu, ''));
  if (match === null) return undefined;
  return Number(match[1]) * 100 + Number(match[2] ?? '0');
}

export function toItem(
  row: SteamSearchRow,
  market: { readonly country: string; readonly currency: string },
): OpenDataItem | null {
  if (row.appId === undefined || row.title === undefined || row.priceFinalMinor === undefined)
    return null;
  // Free to play, or no price in this market.
  if (row.priceFinalMinor === 0) return null;
  const price = minorMoney(row.priceFinalMinor, market.currency);
  if (price === undefined) return null;
  const originalMinor = formattedMinor(row.originalPrice);
  const compareAt =
    originalMinor === undefined || originalMinor <= price.amount
      ? undefined
      : minorMoney(originalMinor, market.currency);

  const facts = new FactCollector('steam')
    .add('app_id', row.appId)
    .text('release_date', row.released)
    .text('review_summary', row.review)
    .add('platforms', [...row.platforms])
    .add('tag_ids', row.tagIds.map(String))
    .number('discount_percent', row.discountPercent, '%')
    .toArray();

  const normalized: NormalizedSourceRecord = {
    title: row.title,
    identifiers: [],
    options: [],
    productGroupKey: row.appId,
    media: row.image === undefined ? [] : [row.image],
    merchantHint: 'Steam',
    price,
    ...(compareAt === undefined ? {} : { compareAtPrice: compareAt }),
    conditionLabel: 'new',
    availability: 'in_stock',
    country: market.country,
    categoryKey: 'video_games/pc',
    ...(row.url === undefined ? {} : { sourceUrl: row.url }),
    facts,
  };
  return {
    externalType: 'offer',
    externalId: row.appId,
    normalized,
    raw: { appId: row.appId, price: row.priceFinalMinor, original: row.originalPrice ?? null },
  };
}
