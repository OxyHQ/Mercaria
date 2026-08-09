/**
 * #62's adapter contract, run against the REAL product-feed adapter (#63
 * acceptance 7: "the output uses the same source-record and matching contracts
 * as API adapters").
 *
 * All thirteen cases, a real Postgres server, and a real CSV: the harness
 * renders the scenario's records as a delimited file, stages it as an UPLOAD and
 * points a real `createProductFeedAdapter` at it. So the pipeline under test is
 * the real one end to end — fetch, decompress, decode, parse, map, validate,
 * stage, page, cursor, completion verdict — and what it produces flows into
 * `source_records`, `catalog_source_objects` and matched external `offers`
 * through the framework's own staged pipeline.
 *
 * ## Three deliberate substitutions, each named
 *
 * 1. **The origin is an UPLOAD, not a URL.** `safeFetch` refuses a loopback
 *    address, which is the guard working — so a URL harness would need a public
 *    host and the suite would depend on the internet. The upload path is the
 *    same `openFeedOrigin`, the same caps and the same parser; only the first
 *    few bytes differ. `feed-security.test.ts` covers the URL path's own
 *    refusals against the real guard.
 * 2. **`pageSize` is ONE.** A file has no page tokens: #63 reads the whole feed
 *    once and pages a local stage by record count, so "three pages" in the
 *    scenario can only mean "three records at one per page". `AdapterContractHarness`
 *    carries the value for exactly this reason.
 * 3. **A scenario `failWith` is raised BEFORE the adapter is called.** Case 6
 *    asks the framework to handle a classified adapter failure — it is about the
 *    RUN being released and nothing being retired, not about how #63 classifies
 *    a refusal. That mapping has its own test below, over every member of the
 *    refusal set, and it drives the real `fetchPage`.
 */

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeedFieldMapping, FeedFieldRole } from '@mercaria/shared-types';
import {
  describeCatalogSourceAdapterContract,
  normalizeContractPages,
  type ContractScenario,
} from '../../__tests__/adapter-contract-suite.js';
import { CatalogSourceFetchError, type CatalogSourceAdapter } from '../../adapter.js';
import { FEED_REFUSAL_REASONS, FeedImportRefusal, feedRefusalFetchKind } from '../../../feed-import/errors.js';
import type { ResolvedFeedImport } from '../../../feed-import/resolve.js';
import { stageUploadedFeed } from '../../../feed-import/upload.js';
import { createProductFeedAdapter, PRODUCT_FEED_PROVIDER } from '../product-feed.js';

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The staging directory is the configured one, and that is safe here.
 *
 * `config` is frozen and read at import, so a per-file override would have to be
 * an env var set before the module graph is evaluated — which vitest's parallel
 * files make unreliable. It costs nothing: an upload key is CSPRNG and a stage
 * key is the feed's own CONTENT DIGEST, so two suites can only share a file by
 * staging byte-identical content, and then the file they share is correct for
 * both.
 */

/** The mapping the harness's generated CSV is read under. */
const MAPPING = {
  fieldMappings: new Map<FeedFieldRole, FeedFieldMapping>([
    ['title', { role: 'title', sourceField: 'title' }],
    ['gtin', { role: 'gtin', sourceField: 'gtin' }],
    // The suite's records carry MINOR units (a `NormalizedSourceMoney.amount`),
    // so the column is declared as such — which is also the escape hatch a real
    // feed publishing `1999` for €19.99 uses. Without it the mapping would read
    // major units and multiply every price by a hundred, which is the failure
    // `money_minor_units` exists to make a merchant state rather than discover.
    ['price', { role: 'price', sourceField: 'price', transform: 'money_minor_units' }],
    ['price_currency', { role: 'price_currency', constantValue: 'EUR' }],
    ['destination_url', { role: 'destination_url', sourceField: 'link' }],
    ['source_updated_at', { role: 'source_updated_at', sourceField: 'updated_at' }],
  ]),
  valueMappings: new Map<string, string>(),
  identityKeyFields: ['id'] as readonly string[],
  listSeparator: ',',
  defaultCurrency: 'EUR',
  defaultCountry: null,
  defaultLanguage: null,
};

