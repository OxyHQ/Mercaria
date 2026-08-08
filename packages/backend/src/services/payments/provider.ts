/**
 * `PaymentProvider` — the seam every payment rail plugs into.
 *
 * ADR 0001's last consequence: "everything provider-specific stays behind the
 * #45 `PaymentProvider` interface". Stripe (#46–#48) and Faircoin (#51) are
 * adapters written against this file and nothing else. No type here names a
 * provider's vocabulary — there is no `PaymentIntent`, no `transfer_group`, no
 * `charge` — and the day one appears, this seam has failed.
 *
 * ## What the interface deliberately does NOT do
 *
 * It does not decide anything. It converts a Mercaria request into a provider
 * call and a provider answer back into Mercaria's own vocabulary. Persistence,
 * status transitions, ledger postings, order effects and the outbox all belong
 * to `payment.service`, which is the only thing that talks to an adapter — so
 * "what happens when a payment succeeds" is written ONCE and cannot drift
 * between rails.
 *
 * ## Idempotency comes IN, it is never invented here
 *
 * Every mutating method takes an `idempotencyKey` derived from Mercaria durable
 * ids (ADR 0001 D11 has the table: `pi:<paymentId>`, `tr:<paymentId>:<orderId>`,
 * `re:<refundId>`). An adapter that minted its own would make a retry a second
 * charge — which is the entire failure this interface's shape exists to prevent,
 * so the key is a required parameter rather than an option.
 *
 * ## `verifyEvent` is the trust boundary
 *
 * It is the ONLY method that takes untrusted input, and it either returns a
 * verified envelope or throws. A payment is never marked succeeded from anything
 * else (#45 invariant 6): a client callback is UX, a `return_url` proves
 * nothing, and a request body without a verified signature is a stranger's
 * opinion.
 */

import type {
  FxRateSnapshot,
  Money,
  PaymentProviderId,
  PaymentStatus,
} from '@mercaria/shared-types';

/**
 * The stages a payment can fail at — used by `getStatus`-style diagnostics and
 * by the contract suite's failure injection, which walks every one of them.
 */
export type PaymentProviderStage =
  | 'createPayment'
  | 'authorize'
  | 'capture'
  | 'cancel'
  | 'refund'
  | 'getStatus'
  | 'verifyEvent';

/**
 * A failure from a payment rail.
 *
 * `retryable` is the only thing the outbox dispatcher needs from an error, and
 * it means exactly one thing: could this same request, unchanged, ever succeed?
 * A network blip is retryable; a declined card and a malformed request are not,
 * because no number of attempts turns them into a payment. Anything that is not
 * a `PaymentProviderError` is treated as retryable, since assuming an unknown
 * defect is permanent is how a recoverable outage becomes an abandoned payment.
 */
export class PaymentProviderError extends Error {
  readonly provider: PaymentProviderId;
  readonly stage: PaymentProviderStage;
  readonly retryable: boolean;
  /** The provider's own machine-readable code, when it gave one. */
  readonly code?: string;

  constructor(input: {
    provider: PaymentProviderId;
    stage: PaymentProviderStage;
    message: string;
    retryable: boolean;
    code?: string;
  }) {
    super(input.message);
    this.name = 'PaymentProviderError';
    this.provider = input.provider;
    this.stage = input.stage;
    this.retryable = input.retryable;
    if (input.code !== undefined) this.code = input.code;
  }
}

/**
 * Whether trying the same request again could ever work.
 *
 * The same shape `isRetryableDeliveryError` uses for CrowdSource, and for the
 * same reason: the dispatcher must not have to know which library threw.
 */
export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof PaymentProviderError) return error.retryable;
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    const retryable: unknown = (error as { retryable: unknown }).retryable;
    if (typeof retryable === 'boolean') return retryable;
  }
  return true;
}

/**
 * What a buyer's client must do next, when the rail needs it to do anything.
 *
 * Opaque on purpose: `value` is whatever the rail's own SDK consumes (a client
 * secret, a redirect URL, a payment request payload). Mercaria never interprets
 * it and never stores it — it is handed to the client in the same response and
 * forgotten, so it cannot become a credential sitting in a database.
 */
export interface PaymentClientAction {
  kind: 'client_secret' | 'redirect';
  value: string;
}

/**
 * Create a payment at the provider for one checkout group.
 *
 * `metadata` carries only minimal, stable Mercaria ids for webhook
 * reconciliation (#45 buyer boundaries 7). Never an email, never a phone
 * number, never a guest or session token — a provider's metadata is readable by
 * everyone with dashboard access, and a raw contact value there is a disclosure
 * with no audit trail.
 */
