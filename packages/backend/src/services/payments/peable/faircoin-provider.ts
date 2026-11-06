/**
 * The Peable FAIRCOIN rail (ADR 0019): a payment on behalf of ONE seller, paid
 * by the buyer's wallet straight into the Peable wallet of the seller's own Oxy
 * account (Peable ADR 0012 D5, ADR 0021 D5).
 *
 * ## What this rail is, and what it is not
 *
 * Mercaria creates the PaymentIntent and records its outcome, and that is all
 * it does with the money. The coins never reach a platform balance, so:
 *
 *  - it books NO ledger entries (`PROVIDER_BOOKS_LEDGER.peable_faircoin`);
 *  - it is NOT a `SettlingPaymentProvider`: there is no transfer to make, the
 *    seller already holds the money, and `settlePaymentTransfers` returns
 *    without one;
 *  - it cannot refund. Peable never held the coins and refuses a FairCoin
 *    refund; returning them is a payment from the seller's wallet to the buyer
 *    (Peable ADR 0012 D10), so a refund of a FairCoin order is recorded where it
 *    is decided and moves no money here — the `external` shape;
 *  - it carries no marketplace fee (Peable ADR 0021 D6, Mercaria ADR 0018).
 *
 * ## The amount is FAIR, never a quote
 *
 * A checkout reaches this rail only when its presentment currency IS `FAIR`
 * (`railForCurrency`), so the amount is the orders' own FAIR total in base
 * units (10⁻⁸ ⊜, Mercaria's FAIR minor unit) and there is no conversion in
 * this file at all. Peable's fiat-order quote is a Checkout Session feature and
 * not one a raw PaymentIntent has.
 *
 * ## Refusals the buyer must SEE
 *
 * Peable answers a payment it cannot take with a closed code —
 * `faircoin_wallet_missing`, `faircoin_network_closed`, `account_not_ready` —
 * carried on the {@link PaymentProviderError} so checkout can say why in words
 * (ADR 0019 D4). Nothing here retries one or falls back to the card rail.
 */

import type { CheckoutFaircoinInstruction } from '@mercaria/shared-types';
import type { PaymentIntent, Peable } from '@peable.to/sdk';
import { PaymentProviderError } from '../provider.js';
import type {
  CreatePaymentRequest,
  PaymentOperationRequest,
  PaymentProvider,
  PaymentProviderStage,
  ProviderEventEnvelope,
  ProviderEventInput,
  ProviderPaymentResult,
  ProviderRefundResult,
  RefundRequest,
  ResumablePaymentProvider,
} from '../provider.js';
import { fromGatewayAmount, toGatewayAmount } from './amounts.js';
import { createPeableClient } from './client.js';
import { callPeable } from './errors.js';
import { toPaymentStatus } from './peable-provider.js';
import { verifyPeableSignature } from './verify.js';

function refuse(stage: PaymentProviderStage, message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'peable_faircoin',
    stage,
    message,
    // Structural: an operation this rail does not HAVE is never transient.
    retryable: false,
  });
}

/**
 * The payer's instruction, while the intent still asks for the coins.
 *
 * Read from `next_action.faircoin_payment`, which Peable sets exactly while the
 * FairCoin intent is `requires_action`. Its amount is re-read through the one
 * amount converter, so a value the gateway sent that is not a safe integer of
 * base units refuses rather than rounds.
 */
function instructionOf(
  intent: PaymentIntent,
  stage: PaymentProviderStage,
): CheckoutFaircoinInstruction | undefined {
  const action = intent.next_action;
  if (action?.type !== 'faircoin_payment') return undefined;
  const payment = action.faircoin_payment;
  return {
    address: payment.address,
    network: payment.network,
    amount: { amount: fromGatewayAmount(payment.amount, stage), currency: 'FAIR' },
    uri: payment.uri,
  };
}

