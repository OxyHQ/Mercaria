/**
 * The billing-provider boundary — a merchant SUBSCRIPTION rail, which is not the
 * marketplace payment rail and shares nothing with it.
 *
 * Issue #89: "A different provider can be added later through the same
 * billing-provider boundary." This interface is that boundary, and it is
 * deliberately a SECOND one rather than a widening of `PaymentProvider`. The two
 * answer opposite questions — one moves a buyer's money to a seller through
 * Mercaria, the other charges a merchant on Mercaria's own account — and a
 * single interface would eventually make a connected account and a billing
 * customer interchangeable in some caller's mind, which is exactly what
 * acceptance 2 asks be impossible.
 *
 * ## Nothing here takes card data, and there is no method that could
 *
 * Issue #89 billing rule 2 asks for a hosted surface. Both session methods
 * return a URL for the merchant's browser; there is no parameter for a card, a
 * token or a payment-method id anywhere in this file, so "Mercaria does not
 * collect card details" is a property of the interface rather than a claim about
 * the implementation.
 *
 * ## The snapshot is Mercaria's vocabulary, never a provider's
 *
 * {@link BillingSubscriptionSnapshot} carries `MerchantSubscriptionStatus`, which
 * spells cancellation the way the order domain does. Mapping the gateway's
 * `canceled` onto it is the ADAPTER's job, stated in one function
 * (`peable/status.ts`), so no service ever branches on a provider's spelling.
 */

import type {
  BillingInterval,
  BillingProviderId,
  MerchantSubscriptionStatus,
} from '@mercaria/shared-types';

/** Which call failed, for an error that has to say. */
export type BillingProviderStage =
  | 'ensureCustomer'
  | 'createCheckoutSession'
  | 'createPortalSession'
  | 'retrieveSubscription'
  | 'retrieveInvoice'
  | 'retrieveInvoicePayment'
  | 'cancelSubscription'
  | 'changeSubscriptionPrice';

/**
 * A billing rail refused or failed.
 *
 * `retryable` is the adapter's judgement and nothing else reads the underlying
 * library: a rate limit and a network fault are worth trying again, an invalid
 * price id never is.
 */
export class BillingProviderError extends Error {
  readonly provider: BillingProviderId;
  readonly stage: BillingProviderStage;
  readonly retryable: boolean;
  /** The provider's own machine-readable code, when it gave one. */
  readonly code?: string;

  constructor(input: {
    provider: BillingProviderId;
    stage: BillingProviderStage;
    message: string;
    retryable: boolean;
    code?: string;
  }) {
    super(input.message);
    this.name = 'BillingProviderError';
    this.provider = input.provider;
    this.stage = input.stage;
    this.retryable = input.retryable;
    if (input.code !== undefined) this.code = input.code;
  }
}

/** Whether trying the same billing request again could ever work. */
export function isRetryableBillingError(error: unknown): boolean {
  return error instanceof BillingProviderError && error.retryable;
}

/** What the rail says about one subscription, in Mercaria's own vocabulary. */
export interface BillingSubscriptionSnapshot {
  readonly providerSubscriptionId: string;
  readonly providerCustomerId: string;
  readonly livemode: boolean;
  readonly status: MerchantSubscriptionStatus;
  readonly interval: BillingInterval;
  /** The provider price the subscription is on — how Mercaria maps back to a plan. */
  readonly providerPriceId: string;
  readonly currentPeriodStart?: Date;
  readonly currentPeriodEnd?: Date;
  readonly trialEndsAt?: Date;
  /** When a scheduled cancellation takes effect, if one is scheduled. */
  readonly cancelAt?: Date;
  readonly cancelledAt?: Date;
}

/**
 * What the rail says about one invoice — read when it reports the invoice paid
 * or failed, never taken from the event's payload.
 */
export interface BillingInvoiceSnapshot {
  readonly providerInvoiceId: string;
  readonly providerCustomerId: string;
  /** The subscription it bills, or `undefined` for a one-off invoice. */
  readonly providerSubscriptionId?: string;
  readonly livemode: boolean;
  /** `paid` is the only status that books anything. */
  readonly status: string;
  /** What the payer paid, in `currency`'s minor units. */
  readonly amountPaidMinor: number;
  /** ISO 4217, upper case, exactly as the rail answered. */
  readonly currency: string;
  /**
   * The payment that collects (or collected) the invoice, or `undefined` when
   * none is linked — an invoice settled from a credit balance has none.
   */
  readonly providerPaymentId?: string;
}

/**
 * The fiat price a FairCoin payment was quoted at (Peable ADR 0021 D4) — a
 * label on the payment, never an exchange: the payer paid FAIR and no fiat
 * moved.
 */
export interface BillingFaircoinQuote {
  /** The order's fiat currency, upper case, as the rail answered. */
  readonly currency: string;
  /** The order's total in `currency`'s minor units — the invoice's `amount_paid`. */
  readonly amountMinor: number;
  readonly quotedAt: Date;
}

/**
 * The payment that paid an invoice, read when the invoice reports paid — what
 * decides how the invoice is booked, because the invoice's own `amount_paid` is
 * the order's figure whichever rail paid it.
 */
