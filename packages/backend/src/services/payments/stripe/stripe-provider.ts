/**
 * `StripePaymentProvider` — the card rail behind the `PaymentProvider` seam.
 *
 * It translates, and it decides nothing. Every Mercaria consequence of a payment
 * — the status transitions, the ledger, the outbox, the orders — belongs to
 * `payment.service`, and every Stripe noun stops here.
 *
 * ## What this rail cannot do, and says so out loud
 *
 * `authorize`, `capture` and `refund` all THROW, and the messages are the
 * documentation:
 *
 *  - **Capture is immediate** (ADR 0001 D3): the PaymentIntent captures itself
 *    the moment the buyer confirms it, so there is no second step for Mercaria
 *    to take. Returning the current status from `capture` would be the tempting
 *    alternative and is worse than throwing — it reports success for an
 *    operation that did nothing, so a caller that genuinely needed a capture
 *    would never learn it had not happened.
 *  - **Authorization is the buyer's**, performed client-side against the client
 *    secret with a payment method Mercaria never sees. There is no server call
 *    that moves a PaymentIntent forward without one, and inventing one would
 *    mean collecting card details, which is the whole thing this integration
 *    exists to avoid (PCI SAQ-A).
 *  - **Refunds are #49's**, together with the transfer reversal that has to
 *    accompany them. Refunding a buyer without reversing the seller's share pays
 *    a seller for goods that came back, so half of that pair is worse than
 *    neither, and the throw names the issue that lands both.
 *
 * ## Payment methods: `card` explicitly, never `automatic_payment_methods`
 *
 * ADR 0001 D3 restricts the launch to cards and card-based wallets (Apple Pay,
 * Google Pay), which Stripe delivers THROUGH the `card` payment method — so
 * `payment_method_types: ['card']` is exactly that set, and the wallets need no
 * separate entry.
 *
 * `automatic_payment_methods` would move the decision into the Stripe dashboard,
 * where enabling SEPA Direct Debit is a toggle. That is not a hypothetical
 * preference: an asynchronous method can FAIL days after `source_transaction`
 * transfers were requested against it, and unlike destination charges nothing
 * auto-reverses (D3 again). A decision the ADR took must not be silently
 * revocable by a checkbox, so it lives in code where changing it is a reviewed
 * diff.
 *
 * ## Idempotency keys come IN
 *
 * Never minted here. `pi:<paymentId>` and `tr:<paymentId>:<orderId>` are ADR
 * 0001 D11's, derived from Mercaria's durable ids by the callers, because a key
 * invented at the adapter would be new on every retry — which is the one failure
 * the whole scheme exists to prevent.
 */

import type Stripe from 'stripe';
import type { CurrencyCode, PaymentStatus } from '@mercaria/shared-types';
import {
  PaymentProviderError,
  type CreatePaymentRequest,
  type CreateTransferRequest,
  type PaymentOperationRequest,
  type PaymentProviderStage,
  type ProviderEventEnvelope,
  type ProviderEventInput,
  type ProviderPaymentResult,
  type ProviderRefundResult,
  type ProviderTransferResult,
  type RefundRequest,
  type ResumablePaymentProvider,
  type SettlingPaymentProvider,
} from '../provider.js';
import {
  cancelStripePaymentIntent,
  createStripePaymentIntent,
  createStripeTransfer,
  retrieveStripePaymentIntent,
} from './client.js';
import { mapPaymentIntentStatus, toProviderEventEnvelope, verifyStripeEvent } from './verify.js';

/**
 * The launch payment method set — ADR 0001 D3. See this file's docblock for why
 * it is a constant here rather than `automatic_payment_methods`.
 */
const PAYMENT_METHOD_TYPES: readonly string[] = ['card'];

/**
 * Turn any Stripe SDK throw into the domain's own error.
 *
 * `retryable` is read from Stripe's own classification rather than guessed:
 * `StripeConnectionError`, `StripeAPIError` and a rate limit are transient by
 * definition, while a card decline, an invalid request and an auth failure are
 * the same answer however many times they are asked. Everything unrecognised is
 * treated as retryable, matching `isRetryableProviderError`'s own default —
 * assuming an unknown defect is permanent is how a recoverable outage becomes an
 * abandoned payment.
 */
function toProviderError(error: unknown, stage: PaymentProviderStage): PaymentProviderError {
  if (error instanceof PaymentProviderError) return error;

  const candidate = error as Partial<Stripe.errors.StripeError> & { message?: string };
  const type = typeof candidate.type === 'string' ? candidate.type : undefined;
  const permanent =
    type === 'StripeCardError' ||
    type === 'StripeInvalidRequestError' ||
    type === 'StripeAuthenticationError' ||
    type === 'StripePermissionError' ||
    type === 'StripeSignatureVerificationError' ||
    type === 'StripeIdempotencyError';

  return new PaymentProviderError({
    provider: 'stripe',
    stage,
    message: typeof candidate.message === 'string' ? candidate.message : String(error),
    retryable: !permanent,
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
  });
}

