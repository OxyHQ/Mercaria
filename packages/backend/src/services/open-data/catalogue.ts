/**
 * Every open-data provider Mercaria can read — THE list.
 *
 * Adding a provider is a module under `providers/`, a line here and a test;
 * every deployment registers all of them (`register.ts`). Slugs
 * are unique by a test, because a slug is the `catalog_source_configs.provider`
 * value every stored source row carries forever.
 */

import type { OpenDataProviderSummary } from '@mercaria/shared-types';
import type { OpenDataProvider } from './provider.js';
import { cheapSharkProvider } from './providers/cheapshark.js';
import { gogProvider } from './providers/gog.js';
import { mitecoFuelProvider } from './providers/miteco-fuel.js';
import { openFactsProviders } from './providers/open-facts.js';
import { openPricesProvider } from './providers/open-prices.js';
import { scryfallProvider } from './providers/scryfall.js';
import { tcgdexProvider } from './providers/tcgdex.js';

export const OPEN_DATA_PROVIDERS: readonly OpenDataProvider[] = [
  openPricesProvider,
  ...openFactsProviders,
  mitecoFuelProvider,
  cheapSharkProvider,
  gogProvider,
  scryfallProvider,
  tcgdexProvider,
];

export function findOpenDataProvider(slug: string): OpenDataProvider | undefined {
  return OPEN_DATA_PROVIDERS.find((provider) => provider.slug === slug);
}

/** The reviewer-facing description of every provider, and whether it runs here. */
export function summarizeOpenDataProviders(registered: ReadonlySet<string>): OpenDataProviderSummary[] {
  return OPEN_DATA_PROVIDERS.map((provider) => ({
    slug: provider.slug,
    name: provider.name,
    homepage: provider.homepage,
    role: provider.role,
    licence: provider.licence,
    attribution: provider.attribution,
    accountRefMeaning: provider.accountRefMeaning,
    registered: registered.has(provider.slug),
  }));
}
