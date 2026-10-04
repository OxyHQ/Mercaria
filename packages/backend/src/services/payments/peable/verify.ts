/**
 * Verifying a delivery from the Peable gateway.
 *
 * The signature scheme is Stripe-shaped by design — `t=<unix>,v1=<hex
 * hmac-sha256 of "<t>.<rawBody>">` — which is why this file is short and why
 * the invariant it depends on is the same one `routes/stripe-webhook.ts`
 * already carries: **the router must be mounted before `express.json()`.** A
 * signature covers BYTES. `JSON.stringify(req.body)` reproduces them only by
 * luck, so a parser reaching the stream first does not weaken verification, it
 * breaks every delivery.
 *
 * The published SDK owns signature/envelope/type verification. This wrapper
 * only supplies current/previous secrets and normalizes the verified event
 * into Mercaria's domain. It creates no client credentials or service token.
 */

import { WebhooksResource, PeableSignatureVerificationError } from '@peable.to/sdk';
import { config } from '../../../config/index.js';
import { PaymentProviderError } from '../provider.js';
import type { ProviderEventEnvelope, ProviderEventInput } from '../provider.js';
import type { PaymentStatus } from '@mercaria/shared-types';

/**
 * How far a delivery's timestamp may drift before it is refused.
 *
 * This is the whole replay defence: without it a signature captured today
 * verifies forever, and an attacker who ever saw one delivery can re-send it
 * whenever the state it describes becomes advantageous.
 */
const TOLERANCE_SECONDS = 300;

/**
 * What the gateway's event types mean for a payment.
 *
 * EXPORTED, and `event-router.ts` derives its handler table from this one rather
 * than restating it. Two maps of the same fact drift — that is exactly how the
 * ledger audit stopped covering an entire rail — and here the drift would be
 * worse than silent: a type this verifier annotates with a status but the router
 * has no handler for is stored, found unhandled, and marked processed. A real
 * settlement, filed as understood.
 */
export const PAYMENT_STATUS_FOR_EVENT: Readonly<Record<string, PaymentStatus>> = {
  'payment_intent.settled': 'succeeded',
  'payment_intent.failed': 'failed',
  'payment_intent.rejected': 'canceled',
  'payment_intent.expired': 'canceled',
  'payment_intent.refunded': 'refunded',
  'payment_intent.partially_refunded': 'partially_refunded',
  // `confirming` is the FairCoin rail's "the payer broadcast and the network is
  // working on it", which is what Mercaria's `processing` means: money in
  // flight, not yet final. Mapped rather than dropped — leaving it unmapped
  // would make a chain payment look untouched between broadcast and settlement,
  // which is precisely the window a buyer asks about.
  'payment_intent.confirming': 'processing',
};

const webhooks = new WebhooksResource();

function refuse(message: string): never {
  throw new PaymentProviderError({
    provider: 'peable',
    stage: 'verifyEvent',
    message,
    // A bad signature is NEVER transient, and retrying one is how a forged
    // event eventually gets a lucky window.
    retryable: false,
  });
}

/**
 * Verify a delivery and normalize it.
 *
 * Tries every configured secret, so a rotation does not reject the deliveries
 * signed with the outgoing one. The gateway cannot atomically swap a secret,
 * and without this window every in-flight delivery during a rotation is
 * rejected as a forgery.
 */
export function verifyPeableSignature(input: ProviderEventInput): ProviderEventEnvelope {
  const secrets = [
    config.payments.peable.webhookSecret,
    config.payments.peable.webhookSecretPrevious,
  ].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);

  if (secrets.length === 0) refuse('no Peable webhook secret is configured');

  let event: ReturnType<WebhooksResource['constructEvent']> | undefined;
  for (const secret of secrets) {
    try {
      event = webhooks.constructEvent(input.payload, input.signature, secret, {
        toleranceSec: TOLERANCE_SECONDS,
      });
      break;
    } catch (error) {
      if (!(error instanceof PeableSignatureVerificationError)) throw error;
    }
  }
  if (!event) refuse('the Peable delivery could not be verified');

  const intentId = event.data?.object?.id;
  const paymentStatus = PAYMENT_STATUS_FOR_EVENT[event.type];

  return {
    provider: 'peable',
    providerEventId: event.id,
    type: event.type,
    // The gateway is single-mode per deployment: it serves the environment its
    // credentials belong to, so there is no `livemode` on the envelope to read.
    // Mercaria's own environment is the mode, and the test/live firewall is the
    // service credential rather than a field in the body.
    livemode: config.payments.peable.livemode,
    objectIds: typeof intentId === 'string' ? { payment_intent: intentId } : {},
    ...(paymentStatus === undefined ? {} : { paymentStatus }),
    payload: event,
  };
}