/** An operation this rail structurally does not have. Never retryable. */
function unsupported(stage: PaymentProviderStage, message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage,
    message,
    retryable: false,
    code: 'unsupported_operation',
  });
}

/**
 * Stripe's lowercase ISO currency, from Mercaria's uppercase one.
 *
 * Trivial, and it is a named function because it is a REQUIREMENT of the API
 * rather than a formatting preference: Stripe rejects `EUR` outright, and a
 * charge that never got created is a checkout that failed for a reason no log
 * line would explain.
 */
function toStripeCurrency(currency: CurrencyCode): string {
  return currency.toLowerCase();
}

/** The status a freshly-created intent is in, in Mercaria's vocabulary. */
function statusOf(intent: Stripe.PaymentIntent, fallback: PaymentStatus): PaymentStatus {
  return mapPaymentIntentStatus(intent.status) ?? fallback;
}

/**
 * The client secret, or a refusal.
 *
 * Stripe types it nullable because a PaymentIntent retrieved with a restricted
 * key has none. Mercaria's key is not restricted, so an absent secret means the
 * response was not what this code believes it is — and handing the client
 * `undefined` would surface as an unexplained failure inside a payment sheet
 * instead of here.
 */
function requireClientSecret(intent: Stripe.PaymentIntent, stage: PaymentProviderStage): string {
  if (typeof intent.client_secret !== 'string' || intent.client_secret === '') {
    throw new PaymentProviderError({
      provider: 'stripe',
      stage,
      message: `Stripe PaymentIntent ${intent.id} carries no client secret.`,
      retryable: false,
      code: 'missing_client_secret',
    });
  }
  return intent.client_secret;
}

export class StripePaymentProvider implements SettlingPaymentProvider, ResumablePaymentProvider {
  readonly id = 'stripe' as const;

