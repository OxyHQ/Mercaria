/**
 * Verifying a Stripe delivery, and normalizing it into Mercaria's vocabulary.
 *
 * The trust boundary. Everything downstream of this file treats its output as
 * fact, which is why it is the only place that touches untrusted bytes and why
 * it either returns a verified event or throws.
 *
 * `StripePaymentProvider.verifyEvent` (#47) calls straight into here rather than
 * verifying anything of its own: the verification and the envelope mapping are
 * the SAME code the webhook ingress runs, so a signature accepted by one is
 * accepted by the other and there is no second implementation to drift.
 */

import Stripe from 'stripe';
import type {
  CurrencyCode,
  DisputeStatus,
  FxRateSnapshot,
  Money,
  PaymentStatus,
  RefundProviderState,
} from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { PaymentProviderError, type ProviderEventEnvelope } from '../provider.js';
import type { StripeWebhookScope } from './event-scopes.js';

/** A refusal is never retryable — see `verifyStripeEvent`. */
function refuse(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage: 'verifyEvent',
    message,
    retryable: false,
  });
}

/**
 * The secrets an endpoint will accept, current first.
 *
 * A rotation is a window in which BOTH are live: Stripe's dashboard mints the
 * new secret and starts signing with it, and the old one keeps arriving from
 * deliveries already in flight and from retries of events signed before the
 * roll. Accepting only the current one turns every rotation into a burst of
 * rejected deliveries; accepting only the previous one is a deployment nobody
 * can ever finish rotating. Order matters only for cost — the current secret
 * matches almost every time, so trying it first avoids a second HMAC.
 */
function secretsFor(scope: StripeWebhookScope): readonly string[] {
  const stripe = config.payments.stripe;
  const [current, previous] =
    scope === 'platform'
      ? [stripe.webhookSecret, stripe.webhookSecretPrevious]
      : [stripe.connectWebhookSecret, stripe.connectWebhookSecretPrevious];
  return previous === undefined ? [current] : [current, previous];
}

/**
 * Verify a delivery's signature over the RAW bytes and parse it.
 *
 * @param payload The exact bytes that arrived. A `Buffer`, never a re-serialized
 *   object: the signature covers what Stripe sent, and `JSON.stringify` of a
 *   parsed body reproduces it only by luck — key order, unicode escaping and
 *   number formatting all differ, and the one time it DOES reproduce a forged
 *   body byte-for-byte is the time it matters.
 * @param signature The `Stripe-Signature` header verbatim.
 * @throws {PaymentProviderError} `retryable: false` when no configured secret
 *   verifies, or when the timestamp is outside Stripe's replay tolerance. A bad
 *   signature is never a transient condition, and retrying one is how a forged
 *   event eventually gets a lucky window.
 */
export async function verifyStripeEvent(input: {
  payload: Buffer;
  signature: string;
  scope: StripeWebhookScope;
}): Promise<Stripe.Event> {
  const secrets = secretsFor(input.scope);
  let lastMessage = 'no webhook secret is configured for this endpoint';

  for (const secret of secrets) {
    if (secret === '') continue;
    try {
      // ASYNC deliberately — the synchronous variant throws outright under Bun,
      // which this backend runs in development. See `client.ts`.
      return await Stripe.webhooks.constructEventAsync(input.payload, input.signature, secret);
    } catch (error: unknown) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
  }

  // The message is Stripe's own ("No signatures found matching the expected
  // signature", "Timestamp outside the tolerance zone"). It quotes no secret and
  // no payload, so it is safe to log — and it is the difference between a
  // rotation that has not been deployed and a clock that has drifted.
  throw refuse(lastMessage);
}

/**
 * Stripe's PaymentIntent status, mapped onto Mercaria's payment lifecycle.
 *
 * The adapter's job, and the reason `PaymentStatus` exists at all: no Stripe
 * noun crosses this line. The two `requires_*` statuses collapse onto
 * `requires_action` because Mercaria acts identically on both — it is waiting
 * for the buyer's client — while `requires_capture` deliberately has NO mapping:
 * ADR 0001 D3 captures immediately, so a PaymentIntent sitting in it is a
 * configuration mistake this code must not paper over by inventing a status.
 *
 * @returns `undefined` for a status this version does not interpret, which the
 *   caller records rather than guesses at.
 */
