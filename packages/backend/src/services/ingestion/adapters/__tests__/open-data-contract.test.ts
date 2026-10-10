/**
 * The generic OPEN-DATA adapter against #62's reusable contract suite — all
 * thirteen cases, on a real Postgres server.
 *
 * Every keyless provider runs through `createOpenDataAdapter`, so this one
 * runner covers the envelope every one of them shares: the cursor codec, the
 * completeness rule, the page instant and the failure translation. A provider's
 * own parsing is covered against recorded responses in
 * `services/open-data/__tests__/open-data-providers.test.ts`.
 *
 * The scenario is materialised as a DESCRIPTOR that serves the scenario's pages
 * by cursor — the same shape a real provider has, with the network replaced by
 * a list.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenDataHttp } from '../../../open-data/http.js';
import type { OpenDataItem, OpenDataProvider } from '../../../open-data/provider.js';
import { createOpenDataAdapter } from '../open-data.js';
import {
  describeCatalogSourceAdapterContract,
  normalizeContractPages,
} from '../../__tests__/adapter-contract-suite.js';

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The suite's own default observation instant. */
const SUITE_INSTANT = new Date('2026-08-09T10:00:00.000Z');

describeCatalogSourceAdapterContract({
  name: 'the open-data adapter',
  providerPrefix: 'open_data_contract',
  adapterSourceDir: ADAPTERS_DIR,
  createAdapter: (slug, scenario) => {
    const pages = normalizeContractPages(scenario);
    const completeOnLastPage = scenario.completeOnLastPage ?? true;
    const descriptor: OpenDataProvider = {
      slug,
      name: 'Contract scenario',
      homepage: 'https://example.org',
      role: 'catalogue_and_prices',
      kind: 'feed',
      licence: 'cc0_1_0',
      attribution: 'Contract scenario data',
      accountRefMeaning: null,
      accountRefRequired: false,
      refreshModes: ['full_snapshot', 'incremental'],
      minRequestIntervalMs: 0,
      async fetchPage(context) {
        const index = typeof context.cursor?.i === 'number' ? context.cursor.i : 0;
        const page = pages[index];
        if (page === undefined) return { items: [], next: null, complete: completeOnLastPage };
        if (page.failWith !== undefined) throw page.failWith;
        const last = index + 1 >= pages.length;
        const items: OpenDataItem[] = page.records.map((record) => ({
          externalType: record.externalType,
          externalId: record.externalId,
          normalized: record.normalized,
          ...(record.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: record.sourceUpdatedAt }),
          raw: record.raw,
        }));
        return {
          items,
          next: last ? null : { i: index + 1 },
          complete: last && completeOnLastPage,
          ...(page.rateLimitHits === undefined ? {} : { rateLimitHits: page.rateLimitHits }),
        };
      },
    };
    const adapter = createOpenDataAdapter(descriptor, {
      // The descriptor never touches the network.
      http: {} as OpenDataHttp,
      // The suite's scenarios state their instants; the adapter's page clock
      // stands at the latest one the scenario's records carry.
      clock: () => {
        const instants = pages.flatMap((page) => page.records.map((record) => record.observedAt.getTime()));
        return instants.length === 0 ? SUITE_INSTANT : new Date(Math.max(...instants));
      },
    });
    // Every real open-data provider is `extraction: false`; the suite's
    // extraction case asks for the other answer to prove the gate refuses it.
    return scenario.extraction === true ? { ...adapter, extraction: true } : adapter;
  },
});
