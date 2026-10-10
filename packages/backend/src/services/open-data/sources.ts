/**
 * The open-data sources Mercaria RUNS — declared in code, reconciled at boot.
 *
 * `catalogue.ts` says what Mercaria can read. This file says what it does
 * read: one entry per `catalog_sources` row, with the merchant it is bound to,
 * its markets, its cadence and the rights its licence grants. The catalogue
 * autopilot (`services/catalog-autopilot/sources.ts`) converges the database
 * onto this list on every boot, so adding a chain is a line here and a deploy.
 * Nothing about a source lives in an environment variable.
 *
 * ## Rights follow from the licence, and are reviewed HERE
 *
 * A pull request that changes this file is the terms review #62 asks for
 * before a source may run. Every provider below publishes its data openly
 * (ODbL), so the declared policy grants what the licence grants: store, cache,
 * display, index and refresh, with attribution required. The differences are
 * about what the data IS:
 * - a CATALOGUE (the Open Facts family) seeds the canonical catalogue
 *   (ADR 0014) and is bound to no merchant, so it never becomes an offer;
 * - a PRICE source (Open Prices) is bound to the chain whose shelf the price
 *   was on and never links out — there is no retailer page to send anyone
 *   to, so its offers are `informational`.
 *
 * An operator who pauses a source or publishes a different policy for it
 * through `/internal/ingestion` wins: the reconciler only activates a source
 * that is still `draft` and only republishes a policy it published itself.
 */

import type { CatalogSourceExtractionMode } from '@mercaria/shared-types';
import { findOpenDataProvider } from './catalogue.js';
import { OPEN_FACTS_DEMAND_ONLY } from './providers/open-facts.js';
import { GOG_PROVIDER } from './providers/gog.js';
import { OPEN_PRICES_PROVIDER } from './providers/open-prices.js';
import { SCRYFALL_PROVIDER } from './providers/scryfall.js';
import { SHOPIFY_STOREFRONT_PROVIDER } from './providers/shopify-storefront.js';
import { TCGDEX_PROVIDER } from './providers/tcgdex.js';
import { OPEN_DATA_USER_AGENT } from './http.js';

/** The retailer a price source is bound to. Converged by slug. */
export interface DeclaredMerchant {
  readonly slug: string;
  readonly name: string;
}

/** The rights one source's policy grants — `PublishPolicyInput` minus its audit fields. */
export interface DeclaredSourceRights {
  readonly mayDisplay: boolean;
  readonly mayStore: boolean;
  readonly mayCache: boolean;
  readonly cacheTtlSeconds: number;
  readonly mayDisplayPrice: boolean;
  readonly mayDisplayMedia: boolean;
  readonly mayLinkOut: boolean;
  readonly mayAppendAffiliateParams: boolean;
  readonly mayIndex: boolean;
  readonly mayRefreshAutomatically: boolean;
  readonly maySeedCatalog: boolean;
  readonly extractionMode: CatalogSourceExtractionMode;
  /** Required with any extraction mode but `disallowed`: the daily budget and the agent. */
  readonly extractionMaxRequestsPerDay?: number;
  readonly extractionUserAgent?: string;
  readonly attributionRequired: boolean;
  /** The licence id (`odbl_1_0`), recorded as the policy's terms version. */
  readonly termsVersion: string;
  readonly termsUrl: string;
}

export interface DeclaredOpenDataSource {
  /** `catalog_sources.name` — the convergence key, stable forever. */
  readonly name: string;
  readonly provider: string;
  readonly accountRef: string | null;
  readonly merchant: DeclaredMerchant | null;
  readonly territories: readonly string[];
  readonly fetchCadenceSeconds: number;
  /** How long an offer stays current after the source last saw it. */
  readonly freshnessTtlSeconds: number;
  readonly pageSize: number;
  readonly rights: DeclaredSourceRights;
}

const HOUR = 3_600;
const DAY = 24 * HOUR;