export function mapPaymentIntentStatus(status: string): PaymentStatus | undefined {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return 'requires_action';
    case 'processing':
      return 'processing';
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'canceled';
    default:
      return undefined;
  }
}

/**
 * Stripe's Refund status, mapped onto Mercaria's refund-money lifecycle.
 *
 * `requires_action` collapses onto `pending` because it means the same thing to
 * everyone downstream: the money has not reached the buyer and Mercaria is not
 * the party that can move it along (it is the buyer's bank asking them to claim
 * a refund to a closed card). Rendering it as a fifth state would put a card
 * network's internal step into a merchant dashboard.
 *
 * An unrecognised status maps to `pending`, which is the fail-safe direction: a
 * refund reported as still moving is re-read and converges, while defaulting to
 * `succeeded` would tell a merchant money had landed on the strength of a word
 * this code does not know.
 */
export function mapRefundStatus(status: string | null): RefundProviderState {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'pending';
  }
}

/**
 * Stripe's Dispute status, mapped onto Mercaria's.
 *
 * Every `warning_*` status is an INQUIRY — a network asking for evidence before
 * any chargeback exists — and they all collapse onto `warning`, matched by
 * PREFIX so an inquiry status Stripe adds later lands on the safe side. Safe
 * here means "assume no money moved", and the backend confirms that
 * independently by reading the dispute's balance movements rather than trusting
 * this mapping to decide whether to book anything.
 *
 * `warning_closed` maps to `warning` too and not to a closed outcome: an inquiry
 * closing is not a dispute being won, and recording it as one would credit the
 * `disputes` account for a debit that never happened.
 */
export function mapDisputeStatus(status: string): DisputeStatus {
  if (status.startsWith('warning')) return 'warning';
  switch (status) {
    case 'won':
      return 'won';
    case 'lost':
      return 'lost';
    case 'under_review':
      return 'under_review';
    default:
      return 'needs_response';
  }
}

/**
 * Where the PAYMENT stands after a refund, read off the refund's charge.
 *
 * A Refund object knows its own amount and nothing about its siblings, and one
 * checkout group is one charge (ADR 0001 D4) — so "is this payment now fully
 * refunded" is a question about the CHARGE's cumulative `amount_refunded`. That
 * is what makes refunding one seller's order out of a multi-seller group report
 * `partially_refunded` rather than closing the whole payment.
 *
 * Without the charge expanded there is nothing to compare, and the honest answer
 * is the conservative one: a partial refund never over-states what came back.
 */
export function refundedPaymentStatus(refund: Stripe.Refund): PaymentStatus {
  const charge: unknown = refund.charge;
  if (typeof charge !== 'object' || charge === null) return 'partially_refunded';
  const record = charge as Partial<Stripe.Charge>;
  if (typeof record.amount !== 'number' || typeof record.amount_refunded !== 'number') {
    return 'partially_refunded';
  }
  return record.amount_refunded >= record.amount ? 'refunded' : 'partially_refunded';
}

/**
 * What a refund took off the PLATFORM balance, and the rate that produced it.
 *
 * The refund-side twin of the charge's `readSettlement`, and ADR 0001 D7's
 * "recorded at their OWN captured amounts, never derived from the charge legs"
 * in one function: a refund converts at the REFUND-time rate, so a converted
 * charge refunded a week later does not return the same platform figure it
 * brought in. That asymmetry is expected and is exactly what the ledger has to
 * show rather than smooth away.
 *
 * A refund's balance transaction carries a NEGATIVE amount (funds leaving), and
 * the absolute value is taken here so every caller books a magnitude and applies
 * its own sign — the ledger's sign convention belongs to the posting builders,
 * not to a provider reader.
 *
 * @returns `undefined` when the rail has not stated it yet, which is a caller's
 *   cue to retry rather than to assume a rate of one.
 */
