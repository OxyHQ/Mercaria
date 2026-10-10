/**
 * GOG.COM CATALOGUE — every game, DLC and pack GOG sells, with the price for
 * the source's market (EUR for Spain), keyless.
 *
 * The endpoint is the one gog.com's own store pages call; it is not a
 * documented public API, so its shape is read defensively and a response
 * without `products` is schema drift, not an empty store.
 *
 * ## Enumeration
 *
 * A single listing stops at 10,000 products, below the catalogue's size, so a
 * pass walks it once per product type (games, DLC, packs, extras), each well
 * under the cap. A listing sorted by title can still shift when a title is
 * added mid-pass, so the provider never claims completeness; offer freshness
 * expires what a later pass stops seeing.
 */

import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import type { OpenDataItem, OpenDataPage, OpenDataPageContext, OpenDataProvider } from '../provider.js';
import { OpenDataSchemaError } from '../provider.js';
import { asArray, asNumber, asObject, asText, asTextList, decimalMoney, FactCollector } from '../read.js';

export const GOG_PROVIDER = 'gog_catalog';

const BASE_URL = 'https://catalog.gog.com/v1/catalog';
const PRODUCT_TYPES = ['game', 'dlc', 'pack', 'extras'] as const;
const PAGE_CAP = 48;
const INTERVAL_MS = 1_000;

/** Market → the currency GOG prices it in and the store locale. */
const MARKETS: Readonly<Record<string, { readonly currency: string; readonly locale: string }>> = {
  ES: { currency: 'EUR', locale: 'es-ES' },
  PT: { currency: 'EUR', locale: 'pt-BR' },
  FR: { currency: 'EUR', locale: 'fr-FR' },
  IT: { currency: 'EUR', locale: 'it-IT' },
  DE: { currency: 'EUR', locale: 'de-DE' },
  NL: { currency: 'EUR', locale: 'en-US' },
  IE: { currency: 'EUR', locale: 'en-US' },
  GB: { currency: 'GBP', locale: 'en-US' },
  US: { currency: 'USD', locale: 'en-US' },
  PL: { currency: 'PLN', locale: 'pl-PL' },
};

export const gogProvider: OpenDataProvider = {
  slug: GOG_PROVIDER,
  name: 'GOG.com',
  homepage: 'https://www.gog.com',
  role: 'catalogue_and_prices',
  kind: 'marketplace_api',
  licence: 'provider_terms',
  attribution: 'Catálogo y precios de GOG.com',
  accountRefMeaning: null,
  accountRefRequired: false,
  refreshModes: ['incremental'],
  minRequestIntervalMs: INTERVAL_MS,
  fetchPage: fetchGogPage,
};

async function fetchGogPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  // A market GOG is not configured for here falls back to Spain rather than
  // to GOG's own default (US dollars), which no source of this deployment wants.
  const requested = (context.territories[0] ?? 'ES').toUpperCase();
  const country = MARKETS[requested] === undefined ? 'ES' : requested;
  const market = MARKETS[country] ?? { currency: 'EUR', locale: 'es-ES' };
  const typeIndex = typeof context.cursor?.t === 'number' ? context.cursor.t : 0;
  const page = typeof context.cursor?.p === 'number' ? context.cursor.p : 1;
  const productType = PRODUCT_TYPES[typeIndex];
  if (productType === undefined) return { items: [], next: null, complete: false };

  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(context.pageSize, 1), PAGE_CAP)),
    page: String(page),
    order: 'asc:title',
    productType: `in:${productType}`,
    countryCode: country,
    currencyCode: market.currency,
    locale: market.locale,
  });
  const response = await context.http.getJson(`${BASE_URL}?${params.toString()}`, {
    minIntervalMs: INTERVAL_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const body = asObject(response?.body);
  if (body === undefined || !Array.isArray(body.products)) {
    throw new OpenDataSchemaError('the catalogue response has no `products` array.');
  }

  const items: OpenDataItem[] = [];
  for (const entry of asArray(body.products)) {
    const product = asObject(entry);
    if (product === undefined) continue;
    const item = toItem(product, country);
    if (item !== null) items.push(item);
  }

  const pages = asNumber(body.pages) ?? 0;
  const typeDone = items.length === 0 || page >= pages;
  const next = typeDone
    ? typeIndex + 1 < PRODUCT_TYPES.length
      ? { t: typeIndex + 1, p: 1 }
      : null
    : { t: typeIndex, p: page + 1 };
  return { items, next, complete: false };
}

/** GOG's `2025.04.16` → `2025-04-16`. */
function gogDate(value: unknown): string | undefined {
  const text = asText(value);
  return text !== undefined && /^\d{4}\.\d{2}\.\d{2}$/u.test(text) ? text.replace(/\./gu, '-') : undefined;
}

function names(value: unknown): string[] {
  return asArray(value)
    .map((entry) => asText(asObject(entry)?.name))
    .filter((name): name is string => name !== undefined);
}

export function toItem(product: Readonly<Record<string, unknown>>, country: string): OpenDataItem | null {
  const id = asText(product.id);
  const title = asText(product.title);
  const price = asObject(product.price);
  const finalMoney = asObject(price?.finalMoney);
  const baseMoney = asObject(price?.baseMoney);
  const amount = decimalMoney(finalMoney?.amount, asText(finalMoney?.currency));
  if (id === undefined || title === undefined || amount === undefined) return null;
  const base = decimalMoney(baseMoney?.amount, asText(baseMoney?.currency));
  const language = asObject(product.userPreferredLanguage);
  const developer = asTextList(product.developers)[0];
  const productType = asText(product.productType);
  const storeLink = asText(product.storeLink);
  const media = [product.coverHorizontal, product.coverVertical, product.logo]
    .map((value) => asText(value))
    .filter((value): value is string => value !== undefined);

  const facts = new FactCollector('gog')
    .add('product_id', id)
    .text('slug', product.slug)
    .text('product_type', product.productType)
    .text('product_state', product.productState)
    .list('developers', product.developers)
    .list('publishers', product.publishers)
    .list('operating_systems', product.operatingSystems)
    .add('genres', names(product.genres))
    .add('tags', names(product.tags))
    .add('features', names(product.features))
    .add('release_date', gogDate(product.releaseDate))
    .add('store_release_date', gogDate(product.storeReleaseDate))
    .number('reviews_rating', product.reviewsRating, 'of 50')
    .number('reviews_count', product.reviewsCount)
    .number('discount_amount', finalMoney?.discount, asText(finalMoney?.currency))
    .text('discount_label', price?.discount)
    .number('editions', asArray(product.editions).length)
    .text('preferred_language', language?.code)
    .flag('preferred_language_in_audio', language?.inAudio)
    .flag('preferred_language_in_text', language?.inText)
    .toArray();

  const normalized: NormalizedSourceRecord = {
    title,
    identifiers: [],
    options: [],
    media,
    merchantHint: 'GOG.com',
    ...(developer === undefined ? {} : { brandHint: developer }),
    price: amount,
    ...(base === undefined || base.amount <= amount.amount ? {} : { compareAtPrice: base }),
    conditionLabel: 'new',
    availability: asText(product.productState) === 'default' ? 'in_stock' : 'unknown',
    country,
    ...(productType === undefined ? {} : { categoryKey: `gog:${productType}` }),
    ...(storeLink === undefined ? {} : { sourceUrl: storeLink }),
    facts,
  };

  return {
    externalType: 'offer',
    externalId: id,
    normalized,
    raw: { id, final: asText(finalMoney?.amount) ?? null, base: asText(baseMoney?.amount) ?? null },
  };
}
