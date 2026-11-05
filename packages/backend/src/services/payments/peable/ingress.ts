/**
 * Receiving a Peable delivery — the whole of what happens before a 200.
 *
 * Four steps, and the invariants are the rail's rather than the provider's:
 *
 *   1. **Verify** the signature over the RAW bytes, against this deployment's
 *      secret and its rotation predecessor. A failure persists NOTHING and
 *      answers 400 — storing an unverified body would put an attacker's chosen
 *      `(provider, account, event id)` into the dedupe key, after which the REAL
 *      event carrying that id is swallowed as a duplicate.
 *   2. **Filter on `livemode`.** The gateway serves test and live side by side
 *      (ADR 0017) and every event names its mode. One for the other mode than
 *      this deployment's carries ids from a key space that correlates to
 *      nothing here: logged, persisted nowhere, acknowledged with 200 so the
 *      gateway stops retrying something that was correctly refused.
 *   3. **Store the envelope**, redacted, keyed on that triple. The insert IS the
 *      dedupe claim: a redelivery loses the race to the unique index and returns
 *      without touching anything.
 *   4. **Process**, through the durable claim in `event-processor.ts`.
 *
 * ## The step Stripe has that this does not, and why
 *
 * **No scope check.** Stripe needs two endpoints because its Connect-scope
 * deliveries are signed with a different secret — a property of Stripe's API,
 * not a preference. The gateway signs everything with one secret, so there is
 * one endpoint and no way for a delivery to arrive at the wrong one. If Peable
 * ever splits its signing, this is where the check goes back.
 *
 * ## A 200 means STORED, never PROCESSED
 *
 * Processing runs inline immediately after the envelope commits, and its failure
 * never changes the answer. The row is durable and claimable, so a handler that
 * throws is retried by any task's poller and eventually dead-lettered where an
 * operator can see it — whereas answering 500 would ask the gateway to redeliver
 * an event Mercaria has already stored, which is how one delivery becomes a
 * queue of duplicates that all resolve to the same no-op.
 */

import { config } from '../../../config/index.js';
import { RETENTION_SECONDS } from '../../../db/expiryTargets.js';
import { recordProviderEvent } from '../../../db/payments/paymentRepository.js';
import { getDb } from '../../../db/postgres.js';
import { log } from '../../../lib/logger.js';
import { PaymentProviderError } from '../provider.js';
import type { ProviderEventEnvelope } from '../provider.js';
import { redactProviderPayload } from '../redact.js';
import { verifyPeableSignature } from './verify.js';
import { processStoredPeableEvent } from './event-processor.js';

/**
 * What the ingress did with a delivery.
 *
 * The `code` on a refusal is what the route puts in its response body: the
 * gateway's delivery log shows it, so it is the first thing an operator
 * debugging a misconfigured endpoint reads. It names a condition, never a detail
 * — no secret, no signature, no payload.
 */
export type PeableIngressResult =
  | {
      readonly outcome: 'accepted';
      readonly providerEventId: string;
      readonly storedEventId: string;
    }
  | {
      readonly outcome: 'duplicate';
      readonly providerEventId: string;
      readonly storedEventId: string;
    }
  | {
      readonly outcome: 'ignored';
      readonly code: 'livemode_mismatch';
      readonly providerEventId: string;
    }
  | { readonly outcome: 'rejected'; readonly code: 'invalid_signature' };

/** One delivery, exactly as it arrived. */
export interface PeableDelivery {
  /** The RAW bytes. Never a re-serialization — a signature covers BYTES. */
  readonly payload: Buffer;
  /** The `Peable-Signature` header verbatim. */
  readonly signature: string;
}

/**
 * Verify, filter, store and process one delivery.
 *
 * Never throws for anything a caller should turn into a 5xx: a refusal is a
 * result, not an exception, because a route that had to distinguish "refused"
 * from "blew up" by catching would eventually get it wrong in the direction that
 * answers 500 to a forged request and invites the sender to try again.
 */
export async function ingestPeableDelivery(delivery: PeableDelivery): Promise<PeableIngressResult> {
  let envelope: ProviderEventEnvelope;
  try {
    const payload = delivery.payload.toString('utf8');
    // The SDK verifies over the body decoded as UTF-8, and decodes lossily.
    // Refuse a lossy decoding first so altered raw bytes cannot authenticate as
    // the same replacement character.
    if (!Buffer.from(payload, 'utf8').equals(delivery.payload)) {
      return { outcome: 'rejected', code: 'invalid_signature' };
    }
    envelope = verifyPeableSignature({
      payload,
      signature: delivery.signature,
    });
  } catch (error: unknown) {
    // The reason only. Never the body, never the signature, never a header.
    log.general.warn(
      {
        reason: error instanceof PaymentProviderError ? error.message : 'verification failed',
      },
      '[Peable] webhook delivery refused',
    );
    return { outcome: 'rejected', code: 'invalid_signature' };
  }

  if (envelope.livemode !== config.payments.peable.livemode) {
    log.general.warn(
      {
        providerEventId: envelope.providerEventId,
        type: envelope.type,
        eventLivemode: envelope.livemode,
        deploymentLivemode: config.payments.peable.livemode,
      },
      '[Peable] delivery is for the other mode; acknowledged and dropped',
    );
    return {
      outcome: 'ignored',
      code: 'livemode_mismatch',
      providerEventId: envelope.providerEventId,
    };
  }

  const stored = await recordProviderEvent(getDb(), {
    provider: 'peable',
    providerEventId: envelope.providerEventId,
    type: envelope.type,
    livemode: envelope.livemode,
    objectIds: { ...envelope.objectIds },
    // NEVER the wholesale payload. A gateway event body carries payer detail,
    // and `provider_events` is the table a support query reads.
    payloadSummary: redactProviderPayload(envelope.payload),
    expiresAt: new Date(Date.now() + RETENTION_SECONDS.paymentProviderEvent * 1_000),
  });

  if (stored.duplicate) {
    // The cheapest answer to the commonest condition. Nothing is processed a
    // second time: the row is already processed, or claimed by whichever task is
    // doing it, so there is deliberately no drain here.
    log.general.debug(
      { providerEventId: envelope.providerEventId, type: envelope.type },
      '[Peable] duplicate delivery acknowledged',
    );
    return {
      outcome: 'duplicate',
      providerEventId: envelope.providerEventId,
      storedEventId: stored.row.id,
    };
  }

  // Committed. From here nothing may change the 200 — see this file's docblock.
  try {
    await processStoredPeableEvent({ storedEventId: stored.row.id });
  } catch (error: unknown) {
    log.general.warn(
      { err: error, providerEventId: envelope.providerEventId, storedEventId: stored.row.id },
      '[Peable] inline processing failed; the event is stored and will be retried',
    );
  }

  return {
    outcome: 'accepted',
    providerEventId: envelope.providerEventId,
    storedEventId: stored.row.id,
  };
}