const ODBL_TERMS_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';

/** What an ODbL licence grants, before the catalogue/price distinction. */
const ODBL_RIGHTS = {
  mayDisplay: true,
  mayStore: true,
  mayCache: true,
  cacheTtlSeconds: 30 * DAY,
  mayDisplayMedia: true,
  mayAppendAffiliateParams: false,
  mayIndex: true,
  mayRefreshAutomatically: true,
  extractionMode: 'disallowed',
  attributionRequired: true,
  termsVersion: 'odbl_1_0',
  termsUrl: ODBL_TERMS_URL,
} as const;

/** The four Open Facts sites: reference catalogues, seeding by GTIN. */
const OPEN_FACTS_SITES = [
  { provider: 'open_food_facts', name: 'Open Food Facts' },
  { provider: 'open_products_facts', name: 'Open Products Facts' },
  { provider: 'open_beauty_facts', name: 'Open Beauty Facts' },
  { provider: 'open_pet_food_facts', name: 'Open Pet Food Facts' },
] as const;

/**
 * Spanish retail chains with prices in Open Prices, and the merchant each is.
 *
 * `chains` are the account refs — the fold of the shop's OpenStreetMap brand
 * (`subFeedKey`). Several formats of one retailer (Carrefour, Carrefour
 * Express, Carrefour Market) are one merchant with one source per format, so
 * each format keeps its own prices and history. Measured against the dump on
 * 2026-10-10; a chain with no current price simply yields an empty pass.
 */
const SPANISH_CHAINS: readonly { readonly merchant: DeclaredMerchant; readonly chains: readonly string[] }[] = [
  { merchant: { slug: 'mercadona', name: 'Mercadona' }, chains: ['mercadona'] },
  { merchant: { slug: 'carrefour', name: 'Carrefour' }, chains: ['carrefour', 'carrefour_express', 'carrefour_market'] },
  { merchant: { slug: 'lidl', name: 'Lidl' }, chains: ['lidl'] },
  { merchant: { slug: 'alcampo', name: 'Alcampo' }, chains: ['alcampo', 'mi_alcampo'] },
  { merchant: { slug: 'supeco', name: 'Supeco' }, chains: ['supeco'] },
  { merchant: { slug: 'dia', name: 'Dia' }, chains: ['dia', 'dia_go'] },
  { merchant: { slug: 'aldi', name: 'ALDI' }, chains: ['aldi'] },
  { merchant: { slug: 'eroski', name: 'Eroski' }, chains: ['eroski'] },
  { merchant: { slug: 'consum', name: 'Consum' }, chains: ['consum'] },
  { merchant: { slug: 'caprabo', name: 'Caprabo' }, chains: ['caprabo'] },
  { merchant: { slug: 'bonpreu', name: 'Bonpreu' }, chains: ['bonpreu'] },
  { merchant: { slug: 'bonarea', name: 'bonÀrea' }, chains: ['bonarea'] },
  { merchant: { slug: 'hiperdino', name: 'HiperDino' }, chains: ['hiperdino'] },
  { merchant: { slug: 'alimerka', name: 'Alimerka' }, chains: ['alimerka'] },
  { merchant: { slug: 'coviran', name: 'Covirán' }, chains: ['coviran'] },
  { merchant: { slug: 'gadis', name: 'Gadis' }, chains: ['gadis'] },
  { merchant: { slug: 'froiz', name: 'Froiz' }, chains: ['froiz'] },
  { merchant: { slug: 'masymas', name: 'Masymas' }, chains: ['masymas'] },
  { merchant: { slug: 'ahorramas', name: 'Ahorramás' }, chains: ['ahorramas'] },
  { merchant: { slug: 'el-corte-ingles', name: 'El Corte Inglés' }, chains: ['el_corte_ingles'] },
  { merchant: { slug: 'e-leclerc', name: 'E.Leclerc' }, chains: ['e_leclerc'] },
  { merchant: { slug: 'makro', name: 'Makro' }, chains: ['makro'] },
  { merchant: { slug: 'costco', name: 'Costco' }, chains: ['costco'] },
  { merchant: { slug: 'primaprix', name: 'Primaprix' }, chains: ['primaprix'] },
  { merchant: { slug: 'lupa', name: 'Lupa' }, chains: ['lupa'] },
  { merchant: { slug: 'bm-supermercados', name: 'BM Supermercados' }, chains: ['bm'] },
  { merchant: { slug: 'coaliment', name: 'Coaliment' }, chains: ['supermercats_coaliment'] },
  { merchant: { slug: 'hiper-asia', name: 'Hiper Asia' }, chains: ['hiper_asia'] },
];

