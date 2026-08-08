/**
 * The payment outbox: deterministic event ids, and draining the rows they key.
 *
 * A row here is not a hint that work exists; it IS the work. What it protects is
 * the set of consequences a payment has beyond the payment itself — an order
 * reaching `paid`, its inventory committing, a seller and a buyer being told.
 * An in-memory queue or a detached promise loses all of that when a task
 * restarts, and loses it silently: the money is captured, the provider is
 * satisfied, and the buyer's order sits at `pending_payment` with nothing
 * reporting an error.
 *
 * ## The ids are derived, never generated
 *
 * Each builder below turns a domain fact into a stable string. Two deliveries of
 * the same provider event, a reclaimed lease and a reconciliation sweep
 * re-deriving the same fact all produce the SAME id, so the insert converges on
 * one row instead of queueing the work twice. Where a fact can legitimately
 * happen more than once — a payment failing, being retried and failing again —
 * the id carries what distinguishes the occurrences.
 *
 * ## Draining, and where it happens from
 *
 * `drainPaymentOutbox` is called from two places and they are the same code
 * path: `outbox-dispatcher.ts` polls it on every task, and `payment.service`
 * calls it for ONE id immediately after committing that row. The inline call is
 * not a second mechanism — it claims the same lease the poller would, so the two
 * cannot both run the handler, and if the process dies between the commit and
 * the drain the poller picks it up. It exists only so a payment's consequences
 * are not held up by a poll interval.
 */

import { randomUUID } from 'node:crypto';
import type { PaymentOutboxEventType } from '@mercaria/shared-types';
import {
  claimPaymentOutboxEvent,
  completePaymentOutboxEvent,
  enqueuePaymentOutboxEvent,
  failPaymentOutboxEvent,
  renewPaymentOutboxEvent,
  type PaymentOutboxRow,
} from '../../db/payments/paymentOutboxRepository.js';
import { RETENTION_SECONDS } from '../../db/expiryTargets.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { isRetryableProviderError } from './provider.js';

/** Longest a retryable failure is backed off for. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;

/** Never claim more than this in one drain, whatever configuration says. */
const MAX_BATCH_SIZE = 500;

/** How often a held lease is renewed while a handler runs. */
const MIN_LEASE_RENEW_INTERVAL_MS = 250;

/**
 * Attempts after which a retryable failure is treated as permanent.
 *
 * Generous, like the moderation outbox's: with backoff capped at six hours this
 * is several days of trying. A payment consequence that has not landed by then
 * needs a human, not another attempt — and the payment itself is still there,
 * correct and traceable, the whole time.
 */
const MAX_RETRYABLE_ATTEMPTS = 25;

/** `payment:payment_succeeded:<paymentId>` — a payment succeeds exactly once. */
export function paymentSucceededEventId(paymentId: string): string {
  return `payment:payment_succeeded:${paymentId}`;
}

/**
 * `payment:payment_failed:<paymentId>:<providerEventId>`.
 *
 * The provider event is IN the id because a payment can genuinely fail more than
 * once — a declined card, a new attempt, another decline — and collapsing those
 * onto one row would deliver the first failure and silently swallow every one
 * after it.
 */
export function paymentFailedEventId(paymentId: string, providerEventId: string): string {
  return `payment:payment_failed:${paymentId}:${providerEventId}`;
}

/**
 * `payment:payment_succeeded_after_release:<paymentId>`.
 *
 * Keyed on the PAYMENT alone, unlike `payment_failed` above. A payment can fail
 * repeatedly and each failure is its own fact; it can be captured-after-release
 * only once, and every redelivery of that capture describes the same exception.
 * Carrying the provider event in the id would open one operator case per
 * redelivery of a single problem.
 */
export function paymentSucceededAfterReleaseEventId(paymentId: string): string {
  return `payment:payment_succeeded_after_release:${paymentId}`;
}

/**
 * `payment:transfer_withheld:<paymentId>:<orderId>`.
 *
 * Keyed on the payment AND the order, because withholding is per SELLER: one
 * order of a multi-seller group can be stuck while its siblings settle, and each
 * is resolved separately (a recovered account, or a refund). Keying on the
 * payment alone would collapse two sellers' exceptions into one case and hide
 * the second.
 *
 * Not keyed on the attempt: a settlement retried by the outbox describes the
 * same stuck money every time, and an operator queue with one row per attempt is
 * a queue nobody reads.
 */
