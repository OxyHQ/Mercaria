/**
 * Draining the moderation outbox: what to retry, for how long, and when to stop.
 *
 * The SQL lives in `db/moderation/moderationOutboxRepository.ts` — claiming with
 * `FOR UPDATE SKIP LOCKED`, the owner-checked lease transitions, the
 * `ON CONFLICT DO NOTHING` enqueue. What is left here is policy, and it is the
 * half that has to be reasoned about rather than translated: which failures are
 * worth another attempt, how far apart the attempts go, and the lease heartbeat
 * that keeps a long delivery from being reclaimed underneath itself.
 *
 * At-least-once: an expired lease is reclaimable and a worker can die mid-flight,
 * so every handler MUST make its downstream effect idempotent using the event id.
 * What differs from an ordinary queue is where retrying STOPS — a failure the SDK
 * marks non-retryable is a defect in the payload, not a blip, and no number of
 * attempts turns two different payloads into one report.
 */

import { randomUUID } from 'node:crypto';
import {
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  releaseModerationOutboxEvent,
  renewModerationOutboxEvent,
  type ModerationOutboxEvent,
} from '../../db/moderation/moderationOutboxRepository.js';
import { log } from '../../lib/logger.js';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const MIN_LEASE_RENEW_INTERVAL_MS = 250;

/**
 * Attempts after which a retryable failure is treated as permanent.
 *
 * Generous on purpose: a retryable failure means CrowdSource might still accept
 * this exact payload, and with backoff capped at six hours this is several days
 * of trying. A report that has not landed by then needs a human, not another
 * attempt.
 */
const MAX_RETRYABLE_ATTEMPTS = 25;

/**
 * The event id for delivering a report.
 *
 * Derived from the REPORT, never from the request: a transaction retry or two
 * concurrent duplicate submissions converge on the SAME row rather than queueing
 * two deliveries. There is exactly one delivery row per report for the life of the
 * report, which is also what keeps the CrowdSource-side idempotency key stable.
 */
export function reportSubmitEventId(reportId: string): string {
  return `moderation:report.submit:${reportId}`;
}

/**
 * The event id for applying an inbound decision.
 *
 * The webhook event id is the key, so a redelivery can never queue the work twice
 * even if the dedupe claim were somehow released.
 */
export function decisionApplyEventId(eventId: string): string {
  return `moderation:decision.apply:${eventId}`;
}

function nextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return new Date(now.getTime() + Math.min(1_000 * 2 ** exponent, MAX_BACKOFF_MS));
}

/**
 * Whether trying the same payload again could ever work.
 *
 * Every error `@oxyhq/crowdsource` throws carries `retryable`, which is the only
 * thing a delivery worker needs from it. Anything else — a bug here, a database
 * error — is treated as retryable, because assuming a defect is permanent is how a
 * recoverable outage becomes lost moderation work.
 */
export function isRetryableDeliveryError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    const retryable: unknown = (error as { retryable: unknown }).retryable;
    if (typeof retryable === 'boolean') return retryable;
  }
  return true;
}

export interface ModerationOutboxFailure {
  released: boolean;
  deadLettered: boolean;
}

/**
 * Release a failed claim with backoff — or stop.
 *
 * Stopping is not an optimisation. A 409 means this `externalReportId` already
 * exists at CrowdSource with a different body, and a 422 means the envelope is not
 * processable. Both need the PAYLOAD to change, so they become `dead_letter`
 * immediately and stay visible with their error rather than accumulating attempts
 * nobody reads.
 */
export async function failModerationOutboxEvent(
  event: Pick<ModerationOutboxEvent, 'id' | 'attempts'>,
  leaseOwner: string,
  error: unknown,
  now: Date = new Date(),
): Promise<ModerationOutboxFailure> {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = isRetryableDeliveryError(error);
  const deadLettered = !retryable || event.attempts >= MAX_RETRYABLE_ATTEMPTS;

  const released = await releaseModerationOutboxEvent({
    eventId: event.id,
    leaseOwner,
    deadLettered,
    availableAt: deadLettered ? now : nextAttemptAt(event.attempts, now),
    error: message,
    now,
  });
  return { released, deadLettered };
}

export type ModerationOutboxHandler = (event: ModerationOutboxEvent) => Promise<void>;

