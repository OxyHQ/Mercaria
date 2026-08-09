/**
 * The procurement outbox: deterministic event ids, and draining the rows they
 * key.
 *
 * `services/payments/payment-outbox.service.ts`'s shape and its reasoning, with
 * one difference stated where it matters: a payment consequence that is lost
 * can be rebuilt from the rail, and a SUBMISSION that is lost cannot — nothing
 * at the supplier records an order that was never placed, so the only trace is
 * the row this module refuses to lose.
 *
 * ## The ids are derived, never generated
 *
 * `procurement:purchase_order_submission:<purchaseOrderId>` — a purchase order
 * is submitted once, however many times the fact is re-derived. A redelivered
 * payment event, a reclaimed lease, an operator clicking retry and a
 * reconciliation sweep all produce the SAME id, so the insert converges instead
 * of queueing a second supplier order. That is #124 idempotency item 6 held by
 * the primary key rather than by a check somebody could forget.
 *
 * Where a fact can legitimately happen more than once — an exception being
 * raised about different conditions — the id carries what distinguishes them.
 */

import { randomUUID } from 'node:crypto';
import type { ProcurementExceptionKind, ProcurementOutboxEventType } from '@mercaria/shared-types';
import {
  claimProcurementOutboxEvent,
  completeProcurementOutboxEvent,
  enqueueProcurementOutboxEvent,
  failProcurementOutboxEvent,
  renewProcurementOutboxEvent,
  rescheduleProcurementOutboxEvent,
  type ProcurementOutboxRow,
} from '../../db/supplierOrders/outboxRepository.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { isRetryableSupplierFailure, normalizeProviderFailure } from './provider-error.js';

/** Longest a retryable failure is backed off for. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;

/** Never claim more than this in one drain, whatever configuration says. */
const MAX_BATCH_SIZE = 200;

/** How often a held lease is renewed while a handler runs. */
const MIN_LEASE_RENEW_INTERVAL_MS = 250;

/**
 * Attempts after which a retryable failure is treated as permanent.
 *
 * The payment outbox's figure, and generous for the same reason: with backoff
 * capped at six hours this is several days of trying. A supplier order that has
 * not been placed by then needs a person — and the customer's money is still
 * there, refundable through the existing path, the whole time.
 */
const MAX_RETRYABLE_ATTEMPTS = 25;

/** 14 days, the payment outbox's retention. */
const PROCUREMENT_OUTBOX_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/** `procurement:purchase_order_submission:<purchaseOrderId>`. */
export function purchaseOrderSubmissionEventId(purchaseOrderId: string): string {
  return `procurement:purchase_order_submission:${purchaseOrderId}`;
}

/**
 * `procurement:purchase_order_cancellation:<purchaseOrderId>`.
 *
 * Keyed on the purchase order alone, not on the attempt: a cancellation asked
 * for twice is one cancellation, and a second row would send the supplier a
 * second request for something it is already answering.
 */
export function purchaseOrderCancellationEventId(purchaseOrderId: string): string {
  return `procurement:purchase_order_cancellation:${purchaseOrderId}`;
}

/**
 * `procurement:purchase_order_status_poll:<purchaseOrderId>`.
 *
 * ONE poll row per purchase order for its whole life. The row reschedules
 * itself rather than being re-enqueued, so a purchase order can never
 * accumulate a queue of poll jobs — which is what would happen if the id
 * carried a timestamp.
 */
export function purchaseOrderStatusPollEventId(purchaseOrderId: string): string {
  return `procurement:purchase_order_status_poll:${purchaseOrderId}`;
}

/**
 * `procurement:purchase_order_convergence:<purchaseOrderId>:<attemptId>`.
 *
 * The ATTEMPT is in the id because each ambiguous attempt is its own unresolved
 * question: a purchase order whose first submission timed out, converged, and
 * whose retry then timed out again has two ambiguities and both need resolving.
 * Keying on the purchase order alone would answer the first and silently drop
 * the second.
 */
export function purchaseOrderConvergenceEventId(
  purchaseOrderId: string,
  attemptId: string,
): string {
  return `procurement:purchase_order_convergence:${purchaseOrderId}:${attemptId}`;
}

/** `procurement:purchase_order_accepted:<purchaseOrderId>` — announced once. */
export function purchaseOrderAcceptedEventId(purchaseOrderId: string): string {
  return `procurement:purchase_order_accepted:${purchaseOrderId}`;
}

/** `procurement:purchase_order_rejected:<purchaseOrderId>` — announced once. */
export function purchaseOrderRejectedEventId(purchaseOrderId: string): string {
  return `procurement:purchase_order_rejected:${purchaseOrderId}`;
}

/**
 * `procurement:purchase_order_exception:<kind>:<subjectId>`.
 *
 * The KIND is in the id because one purchase order can be in two different
 * kinds of trouble at once — a duplicate external order AND a late acceptance
 * after cancellation — and collapsing them would announce the first and hide
 * the second, which is the same reasoning `transfer_withheld` uses for the
 * order in its key.
 */
export function purchaseOrderExceptionEventId(
  kind: ProcurementExceptionKind,
  subjectId: string,
): string {
  return `procurement:purchase_order_exception:${kind}:${subjectId}`;
}

/** When an outbox row written now should be swept. */
export function procurementOutboxExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + PROCUREMENT_OUTBOX_RETENTION_SECONDS * 1_000);
}

/**
 * Enqueue a procurement job with the CALLER's handle.
 *
 * @param db Pass the TRANSACTION whenever the job is a consequence of a write
 *   that must commit with it. The purchase order and its submission job commit
 *   together, or an order is created that nothing will ever submit.
 * @returns `true` when this call created the row.
 */
