/**
 * #62's adapter contract, run against the REAL Awin adapter (#66 test 1).
 *
 * All thirteen cases, a real Postgres server, and a real GZIPPED CSV in Awin's
 * own column names: the harness renders the scenario's records as an Awin feed,
 * gzips it, and points a real `createAwinFeedAdapter` at it through the real
 * `stageAwinFeed`. So the pipeline under test is the real one end to end —
 * decompress, decode, parse, map through the real `buildAwinMapping`, assess
 * every deep link through the real `assessAwinTrackingLink`, measure the real
 * quality counts, stage, page, cursor, completion verdict — and what it
 * produces flows into `source_records`, `catalog_source_objects` and matched
 * external `offers` through #62's own staged pipeline.
 *
 * ## Three deliberate substitutions, each named
 *
 * 1. **The bytes are supplied, not fetched.** `safeFetch` refuses a loopback
 *    address, which is the guard working — so a URL harness would need a public
 *    host and the suite would depend on the internet and on a real publisher
 *    key. `services/awin/network.ts` is the only module that fetches and its own
 *    behaviour is covered by `awin-rules.test.ts` (URL composition) and #63's
 *    `feed-security.test.ts` (the guard itself, against the real
 *    `openFeedStream`).
 * 2. **`pageSize` is ONE.** A file has no page tokens: the adapter reads the
 *    whole feed once and pages a local stage by record count, so "three pages"
 *    in the scenario can only mean "three records at one per page".
 * 3. **A scenario `failWith` is raised BEFORE the adapter is called.** Case 6
 *    asks the framework to handle a classified adapter failure — it is about the
 *    RUN being released and nothing being retired, not about how #66 classifies
 *    a refusal. That mapping has its own test below, over every member of the
 *    refusal set, and it drives the real `fetchPage`.
 *
 * `completeOnLastPage: false` is expressed the way an Awin pass really becomes
 * incomplete: a `sampleLimit`, which is what a pre-activation sample reads and
 * which sets `enumeratedFully: false` on the manifest. No branch is added to the
 * adapter for the test.
 */

import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogSourceRightsVerdict } from '@mercaria/shared-types';
import { AWIN_FEED_COLUMNS, AWIN_MAPPING_VERSION } from '@mercaria/shared-types';
import {
  describeCatalogSourceAdapterContract,
  normalizeContractPages,
  type ContractScenario,
} from '../../__tests__/adapter-contract-suite.js';
import { CatalogSourceFetchError, type CatalogSourceAdapter } from '../../adapter.js';
import {
  FEED_REFUSAL_REASONS,
  FeedImportRefusal,
  feedRefusalFetchKind,
} from '../../../feed-import/errors.js';
import { buildAwinMapping } from '../../../awin/mapping.js';
import type { ResolvedAwinFeed } from '../../../awin/resolve.js';
import { AWIN_FEED_PROVIDER, createAwinFeedAdapter, stageAwinFeed } from '../awin-feed.js';

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALL_RIGHTS: CatalogSourceRightsVerdict = {
  store: true,
  cache: true,
  display_price: true,
  display_media: true,
  outbound_link: true,
  affiliate_params: true,
  index: true,
  automated_refresh: true,
  extraction: false,
};

/**
 * The columns the harness renders — a SUBSET of what Mercaria requests, which
 * is the realistic case: Awin ships only the columns an advertiser mapped.
 */
const RENDERED_COLUMNS = [
  'aw_product_id',
  'product_name',
  'ean',
  'search_price',
  'currency',
  'merchant_deep_link',
  'aw_deep_link',
  'last_updated',
] as const;

