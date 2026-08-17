/**
 * Draining a completed claim's durable follow-up work (#109
 * claim-transaction rules 10 and 14, conflict case 11).
 *
 * The moderation-outbox dispatcher, ported: leases through `FOR UPDATE SKIP
 * LOCKED` so N ECS tasks drain without handing each other a row, capped
 * exponential backoff, and a visible `dead_letter` rather than a silent drop.
 *
 * ## Two handlers, and both are IDEMPOTENT by construction rather than by care
 *
 *  - **`review_eligibility`** calls #76's `grantEligibilitiesForClaimedGuestOrder`
 *    per claimed order. Its write is `insertEligibility`, whose `ON CONFLICT DO
 *    NOTHING` sits on `UNIQUE(order_item_id, oxy_user_id, scope)` — so a retry,
 *    a reclaimed lease and two dispatchers racing all converge on exactly one
 *    row per (line, author, scope). That is #109 review-eligibility rule 2 and
 *    #76 verification rule 11, and neither this module nor that one has to do
 *    anything to get it.
 *  - **`claim_notification`** enqueues #108's `claim_completed` transactional
 *    message, whose deterministic id makes a repeat a genuine no-op down to the
 *    row's `xmin`.
 *
 * ## Why a failure here cannot un-claim anything
 *
 * The claim committed before this file ran. A dead-lettered eligibility grant
 * is a buyer who owns their orders and cannot review them yet — visible in the
 * claim trace, repairable by re-running the job — and a dead-lettered
 * notification is a message that was not sent, which #108's transport seam
 * makes the ordinary state on a deployment with no mail configured. Neither
 * touches ownership, and there is no code path here that could: this module
 * imports no claim WRITE.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  claimGuestClaimJobs,
  markGuestClaimJobCompleted,
  markGuestClaimJobFailed,
  type GuestClaimOutboxRow,
} from '../../db/guestClaims/claimOutboxRepository.js';
import { findClaimById } from '../../db/guestClaims/claimRepository.js';
import { findOrdersInCheckoutGroup } from '../../db/orders/orderRepository.js';
import { log } from '../../lib/logger.js';
import { enqueueGuestMessage } from '../guest-portal/message.service.js';
import { grantEligibilitiesForClaimedGuestOrder } from '../reviews/review-eligibility.service.js';

/** The worker identity a lease is taken under. One per process. */
const DISPATCHER_OWNER = `guest-claim-${randomUUID()}`;

/** First retry delay; doubled per attempt and capped below. */
const BASE_BACKOFF_MS = 30_000;

/** The ceiling on the backoff, so a long outage does not park a row for a day. */
const MAX_BACKOFF_MS = 15 * 60_000;

/** How long a bounded failure note may be — the column's own CHECK, mirrored. */
const MAX_ERROR_LENGTH = 500;

let dispatcherTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Run one dispatcher pass. Exported so a test can drive it deterministically
 * instead of waiting for a timer, and so an operator repair can trigger one.
 *
 * @returns how many jobs this pass claimed, which is what a caller waiting for
 *   a queue to drain checks against zero.
 */
export async function dispatchGuestClaimJobs(): Promise<number> {
  const now = new Date();
  const jobs = await claimGuestClaimJobs(getDb(), {
    owner: DISPATCHER_OWNER,
    now,
    leaseUntil: new Date(now.getTime() + config.guest.claim.jobLeaseMs),
    limit: config.guest.claim.jobBatchSize,
  });

  for (const job of jobs) {
    await runOne(job);
  }
  return jobs.length;
}

/** Perform one claimed job, and record how it went either way. */
async function runOne(job: GuestClaimOutboxRow): Promise<void> {
  try {
    if (job.type === 'review_eligibility') {
      await grantEligibilities(job);
    } else {
      await notifyClaimCompleted(job);
    }
    await markGuestClaimJobCompleted(getDb(), {
      id: job.id,
      owner: DISPATCHER_OWNER,
      now: new Date(),
    });
  } catch (err) {
    await recordFailure(job, err);
  }
}

/**
 * #76's verified-purchase eligibility, for every order the claim moved.
 *
 * `bothSidesProven: true` is asserted HERE and nowhere else in the codebase,
 * and it is the load-bearing line of the whole handler: #76's contract says
 * only the claim service may set it, because only the claim service saw both
 * proofs in one request. This module is that service's own outbox handler,
 * reading a claim row the claim transaction committed — and the eligibility
 * service does not take the assertion on trust either, it compares
 * `evidence.claimedByOxyUserId` against `orders.claimed_by_oxy_user_id` as
 * stored. Two independent facts, one of which is in the database.
 *
 * A REVOKED claim grants nothing: the orders no longer carry the claimant, so
 * #76's own comparison refuses — but the check is made here as well, because a
 * job that runs after a revocation should say so rather than dead-letter on a
 * refusal that reads like a bug.
 */