export function refundPlatformSettlement(
  refund: Stripe.Refund,
): { platform: { amount: Money; rate: FxRateSnapshot } } | undefined {
  const balance: unknown = refund.balance_transaction;
  if (typeof balance !== 'object' || balance === null) return undefined;
  const transaction = balance as Stripe.BalanceTransaction;

  return {
    platform: {
      amount: {
        amount: Math.abs(transaction.amount),
        currency: transaction.currency.toUpperCase() as CurrencyCode,
      },
      rate: {
        from: refund.currency.toUpperCase() as CurrencyCode,
        to: transaction.currency.toUpperCase() as CurrencyCode,
        // `null` means no conversion happened, which is a rate of exactly one.
        // Stated rather than left absent: "there was no rate" and "the rate is
        // unknown" must not look alike in a snapshot whose whole purpose is to
        // be reproducible.
        rate: transaction.exchange_rate ?? 1,
        provider: 'stripe',
        asOf: new Date(transaction.created * 1_000).toISOString(),
      },
    },
  };
}

/** A `Record<string, string>` of only the ids that are actually present. */
function ids(entries: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * The Stripe ids an event refers to, keyed by Stripe's own names.
 *
 * Read off `data.object` by its own `object` discriminator rather than off the
 * event TYPE, because several types share one object shape (`charge.succeeded`
 * and `charge.updated`, the three `charge.dispute.*`) and one type can carry
 * different shapes over time. Anything not enumerated contributes its `id`
 * alone, which is always correct and never a guess.
 *
 * A Stripe id is not personal data — it is the correlation key the operator
 * surface (#50) and the reconciliation sweep both need, and it is why these are
 * stored in their own indexed column rather than being fished out of the
 * redacted payload summary later.
 */
export function stripeObjectIds(event: Stripe.Event): Record<string, string> {
  const object: unknown = event.data.object;
  if (typeof object !== 'object' || object === null) return {};
  const record = object as Record<string, unknown>;
  const self = typeof record.id === 'string' ? record.id : undefined;

  switch (record.object) {
    case 'payment_intent':
      return ids({ paymentIntent: self, charge: record.latest_charge });
    case 'charge':
      return ids({
        charge: self,
        paymentIntent: record.payment_intent,
        balanceTransaction: record.balance_transaction,
        transfer: record.transfer,
      });
    case 'refund':
      return ids({
        refund: self,
        charge: record.charge,
        paymentIntent: record.payment_intent,
        balanceTransaction: record.balance_transaction,
      });
    case 'dispute':
      return ids({
        dispute: self,
        charge: record.charge,
        paymentIntent: record.payment_intent,
      });
    case 'transfer':
      return ids({
        transfer: self,
        destination: record.destination,
        sourceTransaction: record.source_transaction,
        transferGroup: record.transfer_group,
      });
    case 'payout':
      return ids({ payout: self, destination: record.destination, account: event.account });
    case 'account':
      return ids({ account: self });
    default:
      // `account.external_account.updated` carries a `card` or `bank_account`,
      // and `account.application.deauthorized` an `application` — both identify
      // themselves only through `event.account`, which is the id that matters.
      return ids({ object: self, account: event.account });
  }
}

/**
 * A verified Stripe event as the provider-neutral envelope the payment domain
 * consumes.
 *
 * `payload` carries the parsed event and is NOT what gets stored: the caller
 * runs it through `redactProviderPayload` first (#45 invariant 9). It is on the
 * envelope so a handler can read the fields it needs, not so it can be persisted
 * wholesale.
 */
export function toProviderEventEnvelope(event: Stripe.Event): ProviderEventEnvelope {
  const object: unknown = event.data.object;
  const isPaymentIntent =
    typeof object === 'object' &&
    object !== null &&
    (object as { object?: unknown }).object === 'payment_intent';
  const rawStatus = isPaymentIntent ? (object as { status?: unknown }).status : undefined;
  const paymentStatus =
    typeof rawStatus === 'string' ? mapPaymentIntentStatus(rawStatus) : undefined;

  return {
    provider: 'stripe',
    // Present on every connect-scope delivery and absent on every platform-scope
    // one. It is HALF the event store's dedupe key, which is why it is read from
    // the verified event rather than from a header or a route parameter.
    ...(event.account ? { providerAccountId: event.account } : {}),
    providerEventId: event.id,
    type: event.type,
    livemode: event.livemode,
    ...(event.api_version ? { apiVersion: event.api_version } : {}),
    objectIds: stripeObjectIds(event),
    ...(paymentStatus ? { paymentStatus } : {}),
    payload: event,
  };
}