/** Quote a CSV cell exactly as RFC 4180 asks, so the parser earns its keep. */
function cell(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

/**
 * Render a scenario as ONE Awin feed.
 *
 * Every scenario page is concatenated, because a file has no pages — which is
 * the whole reason `pageSize` is one. Prices are rendered in MAJOR units
 * because that is what Awin's `search_price` publishes, and #63's money reader
 * converts them back; a record with a blank title survives into the file so the
 * importer's own validation refuses it, which is contract case 5's partial
 * failure arriving through #63's path rather than #62's.
 *
 * A deep link is rendered only when the record carries a `sourceUrl`, and it is
 * always on `www.awin1.com` — the approved host, so the contract cases exercise
 * the ACCEPTING branch of the tracking assessment. The refusing branches are
 * `awin-rules.test.ts`'s.
 */
function renderScenario(scenario: ContractScenario): Buffer {
  const rows: string[] = [RENDERED_COLUMNS.join(',')];
  for (const page of normalizeContractPages(scenario)) {
    for (const record of page.records) {
      const normalized = record.normalized;
      const destination = normalized.sourceUrl ?? '';
      rows.push(
        [
          cell(record.externalId),
          cell(normalized.title),
          cell(normalized.identifiers[0]?.value ?? ''),
          cell(
            normalized.price === undefined ? '' : (normalized.price.amount / 100).toFixed(2),
          ),
          cell(normalized.price?.currency ?? ''),
          cell(destination),
          cell(
            destination === ''
              ? ''
              : `https://www.awin1.com/cread.php?awinmid=1&awinaffid=2&p=${encodeURIComponent(destination)}`,
          ),
          cell(record.sourceUpdatedAt?.toISOString() ?? ''),
        ].join(','),
      );
    }
  }
  return gzipSync(Buffer.from(`${rows.join('\n')}\n`, 'utf8'));
}

/** A resolved feed with everything the adapter reads, and no database behind it. */
function resolvedFor(): ResolvedAwinFeed {
  const now = new Date('2026-08-09T09:00:00.000Z');
  return {
    advertiser: {
      id: 'adv-contract',
      accountId: 'acct-contract',
      advertiserId: '1001',
      displayName: 'Contract advertiser',
      catalogSourceId: 'src-contract',
      membershipStatus: 'joined',
      membershipChangedAt: now,
      activation: 'active',
      activationChangedAt: now,
      activationChangedByOxyUserId: 'contract-operator',
      activationNote: null,
      activatingSampleId: 'sample-contract',
      primaryRegion: 'ES',
      vertical: 'Retail',
      declaredHost: 'retailer.example',
      lastSeenInListAt: now,
      createdAt: now,
      updatedAt: now,
    },
    account: {
      id: 'acct-contract',
      publisherId: '999',
      label: 'Contract publisher',
      feedCredentialRef: 'env:AWIN_CONTRACT_KEY',
      publisherApiCredentialRef: null,
      state: 'active',
      stateReason: null,
      stateChangedAt: null,
      stateChangedByOxyUserId: null,
      stateNote: null,
      maxConcurrency: 2,
      maxCallsPerMinute: 20,
      lastListPolledAt: now,
      lastListDigest: null,
      lastListFeedCount: 1,
      lastListError: null,
      lastListErrorAt: null,
      createdAt: now,
      updatedAt: now,
    },
    feed: {
      id: 'feed-contract',
      advertiserRowId: 'adv-contract',
      feedId: '42',
      feedName: 'Contract feed',
      language: 'es',
      currency: 'EUR',
      productCount: null,
      listedLastImportedAt: now,
      lastSeenInListAt: now,
      declaredColumns: [],
      importedLastImportedAt: null,
      lastImportAt: null,
      lastImportDigest: null,
      httpEtag: null,
      httpLastModified: null,
      mappingVersion: AWIN_MAPPING_VERSION,
      createdAt: now,
      updatedAt: now,
    },
    rights: ALL_RIGHTS,
    budget: { accountId: 'acct-contract', maxConcurrency: 2, maxCallsPerMinute: 20 },
    validators: { etag: null, lastModified: null },
    requestedColumns: AWIN_FEED_COLUMNS,
    parseOptions: {
      format: 'csv',
      delimiter: ',',
      quoteChar: '"',
      hasHeaderRow: true,
      recordPath: null,
      listSeparator: '|',
      maxRecordBytes: 64 * 1024,
      maxRecords: 10_000,
    },
    mappingVersion: AWIN_MAPPING_VERSION,
  };
}

function createAwinContractAdapter(
  provider: string,
  scenario: ContractScenario,
): CatalogSourceAdapter {
  const pages = normalizeContractPages(scenario);
  const failure = pages.find((page) => page.failWith !== undefined)?.failWith;
  const gzipped = renderScenario(scenario);
  const recordCount = pages.reduce((total, page) => total + page.records.length, 0);
  const resolved = resolvedFor();

  const adapter = createAwinFeedAdapter({
    resolveFeed: async () => Promise.resolve(resolved),
    stageFeed: async (feed) =>
      stageAwinFeed({
        resolved: feed,
        mapping: buildAwinMapping({
          declared: feed.requestedColumns,
          defaultCurrency: feed.feed.currency,
          defaultCountry: feed.advertiser.primaryRegion,
          defaultLanguage: feed.feed.language,
        }),
        openBytes: async () =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              yield gzipped;
            },
          }),
        validators: { etag: null, lastModified: null },
        // An incomplete enumeration expressed the way an Awin pass really
        // becomes one — a capped read, which is what a pre-activation sample
        // does — rather than by adding a branch to the adapter for the test.
        // `buildFeedStage` sets `enumeratedFully` from whether a cap was GIVEN
        // rather than from whether it was reached, which is the correct rule
        // and the reason the limit here can cover every record: a pass that was
        // bounded did not establish that it saw everything, even when it
        // happened to.
        ...((scenario.completeOnLastPage ?? true)
          ? {}
          : { sampleLimit: Math.max(1, recordCount) }),
      }),
    // The quality snapshot is #66's own surface and is covered by
    // `awin-writes.realdb.test.ts`; wiring it here would make every contract
    // case depend on a repository the adapter deliberately cannot reach.
    recordImport: async () => undefined,
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
  name: 'the Awin retailer-network source',
  providerPrefix: 'awincontract',
  adapterSourceDir: ADAPTERS_DIR,
  // A file has no page tokens: three scenario pages are three records read one
  // at a time out of one staged file.
  pageSize: 1,
  // #63 validates BEFORE normalization, so an invalid row never becomes an
  // `AdapterRecord` and the framework has nothing to reject. #66 inherits that
  // whole property by calling #63's stack; the refusal is counted in
  // `awin_advertiser_quality.rejected`, which `awin-rules.test.ts` pins as a
  // partition that ADDS UP and `awin-writes.realdb.test.ts` pins against the
  // CHECK that enforces it.
  isolatesInvalidRecordsUpstream: true,
  createAdapter: createAwinContractAdapter,
});

