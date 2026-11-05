/**
 * The Peable rail (ADR 0009 D13).
 *
 * Mercaria's card payments go through the Oxy gateway rather than to Stripe
 * directly. Everything that makes Mercaria a marketplace stays here — the
 * split, the fee snapshot, the ledger, readiness, reconciliation (D14) — and
 * this adapter does one thing: it turns a `PaymentProvider` call into a gateway
 * request and a gateway answer back into Mercaria's vocabulary.
 *
 * ## Peable is never asked to split anything
 *
 * A transfer carries an amount Mercaria computed. The gateway does not know
 * what a marketplace fee is and must not learn — ADR 0001 insists the split has
 * exactly one definition, and a gateway that computed it would be a second.
 *
 * ## Money crosses the boundary as a canonical integer STRING
 *
 * Mercaria's `Money.amount` is a JS `number` of minor units; the gateway's
 * contract is a `string`, because it works in unbounded `bigint`. The
 * conversion happens at this boundary and nowhere else, and it REFUSES anything
 * that is not a safe non-negative integer rather than rounding — an amount that
 * silently loses precision here is a charge nobody authorised.
 *
 * ## What this rail cannot do, and says so out loud
 *
 * `authorize` and `capture` both THROW, for two reasons. Returning a read from
 * either would report success for an operation that did nothing, so a caller
 * that genuinely needed a capture would never learn it had not happened. The
 * contract suite pins it.
 *
 *  - **Capture is immediate** (ADR 0001 D3, inherited by ADR 0009). The gateway
 *    captures on the buyer's confirmation, so there is no second step to take.
 *  - **Authorization is the buyer's**, performed client-side against the
 *    gateway's client secret with a payment method Mercaria never sees.
 */

import type { CurrencyCode, Money, PaymentStatus, TransferStatus } from '@mercaria/shared-types';
import {
  FIAT_CURRENCY_CODES,
  type FiatCurrencyCode,
  type PaymentIntent,
  type PaymentIntentStatus,
  type Peable,
  PeableError,
} from '@peable.to/sdk';
import { PaymentProviderError } from '../provider.js';
import type {
  CreatePaymentRequest,
  PaymentProviderStage,
  CreateTransferRequest,
  PaymentOperationRequest,
  PaymentProvider,
  ProviderEventEnvelope,
  ProviderEventInput,
  ProviderPaymentResult,
  ProviderRefundResult,
  ProviderTransferResult,
  ProviderTransferReversalResult,
  RefundRequest,
  ResumablePaymentProvider,
  ReverseTransferRequest,
  SettlingPaymentProvider,
} from '../provider.js';
import { createPeableClient } from './client.js';
import { verifyPeableSignature } from './verify.js';

/** The gateway's transfer statuses, as the wire contract closes them. */
type GatewayTransferStatus = Awaited<ReturnType<Peable['transfers']['create']>>['status'];

/** A status this adapter has no Mercaria word for: permanent, and loud. */
function unmapped(stage: PaymentProviderStage, what: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'peable',
    stage,
    message: `the Peable gateway reported an unmapped ${what}`,
    // PERMANENT: the same request returns the same unmapped status forever.
    // A retry would spin, and the fix is a code change here.
    retryable: false,
  });
}

/**
 * Where a `succeeded` payment stands once refunds are counted.
 *
 * The gateway's PaymentIntent stays `succeeded` for life (ADR 0019): money
 * coming back is `amount_refunded` — the sum of SUCCEEDED refunds — beside the
 * `amount_received` it is measured against. Compared as `bigint`, because both
 * are unbounded canonical integer strings.
 */
function refundedStatus(intent: PaymentIntent): PaymentStatus {
  const refunded = BigInt(intent.amount_refunded);
  if (refunded === 0n) return 'succeeded';
  return refunded >= BigInt(intent.amount_received) ? 'refunded' : 'partially_refunded';
}

/**
 * The gateway's PaymentIntent, mapped onto Mercaria's payment status.
 *
 * TOTAL over the contract's status set — a status the gateway adds later is a
 * compile error here rather than a settled payment that stays unpaid.
 */
function toPaymentStatus(intent: PaymentIntent, stage: PaymentProviderStage): PaymentStatus {
  const status: PaymentIntentStatus = intent.status;
  switch (status) {
    // A card intent waits for its payment method twice: before the buyer has
    // been shown a form (`created`, NOT `processing` — that would make every
    // abandoned checkout look like money on its way), and after a declined
    // attempt, which returns it here with `last_payment_error` set. The second
    // is Mercaria's `failed`, which the buyer can still recover from.
    case 'requires_payment_method':
      return intent.last_payment_error ? 'failed' : 'created';
    case 'requires_confirmation':
      return 'created';
    // The SCA challenge, kept distinct because the checkout has a screen for it.
    case 'requires_action':
      return 'requires_action';
    case 'processing':
      return 'processing';
    case 'succeeded':
      return refundedStatus(intent);
    case 'canceled':
      return 'canceled';
    // ADR 0001 D3 captures immediately, so a held authorization is a
    // configuration mistake this code must not paper over with a status.
    case 'requires_capture':
      throw unmapped(stage, `status '${status}'`);
    default: {
      const exhaustive: never = status;
      throw unmapped(stage, `status '${String(exhaustive)}'`);
    }
  }
}