export interface CreatePaymentRequest {
  /** Mercaria's own payment id — the basis of the provider idempotency key. */
  paymentId: string;
  checkoutGroupId: string;
  /** What the buyer is charged, in the presentment currency. */
  amount: Money;
  /** The seller orders this payment funds, for reconciliation metadata. */
  orderIds: readonly string[];
  idempotencyKey: string;
  metadata: Readonly<Record<string, string>>;
}

/**
 * The provider's answer, in Mercaria's vocabulary.
 *
 * `platform` is present only once the rail has actually converted the charge
 * into the platform's settlement currency (ADR 0001 D8) — it is one fact, an
 * amount AND the rate snapshot that produced it, so the two cannot be persisted
 * apart.
 */
export interface ProviderPaymentResult {
  providerObjectId: string;
  status: PaymentStatus;
  clientAction?: PaymentClientAction;
  platform?: { amount: Money; rate: FxRateSnapshot };
}

/** Act on a payment the provider already knows about. */
export interface PaymentOperationRequest {
  paymentId: string;
  providerObjectId: string;
  idempotencyKey: string;
}

/**
 * Refund part or all of a captured payment.
 *
 * `refundId` is Mercaria's refund record, and it is what the idempotency key is
 * derived from (`re:<refundId>`) — so a replayed refund submission converges on
 * the refund the provider already made rather than issuing a second one.
 */
export interface RefundRequest {
  paymentId: string;
  providerObjectId: string;
  refundId: string;
  amount: Money;
  idempotencyKey: string;
}

/** The provider's answer to a refund. */
export interface ProviderRefundResult {
  providerObjectId: string;
  /** Where the PAYMENT stands after it — `refunded` or `partially_refunded`. */
  status: PaymentStatus;
}

/** A signed, untrusted delivery from a provider, exactly as it arrived. */
export interface ProviderEventInput {
  /** The RAW body. Never a parsed object: a signature covers bytes, not a re-serialization. */
  payload: string;
  /** The signature header the provider sent. */
  signature: string;
}

/**
 * A verified inbound event, normalized.
 *
 * `payload` is the raw parsed body and is NOT what gets stored: the caller runs
 * it through `redactProviderPayload` first (#45 invariant 9). It is on the
 * envelope so a handler can read the fields it needs, not so it can be persisted
 * wholesale.
 */
export interface ProviderEventEnvelope {
  provider: PaymentProviderId;
  /** The connected account the event is scoped to; absent for platform scope. */
  providerAccountId?: string;
  providerEventId: string;
  type: string;
  livemode: boolean;
  apiVersion?: string;
  /** The provider object ids this event refers to, keyed by the provider's own names. */
  objectIds: Readonly<Record<string, string>>;
  /**
   * What this event says about the payment, already mapped. `undefined` when the
   * event is about something other than a payment's state (a payout, a transfer)
   * — the envelope still gets stored, because an event Mercaria cannot act on is
   * evidence rather than noise.
   */
  paymentStatus?: PaymentStatus;
  payload: unknown;
}

/**
 * One payment rail.
 *
 * Every method is async and every mutating one is idempotent given the same
 * `idempotencyKey`. An adapter that cannot honour that is not finished.
 */
export interface PaymentProvider {
  readonly id: PaymentProviderId;
  createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult>;
  /**
   * Move a created payment toward capture.
   *
   * Mercaria captures immediately (ADR 0001 D3 — card authorization windows are
   * shorter than realistic secondhand fulfilment), so for a card rail this and
   * `capture` collapse into one provider call. They stay separate methods
   * because a rail that genuinely holds funds — a Faircoin escrow — needs both,
   * and discovering that after the interface froze would be expensive.
   */
  authorize(request: PaymentOperationRequest): Promise<ProviderPaymentResult>;
  capture(request: PaymentOperationRequest): Promise<ProviderPaymentResult>;
  cancel(request: PaymentOperationRequest): Promise<ProviderPaymentResult>;
  refund(request: RefundRequest): Promise<ProviderRefundResult>;
  /**
   * Read the provider's current view. The reconciliation read (#50) — the answer
   * to "we think this is `processing`, what does the rail say?" — and the only
   * method with no idempotency key, because it changes nothing.
   */
  getStatus(providerObjectId: string): Promise<ProviderPaymentResult>;
  /**
   * Verify a signed delivery and normalize it.
   *
   * @throws {PaymentProviderError} with `retryable: false` when the signature
   *   does not verify. A bad signature is never a transient condition, and
   *   retrying one is how a forged event eventually gets a lucky window.
   */
  verifyEvent(input: ProviderEventInput): Promise<ProviderEventEnvelope>;
}
