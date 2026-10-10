/**
 * TCGDEX — every Pokémon TCG card, localized (Spanish included), with
 * Cardmarket's EUR market prices and TCGplayer's USD ones, keyless.
 *
 * ## Two requests per card, paced
 *
 * The listing names cards; only a card's own document carries its prices and
 * its game text. A page therefore lists a small slice and reads each card in
 * it, at {@link INTERVAL_MS} apart, so a page stays well inside the
 * dispatcher's lease.
 *
 * ## One offer per printing per finish
 *
 * Cardmarket publishes a trend for the normal printing and one for the holo /
 * reverse-holo printing. Each priced finish is its own record with a `Finish`
 * option, as Scryfall's are.
 */

import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import type { OpenDataItem, OpenDataPage, OpenDataPageContext, OpenDataProvider } from '../provider.js';
import { OpenDataConfigurationError, OpenDataSchemaError } from '../provider.js';
import { asArray, asNumber, asObject, asText, decimalMoney, FactCollector } from '../read.js';

export const TCGDEX_PROVIDER = 'tcgdex';

const BASE_URL = 'https://api.tcgdex.net/v2';
const LANGUAGES = ['es', 'en', 'fr', 'de', 'it', 'pt'] as const;
const PAGE_CAP = 25;
const INTERVAL_MS = 250;

export const tcgdexProvider: OpenDataProvider = {
  slug: TCGDEX_PROVIDER,
  name: 'TCGdex',
  homepage: 'https://tcgdex.dev',
  role: 'catalogue_and_prices',
  kind: 'marketplace_api',
  licence: 'provider_terms',
  attribution: 'Datos de cartas Pokémon de TCGdex; precios de mercado de Cardmarket',
  accountRefMeaning: 'the card language (es, en, fr, de, it, pt); Spanish when empty',
  accountRefRequired: false,
  refreshModes: ['incremental'],
  minRequestIntervalMs: INTERVAL_MS,
  fetchPage: fetchTcgdexPage,
};

async function fetchTcgdexPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const language = (context.accountRef ?? 'es').toLowerCase();
  if (!(LANGUAGES as readonly string[]).includes(language)) {
    throw new OpenDataConfigurationError(`"${language}" is not a TCGdex language this provider reads.`);
  }
  const page = typeof context.cursor?.p === 'number' ? context.cursor.p : 1;
  const perPage = Math.min(Math.max(context.pageSize, 1), PAGE_CAP);
  const params = new URLSearchParams({
    'pagination:page': String(page),
    'pagination:itemsPerPage': String(perPage),
    'sort:field': 'id',
    'sort:order': 'ASC',
  });
  const signal = context.signal;
  const listing = await context.http.getJson(`${BASE_URL}/${language}/cards?${params.toString()}`, {
    minIntervalMs: INTERVAL_MS,
    ...(signal ? { signal } : {}),
  });
  if (listing === null || !Array.isArray(listing.body)) {
    throw new OpenDataSchemaError('the card listing is not an array.');
  }

  const items: OpenDataItem[] = [];
  for (const entry of asArray(listing.body)) {
    const id = asText(asObject(entry)?.id);
    // Card ids are `<set>-<number>`; anything else is not something to put in a path.
    if (id === undefined || !/^[A-Za-z0-9._-]{1,64}$/u.test(id)) continue;
    const detail = await context.http.getJson(`${BASE_URL}/${language}/cards/${encodeURIComponent(id)}`, {
      minIntervalMs: INTERVAL_MS,
      allowNotFound: true,
      ...(signal ? { signal } : {}),
    });
    const card = asObject(detail?.body);
    if (card !== undefined) items.push(...toItems(card, language));
  }

  const listed = asArray(listing.body).length;
  return { items, next: listed < perPage ? null : { p: page + 1 }, complete: false };
}

