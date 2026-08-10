/**
 * The measurement loop (#82 monitoring 1–3).
 *
 * `PRICE_SIGNALS_ENABLED` gates the LOOP and nothing durable. With it off a
 * policy version is still publishable and activatable, a merchant still reads
 * their own competitiveness, a shopper still sees a badge, and the operator
 * surface still answers — what stops is the background measurement, which is a
 * cost rather than a capability. Turning it on drains whatever runs an operator
 * queued while it was off.
 *
 * A run is never created by this loop. Runs are queued explicitly from
 * `/internal/price-signals/runs`, because a sweep is a measurement somebody
 * decided to take against a named cohort and a named policy version — a
 * self-scheduling one would make "compare a candidate against the live
 * distribution" (monitoring 6) impossible to control.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { drainPriceSignalSweep } from './sweep.service.js';

/** One tick: claim at most one run and advance it by a page. */
export async function runPriceSignalSweepTick(
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  return drainPriceSignalSweep(leaseOwner, now);
}

/**
 * Start the loop on this task.
 *
 * `unref()` immediately: a module-level `setInterval` keeps the Node event loop
 * alive and hangs a vitest run non-deterministically, which is the convention
 * every Oxy singleton follows.
 */
export function startPriceSignalSweepDispatcher(): void {
  if (!config.priceSignals.enabled) return;

  const leaseOwner = `price-signals-${randomUUID()}`;
  const timer = setInterval(() => {
    void runPriceSignalSweepTick(leaseOwner).catch((err: unknown) => {
      log.general.warn({ err }, '[PriceSignals] sweep tick failed');
    });
  }, config.priceSignals.sweepPollIntervalMs);
  timer.unref?.();
}
