/**
 * YGOPRODECK — every Yu-Gi-Oh! card, with its Cardmarket EUR market price,
 * keyless.
 *
 * One record per CARD: YGOPRODeck prices the card, not each printing, and its
 * `cardmarket_price` is Cardmarket's market price in euros. The card id is the
 * `productGroupKey` (ADR 0016), so the card is seeded as one product and the
 * record is its offer at Cardmarket. The other marketplaces' prices it
 * publishes (TCGplayer, eBay, Amazon, CoolStuffInc, all USD) are kept as facts:
 * they describe the market, and none of them is a price Mercaria can attribute
 * to a merchant in Spain.
 *
 * ## Terms
 *
 * 20 requests a second at most, and images must not be hotlinked — so this
 * provider stores no image URL. The data is cached by Mercaria, as asked.
 */

import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import type {
  OpenDataItem,
  OpenDataPage,
  OpenDataPageContext,
  OpenDataProvider,
} from '../provider.js';
import { OpenDataSchemaError } from '../provider.js';
import { asArray, asNumber, asObject, asText, decimalMoney, FactCollector } from '../read.js';

export const YGOPRODECK_PROVIDER = 'ygoprodeck';

const BASE_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const PAGE_CAP = 100;
/** Their limit is 20 a second; five is plenty. */
const INTERVAL_MS = 200;

export const ygoprodeckProvider: OpenDataProvider = {
  slug: YGOPRODECK_PROVIDER,
  name: 'YGOPRODeck',
  homepage: 'https://ygoprodeck.com',
  role: 'catalogue_and_prices',
  kind: 'marketplace_api',
  licence: 'provider_terms',
  attribution: 'Cartas de Yu-Gi-Oh! y precios de Cardmarket vía YGOPRODeck',
  accountRefMeaning: null,
  accountRefRequired: false,
  refreshModes: ['incremental'],
  minRequestIntervalMs: INTERVAL_MS,
  fetchPage: fetchYgoprodeckPage,
};

async function fetchYgoprodeckPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const offset = typeof context.cursor?.o === 'number' ? context.cursor.o : 0;
  const num = Math.min(Math.max(context.pageSize, 1), PAGE_CAP);
  const response = await context.http.getJson(
    `${BASE_URL}?num=${String(num)}&offset=${String(offset)}&misc=yes`,
    {
      minIntervalMs: INTERVAL_MS,
      ...(context.signal ? { signal: context.signal } : {}),
    },
  );
  const body = asObject(response?.body);
  if (body === undefined || !Array.isArray(body.data)) {
    throw new OpenDataSchemaError('the cardinfo response has no `data` array.');
  }

  const items: OpenDataItem[] = [];
  for (const entry of asArray(body.data)) {
    const card = asObject(entry);
    if (card === undefined) continue;
    const item = toItem(card);
    if (item !== null) items.push(item);
  }

  const nextOffset = asNumber(asObject(body.meta)?.next_page_offset);
  return { items, next: nextOffset === undefined ? null : { o: nextOffset }, complete: false };
}

export function toItem(card: Readonly<Record<string, unknown>>): OpenDataItem | null {
  const id = asText(card.id) ?? (asNumber(card.id) === undefined ? undefined : String(card.id));
  const name = asText(card.name);
  const prices = asObject(asArray(card.card_prices)[0]);
  const price = decimalMoney(prices?.cardmarket_price, 'EUR');
  // A zero is YGOPRODeck saying it has no Cardmarket price, not a free card.
  if (id === undefined || name === undefined || price === undefined || price.amount === 0)
    return null;

  const sets = asArray(card.card_sets)
    .map((set) => asObject(set))
    .filter((set): set is Readonly<Record<string, unknown>> => set !== undefined);
  const misc = asObject(asArray(card.misc_info)[0]);
  const facts = new FactCollector('ygoprodeck')
    .add('card_id', id)
    .text('type', card.type)
    .text('card_type', card.humanReadableCardType)
    .text('frame_type', card.frameType)
    .text('race', card.race)
    .text('attribute', card.attribute)
    .text('archetype', card.archetype)
    .number('atk', card.atk)
    .number('def', card.def)
    .number('level', card.level)
    .number('link_value', card.linkval)
    .number('scale', card.scale)
    .add('set_names', [
      ...new Set(
        sets
          .map((set) => asText(set.set_name))
          .filter((value): value is string => value !== undefined),
      ),
    ])
    .add(
      'set_codes',
      sets
        .map((set) => asText(set.set_code))
        .filter((value): value is string => value !== undefined),
    )
    .add('rarities', [
      ...new Set(
        sets
          .map((set) => asText(set.set_rarity))
          .filter((value): value is string => value !== undefined),
      ),
    ])
    .number('tcgplayer_price', prices?.tcgplayer_price, 'USD')
    .number('ebay_price', prices?.ebay_price, 'USD')
    .number('amazon_price', prices?.amazon_price, 'USD')
    .number('coolstuffinc_price', prices?.coolstuffinc_price, 'USD')
    .list('formats', misc?.formats)
    .text('tcg_date', misc?.tcg_date)
    .text('ocg_date', misc?.ocg_date)
    .number('konami_id', misc?.konami_id)
    .number('views', misc?.views)
    .add('price_basis', 'cardmarket_market_price')
    .toArray();

  const description = asText(card.desc);
  const normalized: NormalizedSourceRecord = {
    title: name,
    identifiers: [],
    options: [],
    productGroupKey: id,
    media: [],
    merchantHint: 'Cardmarket',
    brandHint: 'Yu-Gi-Oh!',
    ...(description === undefined ? {} : { description }),
    price,
    conditionLabel: 'new',
    categoryKey: 'trading_cards/yugioh',
    language: 'en',
    sourceUrl: `https://www.cardmarket.com/es/YuGiOh/Products/Search?searchString=${encodeURIComponent(name)}`,
    facts,
  };
  return {
    externalType: 'offer',
    externalId: id,
    normalized,
    raw: { id, cardmarket: asText(prices?.cardmarket_price) ?? null },
  };
}
