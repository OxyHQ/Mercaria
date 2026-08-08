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
 * to the payment domain, never to an adapter — so "what happens when a payment
 * succeeds" is written ONCE and cannot drift between rails. Three modules call
 * an adapter and no others: `payment.service` (status changes and the sweep's
 * cancellation), `checkout-payment.service` (opening a checkout's payment) and
 * `settlement.service` (the per-seller transfers).
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
  RefundProviderState,
  TransferStatus,
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
  | 'transfer'
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
  /** What goes back to the buyer, in the PRESENTMENT currency they were charged. */
  amount: Money;
  idempotencyKey: string;
  /**
   * Minimal, stable Mercaria ids for webhook correlation — the same rule a
   * payment's metadata follows, and never a contact value.
   *
   * It is what closes the window between the rail creating a refund object and
   * Mercaria recording its id: an inbound refund event carrying Mercaria's own
   * `refundId` resolves even if the local row has not been written yet, which is
   * what keeps a legitimate refund from being reported as one made outside
   * Mercaria.
   */
  metadata: Readonly<Record<string, string>>;
}

/** The provider's answer to a refund. */
export interface ProviderRefundResult {
  /** The rail's own id for the REFUND, not for the payment. */
  providerObjectId: string;
  /** Where the PAYMENT stands after it — `refunded` or `partially_refunded`. */
  status: PaymentStatus;
  /** Where the REFUND itself stands — the money's own lifecycle. */
  state: RefundProviderState;
  /**
   * What the refund actually took off the platform balance, and the rate that
   * produced it — present once the rail has stated it.
   *
   * ADR 0001 D7: a refund converts at the REFUND-time rate and the original
   * conversion fee is not returned, so this is captured from the rail's own
   * record of the movement and is NEVER derived from the charge. The asymmetry
   * against the original charge is expected and is what the ledger is supposed
   * to show.
   */
  platform?: { amount: Money; rate: FxRateSnapshot };
  /** The rail's machine-readable failure code, when it failed. */
  failureCode?: string;
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

/**
 * Pay one seller order its share of a funded payment.
 *
 * The provider-neutral shape of ADR 0001 D3's "one Transfer per seller order":
 * the money is already on Mercaria's balance at the rail, and this moves one
 * order's net onto the seller's own.
 *
 * `sourcePaymentObjectId` is the FUNDING object — the rail's own id for the
 * payment this settlement draws from — and naming it is what lets a rail make
 * the movement wait for those funds rather than fail against a balance that has
 * not landed. Which object that is, and how the waiting works, is the adapter's
 * business; nothing above it knows.
 */
export interface CreateTransferRequest {
  paymentId: string;
  orderId: string;
  /** The rail's own id for the payment being settled. */
  sourcePaymentObjectId: string;
  /** The seller's account AT THE RAIL, from their provider-account record. */
  destinationAccountId: string;
  /** The seller's net, in the platform's settlement currency (ADR 0001 D8). */
  amount: Money;
  /** Ties every movement of one checkout together at the rail. */
  groupRef: string;
  idempotencyKey: string;
  metadata: Readonly<Record<string, string>>;
}

/** The rail's answer to a settlement. */
export interface ProviderTransferResult {
  providerObjectId: string;
  /** Where the transfer stands the moment it was made. */
  status: TransferStatus;
}

/**
 * Take part or all of one seller order's settlement back off their balance.
 *
 * The other half of a refund (ADR 0001 D7) and the recovery half of a lost
 * dispute: the buyer's money has already gone back, or the network has already
 * taken it, and this is how the seller bears it.
 *
 * `amount` is in the PLATFORM's settlement currency, because that is what the
 * transfer was denominated in — never the currency the buyer was refunded in.
 * The two come apart on any converted charge, and reversing a EUR transfer by a
 * dollar figure would take the wrong amount off a seller's balance without any
 * step failing.
 *
 * A reversal that the rail refuses for an insufficient balance is a PERMANENT
 * failure, not a retryable one: no number of attempts creates funds. That
 * distinction is what routes it to the operator exception path instead of a
 * backoff loop, and ADR 0001 D7 is explicit that the buyer's refund is not
 * blocked on it either way.
 */
export interface ReverseTransferRequest {
  paymentId: string;
  orderId: string;
  /** The rail's own id for the transfer being reversed. */
  transferObjectId: string;
  /** The seller's share to recover, in the platform settlement currency. */
  amount: Money;
  idempotencyKey: string;
  metadata: Readonly<Record<string, string>>;
}

/** The rail's answer to a reversal. */
export interface ProviderTransferReversalResult {
  /** The rail's own id for the REVERSAL. */
  providerObjectId: string;
  /** What the transfer has now had reversed in TOTAL — cumulative, not this leg. */
  totalReversedMinor: number;
}

/**
 * A rail that can settle each seller order out of a funded payment.
 *
 * An OPTIONAL capability rather than part of `PaymentProvider`, because it is
 * not a property every rail has and pretending otherwise would force a lie. The
 * synthetic rail holds no seller accounts and moves no money — a `createTransfer`
 * on it could only return a fabricated id for a movement that never happened,
 * which is exactly the kind of green nothing that makes a settlement bug
 * invisible. So the mock rail declines to settle and the settlement service
 * skips it, which is the truth about what a dev seam does.
 *
 * #51's Faircoin rail is expected to implement this: a per-order settlement out
 * of a group payment is a marketplace shape, not a Stripe one.
 *
 * `reverseTransfer` is on this interface and not on `PaymentProvider` for the
 * same reason `createTransfer` is: a rail that never settled a seller order has
 * nothing to take back, and giving it a method for the attempt would only let a
 * caller believe money had been recovered from a movement that never happened.
 * They are one capability — "this rail moves a seller's share, both ways" —
 * because a rail that could settle and not reverse would refund buyers with no
 * way to make the seller bear it, which ADR 0001 D7 does not allow for.
 */
export interface SettlingPaymentProvider extends PaymentProvider {
  createTransfer(request: CreateTransferRequest): Promise<ProviderTransferResult>;
  reverseTransfer(
    request: ReverseTransferRequest,
  ): Promise<ProviderTransferReversalResult>;
}

/**
 * A rail whose already-created payment can be READ back, client material and all.
 *
 * The other optional capability, and it exists for a specific failure: a rail
 * that expires its idempotency keys (Stripe's last 24 hours) would hand a buyer
 * returning to an unpaid checkout the next day a SECOND payment object for
 * orders the first one can still fund. Reading the object Mercaria already
 * recorded cannot do that, whatever the age of the key.
 *
 * Optional rather than universal because a rail whose keys never expire — the
 * synthetic one derives its object id from the payment id — needs no second
 * method: its `createPayment` already IS the resume.
 */
export interface ResumablePaymentProvider extends PaymentProvider {
  resumePayment(providerObjectId: string): Promise<ProviderPaymentResult>;
}

/** Whether this rail can re-read a payment it already created. */
export function isResumableProvider(
  provider: PaymentProvider,
): provider is ResumablePaymentProvider {
  return typeof (provider as Partial<ResumablePaymentProvider>).resumePayment === 'function';
}

/**
 * Whether this rail can settle seller orders. The narrowing the caller needs.
 *
 * Both halves are checked, not just `createTransfer`: the two are one capability
 * (see the interface), and a rail offering only the outward half would pass a
 * one-sided test and then throw `is not a function` from inside a refund that
 * had already paid the buyer.
 */
export function isSettlingProvider(
  provider: PaymentProvider,
): provider is SettlingPaymentProvider {
  const candidate = provider as Partial<SettlingPaymentProvider>;
  return (
    typeof candidate.createTransfer === 'function' &&
    typeof candidate.reverseTransfer === 'function'
  );
}
