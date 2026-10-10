/**
 * SCRYFALL — every printed Magic: The Gathering card, with Cardmarket's EUR
 * market price per finish, keyless.
 *
 * ## One offer per printing per finish
 *
 * A card's non-foil and foil copies trade at different prices and are
 * different things to a buyer, so each priced finish is its own record
 * (`<card id>:nonfoil`, `<card id>:foil`) carrying a `Finish` OPTION — a real
 * variant axis the matcher compares — and the rest of the card as facts.
 *
 * ## What the price is
 *
 * Scryfall's `eur` is Cardmarket's daily TREND price, not one seller's asking
 * price. The records are bound to a Cardmarket merchant and say so in a fact
 * (`scryfall.price_basis`), so a surface can label it as a market price.
 *
 * ## Terms
 *
 * Scryfall asks for 50–100 ms between requests, a descriptive User-Agent and
 * an `Accept` header, and forbids paywalling its data or implying endorsement.
 * The interval below honours the first; `http.ts` sends the other two.
 */

import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import type { OpenDataItem, OpenDataPage, OpenDataPageContext, OpenDataProvider } from '../provider.js';
import { OpenDataSchemaError } from '../provider.js';
import { asArray, asNumber, asObject, asText, decimalMoney, FactCollector } from '../read.js';

export const SCRYFALL_PROVIDER = 'scryfall';

const SEARCH_URL = 'https://api.scryfall.com/cards/search';
/** Every paper printing Cardmarket prices. */
const QUERY = 'game:paper (eur>0 or eurfoil>0)';
const INTERVAL_MS = 120;

export const scryfallProvider: OpenDataProvider = {
  slug: SCRYFALL_PROVIDER,
  name: 'Scryfall',
  homepage: 'https://scryfall.com',
  role: 'catalogue_and_prices',
  kind: 'marketplace_api',
  licence: 'provider_terms',
  attribution: 'Datos de cartas de Scryfall; precios de mercado de Cardmarket',
  accountRefMeaning: null,
  accountRefRequired: false,
  refreshModes: ['incremental'],
  minRequestIntervalMs: INTERVAL_MS,
  fetchPage: fetchScryfallPage,
};

async function fetchScryfallPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const page = typeof context.cursor?.p === 'number' ? context.cursor.p : 1;
  const params = new URLSearchParams({ q: QUERY, unique: 'prints', order: 'set', page: String(page) });
  const response = await context.http.getJson(`${SEARCH_URL}?${params.toString()}`, {
    minIntervalMs: INTERVAL_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const body = asObject(response?.body);
  if (body === undefined || !Array.isArray(body.data)) {
    throw new OpenDataSchemaError('the search response has no `data` array.');
  }

  const items: OpenDataItem[] = [];
  for (const entry of asArray(body.data)) {
    const card = asObject(entry);
    if (card !== undefined) items.push(...toItems(card));
  }

  // The NUMBER is followed rather than `next_page` itself, so a response can
  // never point the next request at a host that is not Scryfall's.
  const more = body.has_more === true;
  // A sorted search can shift as cards are added, so a pass is never claimed
  // complete; freshness expires what stops appearing.
  return { items, next: more ? { p: page + 1 } : null, complete: false };
}

/** One card → one record per priced finish. */
export function toItems(card: Readonly<Record<string, unknown>>): OpenDataItem[] {
  const id = asText(card.id);
  const name = asText(card.name);
  if (id === undefined || name === undefined) return [];
  const prices = asObject(card.prices);
  const setName = asText(card.set_name);
  const collectorNumber = asText(card.collector_number);
  const title = setName === undefined ? name : `${name} — ${setName}${collectorNumber === undefined ? '' : ` #${collectorNumber}`}`;
  const firstFace = asObject(asArray(card.card_faces)[0]);
  const images = asObject(card.image_uris) ?? asObject(firstFace?.image_uris);
  const media = [images?.large, images?.normal]
    .map((value) => asText(value))
    .filter((value): value is string => value !== undefined)
    .slice(0, 1);
  const purchase = asObject(card.purchase_uris);
  const cardmarketUrl = asText(purchase?.cardmarket);
  const legalities = asObject(card.legalities);
  const legalIn = legalities === undefined
    ? []
    : Object.entries(legalities).filter(([, status]) => status === 'legal').map(([format]) => format).sort();
  const released = asText(card.released_at);

  const facts = new FactCollector('scryfall')
    .add('card_id', id)
    .text('oracle_id', card.oracle_id)
    .text('name', name)
    .text('lang', card.lang)
    .text('released_at', released)
    .text('layout', card.layout)
    .text('mana_cost', card.mana_cost ?? firstFace?.mana_cost)
    .number('cmc', card.cmc)
    .text('type_line', card.type_line)
    .text('oracle_text', card.oracle_text ?? firstFace?.oracle_text)
    .text('power', card.power)
    .text('toughness', card.toughness)
    .text('loyalty', card.loyalty)
    .list('colors', card.colors)
    .list('color_identity', card.color_identity)
    .list('keywords', card.keywords)
    .text('set', card.set)
    .text('set_name', setName)
    .text('set_type', card.set_type)
    .text('collector_number', collectorNumber)
    .text('rarity', card.rarity)
    .text('artist', card.artist)
    .text('border_color', card.border_color)
    .text('frame', card.frame)
    .list('frame_effects', card.frame_effects)
    .list('finishes', card.finishes)
    .list('games', card.games)
    .add('legal_in', legalIn)
    .flag('full_art', card.full_art)
    .flag('textless', card.textless)
    .flag('promo', card.promo)
    .flag('reprint', card.reprint)
    .flag('variation', card.variation)
    .flag('reserved', card.reserved)
    .flag('booster', card.booster)
    .number('edhrec_rank', card.edhrec_rank)
    .number('penny_rank', card.penny_rank)
    .number('cardmarket_id', card.cardmarket_id)
    .number('tcgplayer_id', card.tcgplayer_id)
    .number('mtgo_id', card.mtgo_id)
    .number('arena_id', card.arena_id)
    .number('price_usd', asNumber(prices?.usd), 'USD')
    .number('price_usd_foil', asNumber(prices?.usd_foil), 'USD')
    .number('price_tix', asNumber(prices?.tix), 'MTGO tix')
    .add('price_basis', 'cardmarket_trend')
    .toArray();

  const finishes: { readonly key: 'nonfoil' | 'foil'; readonly label: string; readonly price: unknown }[] = [
    { key: 'nonfoil', label: 'Nonfoil', price: prices?.eur },
    { key: 'foil', label: 'Foil', price: prices?.eur_foil },
  ];
  const items: OpenDataItem[] = [];
  for (const finish of finishes) {
    const price = decimalMoney(finish.price, 'EUR');
    if (price === undefined) continue;
    const normalized: NormalizedSourceRecord = {
      title,
      identifiers: [],
      options: [{ name: 'Finish', value: finish.label }],
      media,
      merchantHint: 'Cardmarket',
      brandHint: 'Magic: The Gathering',
      price,
      categoryKey: 'trading_cards/magic_the_gathering',
      ...(asText(card.lang) === undefined ? {} : { language: asText(card.lang) }),
      ...(cardmarketUrl === undefined ? {} : { sourceUrl: cardmarketUrl }),
      ...(released === undefined ? {} : { sourceCreatedAt: `${released}T00:00:00.000Z` }),
      facts,
    };
    items.push({
      externalType: 'offer',
      externalId: `${id}:${finish.key}`,
      normalized,
      raw: { id, finish: finish.key, price: asText(finish.price) ?? null },
    });
  }
  return items;
}