  /**
   * One PaymentIntent for the whole checkout group — ADR 0001 D4.
   *
   * Single-seller checkout is the N=1 case of this call and there is no second
   * code path: the buyer authorizes once, one statement line appears, and one
   * charge is what every per-order refund later draws from.
   *
   * `transfer_group` ties the charge and every seller transfer together at
   * Stripe, which is how an operator reading Stripe's side alone can still see
   * one cart. The metadata is D11's contract and is what the webhook resolver
   * reads to find the Mercaria payment — server-issued ids only, never anything
   * a buyer, a card or a Stripe Customer could influence.
   */
  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    try {
      const intent = await createStripePaymentIntent(
        {
          amount: request.amount.amount,
          currency: toStripeCurrency(request.amount.currency),
          // ADR 0001 D3: immediate capture. Stated explicitly rather than left
          // to the API default, because it is a decision with a rejected
          // alternative (authorization holds last 2–7 days, which is shorter
          // than realistic secondhand fulfilment) and a reader should find it
          // here rather than in a docs table.
          capture_method: 'automatic',
          payment_method_types: [...PAYMENT_METHOD_TYPES],
          transfer_group: request.checkoutGroupId,
          metadata: { ...request.metadata },
        },
        request.idempotencyKey,
      );

      return {
        providerObjectId: intent.id,
        status: statusOf(intent, 'created'),
        clientAction: {
          kind: 'client_secret',
          value: requireClientSecret(intent, 'createPayment'),
        },
      };
    } catch (error: unknown) {
      throw toProviderError(error, 'createPayment');
    }
  }

  /**
   * Read a PaymentIntent Mercaria already created, client material included.
   *
   * The resumability path, and the reason it is not simply another
   * `createPayment`: Stripe's idempotency keys expire after 24 hours, so a
   * buyer returning to an unpaid checkout the next day would otherwise be given
   * a SECOND PaymentIntent for orders the first one is still able to fund.
   * Reading the intent Mercaria has already recorded cannot do that, whatever
   * the age of the key.
   */
  async resumePayment(providerObjectId: string): Promise<ProviderPaymentResult> {
    try {
      const intent = await retrieveStripePaymentIntent(providerObjectId);
      return {
        providerObjectId: intent.id,
        status: statusOf(intent, 'created'),
        clientAction: {
          kind: 'client_secret',
          value: requireClientSecret(intent, 'createPayment'),
        },
      };
    } catch (error: unknown) {
      throw toProviderError(error, 'createPayment');
    }
  }

  /** Not a step this rail has — see this file's docblock. */
  authorize(_request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    return Promise.reject(
      unsupported(
        'authorize',
        'Stripe payments are authorized by the buyer, client-side, against the client secret. ' +
          'There is no server-side authorization step and Mercaria never handles a payment method.',
      ),
    );
  }

  /** Not a step this rail has — ADR 0001 D3 captures immediately. */
  capture(_request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    return Promise.reject(
      unsupported(
        'capture',
        'Stripe payments capture automatically on confirmation (ADR 0001 D3), so there is no ' +
          'separate capture. Read the payment with getStatus instead.',
      ),
    );
  }

  /**
   * Cancel an intent that will never be paid.
   *
   * Stripe refuses to cancel an already-captured intent, and that refusal is
   * information rather than an obstacle: it means the money arrived after
   * Mercaria gave up, which is precisely the condition the late-success
   * exception path exists for. So this surfaces the error rather than
   * swallowing it, and the sweep decides what to do about it.
   */
  async cancel(request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    try {
      const intent = await cancelStripePaymentIntent(
        request.providerObjectId,
        request.idempotencyKey,
      );
      return { providerObjectId: intent.id, status: statusOf(intent, 'canceled') };
    } catch (error: unknown) {
      throw toProviderError(error, 'cancel');
    }
  }

  /** #49's, together with the transfer reversal — see this file's docblock. */
  refund(_request: RefundRequest): Promise<ProviderRefundResult> {
    return Promise.reject(
      unsupported(
        'refund',
        'Refunding a Stripe payment lands in #49, with the transfer reversal that must accompany ' +
          'it: a buyer refund without the seller-side reversal pays a seller for returned goods.',
      ),
    );
  }

  async getStatus(providerObjectId: string): Promise<ProviderPaymentResult> {
    try {
      const intent = await retrieveStripePaymentIntent(providerObjectId);
      return { providerObjectId: intent.id, status: statusOf(intent, 'created') };
    } catch (error: unknown) {
      throw toProviderError(error, 'getStatus');
    }
  }

  /**
   * One seller order's share, moved onto their connected account — ADR 0001 D3.
   *
   * `source_transaction` is the charge, which makes Stripe hold the movement
   * until those funds settle rather than failing it against a platform balance
   * that has not landed. The charge is resolved HERE, from the PaymentIntent,
   * rather than being carried through the domain: "which charge funded this
   * payment" is a Stripe question, and a `chargeId` on a provider-neutral
   * request would be the first Stripe noun to cross the seam.
   */
  async createTransfer(request: CreateTransferRequest): Promise<ProviderTransferResult> {
    try {
      const chargeId = await this.resolveChargeId(request.sourcePaymentObjectId);
      const transfer = await createStripeTransfer(
        {
          amount: request.amount.amount,
          currency: toStripeCurrency(request.amount.currency),
          destination: request.destinationAccountId,
          source_transaction: chargeId,
          transfer_group: request.groupRef,
          metadata: { ...request.metadata },
        },
        request.idempotencyKey,
      );

      // A Stripe transfer has no status of its own: the object exists, so the
      // funds reached the connected account's balance. Reversals move it
      // afterwards, and the ingress keeps the row current from `transfer.*`.
      return { providerObjectId: transfer.id, status: 'paid' };
    } catch (error: unknown) {
      throw toProviderError(error, 'transfer');
    }
  }

  /**
   * The charge a PaymentIntent produced.
   *
   * A successful intent always has one. Its absence means this settlement is
   * running against an intent that never captured, and creating a transfer for
   * it would move money Mercaria has not received — so it fails, non-retryably,
   * rather than falling back to a transfer with no source.
   */
  private async resolveChargeId(paymentIntentId: string): Promise<string> {
    const intent = await retrieveStripePaymentIntent(paymentIntentId);
    const latest: unknown = intent.latest_charge;
    const chargeId =
      typeof latest === 'string'
        ? latest
        : typeof latest === 'object' && latest !== null && 'id' in latest
          ? String((latest as { id: unknown }).id)
          : undefined;
    if (chargeId === undefined || chargeId === '') {
      throw new PaymentProviderError({
        provider: 'stripe',
        stage: 'transfer',
        message: `Stripe PaymentIntent ${paymentIntentId} has no charge; it has not captured.`,
        retryable: false,
        code: 'missing_charge',
      });
    }
    return chargeId;
  }

  /**
   * Verify a signed delivery.
   *
   * The SAME verification the webhook ingress runs — `verify.ts` is the trust
   * boundary and this delegates straight into it, so a signature accepted here
   * is accepted there and there is no second implementation to drift.
   *
   * Platform scope, because that is the endpoint every payment event arrives at
   * (`event-scopes.ts`); connect-scope deliveries are about seller accounts and
   * reach `syncAccountState`, not a payment. Verifying against both secrets
   * "just in case" would blur the scope split the dedupe key depends on.
   *
   * The payload is re-encoded to bytes rather than being handed over as a
   * string: the signature covers bytes. UTF-8 round-trips a Stripe body exactly,
   * and the ingress — which has the original buffer — is the path production
   * actually takes.
   */
  async verifyEvent(input: ProviderEventInput): Promise<ProviderEventEnvelope> {
    const event = await verifyStripeEvent({
      payload: Buffer.from(input.payload, 'utf8'),
      signature: input.signature,
      scope: 'platform',
    });
    return toProviderEventEnvelope(event);
  }
}
