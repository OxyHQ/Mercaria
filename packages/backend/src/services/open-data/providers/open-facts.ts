/**
 * THE OPEN FACTS FAMILY — Open Food Facts, Open Products Facts, Open Beauty
 * Facts and Open Pet Food Facts: one wiki-style product database per domain,
 * one software (Product Opener), one API, one vocabulary.
 *
 * They are the CATALOGUE half of the comparator: GTIN, name, brand, quantity,
 * photos and — for food — ingredients, allergens, nutrition per 100 g,
 * Nutri-Score, NOVA and Eco-Score. No prices; those come from Open Prices and
 * every other price provider, joined on the GTIN.
 *
 * ## Four providers, one module
 *
 * The four sites differ only in their host and their name, so they are four
 * DESCRIPTORS from one factory rather than four copies. A field only one of
 * them publishes (nutrition is food's) is simply absent from the others'
 * facts — the readers below never assume a field exists.
 *
 * ## Modes, and why there is no snapshot
 *
 * - `targeted` re-reads named GTINs through the product endpoint; a 404 is a
 *   positive statement the product was deleted, reported as a removal.
 * - `query_driven` first reads the catalogue's DEMAND — GTINs other sources
 *   priced that nothing identifies yet (`OpenDataDemand`) — through the
 *   product endpoint, then walks the search endpoint for the source's
 *   countries, newest edit first, stopping at the run's watermark. A demanded
 *   GTIN the database does not have is simply absent: it is not this source's
 *   object, so there is nothing to remove.
 *
 * Neither is a complete enumeration — the full database is only complete in a
 * multi-gigabyte nightly dump — so this provider never retires by omission.
 * The published API limits (15 product reads and 10 searches a minute per IP)
 * are the request intervals below, and a page is capped so it fits inside the
 * dispatcher's lease at that pace.
 */

import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import type {
  OpenDataItem,
  OpenDataPage,
  OpenDataPageContext,
  OpenDataProvider,
} from '../provider.js';
import { OpenDataSchemaError } from '../provider.js';
import { asArray, asNumber, asObject, asText, asTextList, FactCollector, factKeySegment, gtinDigits } from '../read.js';

interface OpenFactsSite {
  readonly slug: string;
  readonly name: string;
  readonly host: string;
}

export const OPEN_FACTS_SITES: readonly OpenFactsSite[] = [
  { slug: 'open_food_facts', name: 'Open Food Facts', host: 'world.openfoodfacts.org' },
  { slug: 'open_products_facts', name: 'Open Products Facts', host: 'world.openproductsfacts.org' },
  { slug: 'open_beauty_facts', name: 'Open Beauty Facts', host: 'world.openbeautyfacts.org' },
  { slug: 'open_pet_food_facts', name: 'Open Pet Food Facts', host: 'world.openpetfoodfacts.org' },
];

/** 15 product reads a minute, per the published limit. */
const PRODUCT_INTERVAL_MS = 4_000;
/** 10 searches a minute. */
const SEARCH_INTERVAL_MS = 6_000;
/** Product reads per targeted page: 12 × 4 s stays inside a 120 s lease. */
const TARGETED_PAGE_CAP = 12;
/** The search endpoint's own page-size ceiling. */
const SEARCH_PAGE_CAP = 100;

/** ISO country → the Open Facts country tag and the language its labels are in. */
const COUNTRIES: Readonly<Record<string, { readonly tag: string; readonly language: string }>> = {
  ES: { tag: 'en:spain', language: 'es' },
  PT: { tag: 'en:portugal', language: 'pt' },
  FR: { tag: 'en:france', language: 'fr' },
  IT: { tag: 'en:italy', language: 'it' },
  DE: { tag: 'en:germany', language: 'de' },
  AT: { tag: 'en:austria', language: 'de' },
  BE: { tag: 'en:belgium', language: 'fr' },
  NL: { tag: 'en:netherlands', language: 'nl' },
  IE: { tag: 'en:ireland', language: 'en' },
  GB: { tag: 'en:united-kingdom', language: 'en' },
  US: { tag: 'en:united-states', language: 'en' },
  MX: { tag: 'en:mexico', language: 'es' },
  AR: { tag: 'en:argentina', language: 'es' },
  CO: { tag: 'en:colombia', language: 'es' },
  CL: { tag: 'en:chile', language: 'es' },
  PL: { tag: 'en:poland', language: 'pl' },
};

