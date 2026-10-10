/**
 * Registering the open-data adapters — the ONE place their transport is built.
 *
 * Every provider in the catalogue is registered on every deployment.
 * Registering fetches nothing: #62's dispatcher fetches only for a configured,
 * ACTIVE source, and the sources Mercaria runs are declared in `sources.ts` and
 * reconciled by `services/catalog-autopilot/`. A source an operator pauses
 * stops fetching whatever this file registered.
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
import { OPEN_DATA_PROVIDERS } from './catalogue.js';
import { createOpenDataHttp, OPEN_DATA_USER_AGENT } from './http.js';

const registered = new Set<string>();

/** The slugs this process registered — what the provider listing reports. */
export function registeredOpenDataProviders(): ReadonlySet<string> {
  return registered;
}

export function registerOpenDataAdapters(): void {
  const http = createOpenDataHttp({
    userAgent: OPEN_DATA_USER_AGENT,
    timeoutMs: config.openData.requestTimeoutMs,
    cacheDir: config.openData.cacheDir,
    maxDownloadBytes: config.openData.maxDownloadBytes,
  });

  for (const provider of OPEN_DATA_PROVIDERS) {
    if (registered.has(provider.slug)) continue;
    registerCatalogSourceAdapter(
      createOpenDataAdapter(provider, {
        http,
        demandFor: (sourceId) => ({
          gtins: (after, limit) =>
            listGtinDemand(getDb(), { askingSourceId: sourceId, after, limit }),
        }),
      }),
    );
    registered.add(provider.slug);
  }
  log.general.info({ providers: [...registered] }, '[OpenData] open-data adapters registered');
}
