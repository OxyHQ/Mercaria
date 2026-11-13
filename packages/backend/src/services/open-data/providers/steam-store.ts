/**
 * STEAM STORE — the games on sale on Steam for a market, with that market's
 * price, read from the search rows Clarity crawls.
 *
 * Steam has no keyless catalogue API: `appdetails` answers one app at a time
 * (about 200 calls in five minutes), and the app list moved behind a key. The
 * store's search page loads its results as JSON-wrapped HTML fragments, one row
 * per item, carrying the app id, the title, the release date, the review summary,
 * the platforms and the price in the market's minor units.
 *
 * ## Clarity fetches; Mercaria reads
 *
 * Mercaria no longer requests the store. Clarity — Oxy's one crawler of stores
 * — polls the search for each market as a `steam_store` product feed, under
 * robots.txt for ClarityBot and at a browsing pace, and keeps each game's row
 * exactly as rendered (`services/clarity/product-feeds.ts`). This provider pages
 * through those rows and reads them with {@link searchRows} and {@link toItem},
 * the same mapping it always had.
 *
 * ## Bounded on purpose
 *
 * The search lists ~180,000 games. Clarity's walk keeps the first 10,000 in
 * Steam's own relevance order — what people in that market actually buy —
 * rather than the whole store into a shared database. Free games are skipped: a
 * price of nothing compares with nothing.
 *
 * ## Identity
 *
 * The app id is the `productGroupKey` (ADR 0016); bundles and packages, which
 * are not one product, are skipped.
 */

import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import type {
  OpenDataItem,
  OpenDataPage,
  OpenDataPageContext,
  OpenDataProvider,
} from '../provider.js';
import { asObject, asText, FactCollector, minorMoney } from '../read.js';
import { ensureProductFeed, productFeedRecords } from '../../clarity/product-feeds.js';

export const STEAM_STORE_PROVIDER = 'steam_store';

/** The most rows one page asks Clarity for. */
const PAGE_CAP = 500;

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
  refreshModes: ['incremental'],
  // Clarity's API, not the store: the store's pace is Clarity's to keep.
  minRequestIntervalMs: 0,
  fetchPage: fetchSteamPage,
};

async function fetchSteamPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const country = (context.territories[0] ?? 'ES').toUpperCase();
  const feedId =
    typeof context.cursor?.f === 'string'
      ? context.cursor.f
      : (await ensureProductFeed('steam_store', country)).id;
  const page = await productFeedRecords(feedId, {
    ...(typeof context.cursor?.r === 'string' ? { cursor: context.cursor.r } : {}),
    limit: Math.min(Math.max(context.pageSize, 1), PAGE_CAP),
  });

  // The market's currency is the feed's own term, as Clarity read the store for
  // that market — never derived here from the country.
  const currency = asText(asObject(page.feed.meta)?.currency);
  if (currency === undefined || !/^[A-Z]{3}$/u.test(currency)) {
    // Clarity has not read this market yet: nothing to map, and nothing proven gone.
    return { items: [], next: null, complete: false };
  }

  const items: OpenDataItem[] = [];
  for (const record of page.records) {
    const html = asText(asObject(record.payload)?.html);
    if (html === undefined) continue;
    for (const row of searchRows(html)) {
      const item = toItem(row, { country, currency });
      if (item !== null) items.push(item);
    }
  }
  return {
    items,
    next: page.nextCursor === null ? null : { f: feedId, r: page.nextCursor },
    complete: false,
  };
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
