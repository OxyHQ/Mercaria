/**
 * `SyntheticPaymentProvider` — a complete, deterministic, in-memory payment
 * rail.
 *
 * It is a real adapter, not a test double. It implements every method of
 * `PaymentProvider` with the same semantics a live rail must have — idempotent
 * mutations, signed events, a status a caller can read back — and it is what the
 * contract suite runs. That matters more than it sounds: a mock written for the
 * tests can only ever confirm the tests' own assumptions, whereas an adapter the
 * dev `mockPay` seam actually uses is exercised by every developer, every day,
 * against the same service code Stripe will run through.
 *
 * Its provider id is `mock`, which is what a payment made through it IS. The
 * class name says how it is built; the id says what it means.
 *
 * ## Deterministic, and specifically how
 *
 * Every provider object id is a hash of the Mercaria id that caused it, so the
 * same payment always yields the same `mock_pi_…` — a retry converges without
 * needing any stored state, which is exactly the property a real rail's
 * idempotency key buys and the one worth exercising. Nothing here reads a clock
 * for an id or calls `Math.random()`.
 *
 * ## Failure injection
 *
 * `setFailure(stage, error)` makes the next and every subsequent call at that
 * stage throw until it is cleared. It is on the adapter rather than in a test
 * helper so the contract suite can drive ANY provider that offers it, and so the
 * failure travels as a real `PaymentProviderError` with a real `retryable` flag
 * — the thing the outbox's backoff and dead-lettering actually branch on.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Money, PaymentStatus } from '@mercaria/shared-types';
import {
  PaymentProviderError,
  type CreatePaymentRequest,
  type PaymentOperationRequest,
  type PaymentProvider,
  type PaymentProviderStage,
  type ProviderEventEnvelope,
  type ProviderEventInput,
  type ProviderPaymentResult,
  type ProviderRefundResult,
  type RefundRequest,
} from './provider.js';

/** What the provider remembers about one payment. */
interface SyntheticPaymentState {
  providerObjectId: string;
  status: PaymentStatus;
  amount: Money;
  refundedMinor: number;
}