async function grantEligibilities(job: GuestClaimOutboxRow): Promise<void> {
  const db = getDb();
  const claim = await findClaimById(db, job.claimId);
  if (claim === null) {
    throw new Error(`claim ${job.claimId} no longer exists`);
  }
  if (claim.state !== 'completed') {
    log.guest.info(
      { claimId: claim.id, state: claim.state },
      '[GuestClaim] eligibility job skipped: the claim is no longer completed',
    );
    return;
  }

  const orders = await findOrdersInCheckoutGroup(claim.checkoutGroupId, db);
  for (const order of orders) {
    await grantEligibilitiesForClaimedGuestOrder(order.id, {
      claimId: claim.id,
      checkoutGroupId: claim.checkoutGroupId,
      claimedByOxyUserId: claim.claimedByOxyUserId,
      bothSidesProven: true,
    });
  }
}

/**
 * Tell the checkout's contact inbox that emailed access has moved (D14).
 *
 * The message is a SECURITY notice as much as a courtesy: the claim revoked
 * every outstanding portal credential, so a person who was reading their order
 * through a link needs to know why it stopped working and where the order went.
 * It goes to the address on the checkout and nowhere else — this module has no
 * destination parameter, which is #108's own rule that no code path may choose
 * a recipient.
 *
 * `enqueueGuestMessage` returning `false` means the group has no contact record
 * to write to, which cannot happen for a claimed group (the claim's FK required
 * one) — so it is logged rather than swallowed, and never treated as a failure
 * worth retrying.
 */
async function notifyClaimCompleted(job: GuestClaimOutboxRow): Promise<void> {
  const created = await enqueueGuestMessage(
    {
      checkoutGroupId: job.checkoutGroupId,
      kind: 'claim_completed',
    },
    getDb(),
  );
  if (!created) {
    log.guest.info(
      { checkoutGroupId: job.checkoutGroupId },
      '[GuestClaim] claim notification already queued (or the group has no contact record)',
    );
  }
}

/**
 * Record a failed attempt, and decide whether it retries.
 *
 * The note is BOUNDED and derived from the error's message only — never its
 * stack, and truncated to the column's own CHECK. An outbox row is read by an
 * operator, and an uncapped error string is where a query that quoted a buyer's
 * row eventually lands.
 */
async function recordFailure(job: GuestClaimOutboxRow, err: unknown): Promise<void> {
  const attempts = job.attempts + 1;
  const terminal = attempts >= config.guest.claim.jobMaxAttempts;
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** job.attempts, MAX_BACKOFF_MS);
  const message = err instanceof Error ? err.message : 'unknown failure';

  log.guest.error(
    { err, jobId: job.id, claimId: job.claimId, attempts, terminal },
    '[GuestClaim] follow-up job failed',
  );

  await markGuestClaimJobFailed(getDb(), {
    id: job.id,
    owner: DISPATCHER_OWNER,
    error: message.slice(0, MAX_ERROR_LENGTH),
    nextState: terminal ? 'dead_letter' : 'pending',
    availableAt: new Date(Date.now() + backoff),
  });
}

/**
 * Start the dispatcher on this task.
 *
 * Gated by `GUEST_CLAIM_PROJECTION_ENABLED`, which stops the LOOP and never the
 * row: claims made while it is off leave their work queued and it drains when
 * the lever comes back.
 */
export function startGuestClaimDispatcher(): void {
  if (dispatcherTimer !== undefined) return;
  if (!config.guest.claim.projectionEnabled) {
    log.guest.info(
      {},
      '[GuestClaim] follow-up dispatcher not started (GUEST_CLAIM_PROJECTION_ENABLED=false); ' +
        'claims continue to enqueue their work durably',
    );
    return;
  }
  dispatcherTimer = setInterval(() => {
    void dispatchGuestClaimJobs().catch((err: unknown) => {
      log.guest.error({ err }, '[GuestClaim] follow-up dispatcher pass failed');
    });
  }, config.guest.claim.jobPollIntervalMs);
  // Without this a module-level interval keeps the event loop alive and hangs
  // the vitest run non-deterministically — the house rule, not an optimisation.
  dispatcherTimer.unref?.();
}

/** Stop the dispatcher — used by the test harness and a graceful shutdown. */
export function stopGuestClaimDispatcher(): void {
  if (dispatcherTimer === undefined) return;
  clearInterval(dispatcherTimer);
  dispatcherTimer = undefined;
}