function providerName(slug: string): string {
  const provider = findOpenDataProvider(slug);
  if (provider === undefined) throw new Error(`Declared open-data source names unknown provider ${slug}.`);
  return provider.name;
}

const catalogueSources: DeclaredOpenDataSource[] = OPEN_FACTS_SITES.map((site) => ({
  name: `${providerName(site.provider)} · demand (ES)`,
  provider: site.provider,
  // The demand alone: the GTINs a price source saw, which are the products a
  // comparison can show. Walking the whole country catalogue (~370k products
  // for Spain) would mint drafts no price points at, on a shared database.
  accountRef: OPEN_FACTS_DEMAND_ONLY,
  merchant: null,
  territories: ['ES'],
  // A pass re-asks for every GTIN still in demand at the site's published
  // pace, so a few hundred take most of an hour; six hours apart is polite.
  fetchCadenceSeconds: 6 * HOUR,
  freshnessTtlSeconds: 30 * DAY,
  pageSize: 100,
  rights: { ...ODBL_RIGHTS, mayDisplayPrice: false, mayLinkOut: false, maySeedCatalog: true },
}));

const priceSources: DeclaredOpenDataSource[] = SPANISH_CHAINS.flatMap(({ merchant, chains }) =>
  chains.map((chain) => ({
    name: `${providerName(OPEN_PRICES_PROVIDER)} · ${chain} (ES)`,
    provider: OPEN_PRICES_PROVIDER,
    accountRef: chain,
    merchant,
    territories: ['ES'],
    // The dumps are regenerated daily; every source of the provider shares
    // one cached download, revalidated at most every six hours.
    fetchCadenceSeconds: 6 * HOUR,
    // Two missed days of a daily dump is an outage, and the offer stops
    // being current rather than showing a price nobody re-confirmed.
    freshnessTtlSeconds: 2 * DAY,
    pageSize: 200,
    rights: { ...ODBL_RIGHTS, mayDisplayPrice: true, mayLinkOut: false, maySeedCatalog: false },
  })),
);

/**
 * What a provider's OWN terms grant (`provider_terms`): the same uses, with a
 * shorter cache, and the terms page as the reference.
 */
function providerTermsRights(termsUrl: string): Omit<DeclaredSourceRights, 'mayDisplayPrice' | 'mayLinkOut' | 'maySeedCatalog'> {
  return { ...ODBL_RIGHTS, cacheTtlSeconds: 2 * DAY, termsVersion: 'provider_terms', termsUrl };
}

/**
 * Card and game catalogues that price their own products (ADR 0016): each
 * seeds products by its own key and is bound to the merchant its prices are.
 * A card price is Cardmarket's daily trend, not one seller's listing, so it is
 * informational; GOG's is the store's own price for Spain, so it links out.
 */