interface LeaseHeartbeatResult {
  lost: boolean;
  error?: unknown;
}

function startLeaseHeartbeat(options: {
  eventId: string;
  leaseOwner: string;
  leaseMs: number;
}): { stop: () => Promise<LeaseHeartbeatResult> } {
  const renewIntervalMs = Math.max(
    MIN_LEASE_RENEW_INTERVAL_MS,
    Math.floor(options.leaseMs / 3),
  );
  let stopped = false;
  let lost = false;
  let renewalError: unknown;
  let renewalInFlight: Promise<void> | null = null;

  const renew = (): void => {
    if (stopped || lost || renewalInFlight) return;
    const renewal = renewModerationOutboxEvent(
      options.eventId,
      options.leaseOwner,
      options.leaseMs,
    )
      .then((stillOwner) => {
        if (!stillOwner) lost = true;
      })
      .catch((error: unknown) => {
        lost = true;
        renewalError = error;
      })
      .finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null;
      });
    renewalInFlight = renewal;
  };

  const timer = setInterval(renew, renewIntervalMs);
  // Never keep the event loop alive for a heartbeat — see `~/Oxy/AGENTS.md`. In
  // vitest a housekeeping interval that holds the loop open hangs the run
  // non-deterministically, which reads as a flaky test in whichever file was last.
  timer.unref?.();

  return {
    async stop(): Promise<LeaseHeartbeatResult> {
      stopped = true;
      clearInterval(timer);
      await renewalInFlight;
      return { lost, ...(renewalError === undefined ? {} : { error: renewalError }) };
    },
  };
}

export interface ModerationDispatchResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/** Drain up to `batchSize` due rows. Bounded, at-least-once, lease-protected. */
export async function dispatchModerationOutbox(options: {
  handler: ModerationOutboxHandler;
  leaseOwner?: string;
  batchSize?: number;
  leaseMs?: number;
  signal?: AbortSignal;
}): Promise<ModerationDispatchResult> {
  const leaseOwner = options.leaseOwner ?? `moderation:${process.pid}:${randomUUID()}`;
  const batchSize = Math.min(Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE);
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming NEW work but lets the row already in flight reach a
    // durable state.
    if (options.signal?.aborted) break;

    const event = await claimModerationOutboxEvent({ leaseOwner, leaseMs });
    if (!event) break;

    const heartbeat = startLeaseHeartbeat({ eventId: event.id, leaseOwner, leaseMs });
    let deliveryError: unknown;
    try {
      await options.handler(event);
    } catch (error: unknown) {
      deliveryError = error;
    }

    // No completion/failure transition may race an owner-checked renewal.
    const heartbeatResult = await heartbeat.stop();
    if (heartbeatResult.lost) {
      failed += 1;
      log.moderation.warn(
        {
          eventId: event.id,
          kind: event.kind,
          attempts: event.attempts,
          err: heartbeatResult.error,
        },
        '[ModerationOutbox] lease lost during delivery',
      );
      continue;
    }

    if (deliveryError) {
      failed += 1;
      const outcome = await failModerationOutboxEvent(event, leaseOwner, deliveryError);
      const context = {
        eventId: event.id,
        kind: event.kind,
        attempts: event.attempts,
        err: deliveryError,
      };
      // A dead letter is moderation work that will not happen without a human, so
      // it must not be discoverable only by reading a warn-level log line.
      if (outcome.deadLettered) {
        deadLettered += 1;
        log.moderation.error(context, '[ModerationOutbox] event dead-lettered');
      } else {
        log.moderation.warn(context, '[ModerationOutbox] delivery failed, will retry');
      }
      if (!outcome.released) {
        log.moderation.warn(
          { eventId: event.id, kind: event.kind },
          '[ModerationOutbox] lease lost before failure release',
        );
      }
      continue;
    }

    const completed = await completeModerationOutboxEvent(event.id, leaseOwner);
    if (!completed) {
      failed += 1;
      log.moderation.warn(
        { eventId: event.id, kind: event.kind, attempts: event.attempts },
        '[ModerationOutbox] lease lost before completion',
      );
      continue;
    }
    processed += 1;
  }

  return { processed, failed, deadLettered };
}