/** One card document → one record per priced finish. */
export function toItems(card: Readonly<Record<string, unknown>>, language: string): OpenDataItem[] {
  const id = asText(card.id);
  const name = asText(card.name);
  if (id === undefined || name === undefined) return [];
  const set = asObject(card.set);
  const setName = asText(set?.name);
  const localId = asText(card.localId);
  const counts = asObject(set?.cardCount);
  const pricing = asObject(card.pricing);
  const cardmarket = asObject(pricing?.cardmarket);
  const tcgplayer = asObject(pricing?.tcgplayer);
  const legal = asObject(card.legal);
  const image = asText(card.image);
  const updated = asText(cardmarket?.updated) ?? asText(card.updated);
  const variants = asObject(card.variants);
  const title = setName === undefined ? name : `${name} — ${setName}${localId === undefined ? '' : ` #${localId}`}`;

  const facts = new FactCollector('tcgdex')
    .add('card_id', id)
    .text('local_id', localId)
    .text('name', name)
    .text('category', card.category)
    .text('illustrator', card.illustrator)
    .text('rarity', card.rarity)
    .text('set_id', set?.id)
    .text('set_name', setName)
    .number('set_card_count_official', counts?.official)
    .number('set_card_count_total', counts?.total)
    .number('hp', card.hp)
    .list('types', card.types)
    .text('stage', card.stage)
    .text('evolve_from', card.evolveFrom)
    .add('dex_ids', asArray(card.dexId).map((entry) => asText(entry)).filter((entry): entry is string => entry !== undefined))
    .number('retreat', card.retreat)
    .text('regulation_mark', card.regulationMark)
    .flag('legal_standard', legal?.standard)
    .flag('legal_expanded', legal?.expanded)
    .add('attacks', asArray(card.attacks).map((attack) => asText(asObject(attack)?.name)).filter((entry): entry is string => entry !== undefined))
    .add('abilities', asArray(card.abilities).map((ability) => asText(asObject(ability)?.name)).filter((entry): entry is string => entry !== undefined))
    .add('weaknesses', asArray(card.weaknesses).map((weakness) => {
      const entry = asObject(weakness);
      const type = asText(entry?.type);
      return type === undefined ? undefined : `${type} ${asText(entry?.value) ?? ''}`.trim();
    }).filter((entry): entry is string => entry !== undefined))
    .add('variants', variants === undefined ? [] : Object.entries(variants).filter(([, on]) => on === true).map(([variant]) => variant))
    .number('cardmarket_product_id', cardmarket?.idProduct)
    .number('cardmarket_avg', cardmarket?.avg, 'EUR')
    .number('cardmarket_low', cardmarket?.low, 'EUR')
    .number('cardmarket_trend', cardmarket?.trend, 'EUR')
    .number('cardmarket_avg7', cardmarket?.avg7, 'EUR')
    .number('cardmarket_avg30', cardmarket?.avg30, 'EUR')
    .number('cardmarket_trend_holo', cardmarket?.['trend-holo'], 'EUR')
    .number('tcgplayer_normal_market', asObject(tcgplayer?.normal)?.marketPrice, 'USD')
    .number('tcgplayer_holofoil_market', asObject(tcgplayer?.holofoil)?.marketPrice, 'USD')
    .number('tcgplayer_reverse_holofoil_market', asObject(tcgplayer?.['reverse-holofoil'])?.marketPrice, 'USD')
    .add('price_basis', 'cardmarket_trend')
    .toArray();

  const cardmarketId = asNumber(cardmarket?.idProduct);
  const finishes = [
    { key: 'normal', label: 'Normal', price: cardmarket?.trend },
    { key: 'holo', label: 'Holo', price: cardmarket?.['trend-holo'] },
  ];
  const items: OpenDataItem[] = [];
  for (const finish of finishes) {
    const price = decimalMoney(finish.price, asText(cardmarket?.unit) ?? 'EUR');
    if (price === undefined || price.amount === 0) continue;
    const normalized: NormalizedSourceRecord = {
      title,
      identifiers: [],
      options: [{ name: 'Finish', value: finish.label }],
      // One card, its finishes as variants (ADR 0016).
      productGroupKey: id,
      media: image === undefined ? [] : [`${image}/high.webp`],
      merchantHint: 'Cardmarket',
      brandHint: 'Pokémon TCG',
      price,
      categoryKey: 'trading_cards/pokemon',
      language,
      ...(cardmarketId === undefined
        ? {}
        : { sourceUrl: `https://www.cardmarket.com/es/Pokemon/Products?idProduct=${String(cardmarketId)}` }),
      ...(updated === undefined ? {} : { sourceUpdatedAt: updated }),
      facts,
    };
    items.push({
      externalType: 'offer',
      externalId: `${id}:${finish.key}`,
      normalized,
      ...(updated === undefined || Number.isNaN(Date.parse(updated)) ? {} : { sourceUpdatedAt: new Date(updated) }),
      raw: { id, finish: finish.key, price: finish.price ?? null, updated: updated ?? null },
    });
  }
  return items;
}
