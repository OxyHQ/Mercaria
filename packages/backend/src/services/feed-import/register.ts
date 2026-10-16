/**
 * Registering the `product_feed` adapter, and the ONE place its two database
 * dependencies are satisfied (#63).
 *
 * The adapter is registered on every deployment: the importer is not a lever,
 * and a feed credential's encryption key is derived from `MERCARIA_SECRET_KEY`.
 *
 * ## Why the adapter is handed functions rather than importing them
 *
 * `ingestion-isolation.test.ts` scans `services/ingestion/adapters/` and fails
 * the build if any module there imports a repository, a database handle or
 * drizzle — the wall #62 built so it holds for adapters nobody has written yet.
 * The feed adapter genuinely needs two things from Postgres, and both arrive
 * here: its own ACTIVE mapping, and somewhere to put the per-record issues an
 * import found.
 *
 * Neither is a hole in that wall. The wall exists to stop a provider module
 * writing into the COMMERCE GRAPH — a canonical product, a merchant, an offer, a
 * match — and reading a mapping and writing a file-quality report are neither.
 * The write boundary is still the SIGNATURE: `AdapterRecord` has no canonical
 * id, no merchant id and no offer id to put one in, and
 * `feed-import-isolation.test.ts` asserts no module in this domain can reach any
 * of them.
 */

import { log } from '../../lib/logger.js';
import { config } from '../../config/index.js';
import { registerCatalogSourceAdapter } from '../ingestion/registry.js';
import {
  createProductFeedAdapter,
  PRODUCT_FEED_PROVIDER,
} from '../ingestion/adapters/product-feed.js';
import { composeFeedImportReport } from './report.service.js';
import { feedSourceIdFor, recordFeedImportValidators, resolveFeedImport } from './resolve.js';
import { sweepFeedStages } from './staging.js';

let sweepTimer: NodeJS.Timeout | undefined;

/** Register the adapter. */
export function registerProductFeedAdapter(): void {
  registerCatalogSourceAdapter(
    createProductFeedAdapter({
      resolveFeed: async (configurationId) => resolveFeedImport(configurationId),
      recordValidators: async (feed, validators) => {
        await recordFeedImportValidators(feed, validators);
      },
      recordImportReport: async (feed, stage) => {
        const sourceId = await feedSourceIdFor(feed.configurationId);
        if (sourceId === null) return;
        await composeFeedImportReport({
          configurationId: feed.configurationId,
          versionId: feed.versionId,
          sourceId,
          mode: 'import',
          stage,
          // An import is driven by the dispatcher, not by a person. The actor is
          // the loop's own identity rather than a fabricated operator id: a
          // report attributed to somebody who did not ask for it is a false
          // audit trail, which is the `catalog_source_runs_requested_by_check`
          // rule one domain over.
          requestedByOxyUserId: IMPORT_ACTOR,
        });
      },
    }),
  );

  log.general.info({ provider: PRODUCT_FEED_PROVIDER }, '[FeedImport] adapter registered');
}

/**
 * The actor a scheduled import's report is attributed to.
 *
 * A literal rather than an Oxy id, because no Oxy account asked for it. It is
 * recognisable in a report list and cannot collide with an account id, which is
 * a UUIDv7.
 */
const IMPORT_ACTOR = 'system:feed-import';

/**
 * Start the staged-pass sweep.
 *
 * A stage is disposable — losing one costs a re-download and nothing else — so
 * the sweep needs no lease and no coordination. It runs because a task whose
 * disk fills with abandoned stages stops serving requests, which is the failure
 * a feed importer with no sweep produces after a fortnight of interrupted runs.
 */
export function startFeedStageSweeper(): void {
  if (sweepTimer !== undefined) return;

  sweepTimer = setInterval(() => {
    void sweepFeedStages().catch((error: unknown) => {
      log.general.warn({ err: error }, '[FeedImport] stage sweep failed');
    });
  }, config.feedImport.stageTtlMs);
  // Never hold the event loop open for housekeeping — see `~/Oxy/AGENTS.md`.
  sweepTimer.unref?.();
}

export function stopFeedStageSweeper(): void {
  if (sweepTimer !== undefined) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}