const cardMarket: DeclaredMerchant = { slug: 'cardmarket', name: 'Cardmarket' };
const selfPricedSources: DeclaredOpenDataSource[] = [
  {
    name: 'Scryfall · Magic: The Gathering (ES)',
    provider: SCRYFALL_PROVIDER,
    accountRef: null,
    merchant: cardMarket,
    territories: ['ES'],
    fetchCadenceSeconds: DAY,
    freshnessTtlSeconds: 3 * DAY,
    pageSize: 175,
    rights: { ...providerTermsRights('https://scryfall.com/docs/api'), mayDisplayPrice: true, mayLinkOut: false, maySeedCatalog: true },
  },
  {
    name: 'TCGdex · Pokémon TCG (es)',
    provider: TCGDEX_PROVIDER,
    accountRef: 'es',
    merchant: cardMarket,
    territories: ['ES'],
    fetchCadenceSeconds: DAY,
    freshnessTtlSeconds: 3 * DAY,
    pageSize: 50,
    rights: { ...providerTermsRights('https://tcgdex.dev'), mayDisplayPrice: true, mayLinkOut: false, maySeedCatalog: true },
  },
  {
    name: 'GOG.com (ES)',
    provider: GOG_PROVIDER,
    accountRef: null,
    merchant: { slug: 'gog', name: 'GOG.com' },
    territories: ['ES'],
    fetchCadenceSeconds: DAY,
    freshnessTtlSeconds: 3 * DAY,
    pageSize: 48,
    rights: { ...providerTermsRights('https://www.gog.com/en/support_policy'), mayDisplayPrice: true, mayLinkOut: true, maySeedCatalog: true },
  },
];

/**
 * Spanish Shopify stores on Shop (shop.app), read from their own
 * `/products.json` under their robots.txt — Mercaria's own extraction
 * provider. Each was confirmed on 2026-10-10 to answer `/meta.json` with
 * country ES and currency EUR. The store's name is its merchant's.
 */
const SPANISH_SHOPIFY_STORES: readonly { readonly domain: string; readonly name: string }[] = [
  { domain: 'pompeiibrand.com', name: 'Pompeii' },
  { domain: 'singularu.com', name: 'Singularu' },
  { domain: 'laagam.com', name: 'Laagam' },
  { domain: 'thehoffbrand.com', name: 'HOFF' },
  { domain: 'ecoalf.com', name: 'Ecoalf' },
  { domain: 'sepiia.com', name: 'Sepiia' },
  { domain: 'mrboho.com', name: 'Mr. Boho' },
  { domain: 'bimani.com', name: 'Bimani' },
  { domain: 'goldandroses.com', name: 'Gold & Roses' },
  { domain: 'naguisa.com', name: 'Naguisa' },
  { domain: 'twojeys.com', name: 'Twojeys' },
  { domain: 'slowwalk.es', name: 'Slowwalk' },
  { domain: 'alohas.io', name: 'Alohas' },
  { domain: 'castaner.com', name: 'Castañer' },
  { domain: 'beatrizfurest.com', name: 'Beatriz Furest' },
];

const shopifySources: DeclaredOpenDataSource[] = SPANISH_SHOPIFY_STORES.map((store) => ({
  name: `Shop · ${store.domain}`,
  provider: SHOPIFY_STOREFRONT_PROVIDER,
  accountRef: store.domain,
  merchant: { slug: store.domain.replace(/\./gu, '-'), name: store.name },
  territories: ['ES'],
  fetchCadenceSeconds: 12 * HOUR,
  freshnessTtlSeconds: 2 * DAY,
  pageSize: 250,
  rights: {
    ...providerTermsRights(`https://${store.domain}/policies/terms-of-service`),
    mayDisplayPrice: true,
    // The store's own product page: a real price a shopper can buy at.
    mayLinkOut: true,
    maySeedCatalog: true,
    extractionMode: 'robots_respecting',
    // Two passes a day of at most a few dozen pages each, with headroom.
    extractionMaxRequestsPerDay: 500,
    extractionUserAgent: OPEN_DATA_USER_AGENT,
  },
}));

export const DECLARED_OPEN_DATA_SOURCES: readonly DeclaredOpenDataSource[] = [
  ...catalogueSources,
  ...priceSources,
  ...selfPricedSources,
  ...shopifySources,
];
