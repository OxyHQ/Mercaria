/**
 * Receiving a Stripe delivery — the whole of what happens before a 200.
 *
 * ## The invariant order, and what each step is allowed to leave behind
 *
 *   1. **Verify** the signature over the RAW bytes, against this endpoint's own
 *      secret and its rotation predecessor. A failure persists NOTHING and
 *      answers 400: an unverified body is a stranger's opinion, and storing one
 *      would put an attacker's chosen `(provider, account, event id)` into the
 *      dedupe key — after which the REAL event carrying that id is silently
 *      swallowed as a duplicate. That is the whole reason nothing is written
 *      before this line.
 *   2. **Filter on `livemode`.** A production URL receives test events too (ADR
 *      0001), and a test-mode object has ids from a different key space that
 *      would correlate to nothing or, worse, to the wrong thing. Recorded in the
 *      log, persisted nowhere, acknowledged with 200 — Stripe must stop
 *      retrying something that was correctly refused.
 *   3. **Refuse the other endpoint's scope.** Each endpoint has its own secret,
 *      so an authentically-signed event of the other's type means the Stripe
 *      dashboard is misconfigured. 400 and nothing persisted; see
 *      `event-scopes.ts` for why an UNKNOWN type is stored instead.
 *   4. **Store the envelope**, redacted, keyed on `(provider, account, event
 *      id)`. The insert IS the dedupe claim: a redelivery loses the race to the
 *      unique index and returns without touching anything (#45 invariant 3).
 *   5. **Process**, through the durable claim in `event-processor.ts`.
 *
 * ## A 200 means STORED, never PROCESSED
 *
 * Processing runs inline here, immediately after the envelope commits, but its
 * failure never changes the answer. The row is durable and claimable, so a
 * handler that throws is retried by any task's poller with backoff and is
 * eventually dead-lettered where an operator can see it — whereas answering 500
 * would ask Stripe to redeliver an event Mercaria has already stored, which is
 * how one delivery becomes a queue of duplicates that all resolve to the same
 * no-op.
 *
 * Inline rather than fire-and-forget after the response, because a detached
 * promise is unobservable: it cannot be awaited by a test, it cannot be drained
 * on shutdown, and its failures arrive with no request to attribute them to. The
 * cost is a few milliseconds on a call Stripe allows far longer for.
 */

import type Stripe from 'stripe';
import { RETENTION_SECONDS } from '../../../db/expiryTargets.js';
import { recordProviderEvent } from '../../../db/payments/paymentRepository.js';
import { getDb } from '../../../db/postgres.js';
import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { PaymentProviderError } from '../provider.js';
import { redactProviderPayload } from '../redact.js';
import { isWrongScope, type StripeWebhookScope } from './event-scopes.js';
import { processStoredStripeEvent } from './event-processor.js';
import { toProviderEventEnvelope, verifyStripeEvent } from './verify.js';

/**
 * What the ingress did with a delivery.
 *
 * The `code` on each is what the route puts in its response body: Stripe's
 * dashboard shows it beside the delivery, so it is the first thing an operator
 * debugging a misconfigured endpoint reads. It names a condition, never a
 * detail — no secret, no signature, no payload.
 */
export type StripeIngressResult =
  | { readonly outcome: 'accepted'; readonly providerEventId: string; readonly storedEventId: string }
  | { readonly outcome: 'duplicate'; readonly providerEventId: string; readonly storedEventId: string }
  | { readonly outcome: 'ignored'; readonly code: 'livemode_mismatch'; readonly providerEventId: string }
  | { readonly outcome: 'rejected'; readonly code: 'invalid_signature' | 'wrong_scope' };

/** One delivery, exactly as it arrived. */
export interface StripeDelivery {
  /** The RAW bytes. Never a re-serialization — see `verify.ts`. */
  readonly payload: Buffer;
  /** The `Stripe-Signature` header verbatim. */
  readonly signature: string;
  /** Which of the two endpoints received it. */
  readonly scope: StripeWebhookScope;
}

/**
 * Verify, filter, store and process one delivery.
 *
 * Never throws for anything a caller should turn into a 5xx: a refusal is a
 * result, not an exception, because a route that had to distinguish "this was
 * refused" from "this blew up" by catching would eventually get it wrong in the
 * direction that answers 500 to a forged request and invites the sender to try
 * again.
 */
export async function ingestStripeDelivery(
  delivery: StripeDelivery,
): Promise<StripeIngressResult> {
  let event: Stripe.Event;
  try {
    event = await verifyStripeEvent(delivery);
  } catch (error: unknown) {
    // The reason only. Never the body, never the signature, never a header —
    // the same discipline `onRejected` follows for the CrowdSource webhook.
    log.general.warn(
      {
        scope: delivery.scope,
        reason: error instanceof PaymentProviderError ? error.message : 'verification failed',
      },
      '[Stripe] webhook delivery refused',
    );
    return { outcome: 'rejected', code: 'invalid_signature' };
  }

  if (event.livemode !== config.payments.stripe.livemode) {
    log.general.warn(
      {
        scope: delivery.scope,
        providerEventId: event.id,
        type: event.type,
        eventLivemode: event.livemode,
        deploymentLivemode: config.payments.stripe.livemode,
      },
      '[Stripe] delivery is for the other mode; acknowledged and dropped',
    );
    return { outcome: 'ignored', code: 'livemode_mismatch', providerEventId: event.id };
  }

  if (isWrongScope(delivery.scope, event.type)) {
    log.general.error(
      { scope: delivery.scope, providerEventId: event.id, type: event.type },
      '[Stripe] delivery arrived at the wrong endpoint; check the two endpoint ' +
        'subscriptions in the Stripe dashboard',
    );
    return { outcome: 'rejected', code: 'wrong_scope' };
  }

  const envelope = toProviderEventEnvelope(event);
  const stored = await recordProviderEvent(getDb(), {
    provider: 'stripe',
    providerEventId: envelope.providerEventId,
    type: envelope.type,
    livemode: envelope.livemode,
    objectIds: { ...envelope.objectIds },
    // NEVER the wholesale payload — #45 invariant 9. A Stripe event body is the
    // richest personal-data object this system ever receives.
    payloadSummary: redactProviderPayload(envelope.payload),
    expiresAt: new Date(Date.now() + RETENTION_SECONDS.paymentProviderEvent * 1_000),
    ...(envelope.providerAccountId ? { providerAccountId: envelope.providerAccountId } : {}),
    ...(envelope.apiVersion ? { apiVersion: envelope.apiVersion } : {}),
  });

  if (stored.duplicate) {
    // The cheapest possible answer to the commonest condition. Nothing is
    // processed a second time: the row is already `processed` (or claimed by
    // whichever task is doing it), so there is deliberately no drain here.
    log.general.debug(
      { providerEventId: envelope.providerEventId, type: envelope.type },
      '[Stripe] duplicate delivery acknowledged',
    );
    return {
      outcome: 'duplicate',
      providerEventId: envelope.providerEventId,
      storedEventId: stored.row.id,
    };
  }

  // Committed. From here nothing may change the 200 — see this file's docblock.
  try {
    await processStoredStripeEvent({ storedEventId: stored.row.id, event });
  } catch (error: unknown) {
    log.general.warn(
      { err: error, providerEventId: envelope.providerEventId, storedEventId: stored.row.id },
      '[Stripe] inline processing failed; the event is stored and will be retried',
    );
  }

  return {
    outcome: 'accepted',
    providerEventId: envelope.providerEventId,
    storedEventId: stored.row.id,
  };
}
