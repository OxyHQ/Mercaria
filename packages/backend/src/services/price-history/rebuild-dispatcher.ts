/**
 * The rebuild loop (#78 operations 1 and 2).
 *
 * An observation is written on every offer write, and a series is enqueued
 * only in the currencies `PRICE_HISTORY_SERIES_CURRENCIES` lists — that list,
 * empty by default, is the real switch. A series reports its own `rebuiltAt`
 * and coverage, so a reader can see exactly how stale it is.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  claimPriceSeriesRebuilds,
  releasePriceSeriesRebuild,
} from '../../db/priceHistory/priceSeriesRepository.js';
import { rebuildPriceSeries } from './rebuild.service.js';

/** How many failed attempts before a series stops being retried. */
const MAX_REBUILD_ATTEMPTS = 8;

/** One tick: claim a batch, rebuild each, release. Returns how many were rebuilt. */
export async function runPriceSeriesRebuildTick(
  leaseOwner: string,
  now: Date = new Date(),
): Promise<number> {
  const claimed = await claimPriceSeriesRebuilds(
    {
      leaseOwner,
      batchSize: config.priceHistory.rebuildBatchSize,
      leaseMs: config.priceHistory.rebuildLeaseMs,
      now,
    },
    undefined,
  );

  let rebuilt = 0;
  for (const series of claimed) {
    try {
      const owned = await rebuildPriceSeries(series, leaseOwner, now);
      if (owned) rebuilt += 1;
    } catch (err) {
      // Capped exponential backoff, and a VISIBLE dead letter rather than a
      // silent stop — the payment outbox's shape. A dead-lettered series keeps
      // whatever points it had, and its `rebuiltAt` is what tells a reader the
      // chart is not being maintained.
      const deadLettered = series.attempts >= MAX_REBUILD_ATTEMPTS;
      const backoffMs = Math.min(
        config.priceHistory.rebuildMaxBackoffMs,
        1_000 * 2 ** Math.min(series.attempts, 16),
      );
      await releasePriceSeriesRebuild({
        id: series.id,
        leaseOwner,
        deadLettered,
        availableAt: new Date(now.getTime() + backoffMs),
        error: err instanceof Error ? err.message : String(err),
        now,
      });
      log.general.warn(
        { err, seriesId: series.id, deadLettered },
        '[PriceHistory] series rebuild failed',
      );
    }
  }
  return rebuilt;
}

/**
 * Start the loop on this task.
 *
 * `unref()` immediately, because a module-level `setInterval` keeps the Node
 * event loop alive and hangs a jest/vitest run non-deterministically — the
 * convention `LeaseElection` established and every Oxy singleton since has
 * followed.
 */
export function startPriceSeriesRebuildDispatcher(): void {
  const leaseOwner = `price-history-${randomUUID()}`;
  const timer = setInterval(() => {
    void runPriceSeriesRebuildTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[PriceHistory] rebuild tick failed');
    });
  }, config.priceHistory.rebuildPollIntervalMs);
  timer.unref?.();
}
