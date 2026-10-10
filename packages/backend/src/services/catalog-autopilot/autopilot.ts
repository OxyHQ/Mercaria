/**
 * The catalogue autopilot — what keeps the comparator's pipeline running with
 * nobody at the operator console.
 *
 * Two jobs, each behind the lever that already governs it:
 *
 * 1. **Sources** (`CATALOG_INGESTION_ENABLED`): publish the baseline matching
 *    policy when none is active, and converge the declared open-data sources
 *    (`services/open-data/sources.ts`). #62's ingestion dispatcher then fetches
 *    them on their cadence.
 * 2. **Stages** (`CANONICAL_GRAPH_ENABLED`): open the next whole-catalogue
 *    backfill run of the cycle (`stage-plan.ts`) in `apply` mode. The backfill
 *    dispatcher pages it like any operator-opened run, and
 *    `CANONICAL_WRITE_PUBLICATION_ENABLED` still decides whether it writes.
 *
 * The chain this closes, end to end: Open Prices sees a Mercadona price for a
 * GTIN → Open Food Facts fetches that GTIN as demand → `reference_products`
 * mints the product → `source_readvance` attaches the price as an offer →
 * `reference_promotion` makes the product `active` → `/search` finds it.
 *
 * Starts on every task. Planning reads the run table and opening a run
 * converges on the open one, so N tasks open one run per stage, not N.
 */

import { config } from '../../config/index.js';
import { findLatestWholeCatalogueRuns } from '../../db/backfill/backfillRunRepository.js';
import { log } from '../../lib/logger.js';
import { openCatalogBackfillRun } from '../backfill/backfill.service.js';
import { CATALOG_BACKFILL_MAPPING_VERSION } from '../backfill/mapping-version.js';
import { DECLARED_OPEN_DATA_SOURCES } from '../open-data/sources.js';
import { CATALOG_AUTOPILOT_ACTOR } from './actor.js';
import { ensureActiveMatchPolicy } from './match-policy.js';
import { reconcileDeclaredSources } from './sources.js';
import { AUTOPILOT_STAGE_SEQUENCE, planNextStage, type StageRunFacts } from './stage-plan.js';
import type { CatalogBackfillStage } from '@mercaria/shared-types';

/** How often the autopilot looks at the run table. */
const TICK_INTERVAL_MS = 60_000;

/** How often the declared sources are re-converged after the boot pass. */
const SOURCE_RECONCILE_INTERVAL_MS = 60 * 60 * 1_000;

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastSourcesReconciledAt = 0;

/** Converge the matching policy and the declared sources. */
export async function reconcileCatalogSources(): Promise<void> {
  await ensureActiveMatchPolicy();
  const results = await reconcileDeclaredSources(DECLARED_OPEN_DATA_SOURCES);
  const failed = results.filter((result) => result.error !== null).length;
  log.general.info(
    {
      sources: results.length,
      failed,
      activated: results.filter((result) => result.activated).length,
      policiesPublished: results.filter((result) => result.policyPublished).length,
    },
    '[CatalogAutopilot] declared sources reconciled',
  );
}

/** Open the next stage of the cycle, if one is due. Returns the stage opened. */
export async function advanceCatalogStages(
  now: Date = new Date(),
): Promise<CatalogBackfillStage | null> {
  const runs = await findLatestWholeCatalogueRuns({
    stages: AUTOPILOT_STAGE_SEQUENCE,
    mode: 'apply',
    mappingVersion: CATALOG_BACKFILL_MAPPING_VERSION,
  });
  const latest = new Map<CatalogBackfillStage, StageRunFacts>(runs.map((run) => [run.stage, run]));
  const stage = planNextStage(latest, now);
  if (stage === null) return null;

  const { created } = await openCatalogBackfillRun({
    stage,
    mode: 'apply',
    cohort: { kind: 'all' },
    requestedByOxyUserId: CATALOG_AUTOPILOT_ACTOR,
  });
  if (created) log.general.info({ stage }, '[CatalogAutopilot] backfill stage opened');
  return stage;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (
      config.catalogIngestion.enabled &&
      Date.now() - lastSourcesReconciledAt >= SOURCE_RECONCILE_INTERVAL_MS
    ) {
      await reconcileCatalogSources();
      lastSourcesReconciledAt = Date.now();
    }
    if (config.canonicalRollout.graphEnabled) await advanceCatalogStages();
  } catch (error: unknown) {
    // Survive anything one tick throws; the next tick re-reads the state.
    log.general.error({ err: error }, '[CatalogAutopilot] tick failed');
  } finally {
    running = false;
  }
}

/** Begin. Idempotent — a second call is a no-op. */
export function startCatalogAutopilot(): void {
  if (timer !== undefined) return;
  if (!config.catalogIngestion.enabled && !config.canonicalRollout.graphEnabled) {
    log.general.info(
      '[CatalogAutopilot] ingestion and the canonical graph are both off; not started',
    );
    return;
  }
  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();
  void tick();
  log.general.info('[CatalogAutopilot] started');
}

export function stopCatalogAutopilot(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}
