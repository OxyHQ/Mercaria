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
 * It is reimplemented here rather than imported from `@peable.to/shared-types`
 * for the same reason `client.ts` does not use the published SDK: the gateway's
 * contract is versioned by its deployment, and coupling Mercaria's release to a
 * Peable `npm publish` buys nothing for forty lines of HMAC. The scheme is
 * pinned by `verify.test.ts`, which signs with the gateway's own algorithm.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
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

/** What the gateway's event types mean for a payment. */
const PAYMENT_STATUS_FOR_EVENT: Readonly<Record<string, PaymentStatus>> = {
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

interface ParsedHeader {
  readonly timestamp: number;
  readonly signature: string;
}

function parseHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signature = value;
    }
  }
  if (timestamp === null || signature === null) return null;
  return { timestamp, signature };
}

/**
 * Constant-time hex comparison.
 *
 * `timingSafeEqual` throws on mismatched lengths, so the length check comes
 * first and returns false rather than propagating — an exception here would be
 * distinguishable from a mismatch by timing AND by the error, which is the
 * whole thing the constant-time comparison exists to avoid.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length === 0 || bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

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

/** The gateway's event envelope, narrowed to what this reads. */
interface GatewayEvent {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly created?: unknown;
  readonly data?: { readonly object?: { readonly id?: unknown } };
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

  const parsed = parseHeader(input.signature);
  if (!parsed) refuse('the signature header is malformed');

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > TOLERANCE_SECONDS) {
    refuse('the signature timestamp is outside the tolerance window');
  }

  const signedPayload = `${String(parsed.timestamp)}.${input.payload}`;
  const matched = secrets.some((secret) =>
    constantTimeEqualHex(
      createHmac('sha256', secret).update(signedPayload).digest('hex'),
      parsed.signature,
    ),
  );
  if (!matched) refuse('the signature does not verify');

  let event: GatewayEvent;
  try {
    event = JSON.parse(input.payload) as GatewayEvent;
  } catch {
    // Signed and unparseable. Refused rather than stored, because every
    // downstream reader assumes an object and there is nothing to correlate.
    refuse('the delivery body is not JSON');
  }

  if (typeof event.id !== 'string' || typeof event.type !== 'string') {
    refuse('the delivery is missing an id or a type');
  }

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
