/**
 * Turning a stored Stripe event into Mercaria state — the durable half.
 *
 * RECEIPT is `ingress.ts`: verify, filter, store, answer 200. PROCESSING is
 * here, and the split is the point (#48 ingress behavior 5). A 200 from the
 * webhook means "stored", never "understood": Stripe's redelivery schedule is
 * finite and a bug in a handler must retry against Mercaria's own durable copy
 * rather than depend on the provider still being willing to send it again.
 *
 * ## The row IS the job
 *
 * `payment_provider_events` carries `status`, `attempts`, `next_attempt_at`,
 * `lease_owner` and `lease_until`, so claiming one is the same
 * `for update skip locked` claim the payment outbox uses. No second table, no
 * queue, no detached promise. See the table's docblock for why an outbox row
 * pointing at an event row was rejected.
 *
 * ## There is no lease heartbeat, unlike the outbox
 *
 * The outbox renews its lease mid-handler because a handler that outlives its
 * lease could complete work another task has already redone. Here that cannot
 * hurt: every effect below is idempotent by compare-and-swap — a second task
 * reprocessing a reclaimed event applies the same status to the same payment and
 * the CAS discards it. The owner check on the terminal update is kept anyway, so
 * a task whose lease expired cannot record an outcome for work it no longer
 * owns, and the row stays claimable instead of being falsely marked done.
 */

import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import {
  claimProviderEvent,
  completeProviderEvent,
  failProviderEvent,
  findProviderEventById,
  providerEventStats,
  reopenProviderEvent,
  type PaymentProviderEventRow,
  type ProviderEventStats,
} from '../../../db/payments/paymentRepository.js';
import { getDb } from '../../../db/postgres.js';
import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { isRetryableProviderError } from '../provider.js';
import { redactProviderMessage } from '../redact.js';
import {
  routeStripeEvent,
  type StripeEventContext,
  type StripeEventOutcome,
} from './stripe-event-router.js';

/** Longest a retryable failure is backed off for. */
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

/** Never claim more than this in one drain, whatever configuration says. */
const MAX_BATCH_SIZE = 500;

/** What one drain did. */
export interface StripeEventDrainResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/** Options for a drain. */
export interface DrainStripeEventsOptions {
  /** Drain only this row, if it is due — the post-receipt inline path. */
  eventId?: string;
  batchSize?: number;
  leaseMs?: number;
  leaseOwner?: string;
  signal?: AbortSignal;
}

/** Backoff for attempt `n`, capped. Attempts are already incremented by the claim. */
function nextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return new Date(now.getTime() + Math.min(1_000 * 2 ** exponent, MAX_BACKOFF_MS));
}

/**
 * The context a handler runs with, built from the stored row.
 *
 * `objectIds` is what makes this possible without the payload: it is stored in
 * its own column, verbatim and UNREDACTED, precisely so correlation never
 * depends on `payload_summary` — which is an operator's redacted view and would
 * hand a handler `[redacted]` where a field it reads used to be.
 *
 * `delivered` is attached only by the inline path, where the verified event
 * genuinely exists. Everywhere else its absence tells the handler to re-read
 * from Stripe, which is also the more correct answer: by the time a dead letter
 * is replayed, the snapshot in the original delivery is history.
 */
function contextFromRow(row: PaymentProviderEventRow, delivered?: Stripe.Event): StripeEventContext {
  const stored: unknown = row.objectIds;
  const objectIds =
    typeof stored === 'object' && stored !== null ? (stored as Record<string, string>) : {};

  return {
    storedEventId: row.id,
    providerEventId: row.providerEventId,
    type: row.type,
    objectIds,
    ...(row.providerAccountId ? { account: row.providerAccountId } : {}),
    ...(delivered ? { delivered } : {}),
  };
}

/**
 * Run one claimed event, and record what it did.
 *
 * @param event The Stripe event as it arrived, when the caller has it. The
 *   inline path after receipt does; the poller and a replay do not.
 */
async function processClaimedEvent(input: {
  row: PaymentProviderEventRow;
  leaseOwner: string;
  event?: Stripe.Event;
}): Promise<{ ok: boolean; deadLettered: boolean }> {
  const db = getDb();
  const { row, leaseOwner } = input;
  const handler = routeStripeEvent(row.type);

  if (!handler) {
    // Authentic, stored, and nothing in this version acts on it. Marked
    // processed rather than failed: retrying it would never produce a handler,
    // and #45's rule is that an uninterpretable event is evidence, not an error.
    await completeProviderEvent(db, {
      eventId: row.id,
      leaseOwner,
      processingNote: `no handler for '${row.type}' in this version; stored as evidence`,
    });
    return { ok: true, deadLettered: false };
  }

  let outcome: StripeEventOutcome;
  try {
    outcome = await handler(contextFromRow(row, input.event));
  } catch (error: unknown) {
    const retryable = isRetryableProviderError(error);
    const deadLetter = !retryable || row.attempts >= config.payments.stripe.eventMaxAttempts;
    const message = redactProviderMessage(
      error instanceof Error ? error.message : String(error),
    );
    await failProviderEvent(db, {
      eventId: row.id,
      leaseOwner,
      error: message,
      deadLetter,
      nextAttemptAt: nextAttemptAt(row.attempts, new Date()),
    });

    const context = {
      eventId: row.id,
      providerEventId: row.providerEventId,
      type: row.type,
      attempts: row.attempts,
      err: error,
    };
    if (deadLetter) {
      // A dead-lettered payment event is money whose consequences have not
      // happened and will not without a person, so it must not be discoverable
      // only in a warn-level line.
      log.general.error(context, '[Stripe] event dead-lettered');
    } else {
      log.general.warn(context, '[Stripe] event processing failed, will retry');
    }
    return { ok: false, deadLettered: deadLetter };
  }

  const completed = await completeProviderEvent(db, {
    eventId: row.id,
    leaseOwner,
    ...(outcome.paymentId ? { paymentId: outcome.paymentId } : {}),
    ...(outcome.note ? { processingNote: `${outcome.kind}: ${outcome.note}` } : {}),
  });
  if (!completed) {
    // The lease expired mid-handler and another task reclaimed the row. The work
    // is done and idempotent, so the reprocessing is harmless — but this task
    // must not claim the outcome, and the row stays where the owner left it.
    log.general.warn(
      { eventId: row.id, providerEventId: row.providerEventId, type: row.type },
      '[Stripe] lease lost before the event outcome could be recorded',
    );
    return { ok: false, deadLettered: false };
  }

  log.general.debug(
    {
      eventId: row.id,
      providerEventId: row.providerEventId,
      type: row.type,
      outcome: outcome.kind,
      paymentId: outcome.paymentId,
    },
    '[Stripe] event processed',
  );
  return { ok: true, deadLettered: false };
}

