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

import {
  PeableSignatureVerificationError,
  type WebhookEvent,
  type WebhookEventType,
  WebhooksResource,
} from '@peable.to/sdk';
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
 *
 * A `payment_intent.*` type IS the assertion: the status the intent reached
 * (ADR 0019). `charge.refunded` is not — refunds are not intent statuses, and
 * whether the payment is now `refunded` or `partially_refunded` is the intent's
 * cumulative `amount_refunded`, which the router re-reads (`'reread'`).
 */
export const PAYMENT_STATUS_FOR_EVENT = {
  // A card payment's SCA challenge: the checkout has a screen for it.
  'payment_intent.requires_action': 'requires_action',
  'payment_intent.processing': 'processing',
  'payment_intent.succeeded': 'succeeded',
  // An attempt failed. A card returns to `requires_payment_method` and the
  // buyer can try again, which Mercaria's `failed` allows.
  'payment_intent.payment_failed': 'failed',
  // By Mercaria, by the gateway's expiry (`abandoned`), or underpaid.
  'payment_intent.canceled': 'canceled',
  'charge.refunded': 'reread',
} as const satisfies Partial<Record<WebhookEventType, PaymentStatus | 'reread'>>;

/** An event type this rail acts on. */
export type PeablePaymentEventType = keyof typeof PAYMENT_STATUS_FOR_EVENT;

export function isPeablePaymentEvent(type: string): type is PeablePaymentEventType {
  return Object.hasOwn(PAYMENT_STATUS_FOR_EVENT, type);
}

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
 * The payment an event is about: the PaymentIntent itself, or the one a charge,
 * refund or dispute names (an expandable reference, `string | PaymentIntent`).
 */
function paymentIntentIdOf(event: WebhookEvent): string | undefined {
  const object = event.data.object;
  switch (object.object) {
    case 'payment_intent':
      return object.id;
    case 'charge':
    case 'refund':
    case 'dispute': {
      const reference = object.payment_intent;
      return typeof reference === 'string' ? reference : reference.id;
    }
    default:
      return undefined;
  }
}

/**
 * Verify a delivery and normalize it.
 *
 * Every configured secret is offered at once, so a rotation does not reject the
 * deliveries signed with the outgoing one: the SDK accepts the event when any
 * `v1=` signature matches any secret.
 */
export function verifyPeableSignature(input: ProviderEventInput): ProviderEventEnvelope {
  const secrets = [
    config.payments.peable.webhookSecret,
    config.payments.peable.webhookSecretPrevious,
  ].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);

  if (secrets.length === 0) refuse('no Peable webhook secret is configured');

  let event: WebhookEvent;
  try {
    event = webhooks.constructEvent(input.payload, input.signature, secrets, TOLERANCE_SECONDS);
  } catch (error) {
    if (!(error instanceof PeableSignatureVerificationError)) throw error;
    refuse('the Peable delivery could not be verified');
  }

  const intentId = paymentIntentIdOf(event);
  const asserted = isPeablePaymentEvent(event.type)
    ? PAYMENT_STATUS_FOR_EVENT[event.type]
    : undefined;

  return {
    provider: 'peable',
    providerEventId: event.id,
    type: event.type,
    // The mode of the event's merchant (ADR 0017). The ingress drops a delivery
    // whose mode is not this deployment's, as the Stripe ingress does.
    livemode: event.livemode,
    apiVersion: event.api_version,
    objectIds: intentId === undefined ? {} : { payment_intent: intentId },
    ...(asserted === undefined || asserted === 'reread' ? {} : { paymentStatus: asserted }),
    payload: event,
  };
}