/**
 * A `Money` as the gateway's canonical integer string.
 *
 * Refuses rather than rounds. `Money.amount` is a `number`, and above
 * `Number.MAX_SAFE_INTEGER` — reachable in a minor-unit currency — the value is
 * already wrong before it gets here; sending it would charge an amount nobody
 * authorised. Refused as PERMANENT, because no retry makes a number
 * representable.
 */
function toGatewayAmount(money: Money, stage: PaymentProviderStage): string {
  if (!Number.isSafeInteger(money.amount) || money.amount < 0) {
    throw new PaymentProviderError({
      provider: 'peable',
      stage,
      message: `${String(money.amount)} is not a safe non-negative integer of minor units`,
      retryable: false,
    });
  }
  return String(money.amount);
}

/** The card rail charges fiat only; which fiat is the gateway's own vocabulary. */
function isCardCurrency(currency: CurrencyCode): currency is CurrencyCode & FiatCurrencyCode {
  return (FIAT_CURRENCY_CODES as readonly string[]).includes(currency);
}

/** The gateway's transfer statuses, mapped onto Mercaria's. Total, as above. */
function toTransferStatus(status: GatewayTransferStatus): TransferStatus {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'paid':
      return 'paid';
    case 'reversed':
    case 'partially_reversed':
      return 'reversed';
    case 'failed':
      return 'failed';
    default: {
      const exhaustive: never = status;
      throw unmapped('transfer', `transfer status '${String(exhaustive)}'`);
    }
  }
}

function toResult(intent: PaymentIntent, stage: PaymentProviderStage): ProviderPaymentResult {
  // Present only on a create's answer and a single merchant retrieve of a card
  // payment that can still be paid — never on a list or an event.
  const action = intent.client_action;
  return {
    providerObjectId: intent.id,
    status: toPaymentStatus(intent, stage),
    ...(action ? { clientAction: { kind: action.kind, value: action.value } } : {}),
  };
}

/**
 * A refusal for an operation this rail structurally does not have.
 *
 * Non-retryable, because an operation a rail does not HAVE is not a transient
 * condition and retrying one burns the outbox's attempts against a wall.
 */
function unsupported(stage: PaymentProviderStage, reason: string): PaymentProviderError {
  return new PaymentProviderError({ provider: 'peable', stage, message: reason, retryable: false });
}