/**
 * Claim and process up to `batchSize` due events. Bounded, at-least-once.
 *
 * At-least-once and not exactly-once, deliberately: a task can die between doing
 * the work and completing the row. Every handler is idempotent on its own —
 * status changes go through `applyPaymentStatus`'s compare-and-swap — so a redo
 * converges rather than duplicating.
 */
export async function drainStripeEvents(
  options: DrainStripeEventsOptions = {},
): Promise<StripeEventDrainResult> {
  const db = getDb();
  const leaseOwner = options.leaseOwner ?? `stripe-events:${String(process.pid)}:${randomUUID()}`;
  const batchSize = options.eventId
    ? 1
    : Math.min(
        Math.max(1, options.batchSize ?? config.payments.stripe.eventBatchSize),
        MAX_BATCH_SIZE,
      );
  const leaseMs = Math.max(1_000, options.leaseMs ?? config.payments.stripe.eventLeaseMs);
  const result: StripeEventDrainResult = { processed: 0, failed: 0, deadLettered: 0 };

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming NEW work but lets the row already in flight reach
    // a durable state.
    if (options.signal?.aborted) break;

    const row = await claimProviderEvent(db, {
      leaseOwner,
      leaseMs,
      ...(options.eventId ? { eventId: options.eventId } : {}),
    });
    if (!row) break;

    const outcome = await processClaimedEvent({ row, leaseOwner });
    if (outcome.ok) {
      result.processed += 1;
    } else {
      result.failed += 1;
      if (outcome.deadLettered) result.deadLettered += 1;
    }
  }

  return result;
}

/**
 * Process ONE just-stored event with the payload still in hand.
 *
 * Called by the ingress immediately after the envelope commits, for the same
 * reason `applyPaymentStatus` drains its own outbox row inline: it claims the
 * SAME lease the poller would, so the two can never both run the handler, and if
 * this process dies first the poller picks it up. It exists only so a payment's
 * consequences are not held up by a poll interval.
 *
 * The verified event is passed through rather than rebuilt from the stored
 * redacted summary — this is the one moment the full payload legitimately
 * exists, and using it means the handler reads what Stripe actually sent.
 */
export async function processStoredStripeEvent(input: {
  storedEventId: string;
  event: Stripe.Event;
}): Promise<void> {
  const db = getDb();
  const leaseOwner = `stripe-ingress:${String(process.pid)}:${randomUUID()}`;
  const row = await claimProviderEvent(db, {
    leaseOwner,
    leaseMs: Math.max(1_000, config.payments.stripe.eventLeaseMs),
    eventId: input.storedEventId,
  });
  // Not claimable means another task already holds it, or it is already
  // processed. Both are fine and neither is this caller's problem.
  if (!row) return;
  await processClaimedEvent({ row, leaseOwner, event: input.event });
}

/**
 * Re-claim a failed or dead-lettered event and run it again.
 *
 * The service half of #48's replay requirement (security and operations 9); the
 * operator HTTP surface that calls it, with its own authorization, is #50's.
 *
 * Original idempotency is preserved because nothing about the stored event
 * changes: the same `(provider, account, event id)` row is reused, `attempts`
 * keeps counting, and every effect still runs through the same compare-and-swap.
 * So replaying an event whose work already landed is a no-op, which is exactly
 * what makes replay safe to reach for during an incident.
 *
 * @returns Whether the event was reopened and run. `false` means it was not in a
 *   replayable state — already processed, or claimed by a live task.
 */
export async function replayProviderEvent(eventId: string): Promise<boolean> {
  const db = getDb();
  const existing = await findProviderEventById(db, eventId);
  if (!existing) {
    throw new Error(`Provider event ${eventId} does not exist.`);
  }
  if (!(await reopenProviderEvent(db, eventId))) {
    log.general.warn(
      { eventId, status: existing.status },
      '[Stripe] event is not in a replayable state',
    );
    return false;
  }

  log.general.info(
    { eventId, providerEventId: existing.providerEventId, type: existing.type },
    '[Stripe] event reopened for replay',
  );
  const result = await drainStripeEvents({ eventId });
  return result.processed + result.failed > 0;
}

/** Queue depth, failures and lag for the inbound Stripe stream. */
export async function stripeWebhookStats(): Promise<ProviderEventStats> {
  return await providerEventStats(getDb(), 'stripe');
}
