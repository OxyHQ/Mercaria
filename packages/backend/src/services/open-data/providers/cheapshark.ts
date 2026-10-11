/**
 * CHEAPSHARK — current PC game prices across ~15 digital stores (Steam, GOG,
 * Humble, Fanatical, Epic, GreenManGaming…), keyless.
 *
 * ## One source per store
 *
 * A source's account ref is CheapShark's `storeID` ("1" is Steam, "7" is GOG),
 * and the source is bound to that store's merchant. `GET /stores` lists them;
 * the operator picks the ones worth comparing.
 *
 * ## What it can and cannot claim
 *
 * The deals listing pages through a store's catalogue sorted by title, and it
 * is a moving listing — a price change re-sorts nothing, but a title added
 * mid-pass shifts every later page by one. A pass can therefore skip a game it
 * should have seen, so it never reports a complete enumeration and never
 * retires anything by omission; offer freshness (#68) expires what stops being
 * refreshed. Prices are in USD for the US storefront: CheapShark publishes no
 * other market.
 *
 * Its terms ask that a deal link go through its own redirect, which is the
 * `sourceUrl` here.
 */

import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import type {
  OpenDataItem,
  OpenDataPage,
  OpenDataPageContext,
  OpenDataProvider,
} from '../provider.js';
import { OpenDataConfigurationError, OpenDataSchemaError } from '../provider.js';
import type { OpenDataHttp } from '../http.js';
import { asArray, asNumber, asObject, asText, decimalMoney, FactCollector } from '../read.js';

export const CHEAPSHARK_PROVIDER = 'cheapshark';

const BASE_URL = 'https://www.cheapshark.com/api/1.0';
/** The endpoint's own ceiling. */
const PAGE_CAP = 60;
/** CheapShark asks for restraint and answers 429 when it is not shown. */
const INTERVAL_MS = 1_500;
const STORES_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

let storesCache: { readonly at: number; readonly names: ReadonlyMap<string, string> } | undefined;

export const cheapSharkProvider: OpenDataProvider = {
  slug: CHEAPSHARK_PROVIDER,
  name: 'CheapShark',
  homepage: 'https://www.cheapshark.com',
  role: 'prices',
  kind: 'marketplace_api',
  licence: 'provider_terms',
  attribution: 'Precios de juegos vía CheapShark',
  accountRefMeaning: 'the CheapShark store id (GET /api/1.0/stores; "1" is Steam, "7" is GOG)',
  accountRefRequired: true,
  refreshModes: ['incremental'],
  minRequestIntervalMs: INTERVAL_MS,
  fetchPage: fetchCheapSharkPage,
};

