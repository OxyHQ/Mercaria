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
 * spells cancellation the way the order domain does. Mapping Stripe's `canceled`
 * onto it is the ADAPTER's job, stated in one function, so no service ever
 * branches on a provider's spelling.
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
  | 'cancelSubscription';

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

/** A provider-hosted page for the merchant's browser. */
export interface BillingHostedSession {
  readonly url: string;
  readonly expiresAt?: Date;
}

/** The billing rail's operations. Every one of them is idempotent or a read. */
export interface BillingProvider {
  readonly id: BillingProviderId;
  /** Whether this deployment's key is the rail's LIVE key space. */
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

  /** Open a hosted subscription checkout. No card data crosses this call. */
  createCheckoutSession(input: {
    providerCustomerId: string;
    providerPriceId: string;
    trialDays: number;
    returnUrl: string;
    /** Mercaria's own correlation, carried in provider metadata. */
    storeId: string;
    planId: string;
    idempotencyKey: string;
  }): Promise<BillingHostedSession>;

  /** Open the provider's hosted billing portal (#89 billing rule 5). */
  createPortalSession(input: {
    providerCustomerId: string;
    returnUrl: string;
  }): Promise<BillingHostedSession>;

  /** Re-read one subscription — the reconciliation sweep's single-item path. */
  retrieveSubscription(providerSubscriptionId: string): Promise<BillingSubscriptionSnapshot>;

  /**
   * Schedule a cancellation for the end of the paid period.
   *
   * There is deliberately no immediate-termination method: the initial plan
   * design cancels at period end and issues no proration, and a merchant who
   * paid for a month keeps the month. An operator terminating early is a
   * decision taken at the rail, and reconciliation brings it back.
   */
  cancelAtPeriodEnd(providerSubscriptionId: string): Promise<BillingSubscriptionSnapshot>;
}

const providers = new Map<BillingProviderId, BillingProvider>();

/**
 * Register the adapter for one rail.
 *
 * Called at boot from `services/billing/stripe/stripe-billing.ts` when the rail
 * is configured. The registry is EMPTY by default, so a deployment with no
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
