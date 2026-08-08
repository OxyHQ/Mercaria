/**
 * The webhook dedupe claim, backed by Postgres instead of process memory.
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
 * ## There is deliberately no `try` around the claim
 *
 * The winner is decided by the unique primary key, and the repository reports the
 * loss as a VALUE (`false`) rather than as an exception — so there is no
 * duplicate-key error to recognise and, therefore, no `catch` that could ever be
 * widened into swallowing a real failure. That widening is exactly the mistake the
 * Mongo shape was one line away from: a database outage read as "already
 * processed" answers CrowdSource 200 and retires a decision nobody ever handled.
 * Here anything that throws reaches the middleware, which answers non-2xx and
 * leaves the event on the sender's retry schedule.
 */

import type { ProcessedEventStore } from '@oxyhq/crowdsource-express';
import {
  claimModerationEvent,
  releaseModerationEvent,
} from '../../db/moderation/moderationEventRepository.js';
import { log } from '../../lib/logger.js';

/** What `event_type` records for a claim taken by the webhook receiver. */
const WEBHOOK_EVENT_TYPE = 'webhook';

export function postgresProcessedEventStore(): ProcessedEventStore {
  return {
    async claim(eventId: string): Promise<boolean> {
      return await claimModerationEvent(eventId, WEBHOOK_EVENT_TYPE);
    },

    async release(eventId: string): Promise<void> {
      try {
        await releaseModerationEvent(eventId);
      } catch (error: unknown) {
        // The claim is swept by `expiryTargets` even if this fails, so a
        // redelivery is still eventually processable. Worth a log line, never
        // worth throwing from a release path that runs while another error is
        // already being handled.
        log.moderation.warn(
          { err: error, eventId },
          '[Moderation] failed to release webhook event claim',
        );
      }
    },
  };
}
