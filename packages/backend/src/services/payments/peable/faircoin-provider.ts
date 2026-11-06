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
 * ## Two payer objects: a FAIR intent, or a FairCoin-only fiat session
 *
 * A `FAIR`-priced checkout is ONE on-behalf PaymentIntent in FAIR base units
 * (10⁻⁸ ⊜, Mercaria's FAIR minor unit): no conversion anywhere.
 *
 * A fiat-priced checkout the buyer chose to pay in FairCoin (Mercaria ADR 0020)
 * is a FairCoin-only Peable Checkout Session (`payment_method_types:
 * ['faircoin']`, `connected_account` = the seller, Peable ADR 0021 D1/D5): the
 * order's total as one line in its own currency. Peable quotes it in FAIR when
 * the payer confirms (10 minutes, D4) and creates the on-behalf FairCoin intent
 * itself, so Mercaria never computes or stores a rate. That intent carries no
 * Mercaria metadata (Peable creates it), so the SESSION is Mercaria's provider
 * object (`cs_…`): its metadata names the payment, its `checkout.session.*`
 * events and its read decide the status ({@link sessionStatus}). A session is
 * never created without the seller — a marketplace sale must never pay the
 * Peable wallet of the account that owns Mercaria's own application.
 *
 * ## Refusals the buyer must SEE
 *
 * Peable answers a payment it cannot take with a closed code —
 * `faircoin_wallet_missing`, `faircoin_network_closed`, `account_not_ready` —
 * carried on the {@link PaymentProviderError} so checkout can say why in words
 * (ADR 0019 D4). Nothing here retries one or falls back to the card rail.
 */

import type { CheckoutFaircoinInstruction, PaymentStatus } from '@mercaria/shared-types';
import {
  type CheckoutSession,
  FIAT_CURRENCY_CODES,
  type FiatCurrencyCode,
  type PaymentIntent,
  type Peable,
} from '@peable.to/sdk';
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

/**
 * Whether a FairCoin payment's provider object is a Checkout Session (`cs_…`,
 * a fiat order paid in FairCoin) rather than a PaymentIntent (`pi_…`).
 */
export function isFaircoinSessionObject(providerObjectId: string): boolean {
  return providerObjectId.startsWith('cs_');
}

/**
 * Peable's floor on a session's lifetime (30 minutes). A session outlives the
 * reservation; the reservation sweep expires it when it releases the orders, as
 * it cancels an unpaid FAIR intent, and keeps a group whose payment is moving.
 */
const SESSION_MIN_LIFETIME_SECONDS = 30 * 60;

/**
 * Where a FairCoin-only session's payment stands, in Mercaria's vocabulary —
 * the session's state first, because the session IS the order and outlives its
 * quoted intents (a lapsed quote cancels the intent and leaves the session open
 * for a fresh one, Peable ADR 0021 D3):
 *
 *  - `expired` → `canceled`;
 *  - `complete` + `paid` → `succeeded` (the coins confirmed: money received);
 *  - `complete` + `unpaid` → the intent's own state: `processing` while the
 *    broadcast confirms, `canceled` once it underpaid
 *    (`async_payment_failed`);
 *  - `open` → `requires_action` while a live quoted intent awaits the coins,
 *    `created` otherwise.
 */
export function sessionStatus(
  session: CheckoutSession,
  stage: PaymentProviderStage,
): PaymentStatus {
  const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
  if (session.status === 'expired') return 'canceled';
  if (session.status === 'complete') {
    if (session.payment_status === 'paid') return 'succeeded';
    if (intent?.status === 'canceled') return 'canceled';
    return 'processing';
  }
  if (intent && intent.status !== 'canceled') {
    const status = toPaymentStatus(intent, stage);
    return status === 'requires_action' || status === 'processing' ? status : 'created';
  }
  return 'created';
}

function sessionResult(
  session: CheckoutSession,
  stage: PaymentProviderStage,
): ProviderPaymentResult {
  const status = sessionStatus(session, stage);
  // The payer's capability over the SESSION (`cs_…_secret_…`): Peable's sheet
  // and hosted page take it, and the payer confirms FairCoin through it. Only
  // while the order can still be paid.
  const payable = session.status === 'open' && session.client_secret !== null;
  return {
    providerObjectId: session.id,
    status,
    ...(payable && session.client_secret
      ? { clientAction: { kind: 'client_secret', value: session.client_secret } }
      : {}),
  };
}

export class PeableFaircoinPaymentProvider implements PaymentProvider, ResumablePaymentProvider {
  readonly id = 'peable_faircoin' as const;
  private readonly client: Peable;
  constructor(client: Peable = createPeableClient()) {
    this.client = client;
  }

  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    const seller = request.onBehalfOf;
    if (!seller) {
      // Mercaria's own FairCoin would go to the Peable wallet of the account that
      // owns ITS application, which is not who sold the goods. A marketplace
      // FairCoin payment always names the seller.
      throw refuse('createPayment', 'A marketplace FairCoin payment names the seller it pays.');
    }
    if (request.amount.currency !== 'FAIR') return this.createQuotedSession(request, seller);
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

  /**
   * A fiat order paid in FairCoin: one FairCoin-only session on behalf of the
   * seller, in the order's own currency (see this file's docblock).
   */
  private async createQuotedSession(
    request: CreatePaymentRequest,
    seller: NonNullable<CreatePaymentRequest['onBehalfOf']>,
  ): Promise<ProviderPaymentResult> {
    const currency = request.amount.currency;
    if (!(FIAT_CURRENCY_CODES as readonly string[]).includes(currency)) {
      throw refuse('createPayment', 'Peable cannot quote this currency in FAIR.');
    }
    const lifetime = Math.max(SESSION_MIN_LIFETIME_SECONDS, request.expiresInSeconds ?? 0);
    const session = await callPeable(
      'createPayment',
      () =>
        this.client.checkout.sessions.create(
          {
            mode: 'payment',
            // Paid in Peable's sheet inside the storefront, never on a redirect.
            ui_mode: 'embedded',
            line_items: [
              {
                price_data: {
                  currency: currency as FiatCurrencyCode,
                  unit_amount: toGatewayAmount(request.amount, 'createPayment'),
                  product_data: { name: request.description ?? 'Mercaria order' },
                },
                quantity: 1,
              },
            ],
            // FairCoin only: the fiat methods are Mercaria's to leave out, and
            // the buyer chose FairCoin (Peable ADR 0021 D1).
            payment_method_types: ['faircoin'],
            connected_account: seller.providerAccountId,
            client_reference_id: request.paymentId,
            expires_at: Math.floor(Date.now() / 1_000) + lifetime,
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
    const payee = session.connected_account;
    const payeeId = typeof payee === 'string' ? payee : payee?.id;
    if (
      payeeId !== seller.providerAccountId ||
      session.payment_method_types.length !== 1 ||
      session.payment_method_types[0] !== 'faircoin'
    ) {
      throw refuse(
        'createPayment',
        'The gateway answered a session that does not pay this seller in FairCoin.',
      );
    }
    return sessionResult(session, 'createPayment');
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
    if (isFaircoinSessionObject(request.providerObjectId)) {
      // Expiring the session cancels its open quoted intent with it; Peable
      // refuses once the payer's transaction is reported, which is the
      // "the payer got there first" answer the sweep already handles.
      const session = await callPeable(
        'cancel',
        () =>
          this.client.checkout.sessions.expire(
            request.providerObjectId,
            { expand: ['payment_intent'] },
            { idempotencyKey: request.idempotencyKey },
          ),
        'peable_faircoin',
      );
      return sessionResult(session, 'getStatus');
    }
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
    if (isFaircoinSessionObject(providerObjectId)) {
      const session = await callPeable(
        'getStatus',
        () =>
          this.client.checkout.sessions.retrieve(providerObjectId, { expand: ['payment_intent'] }),
        'peable_faircoin',
      );
      return sessionResult(session, 'getStatus');
    }
    const intent = await callPeable(
      'getStatus',
      () => this.client.paymentIntents.retrieve(providerObjectId),
      'peable_faircoin',
    );
    return toResult(intent, 'getStatus');
  }

  /**
   * A buyer returning to an unpaid FairCoin checkout is shown the SAME address
   * (a FAIR intent) or the SAME session (a fiat order, quoted again if its
   * last quote lapsed).
   */
  async resumePayment(providerObjectId: string): Promise<ProviderPaymentResult> {
    return this.getStatus(providerObjectId);
  }

  /** One endpoint and one secret for both of Peable's rails. */
  async verifyEvent(input: ProviderEventInput): Promise<ProviderEventEnvelope> {
    return verifyPeableSignature(input);
  }
}