export interface BillingInvoicePaymentSnapshot {
  readonly providerPaymentId: string;
  readonly livemode: boolean;
  /** The payment's own status; only `succeeded` has received anything. */
  readonly status: string;
  /**
   * `card`: fiat captured to the platform balance. `faircoin`: FAIR sent by the
   * payer's wallet to the Peable wallet of the account that owns Mercaria's
   * merchant — self-custodial, so nothing reaches a fiat balance.
   */
  readonly rail: 'card' | 'faircoin';
  /** What the payment received, in `currency`'s minor units (FAIR's 10⁻⁸ on `faircoin`). */
  readonly amountReceivedMinor: number;
  /** Upper case: `FAIR` on the FairCoin rail. */
  readonly currency: string;
  /** The fiat order a FairCoin payment was quoted for; `null` on a card or FAIR-priced one. */
  readonly faircoinQuote: BillingFaircoinQuote | null;
}

/** A provider-hosted page for the merchant's browser. */
export interface BillingHostedSession {
  readonly url: string;
  readonly expiresAt?: Date;
}

/**
 * A subscription checkout the merchant pays INSIDE the dashboard — Peable's
 * embedded session, paid in Peable's payment sheet. No card data and no rail
 * credential: `clientSecret` is the session's payer capability.
 */
export interface BillingEmbeddedCheckout {
  readonly sessionId: string;
  readonly clientSecret: string;
  /** The session's total, in minor units of `currency`, exactly as the rail priced it. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly livemode: boolean;
  readonly expiresAt?: Date;
}

/** The billing rail's operations. Every one of them is idempotent or a read. */
export interface BillingProvider {
  readonly id: BillingProviderId;
  /** Whether this deployment's merchant is the rail's LIVE mode. */
  readonly livemode: boolean;

  /**
   * Find or create the platform customer for one store.
   *
   * @param idempotencyKey Derived from the STORE, never from a freshly-minted
   *   Mercaria row id — a Mercaria row can be deduplicated after the fact and a
   *   provider customer cannot be un-created, so a key that differed between two
   *   racers would defeat itself (#46's finding, one domain over).
   */
  ensureCustomer(input: {
    storeId: string;
    storeName: string;
    idempotencyKey: string;
  }): Promise<{ providerCustomerId: string }>;

  /**
   * Open an embedded subscription checkout, paid in the dashboard's Peable
   * sheet. No card data crosses this call, and nothing is redirected: there is
   * no return URL, because the page around the sheet is the dashboard's own.
   */
  createCheckoutSession(input: {
    providerCustomerId: string;
    providerPriceId: string;
    trialDays: number;
    /** Mercaria's own correlation, carried in provider metadata. */
    storeId: string;
    planId: string;
    idempotencyKey: string;
  }): Promise<BillingEmbeddedCheckout>;

  /** Open the provider's hosted billing portal (#89 billing rule 5). */
  createPortalSession(input: {
    providerCustomerId: string;
    returnUrl: string;
    idempotencyKey?: string;
  }): Promise<BillingHostedSession>;

  /** Re-read one subscription — the reconciliation sweep's single-item path. */
  retrieveSubscription(providerSubscriptionId: string): Promise<BillingSubscriptionSnapshot>;

  /** Re-read one invoice — what an `invoice.*` event is about. */
  retrieveInvoice(providerInvoiceId: string): Promise<BillingInvoiceSnapshot>;

  /**
   * Re-read the payment an invoice names — its rail, what it received and, on
   * FairCoin, the quote. Never taken from an event payload.
   */
  retrieveInvoicePayment(providerPaymentId: string): Promise<BillingInvoicePaymentSnapshot>;

  /**
   * Schedule a cancellation for the end of the paid period.
   *
   * There is deliberately no immediate-termination method: the initial plan
   * design cancels at period end and issues no proration, and a merchant who
   * paid for a month keeps the month. An operator terminating early is a
   * decision taken at the rail, and reconciliation brings it back.
   */
  cancelAtPeriodEnd(
    providerSubscriptionId: string,
    idempotencyKey?: string,
  ): Promise<BillingSubscriptionSnapshot>;

  /**
   * Move a live subscription onto another plan price — a change between two
   * paid plans, or between a plan's monthly and annual price.
   *
   * The unused time of the old price is credited and the new price's remaining
   * time charged ON AN INVOICE NOW (`always_invoice`), so an upgrade is paid
   * when it is taken rather than at the next renewal, and a downgrade leaves a
   * credit the next invoices draw down. A pending cancellation is withdrawn: a
   * merchant who chose a new plan has said they are staying.
   */
  changeSubscriptionPrice(input: {
    providerSubscriptionId: string;
    providerPriceId: string;
    idempotencyKey: string;
  }): Promise<BillingSubscriptionSnapshot>;
}

const providers = new Map<BillingProviderId, BillingProvider>();

/**
 * Register the adapter for one rail.
 *
 * Called at boot from `services/billing/register.ts` when the rail is
 * configured. The registry is EMPTY by default, so a deployment with no
 * billing rail answers "no provider" rather than throwing halfway through a
 * merchant's upgrade — the `catalog_sources` adapter registry's posture, and the
 * reason a missing provider is an ordinary answer here.
 */
export function registerBillingProvider(provider: BillingProvider): void {
  providers.set(provider.id, provider);
}

/** The adapter for a rail, or `undefined` when this deployment has none. */
export function getBillingProvider(id: BillingProviderId): BillingProvider | undefined {
  return providers.get(id);
}

/** Drop every registration. Test support — a suite must not inherit another's. */
export function resetBillingProviders(): void {
  providers.clear();
}
