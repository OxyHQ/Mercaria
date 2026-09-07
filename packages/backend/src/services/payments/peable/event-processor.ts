/**
 * Turning a stored Peable event into Mercaria state — the durable half.
 *
 * RECEIPT is `ingress.ts`: verify, store, answer 200. PROCESSING is here, and
 * the split is the point. A 200 from the webhook means "stored", never
 * "understood": the gateway's redelivery schedule reaches about eight hours and
 * then stops, and a bug in a handler must retry against Mercaria's own durable
 * copy rather than depend on the gateway still being willing to send it again.
 *
 * ## The row IS the job, and the claim is SCOPED TO THIS RAIL
 *
 * `payment_provider_events` carries the lease columns, so claiming one is the
 * same `for update skip locked` claim the Stripe drain and the payment outbox
 * use. The scope is what makes two drains safe over one table: without it this
 * loop would claim the oldest due row of EITHER rail and hand a Stripe event to
 * `routePeableEvent`, which — the two rails not sharing type names — would find
 * no handler and mark it processed. See `ClaimProviderEventOptions.providers`
 * and `providerEventClaim.realdb.test.ts`.
 *
 * ## No settlement re-read, unlike Stripe
 *
 * Stripe's processor hands the verified event through to its router so the
 * handler reads what Stripe actually sent. Here there is nothing to hand
 * through: `event-router.ts` acts on the event TYPE and the stored `objectIds`,
 * both of which survive redaction and a restart, so the inline path and a replay
 * three days later run identically. That is why `processStoredPeableEvent` takes
 * only an id where its Stripe counterpart also takes the payload.
 */

import { randomUUID } from 'node:crypto';
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
  routePeableEvent,
  type PeableEventContext,
  type PeableEventOutcome,
} from './event-router.js';

/** Longest a retryable failure is backed off for. */
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

/** Never claim more than this in one drain, whatever configuration says. */
const MAX_BATCH_SIZE = 500;

/**
 * The one rail this drain interprets.
 *
 * A named constant rather than a literal at each call site, so the three claims
 * below cannot disagree — and so a reader can see at a glance that this loop is
 * scoped at all.
 */
const RAIL = ['peable'] as const;

/** What one drain did. */
export interface PeableEventDrainResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/** Options for a drain. */
export interface DrainPeableEventsOptions {
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
 * hand a handler `[redacted]` where the intent id used to be.
 */
function contextFromRow(row: PaymentProviderEventRow): PeableEventContext {
  const stored: unknown = row.objectIds;
  const objectIds =
    typeof stored === 'object' && stored !== null ? (stored as Record<string, string>) : {};

  return {
    storedEventId: row.id,
    providerEventId: row.providerEventId,
    type: row.type,
    objectIds,
  };
}

/** Run one claimed event, and record what it did. */
async function processClaimedEvent(input: {
  row: PaymentProviderEventRow;
  leaseOwner: string;
}): Promise<{ ok: boolean; deadLettered: boolean }> {
  const db = getDb();
  const { row, leaseOwner } = input;
  const handler = routePeableEvent(row.type);

  if (!handler) {
    // Authentic, stored, and nothing in this version acts on it. Marked
    // processed rather than failed: retrying would never produce a handler, and
    // an uninterpretable event is evidence, not an error.
    await completeProviderEvent(db, {
      eventId: row.id,
      leaseOwner,
      processingNote: `no handler for '${row.type}' in this version; stored as evidence`,
    });
    return { ok: true, deadLettered: false };
  }

  let outcome: PeableEventOutcome;
  try {
    outcome = await handler(contextFromRow(row));
  } catch (error: unknown) {
    const retryable = isRetryableProviderError(error);
    const deadLetter = !retryable || row.attempts >= config.payments.peable.eventMaxAttempts;
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
      log.general.error(context, '[Peable] event dead-lettered');
    } else {
      log.general.warn(context, '[Peable] event processing failed, will retry');
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
      '[Peable] lease lost before the event outcome could be recorded',
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
    '[Peable] event processed',
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
export async function drainPeableEvents(
  options: DrainPeableEventsOptions = {},
): Promise<PeableEventDrainResult> {
  const db = getDb();
  const leaseOwner = options.leaseOwner ?? `peable-events:${String(process.pid)}:${randomUUID()}`;
  const batchSize = options.eventId
    ? 1
    : Math.min(
        Math.max(1, options.batchSize ?? config.payments.peable.eventBatchSize),
        MAX_BATCH_SIZE,
      );
  const leaseMs = Math.max(1_000, options.leaseMs ?? config.payments.peable.eventLeaseMs);
  const result: PeableEventDrainResult = { processed: 0, failed: 0, deadLettered: 0 };

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming NEW work but lets the row already in flight reach
    // a durable state.
    if (options.signal?.aborted) break;

    const row = await claimProviderEvent(db, {
      leaseOwner,
      leaseMs,
      providers: RAIL,
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
 * Process ONE just-stored event.
 *
 * Called by the ingress immediately after the envelope commits. It claims the
 * SAME lease the poller would, so the two can never both run the handler, and if
 * this process dies first the poller picks it up. It exists only so a payment's
 * consequences are not held up by a poll interval.
 */
export async function processStoredPeableEvent(input: {
  storedEventId: string;
}): Promise<void> {
  const db = getDb();
  const leaseOwner = `peable-ingress:${String(process.pid)}:${randomUUID()}`;
  const row = await claimProviderEvent(db, {
    leaseOwner,
    leaseMs: Math.max(1_000, config.payments.peable.eventLeaseMs),
    providers: RAIL,
    eventId: input.storedEventId,
  });
  // Not claimable means another task already holds it, or it is already
  // processed. Both are fine and neither is this caller's problem.
  if (!row) return;
  await processClaimedEvent({ row, leaseOwner });
}

/**
 * Re-claim a failed or dead-lettered event and run it again.
 *
 * Original idempotency is preserved because nothing about the stored event
 * changes: the same row is reused, `attempts` keeps counting, and every effect
 * still runs through the same compare-and-swap. So replaying an event whose work
 * already landed is a no-op, which is what makes replay safe during an incident.
 *
 * @returns Whether the event was reopened and run. `false` means it was not in a
 *   replayable state — already processed, or claimed by a live task.
 */
export async function replayPeableEvent(eventId: string): Promise<boolean> {
  const db = getDb();
  const existing = await findProviderEventById(db, eventId);
  if (!existing) {
    throw new Error(`Provider event ${eventId} does not exist.`);
  }
  if (!(await reopenProviderEvent(db, eventId))) {
    log.general.warn(
      { eventId, status: existing.status },
      '[Peable] event is not in a replayable state',
    );
    return false;
  }

  log.general.info(
    { eventId, providerEventId: existing.providerEventId, type: existing.type },
    '[Peable] event reopened for replay',
  );
  const result = await drainPeableEvents({ eventId });
  return result.processed + result.failed > 0;
}

/** Queue depth, failures and lag for the inbound Peable stream. */
export async function peableWebhookStats(): Promise<ProviderEventStats> {
  return await providerEventStats(getDb(), 'peable');
}
