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
 * `authorize` and `capture` both THROW, exactly as the Stripe adapter next door
 * does and for the same two reasons. My first version returned a read from
 * both, which is the mistake that file's own docblock names: it reports success
 * for an operation that did nothing, so a caller that genuinely needed a
 * capture would never learn it had not happened. The contract suite caught it.
 *
 *  - **Capture is immediate** (ADR 0001 D3, inherited by ADR 0009). The gateway
 *    captures on the buyer's confirmation, so there is no second step to take.
 *  - **Authorization is the buyer's**, performed client-side against the
 *    gateway's client secret with a payment method Mercaria never sees.
 */

import type { Money, PaymentStatus, TransferStatus } from '@mercaria/shared-types';
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
import { peableRequest } from './client.js';
import { verifyPeableSignature } from './verify.js';

/** The gateway's payment-intent shape, narrowed to what this adapter reads. */
interface GatewayIntent {
  readonly id: string;
  readonly status: string;
  readonly amount: string;
  readonly currency: string;
  readonly client_action?: { readonly kind: string; readonly value: string };
}

interface GatewayTransfer {
  readonly id: string;
  readonly status: string;
  readonly amountReversed: string;
}

/**
 * The gateway's payment statuses, mapped onto Mercaria's.
 *
 * TOTAL over the gateway's set rather than a lookup with a fallback: an
 * unmapped status silently becoming `processing` is how a settled payment stays
 * unpaid, and the compiler cannot see a missing key in a partial record. A
 * status the gateway adds later fails HERE, loudly, rather than downstream.
 */
function toPaymentStatus(status: string, stage: PaymentProviderStage): PaymentStatus {
  switch (status) {
    // `created` is `created`, NOT `processing`, and the two are not
    // interchangeable: `processing` means a charge is in flight at the acquirer,
    // and reporting it for a payment the buyer has not even been shown a form
    // for would make every abandoned checkout look like money on its way.
    case 'created':
      return 'created';
    // The SCA challenge, kept distinct because the checkout has a screen for it.
    case 'requires_action':
      return 'requires_action';
    case 'processing':
      return 'processing';
    case 'settled':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'rejected':
    case 'expired':
      return 'canceled';
    case 'refunded':
      return 'refunded';
    case 'partially_refunded':
      return 'partially_refunded';
    default:
      throw new PaymentProviderError({
        provider: 'peable',
        stage,
        message: `the Peable gateway reported an unmapped status '${status}'`,
        // PERMANENT: the same request returns the same unmapped status forever.
        // A retry would spin, and the fix is a code change here.
        retryable: false,
      });
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

/** The gateway's transfer statuses, mapped onto Mercaria's. Total, as above. */
function toTransferStatus(status: string): TransferStatus {
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
    default:
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'transfer',
        message: `the Peable gateway reported an unmapped transfer status '${status}'`,
        retryable: false,
      });
  }
}