describe('the Awin adapter’s own declarations and refusals', () => {
  function adapterWithRefusal(reason: (typeof FEED_REFUSAL_REASONS)[number]): CatalogSourceAdapter {
    return createAwinFeedAdapter({
      resolveFeed: async () => {
        throw new FeedImportRefusal(reason, `refused: ${reason}`);
      },
      stageFeed: async () => Promise.resolve(null),
      recordImport: async () => undefined,
    });
  }

  const REQUEST = {
    // #65 added `sourceId` to the request; #66 resolves by `sourceAccountRef`
    // (the advertiser row id, #63's arrangement) and carries this so the shape
    // is the framework's real one.
    sourceId: 'src-contract',
    cursor: null,
    pageSize: 10,
    credentialRef: null,
    sourceAccountRef: 'adv-contract',
    since: null,
    territories: [],
    mode: 'full_snapshot' as const,
    externalIds: [],
  };

  it('turns every refusal into #62’s vocabulary, and the mapping is exhaustive', async () => {
    // The half contract case 6 substitutes: the framework's handling of a
    // classified failure is the suite's; TURNING a feed refusal into one is
    // this adapter's, and it is driven here through the real `fetchPage`.
    for (const reason of FEED_REFUSAL_REASONS) {
      let raised: unknown;
      try {
        await adapterWithRefusal(reason).fetchPage(REQUEST);
      } catch (error: unknown) {
        raised = error;
      }
      expect(raised, `${reason} did not refuse`).toBeInstanceOf(CatalogSourceFetchError);
      expect((raised as CatalogSourceFetchError).kind).toBe(feedRefusalFetchKind(reason));
    }
    // The vacuity floor: an emptied reason list would satisfy the loop above
    // without asserting anything.
    expect(FEED_REFUSAL_REASONS.length).toBeGreaterThanOrEqual(16);
  });

  it('a conditional 304 yields no records and is NOT an enumeration', async () => {
    // THE trap conditional requests introduce: the host says "your copy is
    // current", the pass sees zero records, and a complete enumeration of zero
    // records retires everything the advertiser has.
    const page = await createAwinFeedAdapter({
      resolveFeed: async () => Promise.resolve(resolvedFor()),
      stageFeed: async () => Promise.resolve(null),
      recordImport: async () => undefined,
    }).fetchPage(REQUEST);
    expect(page.records).toEqual([]);
    expect(page.complete).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('refuses a feed that scanned rows and mapped none of them', async () => {
    // A pass that read the bytes perfectly well and could not make a record out
    // of any of them is a change in the source's SHAPE, not a catalogue of
    // nothing — a renamed identity column, an error page served with a 200. An
    // EMPTY feed is deliberately different and is covered by the contract
    // suite's own retirement case.
    const resolved = resolvedFor();
    const gzipped = gzipSync(
      Buffer.from('aw_product_id,product_name\n"","no id at all"\n', 'utf8'),
    );
    await expect(
      stageAwinFeed({
        resolved,
        mapping: buildAwinMapping({
          declared: resolved.requestedColumns,
          defaultCurrency: 'EUR',
          defaultCountry: null,
          defaultLanguage: null,
        }),
        openBytes: async () =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              yield gzipped;
            },
          }),
        validators: { etag: null, lastModified: null },
      }),
    ).rejects.toMatchObject({ reason: 'no_records_mapped' });
  });

  it('declares the provider slug, the network kind, and no extraction', () => {
    const adapter = adapterWithRefusal('configuration_missing');
    expect(adapter.provider).toBe(AWIN_FEED_PROVIDER);
    // `affiliate_network` is what makes #62's own `offerKindFor` produce an
    // `affiliate` offer once the rights permit affiliate parameters.
    expect(adapter.kind).toBe('affiliate_network');
    // A feed downloaded from the URL its publisher documented is not extraction.
    expect(adapter.extraction).toBe(false);
    // A feed is one file at one URL: no call re-reads a named list of ids and
    // none answers a query.
    expect([...adapter.refreshModes].sort()).toEqual(['full_snapshot', 'incremental']);
  });
});
