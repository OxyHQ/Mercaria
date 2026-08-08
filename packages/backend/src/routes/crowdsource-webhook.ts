/**
 * Inbound CrowdSource webhooks, mounted at `/webhooks/crowdsource`.
 *
 * ## This router MUST be mounted BEFORE the global `express.json()`
 *
 * `crowdsourceWebhooks` reads the request STREAM itself and verifies the
 * signature over the exact bytes that arrived. If a body parser has already
 * consumed the stream, it REFUSES rather than verifying a re-serialisation —
 * which is correct, and which means a wrong mount order does not degrade the
 * check, it breaks the endpoint outright.
 *
 * Re-serialising is the specific bug this avoids. `JSON.stringify(req.body)`
 * succeeds on every payload a developer writes by hand and fails on the first
 * real delivery whose key order or unicode escaping differs — or, far worse,
 * succeeds on a FORGED body that happens to re-serialise identically.
 *
 * The mount lives in `app.ts` beside `/channels/webhooks`, which is there for
 * exactly the same reason (Shopify's HMAC over its raw body). A test asserts
 * `typeof req.body === 'undefined'` INSIDE a route on this path — proving no
 * parser ran, rather than proving the mount order looked right in a source file.
 *
 * ## Why the handler does almost nothing
 *
 * It queues. Enforcement runs from the outbox, not here, for two reasons: a slow
 * handler makes CrowdSource retry a delivery it already made, and a failure
 * halfway through enforcing would leave the delivery unacknowledged with some
 * actions applied and others not.
 *
 * The queue write is what makes the 2xx honest — it says "durably recorded", and
 * it is true because the row is committed before the response is sent.
 */

import { Router } from 'express';
import { crowdsourceWebhooks } from '@oxyhq/crowdsource-express';
import type { WebhookEventEnvelope } from '@oxyhq/crowdsource-contracts';
import { getDb } from '../db/postgres.js';
import { enqueueModerationOutboxEvent } from '../db/moderation/moderationOutboxRepository.js';
import { decisionApplyEventId } from '../services/moderation/moderation-outbox.service.js';
import { postgresProcessedEventStore } from '../services/moderation/moderation-event.store.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * Durably record the decision for the outbox to enforce.
 *
 * A transaction with ONE write in it, because `enqueueModerationOutboxEvent`
 * refuses to run outside one — and that refusal is not bureaucracy here either:
 * it is the single guarantee that nothing is ever enqueued without a committed
 * row behind it, and exempting the one caller that finds it inconvenient is how
 * that guarantee stops being one.
 *
 * The event id is the key, so a redelivery converges on the same row rather than
 * queueing the work twice — belt and braces alongside the processed-event claim.
 */
async function queueDecision(event: WebhookEventEnvelope): Promise<void> {
  await getDb().transaction(async (tx) => {
    await enqueueModerationOutboxEvent(
      {
        eventId: decisionApplyEventId(event.id),
        kind: 'decision.apply',
        payload: { event: event as unknown as Record<string, unknown> },
      },
      tx,
    );
  });
}

router.post(
  '/',
  makeRateLimiter('reports'),
  crowdsourceWebhooks({
    store: postgresProcessedEventStore(),
    on: {
      'case.decided': async (event) => {
        await queueDecision(event);
      },
      'decision.corrected': async (event) => {
        /**
         * A correction is enforced by the SAME path as an original decision.
         *
         * It arrives as a new revision whose outcome is usually `no_violation`,
         * and the enforcement plan turns that into a `restore`. Treating it as a
         * different kind of event — or ignoring it — is how an accepted appeal
         * leaves a seller's listing delisted forever.
         */
        await queueDecision(event);
      },
      'appeal.decided': async (event) => {
        await queueDecision(event);
      },
    },
    onRejected: (rejection) => {
      // The reason only. Never the body, never the signature, never a header.
      log.moderation.warn({ rejection }, '[Moderation] webhook delivery rejected');
    },
  }),
);

/**
 * NO body parser is mounted on this router, and none may ever be.
 *
 * Adding `express.json()` here "for consistency" would run it before the handler
 * on every request to this path and silently break signature verification for
 * every delivery — the same failure as mounting the router after the global
 * parser, just harder to spot. Unmatched subpaths fall through to the
 * application's normal 404 handling, which is why there is no catch-all here.
 */

export default router;