/**
 * The fields asked for. Naming them keeps a response to a few kilobytes
 * instead of the ~30 KB a full product document is, and makes a renamed field
 * a visible absence rather than a silent new key.
 */
const FIELDS = [
  'code', 'product_name', 'product_name_es', 'product_name_en', 'product_name_fr', 'product_name_pt',
  'product_name_it', 'product_name_de', 'generic_name', 'generic_name_es', 'brands', 'brands_tags',
  'quantity', 'product_quantity', 'product_quantity_unit', 'serving_size', 'serving_quantity',
  'categories_tags', 'labels_tags', 'origins_tags', 'manufacturing_places', 'stores', 'countries_tags',
  'packaging_tags', 'packaging_materials_tags', 'packaging_recycling_tags', 'allergens_tags',
  'traces_tags', 'additives_tags', 'ingredients_analysis_tags', 'food_groups_tags', 'pnns_groups_1',
  'pnns_groups_2', 'ingredients_text', 'ingredients_text_es', 'ingredients_n', 'nutrient_levels',
  'nutriments', 'nutriscore_grade', 'nutriscore_score', 'nova_group', 'ecoscore_grade',
  'ecoscore_score', 'environmental_score_grade', 'environmental_score_score', 'image_front_url',
  'image_ingredients_url', 'image_nutrition_url', 'image_packaging_url', 'lang', 'product_type',
  'completeness', 'unique_scans_n', 'created_t', 'last_modified_t', 'emb_codes', 'link',
  'periods_after_opening', 'conservation_conditions', 'customer_service', 'owner',
].join(',');

export function createOpenFactsProvider(site: OpenFactsSite): OpenDataProvider {
  const provider: OpenDataProvider = {
    slug: site.slug,
    name: site.name,
    homepage: `https://${site.host.replace(/^world\./u, '')}`,
    role: 'catalogue',
    kind: 'marketplace_api',
    licence: 'odbl_1_0',
    attribution: `Datos de producto de ${site.name}, bajo licencia ODbL; imágenes CC BY-SA`,
    accountRefMeaning: null,
    accountRefRequired: false,
    refreshModes: ['query_driven', 'targeted'],
    minRequestIntervalMs: PRODUCT_INTERVAL_MS,
    fetchPage: (context) =>
      context.mode === 'targeted' ? fetchTargeted(site, context) : fetchSearch(site, context),
  };
  return provider;
}

export const openFactsProviders: readonly OpenDataProvider[] = OPEN_FACTS_SITES.map(createOpenFactsProvider);

async function fetchTargeted(site: OpenFactsSite, context: OpenDataPageContext): Promise<OpenDataPage> {
  const start = typeof context.cursor?.i === 'number' ? context.cursor.i : 0;
  const ids = context.externalIds.slice(start, start + Math.min(context.pageSize, TARGETED_PAGE_CAP));
  const language = preferredLanguage(context.territories);
  const items: OpenDataItem[] = [];
  const removed: { externalType: 'product'; externalId: string }[] = [];

  for (const id of ids) {
    const code = gtinDigits(id);
    if (code === undefined) continue;
    const response = await context.http.getJson(
      `https://${site.host}/api/v2/product/${code}.json?fields=${FIELDS}`,
      { minIntervalMs: PRODUCT_INTERVAL_MS, allowNotFound: true, ...(context.signal ? { signal: context.signal } : {}) },
    );
    const body = asObject(response?.body);
    const product = asObject(body?.product);
    if (response === null || body?.status === 0 || product === undefined) {
      removed.push({ externalType: 'product', externalId: code });
      continue;
    }
    const item = toItem(site, product, language);
    if (item !== null) items.push(item);
  }

  const next = start + ids.length;
  return {
    items,
    removed,
    next: next >= context.externalIds.length ? null : { i: next },
    complete: false,
  };
}

