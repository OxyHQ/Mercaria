/**
 * The webhook dedupe claim, backed by Mongo instead of process memory.
 *
 * `@oxyhq/crowdsource-express` defaults to an in-process map, and its own doc
 * comment names the condition that makes that wrong: two instances behind a load
 * balancer each keep their own, so a redelivery landing on the OTHER instance is
 * not deduped. Mercaria's API runs several ECS Fargate tasks behind one ALB, so
 * that is not a hypothetical — it is the normal case.
 *
 * Claim-then-release, never "record after processing" or "check then act":
 *
 *   * Recording the id BEFORE the handler and never releasing makes a handler
 *     failure permanent — every retry is deduped away and a moderation decision is
 *     lost silently, which is the worst outcome available.
 *   * Recording it AFTER lets two concurrent deliveries both run.
 *   * Claiming with an INSERT and releasing on failure gets both: one in flight,
 *     and a failure still retryable.
 *
 * The claim is an insert on a unique `_id`, so the winner is decided by Mongo
 * rather than by a read this code performs and then acts on.
 */

import type { ProcessedEventStore } from '@oxyhq/crowdsource-express';
import {
  ModerationEvent,
  MODERATION_EVENT_RETENTION_SECONDS,
} from '../../models/moderation-event.js';
import { log } from '../../lib/logger.js';

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

export function mongoProcessedEventStore(): ProcessedEventStore {
  return {
    async claim(eventId: string): Promise<boolean> {
      const now = new Date();
      try {
        await ModerationEvent.create({
          _id: eventId,
          eventType: 'webhook',
          claimedAt: now,
          expiresAt: new Date(
            now.getTime() + MODERATION_EVENT_RETENTION_SECONDS * 1_000,
          ),
        });
        return true;
      } catch (error: unknown) {
        if (isDuplicateKeyError(error)) return false;
        /**
         * A Mongo outage must NOT be read as "already processed".
         *
         * Rethrowing makes the receiver refuse the delivery, so CrowdSource
         * retries it. Returning false instead would silently drop a decision on
         * the floor and acknowledge it as handled — the one failure mode this
         * whole store exists to prevent.
         */
        throw error;
      }
    },

    async release(eventId: string): Promise<void> {
      try {
        await ModerationEvent.deleteOne({ _id: eventId });
      } catch (error: unknown) {
        // The claim will expire by TTL even if this fails, so a redelivery is
        // still eventually processable. Worth a log line, never worth throwing
        // from a release path that runs while another error is being handled.
        log.moderation.warn(
          { err: error, eventId },
          '[Moderation] failed to release webhook event claim',
        );
      }
    },
  };
}