export function transferWithheldEventId(paymentId: string, orderId: string): string {
  return `payment:transfer_withheld:${paymentId}:${orderId}`;
}

/** `payment:payment_refunded:<refundId>` — keyed on the refund, not the payment. */
export function paymentRefundedEventId(refundId: string): string {
  return `payment:payment_refunded:${refundId}`;
}

/** `payment:payment_disputed:<disputeRef>` — one per dispute. */
export function paymentDisputedEventId(disputeRef: string): string {
  return `payment:payment_disputed:${disputeRef}`;
}

/**
 * `payment:transfer_changed:<transferId>:<status>`.
 *
 * The STATUS is in the id: a transfer moves through several of them and each
 * change is its own event. Keying on the transfer alone would announce it once
 * and never again.
 */
export function transferChangedEventId(transferId: string, status: string): string {
  return `payment:transfer_changed:${transferId}:${status}`;
}

/** `payment:payout_changed:<payoutId>:<status>` — same reasoning as transfers. */
export function payoutChangedEventId(payoutId: string, status: string): string {
  return `payment:payout_changed:${payoutId}:${status}`;
}

/**
 * `payment:provider_account_changed:<accountRowId>:<state>:<observedAtMs>`.
 *
 * The state alone is not enough — a seller who goes `ready → restricted → ready`
 * has three transitions and an id keyed on the destination could represent two.
 * The OBSERVATION time is what separates them, and it keeps the id deterministic
 * for one observation, so an outbox retry re-derives it and is a genuine no-op.
 *
 * Two different observations of the same transition (an `account.updated` and
 * the reconciliation sweep racing) do produce two rows. That is the cheap side
 * of the trade: the outbox is at-least-once by construction and this event's
 * consumers re-read the row, so a duplicate costs a log line — while a collision
 * would silently drop a readiness change nobody would ever learn about.
 */
export function providerAccountChangedEventId(
  accountRowId: string,
  state: string,
  observedAt: Date,
): string {
  return `payment:provider_account_changed:${accountRowId}:${state}:${String(observedAt.getTime())}`;
}

/** When an outbox row written now should be swept. */
export function paymentOutboxExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + RETENTION_SECONDS.paymentOutbox * 1_000);
}

/**
 * Enqueue a domain event with the CALLER's transaction.
 *
 * @param db Must be the transaction the domain write is in. The payment status
 *   transition, its ledger postings and this row commit together, or a payment
 *   succeeds and nothing downstream ever hears about it.
 * @returns `true` when this call created the row.
 */
export async function enqueuePaymentEvent(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    eventType: PaymentOutboxEventType;
    payload: Record<string, unknown>;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return await enqueuePaymentOutboxEvent(db, {
    id: input.id,
    eventType: input.eventType,
    payload: input.payload,
    availableAt: now,
    expiresAt: paymentOutboxExpiry(now),
  });
}

/** What a drain does with one claimed row. */
export type PaymentOutboxHandler = (event: PaymentOutboxRow) => Promise<void>;

/** Backoff for attempt `n`, capped. */
function nextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return new Date(now.getTime() + Math.min(1_000 * 2 ** exponent, MAX_BACKOFF_MS));
}

interface LeaseHeartbeat {
  stop: () => Promise<{ lost: boolean; error?: unknown }>;
}

/**
 * Keep a claim alive while its handler runs.
 *
 * A handler that outlives its lease has already lost the row to whichever task
 * reclaimed it, and completing it then would mark work done that another task is
 * still doing. The heartbeat renews with an OWNER CHECK, so the moment the lease
 * is gone the renewal fails and the drain reports it rather than finishing.
 */
function startLeaseHeartbeat(eventId: string, leaseOwner: string, leaseMs: number): LeaseHeartbeat {
  const interval = Math.max(MIN_LEASE_RENEW_INTERVAL_MS, Math.floor(leaseMs / 3));
  let stopped = false;
  let lost = false;
  let renewalError: unknown;
  let inFlight: Promise<void> | null = null;

  const renew = (): void => {
    if (stopped || lost || inFlight) return;
    const renewal = renewPaymentOutboxEvent(getDb(), eventId, leaseOwner, leaseMs)
      .then((stillOwner) => {
        if (!stillOwner) lost = true;
      })
      .catch((error: unknown) => {
        lost = true;
        renewalError = error;
      })
      .finally(() => {
        if (inFlight === renewal) inFlight = null;
      });
    inFlight = renewal;
  };

  const timer = setInterval(renew, interval);
  // Never keep the event loop alive for a heartbeat — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      return { lost, error: renewalError };
    },
  };
}