async function fetchSearch(site: OpenFactsSite, context: OpenDataPageContext): Promise<OpenDataPage> {
  // Phase 1: demand. A cursor with `w` is mid-demand; a cursor with `p` is in
  // the search; no cursor starts with demand when there is any.
  if (context.demand !== null && (context.cursor === null || 'w' in context.cursor)) {
    const after = typeof context.cursor?.w === 'string' ? context.cursor.w : null;
    const wanted = await context.demand.gtins(after, Math.min(context.pageSize, TARGETED_PAGE_CAP));
    if (wanted.length > 0) {
      const language = preferredLanguage(context.territories);
      const items: OpenDataItem[] = [];
      for (const gtin of wanted) {
        const code = gtinDigits(gtin);
        if (code === undefined) continue;
        const response = await context.http.getJson(
          `https://${site.host}/api/v2/product/${code}.json?fields=${FIELDS}`,
          { minIntervalMs: PRODUCT_INTERVAL_MS, allowNotFound: true, ...(context.signal ? { signal: context.signal } : {}) },
        );
        const body = asObject(response?.body);
        const product = asObject(body?.product);
        if (product === undefined || body?.status === 0) continue;
        const item = toItem(site, product, language);
        if (item !== null) items.push(item);
      }
      return { items, next: { w: wanted[wanted.length - 1] ?? null }, complete: false };
    }
    // Demand exhausted: the search starts on the next page.
    if (after !== null) return { items: [], next: { p: 1 }, complete: false };
  }
  const page = typeof context.cursor?.p === 'number' ? context.cursor.p : 1;
  const pageSize = Math.min(Math.max(context.pageSize, 1), SEARCH_PAGE_CAP);
  const params = new URLSearchParams({
    fields: FIELDS,
    sort_by: 'last_modified_t',
    page: String(page),
    page_size: String(pageSize),
  });
  const countries = context.territories
    .map((code) => COUNTRIES[code.toUpperCase()]?.tag)
    .filter((tag): tag is string => tag !== undefined);
  // One country per search: the endpoint ANDs repeated tags, and a product
  // sold in Spain and Portugal would otherwise be the only kind returned.
  // A multi-country source walks the first and relies on a source per market.
  if (countries[0] !== undefined) params.set('countries_tags', countries[0]);

  const response = await context.http.getJson(`https://${site.host}/api/v2/search?${params.toString()}`, {
    minIntervalMs: SEARCH_INTERVAL_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const body = asObject(response?.body);
  if (body === undefined || !Array.isArray(body.products)) {
    throw new OpenDataSchemaError('the search response has no `products` array.');
  }

  const language = preferredLanguage(context.territories);
  const items: OpenDataItem[] = [];
  let reachedWatermark = false;
  for (const entry of asArray(body.products)) {
    const product = asObject(entry);
    if (product === undefined) continue;
    const modified = asNumber(product.last_modified_t);
    if (context.since !== null && modified !== undefined && modified * 1_000 < context.since.getTime()) {
      // Newest edit first: everything after this was already read last pass.
      reachedWatermark = true;
      break;
    }
    const item = toItem(site, product, language);
    if (item !== null) items.push(item);
  }

  const count = asNumber(body.count) ?? 0;
  const exhausted = page * pageSize >= count || asArray(body.products).length === 0;
  return {
    items,
    next: reachedWatermark || exhausted ? null : { p: page + 1 },
    complete: false,
  };
}

function preferredLanguage(territories: readonly string[]): string {
  const first = territories[0]?.toUpperCase();
  return (first === undefined ? undefined : COUNTRIES[first]?.language) ?? 'es';
}

/** One product document → one record, or `null` when it has nothing to call it. */
export function toItem(site: OpenFactsSite, product: Readonly<Record<string, unknown>>, language: string): OpenDataItem | null {
  const code = gtinDigits(product.code);
  if (code === undefined) return null;
  const title =
    asText(product[`product_name_${language}`]) ??
    asText(product.product_name) ??
    asText(product[`generic_name_${language}`]) ??
    asText(product.generic_name);
  if (title === undefined) return null;

  const brands = (asText(product.brands) ?? '').split(',').map((brand) => brand.trim()).filter((brand) => brand.length > 0);
  const categories = asTextList(product.categories_tags);
  const media = [product.image_front_url, product.image_packaging_url, product.image_ingredients_url, product.image_nutrition_url]
    .map((value) => asText(value))
    .filter((value): value is string => value !== undefined);
  const lastModified = asNumber(product.last_modified_t);
  const created = asNumber(product.created_t);
  const description = asText(product[`generic_name_${language}`]) ?? asText(product.generic_name);
  const productLanguage = asText(product.lang);

  const facts = new FactCollector('openfacts')
    .text('product_type', product.product_type)
    .list('brands', brands)
    .text('quantity', product.quantity)
    .number('product_quantity', product.product_quantity, asText(product.product_quantity_unit))
    .text('serving_size', product.serving_size)
    .number('serving_quantity', product.serving_quantity)
    .text('nutriscore_grade', product.nutriscore_grade)
    .number('nutriscore_score', product.nutriscore_score)
    .number('nova_group', product.nova_group)
    .text('ecoscore_grade', asText(product.environmental_score_grade) ?? asText(product.ecoscore_grade))
    .number('ecoscore_score', product.environmental_score_score ?? product.ecoscore_score)
    .list('categories', categories)
    .list('labels', product.labels_tags)
    .list('origins', product.origins_tags)
    .text('manufacturing_places', product.manufacturing_places)
    .list('stores', (asText(product.stores) ?? '').split(','))
    .list('countries', product.countries_tags)
    .list('packaging', product.packaging_tags)
    .list('packaging_materials', product.packaging_materials_tags)
    .list('packaging_recycling', product.packaging_recycling_tags)
    .list('allergens', product.allergens_tags)
    .list('traces', product.traces_tags)
    .list('additives', product.additives_tags)
    .list('ingredients_analysis', product.ingredients_analysis_tags)
    .list('food_groups', product.food_groups_tags)
    .text('pnns_group_1', product.pnns_groups_1)
    .text('pnns_group_2', product.pnns_groups_2)
    .text('ingredients_text', asText(product[`ingredients_text_${language}`]) ?? asText(product.ingredients_text))
    .number('ingredients_count', product.ingredients_n)
    .text('emb_codes', product.emb_codes)
    .text('periods_after_opening', product.periods_after_opening)
    .text('conservation_conditions', product.conservation_conditions)
    .text('customer_service', product.customer_service)
    .text('manufacturer_link', product.link)
    .number('completeness', product.completeness)
    .number('unique_scans', product.unique_scans_n)
    .add('media_licence', media.length > 0 ? 'CC-BY-SA-3.0' : undefined);

  const levels = asObject(product.nutrient_levels);
  if (levels !== undefined) {
    for (const [nutrient, level] of Object.entries(levels)) {
      facts.text(`nutrient_level.${factKeySegment(nutrient)}`, level);
    }
  }
  const nutriments = asObject(product.nutriments);
  if (nutriments !== undefined) {
    for (const [key, value] of Object.entries(nutriments)) {
      if (!key.endsWith('_100g')) continue;
      const nutrient = key.slice(0, -'_100g'.length);
      // `nova-group_100g` is a score smuggled into the nutrient table; it is
      // already a fact of its own.
      if (nutrient === 'nova-group' || nutrient.startsWith('nutrition-score')) continue;
      facts.number(`nutrition.${factKeySegment(nutrient)}_100g`, value, asText(nutriments[`${nutrient}_unit`]));
    }
  }

  const normalized: NormalizedSourceRecord = {
    title,
    identifiers: [{ scheme: 'gtin', value: code }],
    options: [],
    media,
    ...(brands[0] === undefined ? {} : { brandHint: brands[0] }),
    ...(description === undefined || description === title ? {} : { description }),
    // The MOST specific category: Open Facts tags run general → specific.
    ...(categories.length === 0 ? {} : { categoryKey: categories[categories.length - 1] }),
    ...(productLanguage === undefined ? {} : { language: productLanguage }),
    sourceUrl: `https://${site.host}/product/${code}`,
    ...(created === undefined ? {} : { sourceCreatedAt: new Date(created * 1_000).toISOString() }),
    ...(lastModified === undefined ? {} : { sourceUpdatedAt: new Date(lastModified * 1_000).toISOString() }),
    facts: facts.toArray(),
  };

  return {
    externalType: 'product',
    externalId: code,
    normalized,
    ...(lastModified === undefined ? {} : { sourceUpdatedAt: new Date(lastModified * 1_000) }),
    raw: { code, lastModified: lastModified ?? null },
  };
}
