/**
 * Registering the open-data adapters — the ONE place their transport is built.
 *
 * `OPEN_DATA_PROVIDERS` names which descriptors this deployment fetches, and
 * `OPEN_DATA_USER_AGENT` must be set for any of them to register (see
 * `OpenDataConfig`). Like `AWIN_ENABLED`, neither gates anything durable: a
 * source configured for an unlisted provider is stored and refused with #62's
 * own `adapter_missing` until it is listed.
 *
 * One transport is shared by every provider, so its per-host request spacing
 * holds across all the sources of a provider in this process — twenty Open
 * Prices chains are one client of `prices.openfoodfacts.org`, not twenty.
 *
 * This file is the composition root and the ONE module of the domain that
 * reaches Postgres: it supplies the catalogue's demand (`listGtinDemand`) as a
 * function, so the providers themselves never do. `open-data-isolation.test.ts`
 * names it as the only exemption.
 */

import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { listGtinDemand } from '../../db/ingestion/catalogSourceObjectRepository.js';
import { log } from '../../lib/logger.js';
import { createOpenDataAdapter } from '../ingestion/adapters/open-data.js';
import { registerCatalogSourceAdapter } from '../ingestion/registry.js';
import { findOpenDataProvider } from './catalogue.js';
import { createOpenDataHttp } from './http.js';

const registered = new Set<string>();

/** The slugs this process registered — what the provider listing reports. */
export function registeredOpenDataProviders(): ReadonlySet<string> {
  return registered;
}

export function registerOpenDataAdapters(): void {
  const { providers, userAgent } = config.openData;
  if (providers.length === 0) {
    log.general.info('[OpenData] OPEN_DATA_PROVIDERS is empty; no open-data adapter is registered.');
    return;
  }
  if (userAgent.length === 0) {
    log.general.warn(
      { providers },
      '[OpenData] OPEN_DATA_PROVIDERS is set but OPEN_DATA_USER_AGENT is not. Every provider asks ' +
        'callers to identify themselves; none is registered until it is set.',
    );
    return;
  }

  const http = createOpenDataHttp({
    userAgent,
    timeoutMs: config.openData.requestTimeoutMs,
    cacheDir: config.openData.cacheDir,
    maxDownloadBytes: config.openData.maxDownloadBytes,
  });

  for (const slug of providers) {
    const provider = findOpenDataProvider(slug);
    if (provider === undefined) {
      // A typo in the list is loud rather than silently fetching less.
      log.general.error({ slug }, '[OpenData] OPEN_DATA_PROVIDERS names a provider that does not exist');
      continue;
    }
    if (registered.has(slug)) continue;
    registerCatalogSourceAdapter(
      createOpenDataAdapter(provider, {
        http,
        demandFor: (sourceId) => ({
          gtins: (after, limit) => listGtinDemand(getDb(), { askingSourceId: sourceId, after, limit }),
        }),
      }),
    );
    registered.add(slug);
  }
  log.general.info({ providers: [...registered] }, '[OpenData] open-data adapters registered');
}