/** What one drain did. */
export interface PaymentDispatchResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/** Options for a drain. */
export interface DrainPaymentOutboxOptions {
  handler: PaymentOutboxHandler;
  leaseOwner?: string;
  batchSize?: number;
  leaseMs?: number;
  /** Drain only this row, if it is due — the post-commit inline path. */
  eventId?: string;
  signal?: AbortSignal;
}

/**
 * Drain up to `batchSize` due rows. Bounded, at-least-once, lease-protected.
 *
 * At-least-once and not exactly-once, deliberately: a task can die between doing
 * the work and completing the row, so every handler must be idempotent on its
 * own. `payment_succeeded` transitions orders through `order.service.transition`,
 * whose compare-and-swap already refuses a second attempt — the property is
 * there because the order domain has it, not because this loop provides it.
 */
export async function drainPaymentOutbox(
  options: DrainPaymentOutboxOptions,
): Promise<PaymentDispatchResult> {
  const db = getDb();
  const leaseOwner = options.leaseOwner ?? `payments:${String(process.pid)}:${randomUUID()}`;
  const batchSize = options.eventId
    ? 1
    : Math.min(Math.max(1, options.batchSize ?? config.payments.outboxBatchSize), MAX_BATCH_SIZE);
  const leaseMs = Math.max(1_000, options.leaseMs ?? config.payments.outboxLeaseMs);
  const result: PaymentDispatchResult = { processed: 0, failed: 0, deadLettered: 0 };

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming NEW work but lets the row already in flight reach
    // a durable state.
    if (options.signal?.aborted) break;

    const event = await claimPaymentOutboxEvent(db, {
      leaseOwner,
      leaseMs,
      ...(options.eventId ? { eventId: options.eventId } : {}),
    });
    if (!event) break;

    const heartbeat = startLeaseHeartbeat(event.id, leaseOwner, leaseMs);
    let handlerError: unknown;
    try {
      await options.handler(event);
    } catch (error: unknown) {
      handlerError = error;
    }

    // No terminal transition may race an owner-checked renewal.
    const heartbeatResult = await heartbeat.stop();
    if (heartbeatResult.lost) {
      result.failed += 1;
      log.general.warn(
        { eventId: event.id, eventType: event.eventType, err: heartbeatResult.error },
        '[PaymentOutbox] lease lost during handling',
      );
      continue;
    }

    if (handlerError) {
      result.failed += 1;
      const retryable = isRetryableProviderError(handlerError);
      const deadLetter = !retryable || event.attempts >= MAX_RETRYABLE_ATTEMPTS;
      const message = handlerError instanceof Error ? handlerError.message : String(handlerError);
      const released = await failPaymentOutboxEvent(db, {
        eventId: event.id,
        leaseOwner,
        error: message,
        deadLetter,
        availableAt: nextAttemptAt(event.attempts, new Date()),
      });
      const context = {
        eventId: event.id,
        eventType: event.eventType,
        attempts: event.attempts,
        err: handlerError,
      };
      // A dead letter is a payment consequence that will not happen without a
      // human, so it must not be discoverable only in a warn-level line.
      if (deadLetter) {
        result.deadLettered += 1;
        log.general.error(context, '[PaymentOutbox] event dead-lettered');
      } else {
        log.general.warn(context, '[PaymentOutbox] handler failed, will retry');
      }
      if (!released) {
        log.general.warn(
          { eventId: event.id, eventType: event.eventType },
          '[PaymentOutbox] lease lost before failure release',
        );
      }
      continue;
    }

    const completed = await completePaymentOutboxEvent(db, event.id, leaseOwner);
    if (!completed) {
      result.failed += 1;
      log.general.warn(
        { eventId: event.id, eventType: event.eventType, attempts: event.attempts },
        '[PaymentOutbox] lease lost before completion',
      );
      continue;
    }
    result.processed += 1;
  }

  return result;
}