/** A deterministic, prefixed id derived from a Mercaria id. */
function deriveId(prefix: string, seed: string): string {
  return `mock_${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

/**
 * The synthetic rail's own event envelope, before signing.
 *
 * `id` is derived from the payment and the status so the SAME transition always
 * produces the SAME event id — which is what lets the contract suite deliver a
 * duplicate without constructing one by hand, and what makes the dedupe index
 * the thing under test rather than the test's own bookkeeping.
 */
export interface SyntheticEvent {
  id: string;
  type: string;
  livemode: boolean;
  paymentId: string;
  providerObjectId: string;
  status: PaymentStatus;
}

export class SyntheticPaymentProvider implements PaymentProvider {
  readonly id = 'mock' as const;

  private readonly payments = new Map<string, SyntheticPaymentState>();
  private readonly failures = new Map<PaymentProviderStage, PaymentProviderError>();
  private readonly eventSecret: string;

  /**
   * @param options.eventSecret The HMAC secret `verifyEvent` checks against. A
   *   random per-instance secret when omitted, so the app registry never holds a
   *   hardcoded one — it verifies no inbound events anyway, and a constant here
   *   would be a shipped secret whether or not anything used it.
   */
  constructor(options: { eventSecret?: string } = {}) {
    this.eventSecret = options.eventSecret ?? randomBytes(32).toString('hex');
  }

  /** Make every call at `stage` throw, or clear it with `null`. */
  setFailure(stage: PaymentProviderStage, error: PaymentProviderError | null): void {
    if (error === null) {
      this.failures.delete(stage);
      return;
    }
    this.failures.set(stage, error);
  }

  /** Forget every payment and every injected failure. */
  reset(): void {
    this.payments.clear();
    this.failures.clear();
  }

  private guard(stage: PaymentProviderStage): void {
    const failure = this.failures.get(stage);
    if (failure) throw failure;
  }

  private require(providerObjectId: string, stage: PaymentProviderStage): SyntheticPaymentState {
    const state = this.payments.get(providerObjectId);
    if (!state) {
      throw new PaymentProviderError({
        provider: this.id,
        stage,
        message: `Unknown payment object ${providerObjectId}`,
        retryable: false,
        code: 'resource_missing',
      });
    }
    return state;
  }

  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    this.guard('createPayment');
    const providerObjectId = deriveId('pi', request.paymentId);
    // Idempotent by construction: a repeat finds the state it already made and
    // returns it, exactly as a real rail does for a reused idempotency key.
    const existing = this.payments.get(providerObjectId);
    const state: SyntheticPaymentState = existing ?? {
      providerObjectId,
      status: 'created',
      amount: request.amount,
      refundedMinor: 0,
    };
    this.payments.set(providerObjectId, state);
    return await Promise.resolve({
      providerObjectId,
      status: state.status,
      clientAction: {
        kind: 'client_secret' as const,
        value: deriveId('secret', `${request.paymentId}:${request.idempotencyKey}`),
      },
    });
  }

  async authorize(request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    this.guard('authorize');
    const state = this.require(request.providerObjectId, 'authorize');
    // A payment already past authorization stays where it is: re-authorizing a
    // captured payment must not walk it backwards.
    if (state.status === 'created' || state.status === 'requires_action') {
      state.status = 'processing';
    }
    return await Promise.resolve({ providerObjectId: state.providerObjectId, status: state.status });
  }

  async capture(request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    this.guard('capture');
    const state = this.require(request.providerObjectId, 'capture');
    if (state.status === 'canceled' || state.status === 'failed') {
      throw new PaymentProviderError({
        provider: this.id,
        stage: 'capture',
        message: `Cannot capture a ${state.status} payment`,
        retryable: false,
        code: 'payment_not_capturable',
      });
    }
    if (state.status !== 'refunded' && state.status !== 'partially_refunded') {
      state.status = 'succeeded';
    }
    return await Promise.resolve({ providerObjectId: state.providerObjectId, status: state.status });
  }

  async cancel(request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    this.guard('cancel');
    const state = this.require(request.providerObjectId, 'cancel');
    if (state.status === 'succeeded') {
      throw new PaymentProviderError({
        provider: this.id,
        stage: 'cancel',
        message: 'Cannot cancel a captured payment; refund it instead',
        retryable: false,
        code: 'payment_not_cancelable',
      });
    }
    state.status = 'canceled';
    return await Promise.resolve({ providerObjectId: state.providerObjectId, status: state.status });
  }

  async refund(request: RefundRequest): Promise<ProviderRefundResult> {
    this.guard('refund');
    const state = this.require(request.providerObjectId, 'refund');
    if (state.status !== 'succeeded' && state.status !== 'partially_refunded') {
      throw new PaymentProviderError({
        provider: this.id,
        stage: 'refund',
        message: `Cannot refund a ${state.status} payment`,
        retryable: false,
        code: 'charge_not_refundable',
      });
    }
    const refunded = state.refundedMinor + request.amount.amount;
    if (refunded > state.amount.amount) {
      throw new PaymentProviderError({
        provider: this.id,
        stage: 'refund',
        message: 'Refund exceeds the captured amount',
        retryable: false,
        code: 'refund_exceeds_charge',
      });
    }
    state.refundedMinor = refunded;
    state.status = refunded === state.amount.amount ? 'refunded' : 'partially_refunded';
    return await Promise.resolve({
      providerObjectId: deriveId('re', request.refundId),
      status: state.status,
      // Always `succeeded`, and no in-memory rail should pretend otherwise: this
      // one moves no money, so a `pending` it invented would never resolve and
      // would leave the dev seam's refunds permanently un-landed. Its whole job
      // is to exercise the code path deterministically.
      state: 'succeeded',
    });
  }

  async getStatus(providerObjectId: string): Promise<ProviderPaymentResult> {
    this.guard('getStatus');
    const state = this.require(providerObjectId, 'getStatus');
    return await Promise.resolve({ providerObjectId, status: state.status });
  }

  /**
   * Build and sign an event this provider would have sent.
   *
   * The counterpart of `verifyEvent`, and legitimately part of the adapter: this
   * rail IS the counterparty, so simulating its outbound deliveries is its job
   * rather than a test helper's. A live adapter has no equivalent — its events
   * come from the network — which is exactly why the contract suite asks for one
   * through an optional capability rather than through the interface.
   */
  signEvent(event: SyntheticEvent): ProviderEventInput {
    const payload = JSON.stringify(event);
    return {
      payload,
      signature: createHmac('sha256', this.eventSecret).update(payload).digest('hex'),
    };
  }

  /** The event a payment reaching `status` would produce. Deterministic id. */
  buildEvent(input: {
    paymentId: string;
    providerObjectId: string;
    status: PaymentStatus;
    livemode?: boolean;
  }): SyntheticEvent {
    return {
      id: deriveId('evt', `${input.paymentId}:${input.status}`),
      type: `payment.${input.status}`,
      livemode: input.livemode ?? false,
      paymentId: input.paymentId,
      providerObjectId: input.providerObjectId,
      status: input.status,
    };
  }

  async verifyEvent(input: ProviderEventInput): Promise<ProviderEventEnvelope> {
    this.guard('verifyEvent');
    const expected = createHmac('sha256', this.eventSecret).update(input.payload).digest();
    const provided = Buffer.from(input.signature, 'hex');
    // Constant time, and length-checked first: `timingSafeEqual` throws on a
    // length mismatch rather than returning false, so a truncated signature
    // would surface as a TypeError instead of the rejection it is.
    const verified = provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!verified) {
      throw new PaymentProviderError({
        provider: this.id,
        stage: 'verifyEvent',
        message: 'Event signature does not verify',
        retryable: false,
        code: 'signature_verification_failed',
      });
    }

    const event: unknown = JSON.parse(input.payload);
    if (typeof event !== 'object' || event === null) {
      throw new PaymentProviderError({
        provider: this.id,
        stage: 'verifyEvent',
        message: 'Event payload is not an object',
        retryable: false,
        code: 'invalid_payload',
      });
    }
    const parsed = event as Partial<SyntheticEvent>;
    if (!parsed.id || !parsed.type || !parsed.providerObjectId || !parsed.status) {
      throw new PaymentProviderError({
        provider: this.id,
        stage: 'verifyEvent',
        message: 'Event payload is missing required fields',
        retryable: false,
        code: 'invalid_payload',
      });
    }

    return await Promise.resolve({
      provider: this.id,
      providerEventId: parsed.id,
      type: parsed.type,
      livemode: parsed.livemode === true,
      objectIds: { payment: parsed.providerObjectId },
      paymentStatus: parsed.status,
      payload: event,
    });
  }
}