async function fetchCheapSharkPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const storeId = context.accountRef ?? '';
  if (!/^\d{1,4}$/u.test(storeId)) {
    throw new OpenDataConfigurationError(`"${storeId}" is not a CheapShark store id.`);
  }
  const storeName = (await storeNames(context.http, context.signal)).get(storeId);
  if (storeName === undefined) {
    throw new OpenDataConfigurationError(`CheapShark lists no active store with id ${storeId}.`);
  }

  const pageNumber = typeof context.cursor?.p === 'number' ? context.cursor.p : 0;
  const params = new URLSearchParams({
    storeID: storeId,
    pageNumber: String(pageNumber),
    pageSize: String(Math.min(Math.max(context.pageSize, 1), PAGE_CAP)),
    sortBy: 'Title',
  });
  const response = await context.http.getJson(`${BASE_URL}/deals?${params.toString()}`, {
    minIntervalMs: INTERVAL_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (response === null || !Array.isArray(response.body)) {
    throw new OpenDataSchemaError('the deals response is not an array.');
  }

  const items: OpenDataItem[] = [];
  for (const entry of asArray(response.body)) {
    const deal = asObject(entry);
    if (deal === undefined) continue;
    const item = toItem(deal, storeId, storeName);
    if (item !== null) items.push(item);
  }

  const totalPages = asNumber(response.headers.get('x-total-page-count')) ?? 0;
  const done = items.length === 0 || pageNumber + 1 >= totalPages;
  return { items, next: done ? null : { p: pageNumber + 1 }, complete: false };
}

/** Store id → name, for ACTIVE stores. Cached for a day; it changes yearly. */
async function storeNames(
  http: OpenDataHttp,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, string>> {
  if (storesCache !== undefined && Date.now() - storesCache.at < STORES_MAX_AGE_MS)
    return storesCache.names;
  const response = await http.getJson(`${BASE_URL}/stores`, {
    minIntervalMs: INTERVAL_MS,
    ...(signal ? { signal } : {}),
  });
  if (response === null || !Array.isArray(response.body)) {
    throw new OpenDataSchemaError('the stores response is not an array.');
  }
  const names = new Map<string, string>();
  for (const entry of asArray(response.body)) {
    const store = asObject(entry);
    const id = asText(store?.storeID);
    const name = asText(store?.storeName);
    if (id !== undefined && name !== undefined && asNumber(store?.isActive) === 1)
      names.set(id, name);
  }
  storesCache = { at: Date.now(), names };
  return names;
}

export function toItem(
  deal: Readonly<Record<string, unknown>>,
  storeId: string,
  storeName: string,
): OpenDataItem | null {
  const gameId = asText(deal.gameID);
  const title = asText(deal.title);
  const price = decimalMoney(deal.salePrice, 'USD');
  if (gameId === undefined || title === undefined || price === undefined) return null;
  const normal = decimalMoney(deal.normalPrice, 'USD');
  const dealId = asText(deal.dealID);
  const lastChange = asNumber(deal.lastChange);
  const releaseDate = asNumber(deal.releaseDate);
  const metacriticLink = asText(deal.metacriticLink);
  const thumb = asText(deal.thumb);

  const facts = new FactCollector('cheapshark')
    .add('game_id', gameId)
    .text('store_id', storeId)
    .text('store_name', storeName)
    .text('steam_app_id', deal.steamAppID)
    .text('internal_name', deal.internalName)
    .number('metacritic_score', deal.metacriticScore)
    .text(
      'metacritic_url',
      metacriticLink === undefined ? undefined : `https://www.metacritic.com${metacriticLink}`,
    )
    .text('steam_rating_text', deal.steamRatingText)
    .number('steam_rating_percent', deal.steamRatingPercent, '%')
    .number('steam_rating_count', deal.steamRatingCount)
    .number('deal_rating', deal.dealRating)
    .number('savings_percent', deal.savings, '%')
    .add('is_on_sale', asText(deal.isOnSale) === '1')
    .add(
      'release_date',
      releaseDate === undefined || releaseDate === 0
        ? undefined
        : new Date(releaseDate * 1_000).toISOString().slice(0, 10),
    )
    .toArray();

  const normalized: NormalizedSourceRecord = {
    title,
    identifiers: [],
    options: [],
    media: thumb === undefined ? [] : [thumb],
    merchantHint: storeName,
    price,
    ...(normal === undefined || normal.amount <= price.amount ? {} : { compareAtPrice: normal }),
    conditionLabel: 'new',
    categoryKey: 'video_games/pc',
    // `dealID` arrives already URL-encoded; re-encoding it would break the link.
    ...(dealId === undefined
      ? {}
      : { sourceUrl: `https://www.cheapshark.com/redirect?dealID=${dealId}` }),
    ...(lastChange === undefined
      ? {}
      : { sourceUpdatedAt: new Date(lastChange * 1_000).toISOString() }),
    facts,
  };

  return {
    externalType: 'offer',
    externalId: gameId,
    normalized,
    ...(lastChange === undefined ? {} : { sourceUpdatedAt: new Date(lastChange * 1_000) }),
    raw: {
      gameId,
      dealId: dealId ?? null,
      salePrice: asText(deal.salePrice) ?? null,
      lastChange: lastChange ?? null,
    },
  };
}