/** Quote a CSV cell exactly as RFC 4180 asks, so the parser earns its keep. */
function cell(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

/**
 * Render a scenario as ONE CSV.
 *
 * Every scenario page is concatenated, because a file has no pages — which is
 * the whole reason `pageSize` is one. A record with a blank title survives into
 * the file so the importer's own validation refuses it, which is contract case
 * 5's partial failure arriving through #63's path rather than #62's.
 */
function renderScenario(scenario: ContractScenario): string {
  const rows: string[] = ['id,title,gtin,price,link,updated_at'];
  for (const page of normalizeContractPages(scenario)) {
    for (const record of page.records) {
      const normalized = record.normalized;
      const gtin = normalized.identifiers[0]?.value ?? '';
      const price = normalized.price === undefined ? '' : String(normalized.price.amount);
      rows.push(
        [
          cell(record.externalId),
          cell(normalized.title),
          cell(gtin),
          cell(price),
          cell(normalized.sourceUrl ?? ''),
          cell(record.sourceUpdatedAt?.toISOString() ?? ''),
        ].join(','),
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

/**
 * Build an adapter that reads the scenario as an uploaded CSV.
 *
 * The staging is SYNCHRONOUS-looking because `createAdapter` is; the upload is
 * written lazily on the first `resolveFeed`, which is also when the adapter
 * would first need it.
 */
function createFeedContractAdapter(
  provider: string,
  scenario: ContractScenario,
): CatalogSourceAdapter {
  const pages = normalizeContractPages(scenario);
  const failure = pages.find((page) => page.failWith !== undefined)?.failWith;
  const csv = renderScenario(scenario);
  const deliveryMode = (scenario.completeOnLastPage ?? true) ? 'snapshot' : 'delta';

  let resolved: ResolvedFeedImport | null = null;

  const adapter = createProductFeedAdapter({
    resolveFeed: async () => {
      if (resolved !== null) return resolved;
      async function* bytes(): AsyncGenerator<Uint8Array> {
        yield Buffer.from(csv, 'utf8');
      }
      const staged = await stageUploadedFeed(bytes(), 'none');
      resolved = {
        configurationId: `contract-${staged.storageKey}`,
        versionId: `contract-version-${staged.storageKey}`,
        deliveryMode,
        compression: 'none',
        encoding: 'utf-8',
        parseOptions: {
          format: 'csv',
          delimiter: ',',
          quoteChar: '"',
          hasHeaderRow: true,
          recordPath: null,
          listSeparator: ',',
          maxRecordBytes: 64 * 1024,
          maxRecords: 10_000,
        },
        mapping: MAPPING,
        origin: {
          fetchMode: 'upload',
          feedUrl: null,
          uploadStorageKey: staged.storageKey,
          authorization: { kind: 'none', secret: null, paramName: null },
          validators: { etag: null, lastModified: null },
          timeoutMs: 5_000,
        },
      };
      return resolved;
    },
    recordValidators: async () => undefined,
    // The import report is #63's own surface and is covered by
    // `feed-import-writes.realdb.test.ts`; wiring it here would make every
    // contract case depend on a repository the adapter deliberately cannot
    // reach.
    recordImportReport: async () => undefined,
  });

  // The suite mints a UNIQUE slug per case so parallel registrations cannot
  // collide; the real adapter declares the one production slug. Overriding it is
  // the harness's job and changes nothing about the code under test — `provider`
  // is an identity the registry keys on, not behaviour.
  if (failure === undefined) return { ...adapter, provider };
  return {
    ...adapter,
    provider,
    async fetchPage() {
      // See the file docblock, substitution 3.
      throw failure;
    },
  };
}

describeCatalogSourceAdapterContract({
  name: 'the universal product-feed importer',
  providerPrefix: 'feedcontract',
  adapterSourceDir: ADAPTERS_DIR,
  // A file has no page tokens: three scenario pages are three records read one
  // at a time out of one staged file.
  pageSize: 1,
  // #63 validates BEFORE normalization, so an invalid row never becomes an
  // `AdapterRecord` and the framework has nothing to reject. The refusal is a
  // `feed_import_report_entries` row instead, which
  // `feed-import-writes.realdb.test.ts` pins against the real server and
  // `feed-mapping.test.ts` pins as an ISSUE with the offending column named.
  isolatesInvalidRecordsUpstream: true,
  createAdapter: createFeedContractAdapter,
});

describe('the adapter’s own failure classification', () => {
  it('turns every refusal into #62’s vocabulary, and the mapping is exhaustive', async () => {
    // The half contract case 6 substitutes: the framework's handling of a
    // classified failure is the suite's; TURNING a feed refusal into one is
    // this adapter's, and it is driven here through the real `fetchPage`.
    for (const reason of FEED_REFUSAL_REASONS) {
      const adapter = createProductFeedAdapter({
        resolveFeed: async () => {
          throw new FeedImportRefusal(reason, `refused: ${reason}`);
        },
        recordValidators: async () => undefined,
        recordImportReport: async () => undefined,
      });

      let raised: unknown;
      try {
        await adapter.fetchPage({
          // #65 added `sourceId` to the request — an identifier with no
          // repository behind it, so an adapter can scope a capability it was
          // already constructed with.
          sourceId: 'source-for-contract-test',
          cursor: null,
          pageSize: 10,
          credentialRef: null,
          sourceAccountRef: 'anything',
          since: null,
          territories: [],
          mode: 'full_snapshot',
          externalIds: [],
        });
      } catch (error: unknown) {
        raised = error;
      }
      expect(raised, `${reason} did not refuse`).toBeInstanceOf(CatalogSourceFetchError);
      expect((raised as CatalogSourceFetchError).kind).toBe(feedRefusalFetchKind(reason));
    }
    // The vacuity floor: an emptied reason list would satisfy the loop above
    // without asserting anything.
    expect(FEED_REFUSAL_REASONS.length).toBeGreaterThanOrEqual(15);
  });

  it('refuses a source with no ACTIVE mapping rather than fetching', async () => {
    const adapter = createProductFeedAdapter({
      resolveFeed: async () => null,
      recordValidators: async () => undefined,
      recordImportReport: async () => undefined,
    });
    await expect(
      adapter.fetchPage({
        sourceId: 'source-for-contract-test',
        cursor: null,
        pageSize: 10,
        credentialRef: null,
        sourceAccountRef: null,
        since: null,
        territories: [],
        mode: 'full_snapshot',
        externalIds: [],
      }),
    ).rejects.toMatchObject({ kind: 'schema_drift' });
  });

  it('declares the provider slug and is not an extraction source', () => {
    const adapter = createProductFeedAdapter({
      resolveFeed: async () => null,
      recordValidators: async () => undefined,
      recordImportReport: async () => undefined,
    });
    expect(adapter.provider).toBe(PRODUCT_FEED_PROVIDER);
    expect(adapter.kind).toBe('feed');
    // A feed is published by its owner or uploaded by them. Declaring it as
    // extraction would make `assertMayFetch` demand an extraction policy nobody
    // needs to review.
    expect(adapter.extraction).toBe(false);
  });
});