export async function enqueueProcurementEvent(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    eventType: ProcurementOutboxEventType;
    payload: Record<string, unknown>;
    availableAt?: Date;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return await enqueueProcurementOutboxEvent(db, {
    id: input.id,
    eventType: input.eventType,
    payload: input.payload,
    availableAt: input.availableAt ?? now,
    expiresAt: procurementOutboxExpiry(now),
  });
}

/** What a drain does with one claimed row. */
export type ProcurementOutboxHandler = (event: ProcurementOutboxRow) => Promise<void>;

/**
 * A handler's way of saying "this job is not done and is not failing".
 *
 * The polling loop's release. Thrown rather than returned so the drain's
 * ordinary success path stays a single expression, and caught by name so a real
 * failure can never be mistaken for a reschedule.
 */
export class ProcurementReschedule extends Error {
  constructor(readonly availableAt: Date) {
    super(`Rescheduled until ${availableAt.toISOString()}`);
    this.name = 'ProcurementReschedule';
  }
}

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
 * reclaimed it, and completing it then would mark a supplier order placed that
 * another task is still placing. The heartbeat renews with an OWNER CHECK, so
 * the moment the lease is gone the renewal fails and the drain reports it.
 */
function startLeaseHeartbeat(eventId: string, leaseOwner: string, leaseMs: number): LeaseHeartbeat {
  const interval = Math.max(MIN_LEASE_RENEW_INTERVAL_MS, Math.floor(leaseMs / 3));
  let stopped = false;
  let lost = false;
  let renewalError: unknown;
  let inFlight: Promise<void> | null = null;

  const renew = (): void => {
    if (stopped || lost || inFlight) return;
    const renewal = renewProcurementOutboxEvent(getDb(), eventId, leaseOwner, leaseMs)
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
export interface ProcurementDispatchResult {
  processed: number;
  rescheduled: number;
  failed: number;
  deadLettered: number;
}

/** Options for a drain. */
export interface DrainProcurementOutboxOptions {
  handler: ProcurementOutboxHandler;
  leaseOwner?: string;
  batchSize?: number;
  leaseMs?: number;
  /** Claim only these types — how the three levers are separated. */
  eventTypes?: readonly ProcurementOutboxEventType[];
  /** Drain only this row, if it is due — the post-commit inline path. */
  eventId?: string;
  signal?: AbortSignal;
}

/**
 * Drain up to `batchSize` due rows. Bounded, at-least-once, lease-protected.
 *
 * At-least-once and not exactly-once, deliberately: a task can die between
 * doing the work and completing the row. Every handler here is idempotent on
 * its own — the submission handler converges on the purchase order's
 * deterministic key and asks the provider by client reference before it ever
 * resubmits, which is where the guarantee actually lives.
 */
export async function drainProcurementOutbox(
  options: DrainProcurementOutboxOptions,
): Promise<ProcurementDispatchResult> {
  const db = getDb();
  const leaseOwner = options.leaseOwner ?? `procurement:${String(process.pid)}:${randomUUID()}`;
  const batchSize = options.eventId
    ? 1
    : Math.min(
        Math.max(1, options.batchSize ?? config.procurement.outboxBatchSize),
        MAX_BATCH_SIZE,
      );
  const leaseMs = Math.max(1_000, options.leaseMs ?? config.procurement.outboxLeaseMs);
  const result: ProcurementDispatchResult = {
    processed: 0,
    rescheduled: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (let index = 0; index < batchSize; index += 1) {
    if (options.signal?.aborted) break;

    const event = await claimProcurementOutboxEvent(db, {
      leaseOwner,
      leaseMs,
      ...(options.eventId ? { eventId: options.eventId } : {}),
      ...(options.eventTypes ? { eventTypes: options.eventTypes } : {}),
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
        '[Procurement] lease lost during handling',
      );
      continue;
    }

    if (handlerError instanceof ProcurementReschedule) {
      const released = await rescheduleProcurementOutboxEvent(db, {
        eventId: event.id,
        leaseOwner,
        availableAt: handlerError.availableAt,
      });
      if (released) result.rescheduled += 1;
      else result.failed += 1;
      continue;
    }

    if (handlerError) {
      result.failed += 1;
      const failure = normalizeProviderFailure(handlerError);
      const deadLetter =
        !isRetryableSupplierFailure(failure) || event.attempts >= MAX_RETRYABLE_ATTEMPTS;
      const released = await failProcurementOutboxEvent(db, {
        eventId: event.id,
        leaseOwner,
        error: failure.message,
        deadLetter,
        availableAt: nextAttemptAt(event.attempts, new Date()),
      });
      const context = {
        eventId: event.id,
        eventType: event.eventType,
        attempts: event.attempts,
        errorClass: failure.errorClass,
        err: handlerError,
      };
      // A dead letter is a supplier order that will not be placed, cancelled or
      // reconciled without a human, so it must not be discoverable only in a
      // warn-level line.
      if (deadLetter) {
        result.deadLettered += 1;
        log.general.error(context, '[Procurement] job dead-lettered');
      } else {
        log.general.warn(context, '[Procurement] handler failed, will retry');
      }
      if (!released) {
        log.general.warn(
          { eventId: event.id, eventType: event.eventType },
          '[Procurement] lease lost before failure release',
        );
      }
      continue;
    }

    const completed = await completeProcurementOutboxEvent(db, event.id, leaseOwner);
    if (!completed) {
      result.failed += 1;
      log.general.warn(
        { eventId: event.id, eventType: event.eventType, attempts: event.attempts },
        '[Procurement] lease lost before completion',
      );
      continue;
    }
    result.processed += 1;
  }

  return result;
}
