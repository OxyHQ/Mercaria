/**
 * The loop that drains the moderation outbox.
 *
 * Starts on EVERY task, not just a leader. A claim is a `SELECT … FOR UPDATE SKIP
 * LOCKED` with an owner-checked lease, so N tasks share the work safely — they
 * step over each other's in-flight rows instead of blocking — and a dead task's
 * lease is reclaimed rather than stranding the row.
 *
 * When CrowdSource is not configured the LOOP no-ops — the durable record is never
 * gated. Reports taken while the integration is off keep their outbox rows, so
 * switching it on delivers the backlog instead of stranding it, and turning it off
 * during an incident parks work rather than losing it.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import type { ModerationOutboxEvent } from '../../db/moderation/moderationOutboxRepository.js';
import { dispatchModerationOutbox } from './moderation-outbox.service.js';
import { deliverReport } from './report-delivery.worker.js';
import { applyDecisionEvent } from './decision.worker.js';

async function handleEvent(event: ModerationOutboxEvent): Promise<void> {
  switch (event.kind) {
    case 'report.submit':
      return await deliverReport(event);
    case 'decision.apply':
      return await applyDecisionEvent(event);
    default:
      /**
       * A kind this version does not know, written by a newer one during a
       * rolling deploy. Throwing lets it retry — the task running the newer code
       * will claim it — rather than completing it as if it had been handled.
       */
      throw new Error(`Unknown moderation outbox kind '${String(event.kind)}'`);
  }
}

let timer: NodeJS.Timeout | undefined;
let running = false;
const abortController = new AbortController();

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await dispatchModerationOutbox({
      handler: handleEvent,
      batchSize: config.crowdSource.outboxBatchSize,
      signal: abortController.signal,
    });
    if (result.processed > 0 || result.failed > 0) {
      log.moderation.debug(result, '[Moderation] outbox drained');
    }
  } catch (error: unknown) {
    // The loop must survive anything a single drain throws, or one bad row stops
    // moderation delivery for the life of the process.
    log.moderation.error({ err: error }, '[Moderation] outbox dispatch failed');
  } finally {
    running = false;
  }
}

/** Begin draining. Idempotent — a second call is a no-op. */
export function startModerationOutboxDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.crowdSource.enabled) {
    log.moderation.info(
      '[Moderation] CrowdSource disabled; reports are stored and will deliver once enabled',
    );
    return;
  }

  timer = setInterval(() => {
    void tick();
  }, config.crowdSource.outboxPollIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.moderation.info(
    {
      pollIntervalMs: config.crowdSource.outboxPollIntervalMs,
      batchSize: config.crowdSource.outboxBatchSize,
      enforcementMode: config.crowdSource.enforcementMode,
    },
    '[Moderation] outbox dispatcher started',
  );
}

/**
 * Stop claiming new work.
 *
 * The row already in flight is allowed to reach a durable state — aborting it
 * mid-delivery would leave a lease to expire and the work to be redone, which is
 * safe but wasteful.
 */
export function stopModerationOutboxDispatcher(): void {
  abortController.abort();
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
