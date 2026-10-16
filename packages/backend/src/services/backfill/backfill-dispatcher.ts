/**
 * The loop that pages open backfill runs (#60 job behaviour 2).
 *
 * Starts on EVERY task, like the moderation, offer and match dispatchers, and
 * for the same reason: a claim is a `FOR UPDATE SKIP LOCKED` lease with an owner
 * check, so N tasks share the work without handing each other a run, and a dead
 * task's lease is reclaimed rather than stranding a pass halfway.
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
  timer = setInterval(() => {
    void tick();
  }, config.canonicalRollout.backfillPollIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      pollIntervalMs: config.canonicalRollout.backfillPollIntervalMs,
      batchSize: config.canonicalRollout.backfillBatchSize,
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