function toResult(intent: GatewayIntent, stage: PaymentProviderStage): ProviderPaymentResult {
  return {
    providerObjectId: intent.id,
    status: toPaymentStatus(intent.status, stage),
    ...(intent.client_action?.kind === 'client_secret' || intent.client_action?.kind === 'redirect'
      ? { clientAction: { kind: intent.client_action.kind, value: intent.client_action.value } }
      : {}),
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

  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    const intent = await peableRequest<GatewayIntent>({
      method: 'POST',
      path: '/v1/payment_intents',
      stage: 'createPayment',
      idempotencyKey: request.idempotencyKey,
      body: {
        rail: 'card',
        amount: toGatewayAmount(request.amount, 'createPayment'),
        currency: request.amount.currency,
        // Minimal, stable Mercaria ids and nothing else (#45 buyer boundaries
        // 7). The gateway forwards none of this to its own provider, but a
        // metadata bag is readable by everyone with gateway access all the same.
        metadata: {
          ...request.metadata,
          mercaria_payment_id: request.paymentId,
          mercaria_checkout_group_id: request.checkoutGroupId,
        },
      },
    });
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
    const intent = await peableRequest<GatewayIntent>({
      method: 'POST',
      path: `/v1/payment_intents/${encodeURIComponent(request.providerObjectId)}/reject`,
      stage: 'cancel',
      idempotencyKey: request.idempotencyKey,
    });
    return toResult(intent, 'getStatus');
  }

  async refund(request: RefundRequest): Promise<ProviderRefundResult> {
    const refund = await peableRequest<{
      readonly id: string;
      readonly status: string;
      readonly paymentStatus: string;
      readonly failureCode: string | null;
    }>({
      method: 'POST',
      path: '/v1/refunds',
      stage: 'refund',
      idempotencyKey: request.idempotencyKey,
      body: {
        paymentIntentId: request.providerObjectId,
        // Mercaria's refund id IS the idempotency, durably. Unlike a header key
        // it cannot be lost, and a duplicate refund is the one failure here
        // that nothing reverses and the payer has no reason to report.
        externalRef: request.refundId,
        amount: toGatewayAmount(request.amount, 'refund'),
      },
    });

    return {
      providerObjectId: refund.id,
      // The PAYMENT's status after this refund, which the gateway returns on the
      // refund itself. Re-reading the intent for it would be a second round
      // trip whose answer can have moved on by the time it arrives.
      status: toPaymentStatus(refund.paymentStatus, 'getStatus'),
      // The REFUND's own lifecycle, which is a different question. A gateway
      // status this adapter does not recognise becomes `pending` rather than
      // `succeeded`: reporting money returned that has not moved is the
      // direction that cannot be walked back.
      state:
        refund.status === 'succeeded'
          ? 'succeeded'
          : refund.status === 'failed'
            ? 'failed'
            : 'pending',
      ...(refund.failureCode === null ? {} : { failureCode: refund.failureCode }),
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
    const intent = await peableRequest<GatewayIntent>({
      method: 'GET',
      path: `/v1/payment_intents/${encodeURIComponent(providerObjectId)}`,
      stage,
    });
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
    const transfer = await peableRequest<GatewayTransfer>({
      method: 'POST',
      path: '/v1/transfers',
      stage: 'transfer',
      idempotencyKey: request.idempotencyKey,
      body: {
        paymentIntentId: request.sourcePaymentObjectId,
        // The seller's account at the GATEWAY (`ca_…`), which is what
        // `provider_accounts.provider_account_id` holds on this rail. Mercaria
        // never learns the acquirer's own id and must not: ADR 0009 D15.
        connectedAccountId: request.destinationAccountId,
        // Mercaria's order id IS the idempotency, durably. Unlike a header key
        // it cannot be lost, so a retried settlement converges on the transfer
        // that already paid this seller rather than paying them twice.
        externalRef: request.orderId,
        amount: toGatewayAmount(request.amount, 'transfer'),
      },
    });
    return { providerObjectId: transfer.id, status: toTransferStatus(transfer.status) };
  }

  async reverseTransfer(
    request: ReverseTransferRequest,
  ): Promise<ProviderTransferReversalResult> {
    const transfer = await peableRequest<GatewayTransfer>({
      method: 'POST',
      path: `/v1/transfers/${encodeURIComponent(request.transferObjectId)}/reversals`,
      stage: 'transfer',
      idempotencyKey: request.idempotencyKey,
      body: { amount: toGatewayAmount(request.amount, 'transfer') },
    });

    // The CUMULATIVE total, read off the transfer — never this leg. A caller
    // deciding whether a transfer is fully reversed must not have to add up
    // legs it may not all have seen, and reporting this one would make a second
    // partial reversal look like the first.
    const total = Number(transfer.amountReversed);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: 'transfer',
        message: `the gateway reported an unusable reversed total '${transfer.amountReversed}'`,
        retryable: false,
      });
    }
    return { providerObjectId: transfer.id, totalReversedMinor: total };
  }
}