function toResult(intent: PaymentIntent, stage: PaymentProviderStage): ProviderPaymentResult {
  const faircoin = instructionOf(intent, stage);
  return {
    providerObjectId: intent.id,
    status: toPaymentStatus(intent, stage),
    // The PAYER's capability over the intent: Peable's hosted pay page
    // (`/i/:id#client_secret=…`) and the Peable wallet's `submit_tx` take it.
    // Present while the coins are still owed, and only then.
    ...(faircoin ? { clientAction: { kind: 'client_secret', value: intent.client_secret } } : {}),
    ...(faircoin ? { faircoin } : {}),
  };
}

export class PeableFaircoinPaymentProvider implements PaymentProvider, ResumablePaymentProvider {
  readonly id = 'peable_faircoin' as const;
  private readonly client: Peable;
  constructor(client: Peable = createPeableClient()) {
    this.client = client;
  }

  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    if (request.amount.currency !== 'FAIR') {
      throw refuse('createPayment', 'A FairCoin payment is denominated in FAIR.');
    }
    const seller = request.onBehalfOf;
    if (!seller) {
      // Mercaria's own FairCoin would go to the Peable wallet of the account that
      // owns ITS application, which is not who sold the goods. A marketplace
      // FairCoin payment always names the seller.
      throw refuse('createPayment', 'A marketplace FairCoin payment names the seller it pays.');
    }
    const intent = await callPeable(
      'createPayment',
      () =>
        this.client.paymentIntents.create(
          {
            rail: 'faircoin',
            amount: toGatewayAmount(request.amount, 'createPayment'),
            currency: 'FAIR',
            network: seller.network,
            connected_account: seller.providerAccountId,
            ...(request.expiresInSeconds !== undefined
              ? { expires_in_seconds: request.expiresInSeconds }
              : {}),
            metadata: {
              ...request.metadata,
              mercaria_payment_id: request.paymentId,
              mercaria_checkout_group_id: request.checkoutGroupId,
            },
          },
          { idempotencyKey: request.idempotencyKey },
        ),
      'peable_faircoin',
    );
    if (intent.rail !== 'faircoin') {
      throw refuse('createPayment', 'The gateway answered a payment on another rail.');
    }
    return toResult(intent, 'createPayment');
  }

  /** Not a step this rail has: the buyer's wallet pays, and Peable watches the chain. */
  authorize(_request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    return Promise.reject(
      refuse('authorize', 'A FairCoin payment is authorized by the payer broadcasting it.'),
    );
  }

  /** Not a step this rail has: a FairCoin payment is final once confirmed. */
  capture(_request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    return Promise.reject(refuse('capture', 'A FairCoin payment has nothing to capture.'));
  }

  async cancel(request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    const intent = await callPeable(
      'cancel',
      () =>
        this.client.paymentIntents.cancel(
          request.providerObjectId,
          { cancellation_reason: 'abandoned' },
          { idempotencyKey: request.idempotencyKey },
        ),
      'peable_faircoin',
    );
    return toResult(intent, 'getStatus');
  }

  /** Never: the coins are the seller's. See this file's docblock. */
  refund(_request: RefundRequest): Promise<ProviderRefundResult> {
    return Promise.reject(
      refuse(
        'refund',
        'A FairCoin payment cannot be refunded through Peable: the coins are in the ' +
          "seller's own wallet, and only the seller can send them back.",
      ),
    );
  }

  async getStatus(providerObjectId: string): Promise<ProviderPaymentResult> {
    const intent = await callPeable(
      'getStatus',
      () => this.client.paymentIntents.retrieve(providerObjectId),
      'peable_faircoin',
    );
    return toResult(intent, 'getStatus');
  }

  /** A buyer returning to an unpaid FairCoin checkout is shown the SAME address. */
  async resumePayment(providerObjectId: string): Promise<ProviderPaymentResult> {
    return this.getStatus(providerObjectId);
  }

  /** One endpoint and one secret for both of Peable's rails. */
  async verifyEvent(input: ProviderEventInput): Promise<ProviderEventEnvelope> {
    return verifyPeableSignature(input);
  }
}
