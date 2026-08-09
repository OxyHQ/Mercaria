/**
 * The adapter contract, run against the FIXTURE provider (#62 acceptance 1).
 *
 * Thirteen cases, a real Postgres server, and an end-to-end ingestion from an
 * in-memory feed into `source_records` observations and matched external
 * `offers`. Everything in `adapter-contract-suite.ts`; this file is the
 * one-line runner a provider package copies.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureAdapter } from '../adapters/fixture.js';
import {
  describeCatalogSourceAdapterContract,
  normalizeContractPages,
} from './adapter-contract-suite.js';

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters');

describeCatalogSourceAdapterContract({
  name: 'the fixture feed',
  providerPrefix: 'fixture',
  adapterSourceDir: ADAPTERS_DIR,
  createAdapter: (provider, scenario) => {
    // The scenario is stated in FRAMEWORK terms; this is where one transport
    // materialises it. A real provider's harness stubs an HTTP server here
    // instead, and gets the same thirteen cases.
    const pages = normalizeContractPages(scenario);
    return createFixtureAdapter({
      provider,
      pages: pages.map((page) => page.records),
      behaviour: Object.fromEntries(
        pages.flatMap((page, index) =>
          page.failWith === undefined && page.rateLimitHits === undefined
            ? []
            : [
                [
                  index,
                  {
                    ...(page.failWith === undefined ? {} : { failWith: page.failWith }),
                    ...(page.rateLimitHits === undefined
                      ? {}
                      : { rateLimitHits: page.rateLimitHits }),
                  },
                ],
              ],
        ),
      ),
      ...(scenario.completeOnLastPage === undefined
        ? {}
        : { completeOnLastPage: scenario.completeOnLastPage }),
      ...(scenario.extraction === undefined ? {} : { extraction: scenario.extraction }),
    });
  },
});
