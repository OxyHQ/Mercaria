/**
 * The bounded, per-language shopping dictionaries (#95 "Localization" rules 1,
 * 3 and 6).
 *
 * PURE and DATA: no database, no configuration, no clock, no generation step.
 * Everything here is a table somebody wrote and somebody can read, which is the
 * property that makes it different in kind from a synonym model.
 *
 * ## Why these are dictionaries and not synonym expansion
 *
 * #70 refuses "unbounded synonym rewriting" and resolves it by having no
 * synonym table at all — its alias expansion runs against real stored alias
 * rows. This module does not reintroduce one. What it holds is a mapping from
 * WORDS A SHOPPER USES to CLOSED VOCABULARIES MERCARIA ALREADY OWNS: `usado`
 * and `de segunda mano` name the `used` condition SEGMENT (#90), `tienda
 * oficial` names #70's `officialChannelOnly` filter, `cerca de mí` names a
 * proximity request. None of them rewrites the query text, none adds a search
 * term, and none can produce a value outside the vocabulary it maps into,
 * because the target types are the closed unions themselves.
 *
 * **The user's own words survive** (rule 3). Nothing here edits `searchText`:
 * a colloquial term produces a structured leaning BESIDE the query, and the
 * query still reaches #70 exactly as the shopper wrote it. That is what makes
 * "normalize colloquial terms while preserving the user's words" two facts
 * rather than a compromise between them.
 *
 * ## The application language never changes (rule 6)
 *
 * A query in another language is READ in that language and answered in the
 * request's locale. `matchesAnyLanguage` is the mechanism: every dictionary is
 * consulted for every query, so `usado` is understood by an English-locale
 * shopper without the response, the paraphrase or anything else switching to
 * Spanish. A mixed-language query (`laptop 16GB segunda mano`) therefore works,
 * which is rule 5's "evaluate mixed-language and misspelled queries" for the
 * mixed half; the misspelled half is #70's trigram stage, which this module
 * deliberately does not duplicate.
 */

import type { ConditionGroup, OfferAvailability, ShoppingUseTag } from '@mercaria/shared-types';

/**
 * The launch languages this module carries entries for (#95 localization
 * rule 1: "support launch languages selected by product policy").
 *
 * Spanish and English, which is Mercaria's own launch policy, plus Catalan —
 * because a marketplace serving Spain receives it and a Catalan query silently
 * understood as nothing is worse than one understood as Spanish. German,
 * French, Italian and Portuguese carry the CONDITION and CHANNEL words only:
 * those four vocabularies are small, closed and verifiable, and shipping a
 * partial dictionary that is right about condition beats shipping none.
 *
 * A language absent from here is not refused — its numbers still read under
 * `decimalConventionOf`, its identifiers and magnitudes still parse, and its
 * words simply produce no leanings. That is the correct degradation: fewer
 * structured facts, never a wrong one.
 */
export const INTENT_DICTIONARY_LANGUAGES: readonly string[] = [
  'en',
  'es',
  'ca',
  'de',
  'fr',
  'it',
  'pt',
];

/** One entry: the phrases, and the thing they name. */
interface DictionaryEntry<T> {
  readonly value: T;
  /** Lowercased, accent-folded phrases. Matched on a WORD boundary. */
  readonly phrases: readonly string[];
}

/**
 * Fold a phrase into the space the dictionaries are written in.
 *
 * Lowercase, NFD, combining marks removed, whitespace collapsed. Accent folding
 * is what makes `segunda máno`, `SEGUNDA MANO` and `segunda mano` one phrase,
 * and it is locale-independent — the same decision `services/search/normalize.ts`
 * makes and for the same reason.
 */
