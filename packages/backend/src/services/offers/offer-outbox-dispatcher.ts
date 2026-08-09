/**
 * The loop that drains the native-offer convergence queue (#57 native rule 4).
 *
 * Starts on EVERY task, like the moderation dispatcher and for the same reason:
 * a claim is a `SELECT … FOR UPDATE SKIP LOCKED` with an owner-checked lease, so
 * N tasks share the work without handing each other a row, and a dead task's
 * lease is reclaimed rather than stranding a listing.
 *
 * ## The LOOP is gated; the durable record never is
 *
 * `OFFER_MATERIALIZATION_ENABLED` stops this loop and nothing else. Catalogue
 * writes keep enqueuing while it is off, so turning it on drains the backlog
 * instead of stranding it, and turning it off during an incident parks the work.
 * That is safe here in a way it would not be for a checkout gate, because the
 * gate is DERIVED at read time: a listing restricted while the loop is off has a
 * stale offer row and is still not buyable, because
 * `deriveNativeCheckoutEligibility` reads `listings.status` live.
 *
 * ## Backoff and dead letters
 *
 * Capped exponential backoff, and a dead letter after
 * {@link MAX_CONVERGENCE_ATTEMPTS}. A dead letter here means one listing's
 * comparison facts are stale, which is visible in `offer_outboxes.last_error`
 * and on the operator surface; it does not mean anything is mis-sold.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  claimOfferOutbox,
  completeOfferOutbox,
  releaseOfferOutbox,
  type OfferOutboxRow,
} from '../../db/offers/offerOutboxRepository.js';
import { convergeNativeOffersForListing } from './native-offer.service.js';

/** After this many failed attempts a job stops retrying and becomes visible. */
export const MAX_CONVERGENCE_ATTEMPTS = 8;

/** The first retry delay; each attempt doubles it up to {@link MAX_BACKOFF_MS}. */
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 10 * 60 * 1_000;

/** How long a claim is held before another task may reclaim it. */
const LEASE_MS = 60_000;

/**
 * This process's identity for the lease.
 *
 * A per-PROCESS value rather than a per-claim one: the owner check exists to
 * stop a task completing work another task has taken over, and a fresh id per
 * claim would make every dispatcher unable to recognise its own in-flight rows
 * after a restart-free reconnection.
 */
const LEASE_OWNER = `offer-outbox-${randomUUID()}`;

function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/** What one drain did. Returned so a test can assert progress without a clock. */
export interface OfferOutboxDrainResult {
  claimed: number;
  converged: number;
  failed: number;
}

async function handleJob(job: OfferOutboxRow, now: Date): Promise<boolean> {
  try {
    const result = await convergeNativeOffersForListing(job.listingId, now);
    const completed = await completeOfferOutbox(job.id, LEASE_OWNER, now);
    if (!completed) {
      // The lease was reclaimed mid-run. The convergence itself is idempotent,
      // so the work is not lost — but this task is no longer authoritative for
      // the row and must not write its outcome over the new owner's.
      log.general.warn({ listingId: job.listingId }, '[Offers] convergence lease was reclaimed');
    }
    log.general.debug(result, '[Offers] converged native offers');
    return true;
  } catch (error: unknown) {
    const deadLettered = job.attempts >= MAX_CONVERGENCE_ATTEMPTS;
    await releaseOfferOutbox({
      id: job.id,
      leaseOwner: LEASE_OWNER,
      deadLettered,
      availableAt: new Date(now.getTime() + backoffFor(job.attempts)),
      error: error instanceof Error ? error.message : String(error),
      now,
    });
    log.general.error(
      { err: error, listingId: job.listingId, attempts: job.attempts, deadLettered },
      '[Offers] native offer convergence failed',
    );
    return false;
  }
}

/**
 * Claim and run one batch.
 *
 * Exported so a test — and the operator surface's manual run — can drain
 * deterministically instead of waiting for a timer, which is the same seam
 * `dispatchModerationOutbox` gives its own loop.
 */
export async function drainOfferOutbox(
  options: { batchSize?: number; now?: Date } = {},
): Promise<OfferOutboxDrainResult> {
  const now = options.now ?? new Date();
  const jobs = await claimOfferOutbox({
    leaseOwner: LEASE_OWNER,
    batchSize: options.batchSize ?? config.offers.outboxBatchSize,
    leaseMs: LEASE_MS,
    now,
  });

  let converged = 0;
  let failed = 0;
  for (const job of jobs) {
    if (await handleJob(job, now)) converged += 1;
    else failed += 1;
  }
  return { claimed: jobs.length, converged, failed };
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await drainOfferOutbox();
    if (result.claimed > 0) log.general.debug(result, '[Offers] outbox drained');
  } catch (error: unknown) {
    // The loop must survive anything a single drain throws, or one bad row stops
    // offer convergence for the life of the process.
    log.general.error({ err: error }, '[Offers] outbox dispatch failed');
  } finally {
    running = false;
  }
}

/** Begin draining. Idempotent — a second call is a no-op. */
export function startOfferOutboxDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.offers.materializationEnabled) {
    log.general.info(
      '[Offers] native offer materialization disabled; convergence requests are stored and ' +
        'will run once enabled',
    );
    return;
  }

  timer = setInterval(() => {
    void tick();
  }, config.offers.outboxPollIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      pollIntervalMs: config.offers.outboxPollIntervalMs,
      batchSize: config.offers.outboxBatchSize,
    },
    '[Offers] outbox dispatcher started',
  );
}

/** Stop claiming new work. A row already in flight reaches a durable state. */
export function stopOfferOutboxDispatcher(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
