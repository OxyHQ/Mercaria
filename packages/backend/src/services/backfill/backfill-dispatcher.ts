/**
 * The loop that pages open backfill runs (#60 job behaviour 2).
 *
 * Starts on EVERY task, like the moderation, offer and match dispatchers, and
 * for the same reason: a claim is a `FOR UPDATE SKIP LOCKED` lease with an owner
 * check, so N tasks share the work without handing each other a run, and a dead
 * task's lease is reclaimed rather than stranding a pass halfway.
 *
 * ## The LOOP is gated; the durable record never is
 *
 * `CANONICAL_GRAPH_ENABLED` stops this loop and nothing else. An operator can
 * still OPEN a run while it is off — the row is durable, the cursor is durable,
 * and turning the flag on drains the backlog instead of stranding it. That is
 * the `CROWDSOURCE_ENABLED` rule, and it is what makes "start the migration
 * paused, then turn it on during a quiet window" a supported thing to do rather
 * than a scripting exercise.
 *
 * ## Why this loop is NOT what a canary rollout uses
 *
 * A canary is a cohort-scoped run an operator opens and pages by hand from
 * `/internal/backfill/runs/:id/page`, watching the counters between pages. The
 * dispatcher exists for the unattended remainder — the whole-catalogue passes
 * that take hours — and for resuming after a deploy. Both drive the same
 * `runCatalogBackfillPage`, so neither is a second implementation of the
 * migration.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { drainCatalogBackfill } from './backfill.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const pages = await drainCatalogBackfill();
    if (pages.length > 0) log.general.debug({ pages: pages.length }, '[Backfill] pages drained');
  } catch (error: unknown) {
    // The loop must survive anything a single page throws, or one bad run stops
    // the migration for the life of the process.
    log.general.error({ err: error }, '[Backfill] dispatch failed');
  } finally {
    running = false;
  }
}

/** Begin paging. Idempotent — a second call is a no-op. */
export function startCatalogBackfillDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.canonicalRollout.graphEnabled) {
    log.general.info(
      '[Backfill] canonical graph backfill disabled; runs opened now are stored and will ' +
        'resume once CANONICAL_GRAPH_ENABLED is on',
    );
    return;
  }

  timer = setInterval(() => {
    void tick();
  }, config.canonicalRollout.backfillPollIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      pollIntervalMs: config.canonicalRollout.backfillPollIntervalMs,
      batchSize: config.canonicalRollout.backfillBatchSize,
      writePublicationEnabled: config.canonicalRollout.writePublicationEnabled,
    },
    '[Backfill] dispatcher started',
  );
}

/** Stop claiming new pages. A page already in flight reaches a durable state. */
export function stopCatalogBackfillDispatcher(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
