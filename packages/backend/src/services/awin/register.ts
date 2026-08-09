/**
 * Registering the Awin adapter, and the ONE place its three dependencies are
 * satisfied (#66).
 *
 * ## The registration is gated and the durable record never is
 *
 * `AWIN_ENABLED` decides whether this deployment FETCHES Awin. With it off,
 * accounts, advertisers, feeds, quality snapshots, samples and every #62 row are
 * stored and readable, every run refuses with #62's own `adapter_missing`, and
 * turning the flag on drains the backlog. That is `CATALOG_INGESTION_ENABLED`'s
 * arrangement one layer down, and it is why a rollback of this source costs
 * nobody anything they configured.
 *
 * **It deliberately does NOT demand a credential to be set**, unlike #63's
 * `FEED_IMPORT_ENABLED`. The difference is real rather than an inconsistency:
 * #63 demands its encryption key because a feed's credential has nowhere to GO
 * without it, so a configuration would be unstorable. Awin's key is a LOCATOR on
 * a row — storable and reviewable with no key present — and a deployment that
 * registered the adapter before the locator resolves gets an honest
 * `auth_failure` naming the missing secret rather than a silent no-op.
 *
 * ## Why the adapter is handed functions rather than importing them
 *
 * `ingestion-isolation.test.ts` scans `services/ingestion/adapters/` and fails
 * the build if any module there imports a repository, a database handle or
 * drizzle — the wall #62 built so it holds for adapters nobody has written yet.
 * The Awin adapter genuinely needs three things from Postgres, and all three
 * arrive here: which advertiser this source is, the network lease its download
 * spends, and somewhere to put the measurement.
 *
 * Neither is a hole in that wall. The wall exists to stop a provider module
 * writing into the COMMERCE GRAPH — a canonical product, a merchant, an offer, a
 * match — and none of the three can. The write boundary is still the SIGNATURE.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { registerCatalogSourceAdapter } from '../ingestion/registry.js';
import {
  AWIN_FEED_PROVIDER,
  createAwinFeedAdapter,
  stageAwinFeed,
  type AwinStagedPass,
} from '../ingestion/adapters/awin-feed.js';
import { openAwinFeed, withAwinNetworkLease } from './network.js';
import {
  awinMappingFor,
  recordAwinImport,
  resolveAwinFeed,
  type ResolvedAwinFeed,
} from './resolve.js';

/** Register the adapter, unless this deployment does not fetch Awin. */
export function registerAwinFeedAdapter(): void {
  if (!config.awin.enabled) {
    log.general.info(
      '[Awin] AWIN_ENABLED is off; the awin_feed adapter is not registered. Accounts, ' +
        'advertisers, feeds, quality snapshots and samples are stored and every run refuses ' +
        'until it is switched on.',
    );
    return;
  }

  registerCatalogSourceAdapter(
    createAwinFeedAdapter({
      resolveFeed: async (sourceAccountRef) => resolveAwinFeed(sourceAccountRef),
      stageFeed: async (resolved, signal) => stageOneAwinFeed(resolved, signal),
      recordImport: async (resolved, pass) => {
        await recordAwinImport(resolved, {
          digest: pass.stage.manifest.digest,
          declaredColumns: pass.declaredColumns,
          // What this pass CONSUMED, which is what the cheap staleness detector
          // compares against next time. Taken from the LISTING rather than from
          // the download, because it is the list's claim that the scheduler
          // reads — recording anything else would compare two different facts.
          consumedLastImportedAt: resolved.feed.listedLastImportedAt,
          validators: pass.validators,
          counts: pass.counts,
          // #66 records no run id: the adapter is handed no run, by #62's own
          // contract, and inventing one from the dispatcher's context would make
          // a snapshot cite a pass it cannot prove it belonged to. The column is
          // nullable for exactly this reason and the measurement stands alone.
          runId: null,
        });
      },
    }),
  );

  log.general.info({ provider: AWIN_FEED_PROVIDER }, '[Awin] adapter registered');
}

/**
 * Open one advertiser's feed under the network lease and stage it.
 *
 * The lease wraps the WHOLE call, download included: a lease released at the
 * response headers would let N tasks stream N feeds concurrently under a
 * concurrency bound of two, which is the arithmetic that gets a publisher
 * account suspended.
 */
async function stageOneAwinFeed(
  resolved: ResolvedAwinFeed,
  signal: AbortSignal | undefined,
): Promise<AwinStagedPass | null> {
  return withAwinNetworkLease(
    { budget: resolved.budget, leaseOwner: `awin-${resolved.advertiser.id}` },
    async () => {
      const opened = await openAwinFeed({
        feedCredentialRef: resolved.account.feedCredentialRef,
        feedId: resolved.feed.feedId,
        columns: resolved.requestedColumns,
        validators: resolved.validators,
        ...(signal === undefined ? {} : { signal }),
      });
      if (opened.kind === 'not_modified') return null;

      try {
        return await stageAwinFeed({
          resolved,
          mapping: awinMappingFor(resolved),
          openBytes: async () => opened.bytes,
          validators: opened.validators,
        });
      } finally {
        // Every branch, including a refusal mid-stream: a socket left open
        // holds a connection to Awin until the process exits.
        opened.close();
      }
    },
  );
}