export class PeablePaymentProvider
  implements PaymentProvider, SettlingPaymentProvider, ResumablePaymentProvider
{
  readonly id = 'peable' as const;
  private readonly client: Peable;
  constructor(client: Peable = createPeableClient()) {
    this.client = client;
  }
  private async call<T>(stage: PaymentProviderStage, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      const status = error instanceof PeableError ? error.statusCode : undefined;
      throw new PaymentProviderError({
        provider: 'peable',
        stage,
        message: 'The Peable operation failed; retry only with the original intent.',
        // A truncated error body keeps its known refusal status. A lost 2xx
        // body or transport without headers remains indeterminate/retryable.
        retryable:
          status === undefined || status < 400 || status >= 500 || status === 408 || status === 429,
      });
    }
  }

  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    const currency = request.amount.currency;
    if (!isCardCurrency(currency))
      throw unsupported('createPayment', 'Currency is not supported by the Peable card rail.');
    const intent = await this.call('createPayment', () =>
      this.client.paymentIntents.create(
        {
          rail: 'card',
          amount: toGatewayAmount(request.amount, 'createPayment'),
          currency,
          metadata: {
            ...request.metadata,
            mercaria_payment_id: request.paymentId,
            mercaria_checkout_group_id: request.checkoutGroupId,
          },
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );
    return toResult(intent, 'createPayment');
  }

  /** Not a step this rail has — see this file's docblock. */
  authorize(_request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    return Promise.reject(
      unsupported(
        'authorize',
        'Peable payments are authorized by the buyer, client-side, against the gateway client ' +
          'secret. There is no server-side authorization step and Mercaria never handles a ' +
          'payment method.',
      ),
    );
  }

  /** Not a step this rail has — ADR 0001 D3 captures immediately. */
  capture(_request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    return Promise.reject(
      unsupported(
        'capture',
        'Peable payments capture automatically on confirmation (ADR 0001 D3), so there is no ' +
          'separate capture. Read the payment with getStatus instead.',
      ),
    );
  }

  async cancel(request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    const intent = await this.call('cancel', () =>
      this.client.paymentIntents.cancel(
        request.providerObjectId,
        // The one caller is the reservation sweep giving up on a checkout the
        // buyer never completed — the gateway's own word for its expiry.
        { cancellation_reason: 'abandoned' },
        { idempotencyKey: request.idempotencyKey },
      ),
    );
    return toResult(intent, 'getStatus');
  }

  async refund(request: RefundRequest): Promise<ProviderRefundResult> {
    const refund = await this.call('refund', () =>
      this.client.refunds.create(
        {
          payment_intent: request.providerObjectId,
          external_ref: request.refundId,
          amount: toGatewayAmount(request.amount, 'refund'),
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );
    // Where the PAYMENT stands after this refund. Refunds are not intent
    // statuses (ADR 0019); the payment's refund budget is — `remaining_refundable`
    // counts pending refunds beside succeeded ones, so a full refund still in
    // flight already closes the payment.
    const refunds = await this.call('refund', () =>
      this.client.refunds.listForPaymentIntent(request.providerObjectId, { limit: 1 }),
    );

    return {
      providerObjectId: refund.id,
      status: refunds.remaining_refundable === '0' ? 'refunded' : 'partially_refunded',
      // The REFUND's own lifecycle, which is a different question. A status this
      // adapter does not recognise becomes `pending` rather than `succeeded`:
      // reporting money returned that has not moved is the direction that
      // cannot be walked back.
      state:
        refund.status === 'succeeded'
          ? 'succeeded'
          : refund.status === 'failed'
            ? 'failed'
            : refund.status === 'canceled'
              ? 'canceled'
              : 'pending',
      ...(refund.failure_code ? { failureCode: refund.failure_code } : {}),
    };
  }

  async getStatus(providerObjectId: string): Promise<ProviderPaymentResult> {
    return this.readIntent(providerObjectId, 'getStatus');
  }

  /** One read, under whichever stage the caller is serving. */
  private async readIntent(
    providerObjectId: string,
    stage: PaymentProviderStage,
  ): Promise<ProviderPaymentResult> {
    const intent = await this.call(stage, () =>
      this.client.paymentIntents.retrieve(providerObjectId),
    );
    return toResult(intent, stage);
  }

  /**
   * Re-read a payment Mercaria already created, client material and all.
   *
   * The whole point of `ResumablePaymentProvider`: a buyer returning to an
   * unpaid checkout the next day must be handed the payment that already funds
   * their orders, not a second one — and an idempotency key that has aged out
   * at the rail would produce exactly that second payment.
   */
  async resumePayment(providerObjectId: string): Promise<ProviderPaymentResult> {
    return this.readIntent(providerObjectId, 'getStatus');
  }

  async verifyEvent(input: ProviderEventInput): Promise<ProviderEventEnvelope> {
    return verifyPeableSignature(input);
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  async createTransfer(request: CreateTransferRequest): Promise<ProviderTransferResult> {
    const transfer = await this.call('transfer', () =>
      this.client.transfers.create(
        {
          payment_intent: request.sourcePaymentObjectId,
          connected_account: request.destinationAccountId,
          external_ref: request.orderId,
          amount: toGatewayAmount(request.amount, 'transfer'),
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );
    return { providerObjectId: transfer.id, status: toTransferStatus(transfer.status) };
  }

  async reverseTransfer(request: ReverseTransferRequest): Promise<ProviderTransferReversalResult> {
    const transfer = await this.call('transfer', () =>
      this.client.transfers.reverse(
        request.transferObjectId,
        {
          amount: toGatewayAmount(request.amount, 'transfer'),
          // The reversal's DURABLE identity. The caller's key is already one per
          // recovery (`trr:<refund>:<order>`, `trr:dispute:<dispute>:<order>`,
          // ADR 0001 D11), so it names this reversal at the gateway beyond the
          // 24-hour `Idempotency-Key` window — an amount is not an identity.
          external_ref: request.idempotencyKey,
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );

    // The CUMULATIVE total, read off the transfer — never this leg. A caller
    // deciding whether a transfer is fully reversed must not have to add up
    // legs it may not all have seen, and reporting this one would make a second
    // partial reversal look like the first.
    const total = Number(transfer.amount_reversed);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'transfer',
        message: `the gateway reported an unusable reversed total '${transfer.amount_reversed}'`,
        retryable: false,
      });
    }
    return { providerObjectId: transfer.reversal.id, totalReversedMinor: total };
  }
}