export function foldPhrase(phrase: string): string {
  return phrase
    .normalize('NFD')
    .replace(/[\u{300}-\u{36F}]/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Whether a folded query contains a folded phrase as whole words.
 *
 * Word-boundary matching rather than `includes`, because `nuevo` inside
 * `renuevo` is not a claim about condition, and a substring match on a
 * three-letter dictionary phrase turns half a catalogue into a leaning nobody
 * expressed. The boundary is defined against letters and digits so `16gb`
 * matches inside `16gb/512gb`.
 *
 * ## A combining mark is part of the word it sits on (#836)
 *
 * `\p{L}` **excludes** combining marks, so `[\p{L}\p{N}]` alone reads a mark as
 * "not a word character" and therefore as a boundary — and this predicate's
 * whole job is to refuse a match that is not on a boundary. Measured before the
 * fix, with the phrase on the right and the query on the left:
 *
 * ```
 * साइकिल   contains ल        -> true   (ल is preceded by ि, U+093F, a mark)
 * সাইকেল   contains ল        -> true   (ল is preceded by ে, U+09C7, a mark)
 * じてんしゃ contains てんしゃ -> true   (NFD leaves U+3099 before て)
 * renuevo  contains nuevo    -> false  (the Latin control, already correct)
 * ```
 *
 * So exactly the substring match the docblock above forbids was reachable in
 * every script whose vowels are marks, and only there — which is the #830
 * mechanism arriving through a predicate instead of a tokenizer. It is a false
 * POSITIVE rather than #830's false merge, and it is not harmless here because
 * a match ADDS a filter: `readCategory` turns one into a category constraint on
 * a shopper's search, and the enum pass turns one into an attribute requirement.
 * A one-letter Hindi or Bengali `category_aliases.normalized_alias` therefore
 * narrowed a page to a category nobody asked for, with nothing saying why.
 *
 * Adding `\p{M}` makes those scripts behave the way Latin already did. It can
 * only ever REMOVE a match — a mark that used to open a boundary now closes one
 * — so the direction is recall, never precision, which is the whole family's
 * safe direction. The one true positive it removes is a query that differs from
 * its alias only by a trailing matra (`साइकिलें` against the alias `साइकिल`),
 * and refusing that is exactly what Latin already does with `bicycles` against
 * `bicycle`.
 *
 * Note the sibling that is deliberately NOT changed:
 * `services/attributes/marketing-claims.ts` carries the same class in the same
 * shape, and there a match REFUSES a value rather than selecting one, so adding
 * `\p{M}` would open an evasion instead of closing a hole. Its own docblock
 * carries the measurement.
 */
function containsPhrase(foldedQuery: string, foldedPhrase: string): boolean {
  const escaped = foldedPhrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}(?![\\p{L}\\p{N}\\p{M}])`, 'u').test(
    foldedQuery,
  );
}

/**
 * The same word-boundary test, for a phrase that is not in a dictionary here.
 *
 * Exported so the ONE matching rule serves the registry-driven passes too —
 * enum labels, enum values and #94's recorded value aliases — rather than each
 * of them carrying its own. A second rule would not announce itself: it would
 * simply be more permissive somewhere, and an alias is exactly where that
 * costs, because an alias is short by nature (`tb4`, `cel`) and a substring
 * match on three characters turns half a catalogue into a leaning nobody
 * expressed.
 */
export function containsFoldedPhrase(foldedQuery: string, foldedPhrase: string): boolean {
  return containsPhrase(foldedQuery, foldedPhrase);
}

/** The first entry whose phrase appears, with the phrase that matched. */
function firstMatch<T>(
  foldedQuery: string,
  entries: readonly DictionaryEntry<T>[],
): { readonly value: T; readonly phrase: string } | undefined {
  for (const entry of entries) {
    for (const phrase of entry.phrases) {
      if (containsPhrase(foldedQuery, phrase)) return { value: entry.value, phrase };
    }
  }
  return undefined;
}

/** Every entry whose phrase appears, deduplicated by value, in table order. */
function allMatches<T>(
  foldedQuery: string,
  entries: readonly DictionaryEntry<T>[],
): { readonly value: T; readonly phrase: string }[] {
  const matches: { value: T; phrase: string }[] = [];
  for (const entry of entries) {
    if (matches.some((match) => match.value === entry.value)) continue;
    for (const phrase of entry.phrases) {
      if (containsPhrase(foldedQuery, phrase)) {
        matches.push({ value: entry.value, phrase });
        break;
      }
    }
  }
  return matches;
}

/* -------------------------------------------------------------------------- */
/*  Condition (#90 segments, never a raw condition key)                        */
/* -------------------------------------------------------------------------- */

/**
 * Condition words, mapped to #90 SEGMENTS.
 *
 * Segments and never the nine keys, which is #90's own rule for filters: a
 * shopper saying "used" means the whole used band and not `used_good`
 * specifically, and reading it as a key would silently exclude `used_like_new`
 * and `used_fair` from a query that plainly wanted them.
 *
 * ORDER is load-bearing. `refurbished` sits before `used` so `reacondicionado`
 * — which contains no `usado` but is semantically adjacent — is not reached by
 * a broader rule, and `open_box` sits before `new` so `caja abierta` is not read
 * as a claim of newness. `for_parts` is first because "para piezas" is the most
 * specific statement in the set and the one whose misreading is worst: a
 * shopper who wants a working phone must never be shown one sold for parts.
 */
const CONDITION_PHRASES: readonly DictionaryEntry<ConditionGroup>[] = [
  {
    value: 'for_parts',
    phrases: [
      'for parts',
      'spares or repair',
      'not working',
      'para piezas',
      'para repuestos',
      'no funciona',
      'per peces',
      'als teile',
      'defekt',
      'pour pieces',
      'pour pieces detachees',
      'per ricambi',
      'para pecas',
    ],
  },
  {
    value: 'refurbished',
    phrases: [
      'refurbished',
      'refurb',
      'renewed',
      'reacondicionado',
      'reacondicionada',
      'reacondicionat',
      'generalüberholt',
      'generaluberholt',
      'reconditionne',
      'ricondizionato',
      'recondicionado',
    ],
  },
  {
    value: 'open_box',
    phrases: [
      'open box',
      'open-box',
      'caja abierta',
      'capsa oberta',
      'geöffnete verpackung',
      'geoffnete verpackung',
      'boite ouverte',
      'scatola aperta',
      'caixa aberta',
    ],
  },
  {
    value: 'used',
    phrases: [
      'used',
      'second hand',
      'secondhand',
      'pre owned',
      'pre-owned',
      'usado',
      'usada',
      'de segunda mano',
      'segunda mano',
      'de segona ma',
      'segona ma',
      'gebraucht',
      // German adjectives inflect and a shopper writes the inflected form: a
      // dictionary holding only the stem understands `gebraucht` and misses
      // `gebrauchter Laptop`, which is how anybody actually types it.
      'gebrauchte',
      'gebrauchter',
      'gebrauchtes',
      'gebrauchten',
      'occasion',
      "d'occasion",
      'usato',
      'usada',
    ],
  },
  {
    value: 'new',
    phrases: [
      'brand new',
      'new',
      'nuevo',
      'nueva',
      'a estrenar',
      'sin abrir',
      'nou',
      'neu',
      'neuf',
      'nuovo',
      'novo',
    ],
  },
];

/** Which condition segments a query asked for, in table order. */
export function readConditionGroups(
  foldedQuery: string,
): { readonly value: ConditionGroup; readonly phrase: string }[] {
  return allMatches(foldedQuery, CONDITION_PHRASES);
}

/* -------------------------------------------------------------------------- */
/*  Channel and availability leanings                                          */
/* -------------------------------------------------------------------------- */

/** Phrases asking for an official or authorized channel (#70 filter 7). */
const OFFICIAL_CHANNEL_PHRASES: readonly string[] = [
  'official store',
  'official shop',
  'authorized reseller',
  'authorised reseller',
  'tienda oficial',
  'distribuidor oficial',
  'botiga oficial',
  'offizieller shop',
  'boutique officielle',
  'negozio ufficiale',
  'loja oficial',
];

/** Phrases asking to buy HERE rather than leaving for a retailer's own site. */
const NATIVE_CHANNEL_PHRASES: readonly string[] = [
  'buy here',
  'buy on mercaria',
  'comprar aqui',
  'comprar en mercaria',
  'comprar aqui mateix',
];

/** Phrases asking for something nearby (reported, never enforced — see #93). */
const NEARBY_PHRASES: readonly string[] = [
  'near me',
  'nearby',
  'local pickup',
  'collection only',
  'cerca de mi',
  'cerca de mí',
  'recogida en mano',
  'en mano',
  'a prop meu',
  'in meiner nahe',
  'in meiner nähe',
  'pres de chez moi',
  'vicino a me',
  'perto de mim',
];

/** Phrases asking for something that can actually be bought right now. */
const IN_STOCK_PHRASES: readonly string[] = [
  'in stock',
  'available now',
  'en stock',
  'disponible ahora',
  'disponible ara',
  'auf lager',
  'en stock maintenant',
  'disponibile subito',
  'em stock',
];

/** What a query asked for about the CHANNEL, if anything. */
export interface ChannelLeanings {
  readonly officialChannelOnly?: { readonly phrase: string };
  readonly nativeOnly?: { readonly phrase: string };
  readonly nearby?: { readonly phrase: string };
  readonly availability?: { readonly value: OfferAvailability; readonly phrase: string };
}

/** Read every channel leaning out of a folded query. */
export function readChannelLeanings(foldedQuery: string): ChannelLeanings {
  const official = OFFICIAL_CHANNEL_PHRASES.find((phrase) => containsPhrase(foldedQuery, phrase));
  const native = NATIVE_CHANNEL_PHRASES.find((phrase) => containsPhrase(foldedQuery, phrase));
  const nearby = NEARBY_PHRASES.find((phrase) => containsPhrase(foldedQuery, phrase));
  const inStock = IN_STOCK_PHRASES.find((phrase) => containsPhrase(foldedQuery, phrase));
  return {
    ...(official === undefined ? {} : { officialChannelOnly: { phrase: official } }),
    ...(native === undefined ? {} : { nativeOnly: { phrase: native } }),
    ...(nearby === undefined ? {} : { nearby: { phrase: nearby } }),
    ...(inStock === undefined ? {} : { availability: { value: 'in_stock' as const, phrase: inStock } }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Budget phrasing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How a budget bound was phrased.
 *
 * `delivered` is the field that matters and it is why this is a table rather
 * than a regex: "under 900 delivered", "900 € todo incluido" and "900 € gastos
 * de envío incluidos" all mean `known_total` (#94's separate facet), and
 * treating them as `offer_price` answers a different question than the one the
 * shopper asked. When nothing says so the basis is `item_price` and the
 * paraphrase SAYS which was assumed, so a shopper can correct it in one tap —
 * clarification rule 2's "safe defaults shown transparently".
 */
export interface BudgetPhrasing {
  readonly bound: 'max' | 'min';
  readonly phrase: string;
}

const MAX_BUDGET_PHRASES: readonly string[] = [
  'under',
  'below',
  'less than',
  'up to',
  'at most',
  'no more than',
  'cheaper than',
  'max',
  'maximum',
  'menos de',
  'por debajo de',
  'hasta',
  'como maximo',
  'maximo',
  'no mas de',
  'mas barato que',
  'menys de',
  'fins a',
  'unter',
  'bis zu',
  'hochstens',
  'höchstens',
  'moins de',
  "jusqu'a",
  'au maximum',
  'meno di',
  'fino a',
  'menos de',
  'ate',
  'até',
];

const MIN_BUDGET_PHRASES: readonly string[] = [
  'over',
  'above',
  'more than',
  'at least',
  'from',
  'starting at',
  'min',
  'minimum',
  'mas de',
  'a partir de',
  'desde',
  'como minimo',
  'minimo',
  'mes de',
  'uber',
  'über',
  'mindestens',
  'ab',
  'plus de',
  'a partir de',
  'au minimum',
  'piu di',
  'almeno',
  'mais de',
];

/** Phrases that make a budget a KNOWN TOTAL rather than an item price. */
const DELIVERED_TOTAL_PHRASES: readonly string[] = [
  'delivered',
  'shipped',
  'including shipping',
  'including delivery',
  'shipping included',
  'all in',
  'total',
  'envio incluido',
  'envío incluido',
  'gastos de envio incluidos',
  'todo incluido',
  'puesto en casa',
  'enviament inclos',
  'inklusive versand',
  'versandkosten inklusive',
  'livraison incluse',
  'tout compris',
  'spedizione inclusa',
  'tutto incluso',
  'frete incluido',
];

/** Whether a budget phrase asked for a delivered total (#94's `known_total`). */
export function readsAsDeliveredTotal(foldedQuery: string): string | undefined {
  return DELIVERED_TOTAL_PHRASES.find((phrase) => containsPhrase(foldedQuery, phrase));
}

/** Which bound a phrase before an amount expresses, when it expresses one. */
export function readBudgetBound(foldedPrefix: string): BudgetPhrasing | undefined {
  // The LONGEST match wins, so `no mas de` is not read as `mas de` — which is
  // the opposite bound. A first-match scan over an unsorted table would invert
  // exactly this case, and the shopper would be shown everything above their
  // budget instead of everything below it.
  const max = longestMatch(foldedPrefix, MAX_BUDGET_PHRASES);
  const min = longestMatch(foldedPrefix, MIN_BUDGET_PHRASES);
  if (max === undefined && min === undefined) return undefined;
  if (min === undefined) return { bound: 'max', phrase: max ?? '' };
  if (max === undefined) return { bound: 'min', phrase: min };
  return max.length >= min.length ? { bound: 'max', phrase: max } : { bound: 'min', phrase: min };
}

function longestMatch(folded: string, phrases: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const phrase of phrases) {
    if (!containsPhrase(folded, phrase)) continue;
    if (best === undefined || phrase.length > best.length) best = phrase;
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/*  Requirement strength                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Words that make a requirement HARD, and words that make it a PREFERENCE.
 *
 * The DEFAULT is `preference`, and that asymmetry is deliberate: promoting a
 * leaning to a hard requirement excludes products the shopper would have
 * bought, and #94's whole hard-versus-preference apparatus exists because that
 * direction is the damaging one. A shopper who means "must" usually says so
 * ("must have", "necesito", "imprescindible"); a shopper who says nothing gets
 * a leaning they can promote in one tap.
 *
 * The exception is a MEASURED bound — "at least 16 GB" — which the deterministic
 * interpreter treats as hard without a keyword, because a numeric threshold is
 * already an explicit statement of a limit. That decision lives in
 * `deterministic.ts` beside the parse that produces it, not here.
 */
const HARD_REQUIREMENT_PHRASES: readonly string[] = [
  'must have',
  'must be',
  'needs to have',
  'need',
  'required',
  'only',
  'strictly',
  'debe tener',
  'debe ser',
  'necesito',
  'imprescindible',
  'obligatorio',
  'solo',
  'unicamente',
  'ha de tenir',
  'muss haben',
  'zwingend',
  'doit avoir',
  'obligatoire',
  'deve avere',
  'indispensabile',
  'precisa ter',
];

const PREFERENCE_PHRASES: readonly string[] = [
  'prefer',
  'preferably',
  'ideally',
  'nice to have',
  'would like',
  'if possible',
  'preferiblemente',
  'a ser posible',
  'si es posible',
  'me gustaria',
  'preferentment',
  'vorzugsweise',
  'moglichst',
  'möglichst',
  'de preference',
  'si possible',
  'preferibilmente',
  'de preferencia',
];

/** Whether the query stated a strength explicitly, and which. */
export function readStatedStrength(foldedQuery: string): 'hard' | 'preference' | undefined {
  if (HARD_REQUIREMENT_PHRASES.some((phrase) => containsPhrase(foldedQuery, phrase))) return 'hard';
  if (PREFERENCE_PHRASES.some((phrase) => containsPhrase(foldedQuery, phrase))) return 'preference';
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Product-use tags                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Words that name one of the bounded use tags.
 *
 * A tag is a HINT and reaches no retrieval decision — see
 * `SHOPPING_USE_TAGS`'s own doc comment. It is here so a paraphrase can say
 * "for gaming" and a client can offer to remove it, which is the whole of what
 * "product-use intent expressed as bounded tags" buys.
 */
const USE_TAG_PHRASES: readonly DictionaryEntry<ShoppingUseTag>[] = [
  { value: 'gaming', phrases: ['gaming', 'for games', 'para juegos', 'para gaming', 'zum spielen'] },
  {
    value: 'photography',
    phrases: ['photography', 'for photos', 'fotografia', 'para fotos', 'fotografie'],
  },
  {
    value: 'video_editing',
    phrases: ['video editing', 'edicion de video', 'edicio de video', 'videobearbeitung'],
  },
  {
    value: 'music_production',
    phrases: ['music production', 'produccion musical', 'musikproduktion'],
  },
  {
    value: 'programming',
    phrases: ['programming', 'for coding', 'programar', 'programacion', 'programmieren'],
  },
  { value: 'office_work', phrases: ['office work', 'for work', 'para trabajar', 'para la oficina'] },
  { value: 'study', phrases: ['for study', 'for school', 'para estudiar', 'para la universidad'] },
  { value: 'travel', phrases: ['for travel', 'para viajar', 'de viaje', 'zum reisen'] },
  { value: 'commuting', phrases: ['commuting', 'for commuting', 'para el trabajo diario'] },
  { value: 'fitness', phrases: ['fitness', 'for the gym', 'para el gimnasio', 'deporte'] },
  { value: 'outdoors', phrases: ['outdoors', 'hiking', 'camping', 'para montana', 'senderismo'] },
  { value: 'cooking', phrases: ['cooking', 'for the kitchen', 'para cocinar', 'cocina'] },
  { value: 'gardening', phrases: ['gardening', 'for the garden', 'jardineria', 'para el jardin'] },
  { value: 'home_repair', phrases: ['diy', 'home repair', 'bricolaje', 'para reparar'] },
  { value: 'childcare', phrases: ['for kids', 'for a baby', 'para ninos', 'para bebe', 'infantil'] },
  { value: 'pets', phrases: ['for pets', 'for a dog', 'for a cat', 'para mascotas', 'para perro'] },
  {
    value: 'accessibility',
    phrases: ['accessible', 'accessibility', 'accesible', 'accesibilidad', 'movilidad reducida'],
  },
  { value: 'gift', phrases: ['as a gift', 'for a gift', 'de regalo', 'para regalar', 'als geschenk'] },
];

/** Which use tags a query named, bounded by the caller. */
export function readUseTags(
  foldedQuery: string,
): { readonly value: ShoppingUseTag; readonly phrase: string }[] {
  return allMatches(foldedQuery, USE_TAG_PHRASES);
}

/* -------------------------------------------------------------------------- */
/*  Category colloquialisms                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Colloquial category words, mapped to the SLUG a category is addressed by.
 *
 * A slug and not an id, because a slug is stable, readable and resolvable
 * against the real `categories` table — an id in a code table would be a
 * per-deployment fact hard-coded into a dictionary. The resolution happens in
 * `deterministic.ts` against the database, so a slug nobody created simply
 * produces no category, which is the honest failure.
 *
 * These are the words no product name contains: `móvil`, `celular` and `cel`
 * all mean a phone and none of them appears in the phone's own title, so a
 * lexical search on them finds nothing while a shopper is certain they said
 * what they wanted. That is the whole population this table is for — it is not
 * a category index and must not grow into one.
 */
const CATEGORY_COLLOQUIALISMS: readonly DictionaryEntry<string>[] = [
  {
    value: 'smartphones',
    phrases: ['movil', 'moviles', 'celular', 'celulares', 'cel', 'mobil', 'mobils', 'handy'],
  },
  {
    value: 'laptops',
    phrases: ['portatil', 'portatiles', 'portatil', 'ordenador portatil', 'notebook', 'laptop'],
  },
  {
    value: 'desktops',
    phrases: ['ordenador de sobremesa', 'sobremesa', 'torre', 'pc de escritorio', 'desktop pc'],
  },
  { value: 'televisions', phrases: ['tele', 'tv', 'televisor', 'televisio', 'fernseher'] },
  { value: 'headphones', phrases: ['cascos', 'auriculares', 'audifonos', 'kopfhorer', 'ecouteurs'] },
  { value: 'tablets', phrases: ['tableta', 'tablet', 'tauleta'] },
  { value: 'cameras', phrases: ['camara', 'camara de fotos', 'camera', 'kamera', 'appareil photo'] },
  { value: 'washing-machines', phrases: ['lavadora', 'rentadora', 'waschmaschine', 'lave linge'] },
  { value: 'refrigerators', phrases: ['nevera', 'frigorifico', 'nevera', 'kuhlschrank', 'frigo'] },
  { value: 'bicycles', phrases: ['bici', 'bicicleta', 'bicicletes', 'fahrrad', 'velo'] },
];

/** Which category slug a colloquial word named, with the word that named it. */
export function readCategoryColloquialism(
  foldedQuery: string,
): { readonly value: string; readonly phrase: string } | undefined {
  return firstMatch(foldedQuery, CATEGORY_COLLOQUIALISMS);
}
